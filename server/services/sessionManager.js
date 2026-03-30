const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const treeKill = require('tree-kill');
const { getDb } = require('../database');

const activeSessions = new Map();

class SessionProcess {
  constructor(id, options = {}) {
    this.id = id;
    this.process = null;
    this.outputBuffer = '';
    this.status = 'idle';
    this.listeners = new Set();
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.permissionMode = options.permissionMode || 'acceptEdits';
    this.mcpConnections = options.mcpConnections || [];
    this.initialPrompt = options.initialPrompt || null;
    this.useWorktree = options.useWorktree || false;
    this.model = options.model || 'claude-opus-4-6';
    this.pendingPermission = null;
    this.errorMessage = null;
    this.messageQueue = [];
    this.cliSessionId = null; // Tracks Claude CLI session ID for --resume
  }

  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  broadcast(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Listener error:', e);
      }
    }
  }

  buildMcpConfig() {
    const db = getDb();
    const servers = {};

    // Add explicitly requested MCP connections
    if (this.mcpConnections && this.mcpConnections.length > 0) {
      for (const mcpId of this.mcpConnections) {
        const mcpServer = db.prepare('SELECT * FROM mcp_servers WHERE id = ? OR name = ?').get(mcpId, mcpId);
        if (mcpServer) {
          servers[mcpServer.name] = {
            command: mcpServer.command,
            args: mcpServer.args ? JSON.parse(mcpServer.args) : []
          };
          if (mcpServer.env) {
            servers[mcpServer.name].env = JSON.parse(mcpServer.env);
          }
        }
      }
    }

    // Add auto-connect servers not already present
    const autoConnectServers = db.prepare('SELECT * FROM mcp_servers WHERE auto_connect = 1').all();
    for (const server of autoConnectServers) {
      if (!servers[server.name]) {
        servers[server.name] = {
          command: server.command,
          args: server.args ? JSON.parse(server.args) : []
        };
        if (server.env) {
          servers[server.name].env = JSON.parse(server.env);
        }
      }
    }

    if (Object.keys(servers).length === 0) return null;
    return { mcpServers: servers };
  }

  start() {
    this.status = 'idle';
    this.updateDbStatus('idle');

    if (this.initialPrompt) {
      this.sendMessage(this.initialPrompt);
    }
  }

  buildArgs(prompt) {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose'
    ];

    // Resume existing CLI session or start a new one
    if (this.cliSessionId) {
      args.push('--resume', this.cliSessionId);
    }

    if (this.useWorktree && !this.cliSessionId) {
      args.push('--worktree');
    }

    args.push('--permission-mode', this.permissionMode || 'acceptEdits');

    // Model selection
    if (this.model) {
      args.push('--model', this.model);
    }

    // MCP server connections
    const mcpConfig = this.buildMcpConfig();
    if (mcpConfig) {
      args.push('--mcp-config', JSON.stringify(mcpConfig));
    }

    // The prompt is passed as a positional argument
    args.push(prompt);

    return args;
  }

  spawnProcess(prompt) {
    const args = this.buildArgs(prompt);

    this.process = spawn('claude', args, {
      cwd: this.workingDirectory,
      env: {
        ...process.env,
        FORCE_COLOR: '0'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let partialLine = '';

    this.process.stdout.on('data', (data) => {
      const text = data.toString();
      partialLine += text;

      const lines = partialLine.split('\n');
      partialLine = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          this.handleOutputLine(line.trim());
        }
      }
    });

    this.process.stderr.on('data', (data) => {
      const text = data.toString();
      this.broadcast({
        type: 'stderr',
        sessionId: this.id,
        data: text,
        timestamp: new Date().toISOString()
      });
    });

    this.process.on('close', (code) => {
      this.process = null;
      // Don't overwrite 'error' status — preserve the error message for the UI
      if (this.status !== 'error') {
        this.status = 'idle';
        this.updateDbStatus('idle');
        this.broadcast({
          type: 'session_status',
          sessionId: this.id,
          status: 'idle',
          timestamp: new Date().toISOString()
        });
      }
    });

    this.process.on('error', (err) => {
      this.process = null;
      this.status = 'error';
      this.updateDbStatus('error');
      const message = err.code === 'ENOENT'
        ? 'claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code'
        : err.message;
      this.errorMessage = message;
      this.broadcast({
        type: 'error',
        sessionId: this.id,
        error: message,
        timestamp: new Date().toISOString()
      });
    });
  }

  handleOutputLine(line) {
    // Check for quality result markers in any output
    this.parseQualityResults(line);

    // Check for dev server URLs in raw output
    this.detectDevServerUrl(line);

    try {
      const event = JSON.parse(line);
      this.processStreamEvent(event);
    } catch (e) {
      this.broadcast({
        type: 'raw_output',
        sessionId: this.id,
        data: line,
        timestamp: new Date().toISOString()
      });
    }
  }

  detectDevServerUrl(text) {
    const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i);
    if (!match) return;

    const url = match[0].replace('0.0.0.0', 'localhost');

    // Only fire once per unique URL
    if (this._lastDetectedUrl === url) return;
    this._lastDetectedUrl = url;

    const db = getDb();
    db.prepare('UPDATE sessions SET preview_url = ? WHERE id = ?').run(url, this.id);

    this.broadcast({
      type: 'dev_server_detected',
      sessionId: this.id,
      url,
      timestamp: new Date().toISOString()
    });
  }

  processStreamEvent(event) {
    const db = getDb();

    switch (event.type) {
      case 'assistant':
        this.status = 'working';
        this.updateDbStatus('working');
        if (event.message) {
          // Extract text content from the message object
          let content;
          if (typeof event.message === 'string') {
            content = event.message;
          } else if (event.message.content && Array.isArray(event.message.content)) {
            content = event.message.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('\n');
          } else {
            content = JSON.stringify(event.message);
          }
          if (content) {
            db.prepare(`
              INSERT INTO messages (session_id, role, content, timestamp)
              VALUES (?, 'assistant', ?, datetime('now'))
            `).run(this.id, content);
            db.prepare(`
              UPDATE sessions SET
                assistant_message_count = assistant_message_count + 1,
                last_action_summary = ?,
                last_activity_at = datetime('now')
              WHERE id = ?
            `).run(
              content.substring(0, 200),
              this.id
            );
          }
        }
        break;

      case 'tool_use':
        this.status = 'working';
        this.updateDbStatus('working');
        db.prepare(`
          UPDATE sessions SET
            tool_call_count = tool_call_count + 1,
            last_action_summary = ?,
            last_activity_at = datetime('now')
          WHERE id = ?
        `).run(
          `Tool: ${event.tool || event.name || 'unknown'}`,
          this.id
        );
        break;

      case 'tool_result':
        // Scan tool output for dev server URLs
        if (event.content) {
          const text = typeof event.content === 'string'
            ? event.content
            : JSON.stringify(event.content);
          this.detectDevServerUrl(text);
        }
        break;

      case 'permission_request':
        this.status = 'waiting';
        this.updateDbStatus('waiting');
        this.pendingPermission = event;
        break;

      case 'system':
        // Capture the CLI session ID from init event for --resume
        if (event.subtype === 'init' && event.session_id) {
          this.cliSessionId = event.session_id;
        }
        if (event.subtype === 'context_window' || event.usage) {
          const usage = event.usage || {};
          const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0);
          const maxTokens = usage.max_tokens || 200000;
          const usageRatio = Math.min(totalTokens / maxTokens, 1.0);
          db.prepare(`
            UPDATE sessions SET context_window_usage = ? WHERE id = ?
          `).run(usageRatio, this.id);

          // Check for context warning notification
          const { sendNotification } = require('./notificationService');
          const settings = db.prepare('SELECT context_threshold FROM notification_settings WHERE id = 1').get();
          if (settings && usageRatio >= settings.context_threshold) {
            sendNotification(
              'Context Window Warning',
              `Session context usage at ${Math.round(usageRatio * 100)}%`,
              { type: 'context_warning', sessionId: this.id }
            ).catch(() => {});
          }
        }
        break;

      case 'usage':
        // Alternative event format for context tracking
        if (event.input_tokens || event.output_tokens) {
          const totalTokens = (event.input_tokens || 0) + (event.output_tokens || 0);
          const maxTokens = event.max_tokens || 200000;
          const usageRatio = Math.min(totalTokens / maxTokens, 1.0);
          db.prepare(`
            UPDATE sessions SET context_window_usage = ? WHERE id = ?
          `).run(usageRatio, this.id);
        }
        break;

      case 'result':
        // Don't insert message here — already handled by 'assistant' event
        // Process queued messages after this turn completes
        if (this.messageQueue.length > 0) {
          const nextMsg = this.messageQueue.shift();
          // Wait for process to fully close before starting next
          setTimeout(() => this.sendMessage(nextMsg), 100);
        }
        break;
    }

    this.broadcast({
      type: 'stream_event',
      sessionId: this.id,
      event: event,
      status: this.status,
      timestamp: new Date().toISOString()
    });
  }

  sendMessage(text) {
    if (this.process) {
      // A process is already running — queue the message
      this.messageQueue.push(text);
      return;
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO messages (session_id, role, content, timestamp)
      VALUES (?, 'user', ?, datetime('now'))
    `).run(this.id, text);

    db.prepare(`
      UPDATE sessions SET
        user_message_count = user_message_count + 1,
        last_activity_at = datetime('now')
      WHERE id = ?
    `).run(this.id);

    this.status = 'working';
    this.updateDbStatus('working');

    this.broadcast({
      type: 'user_message',
      sessionId: this.id,
      content: text,
      timestamp: new Date().toISOString()
    });

    // Spawn a new claude process for this message
    this.spawnProcess(text);
  }

  respondToPermission(approved) {
    if (!this.process || !this.pendingPermission) return;

    // With --input-format stream-json, permission responses are JSON
    const response = JSON.stringify({
      type: 'permission_response',
      id: this.pendingPermission.id || this.pendingPermission.tool_use_id,
      approved
    }) + '\n';
    this.process.stdin.write(response);
    this.pendingPermission = null;
    this.status = 'working';
    this.updateDbStatus('working');

    this.broadcast({
      type: 'permission_response',
      sessionId: this.id,
      approved,
      timestamp: new Date().toISOString()
    });
  }

  pause() {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTSTP');
      this.status = 'paused';
      this.updateDbStatus('paused');
      this.broadcast({
        type: 'session_paused',
        sessionId: this.id,
        timestamp: new Date().toISOString()
      });
    }
  }

  resume() {
    if (this.process) {
      this.process.kill('SIGCONT');
      this.status = 'working';
      this.updateDbStatus('working');
      this.broadcast({
        type: 'session_resumed',
        sessionId: this.id,
        timestamp: new Date().toISOString()
      });
    }
  }

  async end() {
    this.messageQueue = [];
    if (this.process && !this.process.killed) {
      return new Promise((resolve) => {
        this.process.on('close', () => {
          this.status = 'ended';
          this.updateDbStatus('ended');
          this.broadcast({
            type: 'session_ended',
            sessionId: this.id,
            timestamp: new Date().toISOString()
          });
          this.generateSummary();
          resolve();
        });
        treeKill(this.process.pid, 'SIGTERM');
      });
    } else {
      this.status = 'ended';
      this.updateDbStatus('ended');
      this.broadcast({
        type: 'session_ended',
        sessionId: this.id,
        timestamp: new Date().toISOString()
      });
      this.generateSummary();
    }
  }

  updateDbStatus(status) {
    const db = getDb();
    const updates = { status };
    if (status === 'ended') {
      db.prepare(`
        UPDATE sessions SET status = ?, ended_at = datetime('now'), last_activity_at = datetime('now')
        WHERE id = ?
      `).run(status, this.id);
    } else {
      db.prepare(`
        UPDATE sessions SET status = ?, last_activity_at = datetime('now')
        WHERE id = ?
      `).run(status, this.id);
    }
  }

  parseQualityResults(text) {
    // Look for QUALITY_RESULT markers from prompt/agent hooks
    const pattern = /QUALITY_RESULT:(\S+):(\w+):(PASS|FAIL)(?::(.*))?/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const [, ruleId, severity, result, details] = match;
      try {
        const db = getDb();
        db.prepare(`
          INSERT INTO quality_results (session_id, rule_id, rule_name, result, severity, details, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          this.id,
          ruleId,
          ruleId,
          result.toLowerCase(),
          severity,
          details || null
        );
      } catch (e) {
        // Ignore DB errors for quality results
      }
    }
  }

  generateSummary() {
    const db = getDb();
    const messages = db.prepare(`
      SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp
    `).all(this.id);

    if (messages.length === 0) return;

    const userMsgs = messages.filter(m => m.role === 'user');
    const assistantMsgs = messages.filter(m => m.role === 'assistant');

    const keyActions = userMsgs
      .map(m => m.content.substring(0, 100))
      .slice(0, 10)
      .join('; ');

    const filePattern = /(?:(?:created?|modified?|edited?|updated?|wrote|read)\s+)?(?:file\s+)?[`"']?([^\s`"']+\.[a-z]{1,6})[`"']?/gi;
    const filesModified = new Set();
    for (const msg of assistantMsgs) {
      const matches = msg.content.matchAll(filePattern);
      for (const match of matches) {
        if (match[1] && !match[1].startsWith('http')) {
          filesModified.add(match[1]);
        }
      }
    }

    // Build transcript for LLM summarization (truncated)
    const transcript = messages
      .slice(-40)
      .map(m => `${m.role}: ${m.content.substring(0, 500)}`)
      .join('\n\n');

    const summarizationPrompt = `Summarize this Claude Code session in 2-3 sentences. Focus on: what was accomplished, which files were changed, and what branch the work was on. Be concise and specific.\n\nTranscript:\n${transcript}`;

    // Async LLM-based summary via Claude Code CLI (non-blocking)
    const { execFile } = require('child_process');
    const cwd = this.workingDirectory || process.cwd();

    execFile('claude', [
      '--print',
      '--output-format', 'text',
      '--no-session-persistence',
      summarizationPrompt
    ], {
      encoding: 'utf-8',
      timeout: 60000,
      cwd
    }, (err, stdout) => {
      if (!err && stdout && stdout.trim().length > 20) {
        this.saveSummary(db, stdout.trim(), keyActions, filesModified);
      } else {
        // Fallback: heuristic summary
        this.saveFallbackSummary(db, messages, keyActions, filesModified);
      }
    });
  }

  saveFallbackSummary(db, messages, keyActions, filesModified) {
    const userMsgs = messages.filter(m => m.role === 'user');
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    const parts = [];
    parts.push(`Session with ${messages.length} messages (${userMsgs.length} user, ${assistantMsgs.length} assistant).`);
    if (filesModified.size > 0) {
      parts.push(`Files referenced: ${[...filesModified].slice(0, 20).join(', ')}.`);
    }
    if (lastAssistant) {
      parts.push(`Last response: ${lastAssistant.content.substring(0, 300)}`);
    }
    this.saveSummary(db, parts.join(' '), keyActions, filesModified);
  }

  saveSummary(db, summaryText, keyActions, filesModified) {
    db.prepare(`
      INSERT INTO session_summaries (session_id, summary, key_actions, files_modified, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(
      this.id,
      summaryText,
      keyActions || null,
      filesModified instanceof Set
        ? (filesModified.size > 0 ? JSON.stringify([...filesModified]) : null)
        : (filesModified || null)
    );
  }
}

const VALID_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6'];
const DEFAULT_MODEL = 'claude-opus-4-6';

function createSession(options = {}) {
  const db = getDb();
  const id = uuidv4();
  const name = options.name || `Session ${new Date().toLocaleString()}`;

  // Validate and normalize model
  if (options.model && !VALID_MODELS.includes(options.model)) {
    throw new Error(`Invalid model "${options.model}". Must be one of: ${VALID_MODELS.join(', ')}`);
  }
  options.model = options.model || DEFAULT_MODEL;

  db.prepare(`
    INSERT INTO sessions (id, name, status, working_directory, branch, preset_id, permission_mode, model, created_at, last_activity_at)
    VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    name,
    options.workingDirectory || null,
    options.branch || null,
    options.presetId || null,
    options.permissionMode || 'acceptEdits',
    options.model || 'claude-opus-4-6'
  );

  const session = new SessionProcess(id, options);
  activeSessions.set(id, session);
  session.start();

  return { id, name, status: 'idle' };
}

function getSession(id) {
  return activeSessions.get(id);
}

function getAllActiveSessions() {
  return Array.from(activeSessions.entries()).map(([id, session]) => ({
    id,
    status: session.status,
    pendingPermission: session.pendingPermission
  }));
}

function endSession(id) {
  const session = activeSessions.get(id);
  if (session) {
    session.end();
    activeSessions.delete(id);
  }
}

module.exports = {
  createSession,
  getSession,
  getAllActiveSessions,
  endSession,
  activeSessions,
  VALID_MODELS,
  DEFAULT_MODEL
};
