const { spawn, execSync, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const treeKill = require('tree-kill');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../database');

const activeSessions = new Map();

// Check if tmux is available on the system
let tmuxAvailable = false;
try {
  execSync('which tmux', { stdio: 'ignore' });
  tmuxAvailable = true;
} catch (e) {
  console.warn('WARNING: tmux not found. Sessions will not survive server restarts.');
}

// Directory for tmux output files
const TMUX_OUTPUT_DIR = path.join(__dirname, '..', '..', '.tmux-outputs');
if (tmuxAvailable) {
  try { fs.mkdirSync(TMUX_OUTPUT_DIR, { recursive: true }); } catch (e) {}
}

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
    this.pendingPermission = null;
    this.errorMessage = null;
    this.messageQueue = [];
    this.cliSessionId = null;
    this.tmuxSessionName = options.tmuxSessionName || null;
    this.outputTail = null; // file watcher for tmux output
    this.resuming = false; // true when restoring context for a resumed session
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

    if (this.cliSessionId) {
      args.push('--resume', this.cliSessionId);
    }

    args.push('--permission-mode', this.permissionMode || 'acceptEdits');

    const mcpConfig = this.buildMcpConfig();
    if (mcpConfig) {
      args.push('--mcp-config', JSON.stringify(mcpConfig));
    }

    args.push(prompt);

    return args;
  }

  getOutputFilePath() {
    return path.join(TMUX_OUTPUT_DIR, `${this.id}.jsonl`);
  }

  getTmuxName() {
    if (!this.tmuxSessionName) {
      this.tmuxSessionName = `mc-${this.id.substring(0, 8)}`;
      const db = getDb();
      db.prepare('UPDATE sessions SET tmux_session_name = ? WHERE id = ?').run(this.tmuxSessionName, this.id);
    }
    return this.tmuxSessionName;
  }

  spawnProcess(prompt) {
    if (tmuxAvailable) {
      this.spawnTmuxProcess(prompt);
    } else {
      this.spawnDirectProcess(prompt);
    }
  }

  spawnTmuxProcess(prompt) {
    const tmuxName = this.getTmuxName();
    const outputFile = this.getOutputFilePath();
    const args = this.buildArgs(prompt);

    // Ensure output file exists
    try { fs.writeFileSync(outputFile, '', { flag: 'a' }); } catch (e) {}

    // Build the claude command. We pipe stdout to a file so Mission Control can tail it.
    const escapedArgs = args.map(a => {
      // Shell-escape each argument
      return `'${a.replace(/'/g, "'\\''")}'`;
    }).join(' ');

    const cwd = this.workingDirectory || process.cwd();
    const claudeCmd = `cd '${cwd.replace(/'/g, "'\\''")}' && FORCE_COLOR=0 claude ${escapedArgs} >> '${outputFile.replace(/'/g, "'\\''")}' 2>&1; echo '{"type":"__process_exited__"}' >> '${outputFile.replace(/'/g, "'\\''")}'`;

    try {
      // Kill existing tmux session if it exists (stale)
      try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null`, { stdio: 'ignore' }); } catch (e) {}

      // Create new tmux session running the claude command
      execSync(`tmux new-session -d -s ${tmuxName} "${claudeCmd.replace(/"/g, '\\"')}"`, {
        stdio: 'ignore'
      });

      // Mark process as running (we use a sentinel object since there's no direct child process)
      this.process = { tmux: true, sessionName: tmuxName, killed: false };

      // Start tailing the output file
      this.startOutputTail(outputFile);

    } catch (err) {
      console.error(`Failed to create tmux session ${tmuxName}:`, err.message);
      // Fall back to direct spawning
      this.spawnDirectProcess(prompt);
    }
  }

  startOutputTail(outputFile) {
    // Track file position for reading new content
    let filePos = 0;
    try {
      const stats = fs.statSync(outputFile);
      filePos = stats.size;
    } catch (e) {}

    let partialLine = '';

    const readNewContent = () => {
      try {
        const stats = fs.statSync(outputFile);
        if (stats.size > filePos) {
          const fd = fs.openSync(outputFile, 'r');
          const buf = Buffer.alloc(stats.size - filePos);
          fs.readSync(fd, buf, 0, buf.length, filePos);
          fs.closeSync(fd);
          filePos = stats.size;

          const text = buf.toString();
          partialLine += text;

          const lines = partialLine.split('\n');
          partialLine = lines.pop() || '';

          for (const line of lines) {
            if (line.trim()) {
              if (line.trim() === '{"type":"__process_exited__"}') {
                // Process exited inside tmux
                this.handleTmuxProcessExit();
                return;
              }
              this.handleOutputLine(line.trim());
            }
          }
        }
      } catch (e) {
        // File may not exist yet or be briefly unavailable
      }
    };

    // Poll the output file for new content
    this.outputTail = setInterval(readNewContent, 100);

    // Also do an immediate read
    readNewContent();
  }

  stopOutputTail() {
    if (this.outputTail) {
      clearInterval(this.outputTail);
      this.outputTail = null;
    }
  }

  handleTmuxProcessExit() {
    this.stopOutputTail();
    this.process = null;

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

    // Process queued messages
    if (this.messageQueue.length > 0) {
      const nextMsg = this.messageQueue.shift();
      setTimeout(() => this.sendMessage(nextMsg), 100);
    }
  }

  spawnDirectProcess(prompt) {
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
    this.parseQualityResults(line);
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
        if (this.messageQueue.length > 0) {
          const nextMsg = this.messageQueue.shift();
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

    this.spawnProcess(text);
  }

  respondToPermission(approved) {
    if (!this.process || !this.pendingPermission) return;

    if (this.process.tmux) {
      // For tmux sessions, send the permission response via tmux send-keys
      // This won't work with stream-json permission flow in tmux mode
      // since we don't have direct stdin access. For now, we log a warning.
      console.warn('Permission responses in tmux mode are not yet fully supported.');
    } else {
      const response = JSON.stringify({
        type: 'permission_response',
        id: this.pendingPermission.id || this.pendingPermission.tool_use_id,
        approved
      }) + '\n';
      this.process.stdin.write(response);
    }

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
      if (this.process.tmux) {
        try {
          execSync(`tmux send-keys -t ${this.process.sessionName} C-z`, { stdio: 'ignore' });
        } catch (e) {}
      } else {
        this.process.kill('SIGTSTP');
      }
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
      if (this.process.tmux) {
        try {
          execSync(`tmux send-keys -t ${this.process.sessionName} 'fg' Enter`, { stdio: 'ignore' });
        } catch (e) {}
      } else {
        this.process.kill('SIGCONT');
      }
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
    this.stopOutputTail();

    if (this.process && !this.process.killed) {
      if (this.process.tmux) {
        // Kill the tmux session
        const tmuxName = this.process.sessionName;
        this.process.killed = true;
        this.process = null;
        try {
          execSync(`tmux kill-session -t ${tmuxName}`, { stdio: 'ignore' });
        } catch (e) {}
      } else {
        return new Promise((resolve) => {
          this.process.on('close', () => {
            this.process = null;
            this.finishEnd();
            resolve();
          });
          treeKill(this.process.pid, 'SIGTERM');
        });
      }
    }

    this.finishEnd();
  }

  finishEnd() {
    this.status = 'ended';
    this.updateDbStatus('ended');
    this.broadcast({
      type: 'session_ended',
      sessionId: this.id,
      timestamp: new Date().toISOString()
    });
    this.generateSummary();
  }

  updateDbStatus(status) {
    const db = getDb();
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
      } catch (e) {}
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

    const transcript = messages
      .slice(-40)
      .map(m => `${m.role}: ${m.content.substring(0, 500)}`)
      .join('\n\n');

    const summarizationPrompt = `Summarize this Claude Code session in 2-3 sentences. Focus on: what was accomplished, which files were changed, and what branch the work was on. Be concise and specific.\n\nTranscript:\n${transcript}`;

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

// --- Context Preamble for Session Resume ---

function buildContextPreamble(sessionId) {
  const db = getDb();

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const parts = [];

  // 1. Session summary (if available)
  const summary = db.prepare(`
    SELECT summary FROM session_summaries
    WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(sessionId);
  if (summary) {
    parts.push(`Session summary: ${summary.summary}`);
  }

  // 2. Original task (first user message)
  const firstMessage = db.prepare(`
    SELECT content FROM messages
    WHERE session_id = ? AND role = 'user'
    ORDER BY timestamp ASC LIMIT 1
  `).get(sessionId);
  if (firstMessage) {
    parts.push(`The original task was: ${firstMessage.content.substring(0, 500)}`);
  }

  // 3. Key decisions (user messages that contain directives)
  const allUserMessages = db.prepare(`
    SELECT content FROM messages
    WHERE session_id = ? AND role = 'user'
    ORDER BY timestamp ASC
  `).all(sessionId);

  const keyDecisions = allUserMessages
    .filter(m => {
      const lower = m.content.toLowerCase();
      return lower.includes('instead') || lower.includes('actually') ||
        lower.includes('change') || lower.includes('don\'t') ||
        lower.includes('make sure') || lower.includes('always') ||
        lower.includes('never') || lower.includes('use ') ||
        lower.includes('switch') || lower.includes('prefer');
    })
    .slice(0, 5)
    .map(m => m.content.substring(0, 200));

  if (keyDecisions.length > 0) {
    parts.push(`Key decisions made: ${keyDecisions.join(' | ')}`);
  }

  // 4. Files modified
  const summaryRecord = db.prepare(`
    SELECT files_modified FROM session_summaries
    WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(sessionId);
  if (summaryRecord && summaryRecord.files_modified) {
    try {
      const files = JSON.parse(summaryRecord.files_modified);
      if (files.length > 0) {
        parts.push(`Files modified: ${files.slice(0, 20).join(', ')}`);
      }
    } catch (e) {}
  }

  // 5. Last 5 exchanges
  const recentMessages = db.prepare(`
    SELECT role, content FROM messages
    WHERE session_id = ?
    ORDER BY timestamp DESC LIMIT 10
  `).all(sessionId);

  if (recentMessages.length > 0) {
    const exchanges = recentMessages
      .reverse()
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 300)}`)
      .join('\n');
    parts.push(`Last exchanges:\n${exchanges}`);
  }

  // 6. Current git state
  let gitStatus = '';
  try {
    if (session.working_directory) {
      const cwd = session.working_directory.replace(/^~/, process.env.HOME || '');
      gitStatus = execSync('git status --short 2>/dev/null && echo "---" && git branch --show-current 2>/dev/null', {
        cwd,
        encoding: 'utf-8',
        timeout: 5000
      }).trim();
    }
  } catch (e) {}

  if (gitStatus) {
    parts.push(`Current git status:\n${gitStatus}`);
  }

  const preamble = `CONTEXT RECOVERY: You are resuming a previous session. Here is the context from that session:\n\n${parts.join('\n\n')}\n\nThe user's new message follows.`;

  return preamble;
}

// --- Resume a closed session ---

function resumeSession(sessionId, newMessage) {
  const db = getDb();
  const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!sessionRow) return null;

  // Build context preamble
  const preamble = buildContextPreamble(sessionId);

  // Create a new SessionProcess for this session ID
  const session = new SessionProcess(sessionId, {
    workingDirectory: sessionRow.working_directory,
    permissionMode: sessionRow.permission_mode || 'acceptEdits',
    mcpConnections: [],
    tmuxSessionName: null // new tmux session for resumed session
  });

  session.resuming = true;

  // Re-activate the session
  activeSessions.set(sessionId, session);

  // Update DB status
  db.prepare(`
    UPDATE sessions SET status = 'working', ended_at = NULL, last_activity_at = datetime('now')
    WHERE id = ?
  `).run(sessionId);

  // Broadcast the resume event
  session.broadcast({
    type: 'session_resuming',
    sessionId: sessionId,
    timestamp: new Date().toISOString()
  });

  // Combine preamble + new message and send
  const combinedPrompt = preamble
    ? `${preamble}\n\nUser's new message: ${newMessage}`
    : newMessage;

  // Store the user message in DB
  db.prepare(`
    INSERT INTO messages (session_id, role, content, timestamp)
    VALUES (?, 'user', ?, datetime('now'))
  `).run(sessionId, newMessage);

  db.prepare(`
    UPDATE sessions SET
      user_message_count = user_message_count + 1,
      last_activity_at = datetime('now')
    WHERE id = ?
  `).run(sessionId);

  session.status = 'working';
  session.updateDbStatus('working');

  session.broadcast({
    type: 'user_message',
    sessionId: sessionId,
    content: newMessage,
    timestamp: new Date().toISOString()
  });

  // Spawn the process with the combined prompt
  session.spawnProcess(combinedPrompt);

  return session;
}

