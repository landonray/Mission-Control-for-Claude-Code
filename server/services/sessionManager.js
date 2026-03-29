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
    this.permissionMode = options.permissionMode || 'default';
    this.autoAccept = options.autoAccept || false;
    this.planMode = options.planMode || false;
    this.mcpConnections = options.mcpConnections || [];
    this.initialPrompt = options.initialPrompt || null;
    this.pendingPermission = null;
    this.messageQueue = [];
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

  start() {
    const args = ['--output-format', 'stream-json'];

    if (this.autoAccept) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.planMode) {
      args.push('--plan');
    }

    // Add MCP server connections
    if (this.mcpConnections && this.mcpConnections.length > 0) {
      const db = getDb();
      for (const mcpId of this.mcpConnections) {
        const mcpServer = db.prepare('SELECT * FROM mcp_servers WHERE id = ? OR name = ?').get(mcpId, mcpId);
        if (mcpServer) {
          const mcpArgs = mcpServer.args ? JSON.parse(mcpServer.args) : [];
          const mcpCmd = [mcpServer.command, ...mcpArgs].join(' ');
          args.push('--mcp', mcpCmd);
        }
      }

      // Also auto-connect any servers flagged for auto-connect
      const autoConnectServers = db.prepare('SELECT * FROM mcp_servers WHERE auto_connect = 1').all();
      for (const server of autoConnectServers) {
        const alreadyAdded = this.mcpConnections.includes(server.id) || this.mcpConnections.includes(server.name);
        if (!alreadyAdded) {
          const serverArgs = server.args ? JSON.parse(server.args) : [];
          const serverCmd = [server.command, ...serverArgs].join(' ');
          args.push('--mcp', serverCmd);
        }
      }
    } else {
      // Even without explicit connections, add auto-connect servers
      const db = getDb();
      const autoConnectServers = db.prepare('SELECT * FROM mcp_servers WHERE auto_connect = 1').all();
      for (const server of autoConnectServers) {
        const serverArgs = server.args ? JSON.parse(server.args) : [];
        const serverCmd = [server.command, ...serverArgs].join(' ');
        args.push('--mcp', serverCmd);
      }
    }

    this.process = spawn('claude', args, {
      cwd: this.workingDirectory,
      env: {
        ...process.env,
        FORCE_COLOR: '0'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.status = 'idle';
    this.updateDbStatus('idle');

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
      this.status = 'ended';
      this.updateDbStatus('ended');
      this.broadcast({
        type: 'session_ended',
        sessionId: this.id,
        exitCode: code,
        timestamp: new Date().toISOString()
      });
      this.generateSummary();
    });

    this.process.on('error', (err) => {
      this.status = 'error';
      this.updateDbStatus('error');
      this.broadcast({
        type: 'error',
        sessionId: this.id,
        error: err.message,
        timestamp: new Date().toISOString()
      });
    });

    if (this.initialPrompt) {
      setTimeout(() => this.sendMessage(this.initialPrompt), 500);
    }
  }

  handleOutputLine(line) {
    // Check for quality result markers in any output
    this.parseQualityResults(line);

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

  processStreamEvent(event) {
    const db = getDb();

    switch (event.type) {
      case 'assistant':
        this.status = 'working';
        this.updateDbStatus('working');
        if (event.message) {
          const content = typeof event.message === 'string'
            ? event.message
            : JSON.stringify(event.message);
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
        break;

      case 'permission_request':
        this.status = 'waiting';
        this.updateDbStatus('waiting');
        this.pendingPermission = event;
        break;

      case 'system':
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
        this.status = 'idle';
        this.updateDbStatus('idle');
        if (event.result) {
          const content = typeof event.result === 'string'
            ? event.result
            : JSON.stringify(event.result);
          db.prepare(`
            INSERT INTO messages (session_id, role, content, timestamp)
            VALUES (?, 'assistant', ?, datetime('now'))
          `).run(this.id, content);
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
    if (!this.process || this.process.killed) {
      throw new Error('Session process is not running');
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

    this.process.stdin.write(text + '\n');

    this.broadcast({
      type: 'user_message',
      sessionId: this.id,
      content: text,
      timestamp: new Date().toISOString()
    });
  }

  respondToPermission(approved) {
    if (!this.process || !this.pendingPermission) return;

    const response = approved ? 'y' : 'n';
    this.process.stdin.write(response + '\n');
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
      this.status = 'idle';
      this.updateDbStatus('idle');
      this.broadcast({
        type: 'session_resumed',
        sessionId: this.id,
        timestamp: new Date().toISOString()
      });
    }
  }

  async end() {
    if (this.process && !this.process.killed) {
      return new Promise((resolve) => {
        this.process.on('close', () => {
          resolve();
        });
        treeKill(this.process.pid, 'SIGTERM');
      });
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

    const messageCount = messages.length;
    const userMsgs = messages.filter(m => m.role === 'user');
    const assistantMsgs = messages.filter(m => m.role === 'assistant');

    // Extract key actions from user messages
    const keyActions = userMsgs
      .map(m => m.content.substring(0, 100))
      .slice(0, 10)
      .join('; ');

    // Extract file references from assistant messages
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

    // Build transcript for LLM summarization (truncate to fit context)
    const transcript = messages
      .slice(-40) // Last 40 messages to stay within limits
      .map(m => `${m.role}: ${m.content.substring(0, 500)}`)
      .join('\n\n');

    const summarizationPrompt = `Summarize this Claude Code session in 2-3 sentences. Focus on: what was accomplished, which files were changed, and what branch the work was on. Be concise and specific.\n\nTranscript:\n${transcript}`;

    // Try LLM-based summary via Claude Code CLI
    try {
      const { execSync } = require('child_process');
      const llmSummary = execSync(
        `echo ${JSON.stringify(summarizationPrompt)} | claude --output-format text --no-input 2>/dev/null`,
        {
          encoding: 'utf-8',
          timeout: 30000,
          cwd: this.workingDirectory || process.cwd()
        }
      ).trim();

      if (llmSummary && llmSummary.length > 20) {
        // Use LLM-generated summary
        this.saveSummary(db, llmSummary, keyActions, filesModified);
        return;
      }
    } catch (e) {
      // LLM summarization failed, fall back to heuristic
    }

    // Fallback: heuristic summary
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    const summaryParts = [];
    summaryParts.push(`Session with ${messageCount} messages (${userMsgs.length} user, ${assistantMsgs.length} assistant).`);

    if (filesModified.size > 0) {
      summaryParts.push(`Files referenced: ${[...filesModified].slice(0, 20).join(', ')}.`);
    }

    if (lastAssistant) {
      summaryParts.push(`Last response: ${lastAssistant.content.substring(0, 300)}`);
    }

    const summaryText = summaryParts.join(' ');
    this.saveSummary(db, summaryText, keyActions, filesModified);
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

function createSession(options = {}) {
  const db = getDb();
  const id = uuidv4();
  const name = options.name || `Session ${new Date().toLocaleString()}`;

  db.prepare(`
    INSERT INTO sessions (id, name, status, working_directory, branch, preset_id, permission_mode, auto_accept, plan_mode, created_at, last_activity_at)
    VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    name,
    options.workingDirectory || null,
    options.branch || null,
    options.presetId || null,
    options.permissionMode || 'default',
    options.autoAccept ? 1 : 0,
    options.planMode ? 1 : 0
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
  activeSessions
};