// --- Tmux Session Recovery ---

function recoverTmuxSessions() {
  if (!tmuxAvailable) return;

  console.log('Recovering tmux sessions...');

  let tmuxSessions = [];
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8'
    }).trim();
    tmuxSessions = output.split('\n').filter(s => s.startsWith('mc-'));
  } catch (e) {
    // No tmux sessions running
    return;
  }

  if (tmuxSessions.length === 0) {
    console.log('No tmux sessions to recover.');
    return;
  }

  const db = getDb();

  for (const tmuxName of tmuxSessions) {
    // Find matching session in DB
    const sessionRow = db.prepare('SELECT * FROM sessions WHERE tmux_session_name = ?').get(tmuxName);
    if (!sessionRow) {
      console.log(`  Orphan tmux session ${tmuxName} — no DB record, killing.`);
      try { execSync(`tmux kill-session -t ${tmuxName}`, { stdio: 'ignore' }); } catch (e) {}
      continue;
    }

    // Check if tmux session is still alive
    let isAlive = false;
    try {
      execSync(`tmux has-session -t ${tmuxName} 2>/dev/null`, { stdio: 'ignore' });
      isAlive = true;
    } catch (e) {}

    if (!isAlive) continue;

    console.log(`  Recovering session ${sessionRow.id} (tmux: ${tmuxName})`);

    // Create a SessionProcess and reconnect
    const session = new SessionProcess(sessionRow.id, {
      workingDirectory: sessionRow.working_directory,
      permissionMode: sessionRow.permission_mode || 'acceptEdits',
      tmuxSessionName: tmuxName
    });

    // The tmux session may still be running a claude process
    // We set it as active and start tailing the output
    session.process = { tmux: true, sessionName: tmuxName, killed: false };

    const outputFile = session.getOutputFilePath();
    if (fs.existsSync(outputFile)) {
      session.startOutputTail(outputFile);
    }

    // Determine if the session is idle or working
    // If there's a claude process running in the tmux pane, it's working
    let sessionStatus = 'idle';
    try {
      const paneCmd = execSync(`tmux display-message -p -t ${tmuxName} '#{pane_current_command}'`, {
        encoding: 'utf-8'
      }).trim();
      if (paneCmd === 'claude' || paneCmd === 'node') {
        sessionStatus = 'working';
      }
    } catch (e) {}

    session.status = sessionStatus;
    session.updateDbStatus(sessionStatus);

    activeSessions.set(sessionRow.id, session);
    console.log(`  Recovered session ${sessionRow.id} as ${sessionStatus}`);
  }

  console.log(`Recovered ${activeSessions.size} tmux sessions.`);
}

// --- Session CRUD ---

function createSession(options = {}) {
  const db = getDb();
  const id = uuidv4();
  const name = options.name || `Session ${new Date().toLocaleString()}`;

  db.prepare(`
    INSERT INTO sessions (id, name, status, working_directory, branch, preset_id, permission_mode, created_at, last_activity_at)
    VALUES (?, ?, 'idle', ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    name,
    options.workingDirectory || null,
    options.branch || null,
    options.presetId || null,
    options.permissionMode || 'acceptEdits'
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
  resumeSession,
  recoverTmuxSessions,
  activeSessions,
  tmuxAvailable
};
