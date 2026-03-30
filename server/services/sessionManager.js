const { spawn, execSync, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const treeKill = require('tree-kill');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { query } = require('../database');
const Anthropic = require('@anthropic-ai/sdk');

// Lazy-init Anthropic client (only created when needed)
let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

const activeSessions = new Map();

// Resolve ~ to home directory (shell and Node spawn don't expand ~ in all contexts)
function resolvePath(p) {
  if (!p) return process.cwd();
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

// Check if tmux is available on the system
let tmuxAvailable = false;
try {
  execSync('which tmux', { stdio: 'ignore' });
  tmuxAvailable = true;
} catch (e) {
  console.warn('WARNING: tmux not found. Sessions will not survive server restarts.');
}

// Directory for tmux output files and launch scripts
const TMUX_OUTPUT_DIR = path.join(__dirname, '..', '..', '.tmux-outputs');
const TMUX_SCRIPTS_DIR = path.join(__dirname, '..', '..', '.tmux-scripts');
if (tmuxAvailable) {
  try { fs.mkdirSync(TMUX_OUTPUT_DIR, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(TMUX_SCRIPTS_DIR, { recursive: true }); } catch (e) {}
}

// Generate a short AI-powered session name from the first user message
async function generateSessionName(messageText) {
  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{ role: 'user', content: messageText }],
      system: 'Generate a concise 3-6 word session name that captures the essence of this user message. Return ONLY the name, no quotes, no punctuation, no explanation. Examples: "Fix Login Page Bug", "Add Dark Mode Toggle", "Refactor Database Layer", "Debug API Endpoints".',
    });
    const name = response.content[0]?.text?.trim();
    return name || null;
  } catch (e) {
    console.error('Failed to generate session name:', e.message);
    return null;
  }
}

class SessionProcess {
  constructor(id, options = {}) {
    this.id = id;
    this.process = null;
    this.outputBuffer = '';
    this.status = 'idle';
    this.listeners = new Set();
    this.workingDirectory = resolvePath(options.workingDirectory);
    this.permissionMode = options.permissionMode || 'acceptEdits';
    this.mcpConnections = options.mcpConnections || [];
    this.initialPrompt = options.initialPrompt || null;
    this.useWorktree = options.useWorktree || false;
    this.model = options.model || 'claude-opus-4-6';
    this.pendingPermission = null;
    this.errorMessage = null;
    this.messageQueue = [];
    this.cliSessionId = null;
    this.tmuxSessionName = options.tmuxSessionName || null;
    this.outputTail = null; // file watcher for tmux output
    this.resuming = false; // true when restoring context for a resumed session
    this.stderrBuffer = ''; // accumulates stderr for error reporting
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

  async buildMcpConfig() {
    const servers = {};

    if (this.mcpConnections && this.mcpConnections.length > 0) {
      for (const mcpId of this.mcpConnections) {
        const result = await query('SELECT * FROM mcp_servers WHERE id = $1 OR name = $1', [mcpId]);
        const mcpServer = result.rows[0];
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

    const autoResult = await query('SELECT * FROM mcp_servers WHERE auto_connect = 1');
    for (const server of autoResult.rows) {
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

  async buildArgs(prompt) {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose'
    ];

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

    const mcpConfig = await this.buildMcpConfig();
    if (mcpConfig) {
      args.push('--mcp-config', JSON.stringify(mcpConfig));
    }

    args.push(prompt);

    return args;
  }

  getOutputFilePath() {
    return path.join(TMUX_OUTPUT_DIR, `${this.id}.jsonl`);
  }

  async getTmuxName() {
    if (!this.tmuxSessionName) {
      this.tmuxSessionName = `mc-${this.id.substring(0, 8)}`;
      await query('UPDATE sessions SET tmux_session_name = $1 WHERE id = $2', [this.tmuxSessionName, this.id]);
    }
    return this.tmuxSessionName;
  }

  async spawnProcess(prompt) {
    if (tmuxAvailable) {
      await this.spawnTmuxProcess(prompt);
    } else {
      await this.spawnDirectProcess(prompt);
    }
  }

  getScriptFilePath() {
    return path.join(TMUX_SCRIPTS_DIR, `${this.id}.sh`);
  }

  getPromptFilePath() {
    return path.join(TMUX_SCRIPTS_DIR, `${this.id}.prompt`);
  }

  async spawnTmuxProcess(prompt) {
    const tmuxName = await this.getTmuxName();
    const outputFile = this.getOutputFilePath();
    const stderrFile = outputFile + '.stderr';
    const args = await this.buildArgs(prompt);

    // Ensure output file exists
    try { fs.writeFileSync(outputFile, '', { flag: 'a' }); } catch (e) {}

    // Write the prompt to a file to completely avoid shell interpretation.
    const promptFile = this.getPromptFilePath();
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });

    // Write a self-contained launch script. No user content is embedded
    // in the script — the prompt is read from the prompt file at runtime.
    const cwd = this.workingDirectory;
    const scriptPath = this.getScriptFilePath();
    const cliArgs = args.slice(0, -1); // everything except the final prompt arg

    const scriptLines = [
      '#!/usr/bin/env bash',
      `OUTPUT_FILE=${JSON.stringify(outputFile)}`,
      `PROMPT_FILE=${JSON.stringify(promptFile)}`,
      '',
      `cd ${JSON.stringify(cwd)} 2>/dev/null || {`,
      `  echo '{"type":"__process_error__","error":"Working directory not found"}' >> "$OUTPUT_FILE"`,
      `  echo '{"type":"__process_exited__"}' >> "$OUTPUT_FILE"`,
      `  exit 1`,
      `}`,
      '',
      `export FORCE_COLOR=0`,
      `PROMPT="$(cat "$PROMPT_FILE")"`,
      `claude ${cliArgs.map(a => JSON.stringify(a)).join(' ')} "$PROMPT" >> "$OUTPUT_FILE" 2>${JSON.stringify(stderrFile)}`,
      `echo '{"type":"__process_exited__"}' >> "$OUTPUT_FILE"`,
    ];

    fs.writeFileSync(scriptPath, scriptLines.join('\n') + '\n', { mode: 0o755 });

    try {
      // Kill existing tmux session if it exists (stale)
      try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null`, { stdio: 'ignore' }); } catch (e) {}

      // Create tmux session running the script. No user content touches the shell.
      execSync(`tmux new-session -d -s ${tmuxName} ${scriptPath}`, {
        stdio: 'ignore'
      });

      // Mark process as running (sentinel object since there's no direct child process)
      this.process = { tmux: true, sessionName: tmuxName, killed: false };

      // Start tailing the output file
      this.startOutputTail(outputFile);

    } catch (err) {
      console.error(`Failed to create tmux session ${tmuxName}:`, err.message);
      // Clean up script/prompt files
      try { fs.unlinkSync(scriptPath); } catch (e) {}
      try { fs.unlinkSync(promptFile); } catch (e) {}
      // Fall back to direct spawning
      await this.spawnDirectProcess(prompt);
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
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Try to parse as JSON once — route sentinels vs normal events
            let parsed = null;
            try { parsed = JSON.parse(trimmed); } catch (e) {}

            if (parsed && parsed.type === '__process_exited__') {
              this.handleTmuxProcessExit();
              return;
            }
            if (parsed && parsed.type === '__process_error__') {
              this.status = 'error';
              this.errorMessage = parsed.error || 'Process failed to start';
              this.updateDbStatus('error');
              this.broadcast({
                type: 'error',
                sessionId: this.id,
                error: this.errorMessage,
                timestamp: new Date().toISOString()
              });
              return;
            }

            // Normal output — pass pre-parsed JSON to avoid double-parse
            this.handleOutputLine(trimmed, parsed);
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

  async spawnDirectProcess(prompt) {
    // Validate working directory exists before spawning
    if (!fs.existsSync(this.workingDirectory)) {
      const message = `Working directory not found: ${this.workingDirectory}`;
      console.error(`[Session ${this.id.slice(0, 8)}] ${message}`);
      this.status = 'error';
      this.updateDbStatus('error');
      this.errorMessage = message;
      this.broadcast({ type: 'error', sessionId: this.id, error: message, timestamp: new Date().toISOString() });
      return;
    }

    const args = await this.buildArgs(prompt);
    this.stderrBuffer = '';

    console.log(`[Session ${this.id.slice(0, 8)}] Spawning claude`, args.slice(0, -1), 'cwd:', this.workingDirectory);

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
      this.stderrBuffer += text;
      console.warn(`[Session ${this.id.slice(0, 8)}] stderr:`, text.trim());
      this.broadcast({
        type: 'stderr',
        sessionId: this.id,
        data: text,
        timestamp: new Date().toISOString()
      });
    });

    this.process.on('close', (code) => {
      this.process = null;

      if (code !== 0 && this.status === 'working') {
        // Process failed without setting error status — use stderr as message
        const message = this.stderrBuffer.trim() || `claude process exited with code ${code}`;
        console.error(`[Session ${this.id.slice(0, 8)}] Process failed (code ${code}): ${message}`);
        this.status = 'error';
        this.updateDbStatus('error');
        this.errorMessage = message;
        this.broadcast({
          type: 'error',
          sessionId: this.id,
          error: message,
          timestamp: new Date().toISOString()
        });
      } else if (this.status !== 'error') {
        this.status = 'idle';
        this.updateDbStatus('idle');
        this.broadcast({
          type: 'session_status',
          sessionId: this.id,
          status: 'idle',
          timestamp: new Date().toISOString()
        });
      }

      // Drain message queue (matches tmux behavior)
      if (this.messageQueue.length > 0) {
        const nextMsg = this.messageQueue.shift();
        setTimeout(() => this.sendMessage(nextMsg), 100);
      }
    });

    this.process.on('error', (err) => {
      this.process = null;
      this.status = 'error';
      this.updateDbStatus('error');
      let message;
      if (err.code === 'ENOENT') {
        message = !fs.existsSync(this.workingDirectory)
          ? `Working directory not found: ${this.workingDirectory}`
          : 'claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code';
      } else {
        message = err.message;
      }
      console.error(`[Session ${this.id.slice(0, 8)}] Spawn error:`, err.code, message);
      this.errorMessage = message;
      this.broadcast({
        type: 'error',
        sessionId: this.id,
        error: message,
        timestamp: new Date().toISOString()
      });
    });
  }

  handleOutputLine(line, preParsed) {
    this.parseQualityResults(line);
    this.detectDevServerUrl(line);

    // Use pre-parsed JSON if available (from tmux tail), otherwise parse
    let event = preParsed;
    if (!event) {
      try { event = JSON.parse(line); } catch (e) {}
    }

    if (event) {
      this.processStreamEvent(event);
    } else {
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

    query('UPDATE sessions SET preview_url = $1 WHERE id = $2', [url, this.id]).catch(e => console.error('Failed to update preview URL:', e.message));

    this.broadcast({
      type: 'dev_server_detected',
      sessionId: this.id,
      url,
      timestamp: new Date().toISOString()
    });
  }

  processStreamEvent(event) {
    // Fire-and-forget async DB operations — errors logged but don't block event processing
    this._processStreamEventAsync(event).catch(e => console.error('Stream event DB error:', e.message));

    this.broadcast({
      type: 'stream_event',
      sessionId: this.id,
      event: event,
      status: this.status,
      timestamp: new Date().toISOString()
    });
  }

  async _processStreamEventAsync(event) {
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
            await query(
              `INSERT INTO messages (session_id, role, content, timestamp) VALUES ($1, 'assistant', $2, NOW())`,
              [this.id, content]
            );
            await query(
              `UPDATE sessions SET assistant_message_count = assistant_message_count + 1, last_action_summary = $1, last_activity_at = NOW() WHERE id = $2`,
              [content.substring(0, 200), this.id]
            );
          }
        }
        break;

      case 'tool_use':
        this.status = 'working';
        this.updateDbStatus('working');
        await query(
          `UPDATE sessions SET tool_call_count = tool_call_count + 1, last_action_summary = $1, last_activity_at = NOW() WHERE id = $2`,
          [`Tool: ${event.tool || event.name || 'unknown'}`, this.id]
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
          await query('UPDATE sessions SET context_window_usage = $1 WHERE id = $2', [usageRatio, this.id]);

          const { sendNotification } = require('./notificationService');
          const settingsResult = await query('SELECT context_threshold FROM notification_settings WHERE id = 1');
          const settings = settingsResult.rows[0];
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
          await query('UPDATE sessions SET context_window_usage = $1 WHERE id = $2', [usageRatio, this.id]);
        }
        break;

      case 'result':
        if (this.messageQueue.length > 0) {
          const nextMsg = this.messageQueue.shift();
          setTimeout(() => this.sendMessage(nextMsg), 100);
        }
        break;
    }
  }

  async sendMessage(text, attachments = null) {
    if (this.process) {
      // A process is already running — queue the message but still show it in the UI
      this.messageQueue.push(text);

      // Insert into DB and broadcast so the user sees their message immediately
      await query(
        `INSERT INTO messages (session_id, role, content, attachments, timestamp) VALUES ($1, 'user', $2, $3, NOW())`,
        [this.id, text, attachments ? JSON.stringify(attachments) : null]
      );
      await query(
        `UPDATE sessions SET user_message_count = user_message_count + 1, last_activity_at = NOW() WHERE id = $1`,
        [this.id]
      );
      this.broadcast({
        type: 'user_message',
        sessionId: this.id,
        content: text,
        attachments: attachments || null,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Check if this is the first user message — trigger AI name generation
    const msgCountResult = await query('SELECT user_message_count FROM sessions WHERE id = $1', [this.id]);
    const msgCount = msgCountResult.rows[0];
    if (msgCount && msgCount.user_message_count === 0) {
      generateSessionName(text).then(async (name) => {
        if (!name) return;
        const currentResult = await query('SELECT name FROM sessions WHERE id = $1', [this.id]);
        const currentSession = currentResult.rows[0];
        if (currentSession && currentSession.name === 'New Session') {
          await query('UPDATE sessions SET name = $1 WHERE id = $2', [name, this.id]);
          this.broadcast({
            type: 'session_name_updated',
            sessionId: this.id,
            name,
            timestamp: new Date().toISOString()
          });
        }
      }).catch(e => console.error('Session name generation error:', e.message));
    }

    await query(
      `INSERT INTO messages (session_id, role, content, attachments, timestamp) VALUES ($1, 'user', $2, $3, NOW())`,
      [this.id, text, attachments ? JSON.stringify(attachments) : null]
    );

    await query(
      `UPDATE sessions SET user_message_count = user_message_count + 1, last_activity_at = NOW() WHERE id = $1`,
      [this.id]
    );

    this.status = 'working';
    this.updateDbStatus('working');

    this.broadcast({
      type: 'user_message',
      sessionId: this.id,
      content: text,
      attachments: attachments || null,
      timestamp: new Date().toISOString()
    });

    await this.spawnProcess(text);
  }

  respondToPermission(approved) {
    if (!this.process || !this.pendingPermission) return;

    const response = JSON.stringify({
      type: 'permission_response',
      id: this.pendingPermission.id || this.pendingPermission.tool_use_id,
      approved
    });

    if (this.process.tmux) {
      // For tmux sessions, write the response to the pane's stdin via send-keys.
      // We write the JSON followed by Enter to simulate stdin input.
      // tmux send-keys -l sends literal characters (no key name interpretation).
      try {
        execSync(`tmux send-keys -t ${this.process.sessionName} -l ${JSON.stringify(response + '\n')}`, {
          stdio: 'ignore'
        });
      } catch (e) {
        console.error(`Failed to send permission response to tmux session: ${e.message}`);
      }
    } else {
      this.process.stdin.write(response + '\n');
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

  // Get the PID of the process running inside the tmux pane
  getTmuxPanePid() {
    try {
      return parseInt(
        execSync(`tmux display-message -p -t ${this.process.sessionName} '#{pane_pid}'`, {
          encoding: 'utf-8'
        }).trim()
      );
    } catch (e) {
      return null;
    }
  }

  pause() {
    if (this.process && !this.process.killed) {
      if (this.process.tmux) {
        // Send SIGTSTP directly to the tmux pane's process (since exec replaced the shell)
        const pid = this.getTmuxPanePid();
        if (pid) {
          try { process.kill(pid, 'SIGTSTP'); } catch (e) {}
        }
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
        // Send SIGCONT directly to the tmux pane's process
        const pid = this.getTmuxPanePid();
        if (pid) {
          try { process.kill(pid, 'SIGCONT'); } catch (e) {}
        }
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
    this.cleanupTmuxFiles();
  }

  cleanupTmuxFiles() {
    // Remove temporary script, prompt, and output files
    const files = [
      this.getScriptFilePath(),
      this.getPromptFilePath(),
      this.getOutputFilePath(),
      this.getOutputFilePath() + '.stderr',
    ];
    for (const f of files) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }

  updateDbStatus(status) {
    if (status === 'ended') {
      query('UPDATE sessions SET status = $1, ended_at = NOW(), last_activity_at = NOW() WHERE id = $2', [status, this.id])
        .catch(e => console.error('Failed to update session status:', e.message));
    } else {
      query('UPDATE sessions SET status = $1, last_activity_at = NOW() WHERE id = $2', [status, this.id])
        .catch(e => console.error('Failed to update session status:', e.message));
    }
  }

  parseQualityResults(text) {
    const pattern = /QUALITY_RESULT:(\S+):(\w+):(PASS|FAIL)(?::(.*))?/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const [, ruleId, severity, result, details] = match;
      query(
        `INSERT INTO quality_results (session_id, rule_id, rule_name, result, severity, details, timestamp) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [this.id, ruleId, ruleId, result.toLowerCase(), severity, details || null]
      ).catch(() => {});
    }
  }

  async generateSummary() {
    const result = await query('SELECT role, content FROM messages WHERE session_id = $1 ORDER BY timestamp', [this.id]);
    const messages = result.rows;

    if (messages.length === 0) return;

    const assistantMsgs = messages.filter(m => m.role === 'assistant');

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

    const summarizationPrompt = `Analyze this Claude Code session transcript and produce a JSON response with exactly two fields:

1. "summary": A 2-3 sentence summary of what was accomplished, which files were changed, and what branch the work was on.

2. "key_decisions": An array of strings (max 5) listing the most important directives, corrections, or architectural decisions the user made during the session. These are moments where the user steered the work — things like "use TypeScript instead of JavaScript", "don't modify the database schema", "always validate inputs first". Only include clear, explicit directives. If there are none, return an empty array.

Respond with ONLY valid JSON, no markdown fences or other text.

Transcript:
${transcript}`;

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
      if (!err && stdout && stdout.trim().length > 10) {
        try {
          // Try to parse structured JSON response
          const cleaned = stdout.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
          const parsed = JSON.parse(cleaned);
          const summaryText = parsed.summary || stdout.trim();
          const keyDecisions = Array.isArray(parsed.key_decisions) ? parsed.key_decisions : [];
          this.saveSummary(summaryText, JSON.stringify(keyDecisions), filesModified);
        } catch (parseErr) {
          // Claude returned plain text instead of JSON — use it as the summary
          this.saveSummary(stdout.trim(), null, filesModified);
        }
      } else {
        this.saveFallbackSummary(messages, filesModified);
      }
    });
  }

  saveFallbackSummary(messages, filesModified) {
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
    this.saveSummary(parts.join(' '), null, filesModified);
  }

  saveSummary(summaryText, keyActions, filesModified) {
    const filesStr = filesModified instanceof Set
      ? (filesModified.size > 0 ? JSON.stringify([...filesModified]) : null)
      : (filesModified || null);
    query(
      `INSERT INTO session_summaries (session_id, summary, key_actions, files_modified, created_at) VALUES ($1, $2, $3, $4, NOW())`,
      [this.id, summaryText, keyActions || null, filesStr]
    ).catch(e => console.error('Failed to save summary:', e.message));
  }
}

// --- Context Preamble for Session Resume ---

async function buildContextPreamble(sessionId) {
  const sessionResult = await query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  const session = sessionResult.rows[0];
  if (!session) return null;

  const parts = [];

  const summaryResult = await query('SELECT summary FROM session_summaries WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1', [sessionId]);
  const summary = summaryResult.rows[0];
  if (summary) {
    parts.push(`Session summary: ${summary.summary}`);
  }

  const firstMsgResult = await query("SELECT content FROM messages WHERE session_id = $1 AND role = 'user' ORDER BY timestamp ASC LIMIT 1", [sessionId]);
  const firstMessage = firstMsgResult.rows[0];
  if (firstMessage) {
    parts.push(`The original task was: ${firstMessage.content.substring(0, 500)}`);
  }

  const detailsResult = await query('SELECT key_actions, files_modified FROM session_summaries WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1', [sessionId]);
  const summaryDetails = detailsResult.rows[0];

  if (summaryDetails) {
    if (summaryDetails.key_actions) {
      try {
        const decisions = JSON.parse(summaryDetails.key_actions);
        if (Array.isArray(decisions) && decisions.length > 0) {
          parts.push(`Key decisions made:\n${decisions.map(d => `- ${d}`).join('\n')}`);
        }
      } catch (e) {
        parts.push(`Key decisions made: ${summaryDetails.key_actions}`);
      }
    }
    if (summaryDetails.files_modified) {
      try {
        const files = JSON.parse(summaryDetails.files_modified);
        if (files.length > 0) {
          parts.push(`Files modified: ${files.slice(0, 20).join(', ')}`);
        }
      } catch (e) {}
    }
  }

  const recentResult = await query('SELECT role, content FROM messages WHERE session_id = $1 ORDER BY timestamp DESC LIMIT 10', [sessionId]);
  const recentMessages = recentResult.rows;

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
      const cwd = resolvePath(session.working_directory);
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

// Guard against concurrent resume calls for the same session
const resumeInProgress = new Set();

async function resumeSession(sessionId, newMessage) {
  if (resumeInProgress.has(sessionId)) {
    const existing = activeSessions.get(sessionId);
    if (existing) {
      await existing.sendMessage(newMessage);
      return existing;
    }
    return null;
  }

  const alreadyActive = activeSessions.get(sessionId);
  if (alreadyActive) {
    await alreadyActive.sendMessage(newMessage);
    return alreadyActive;
  }

  resumeInProgress.add(sessionId);

  const sessionResult = await query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  const sessionRow = sessionResult.rows[0];
  if (!sessionRow) {
    resumeInProgress.delete(sessionId);
    return null;
  }

  const preamble = await buildContextPreamble(sessionId);

  const session = new SessionProcess(sessionId, {
    workingDirectory: sessionRow.working_directory,
    permissionMode: sessionRow.permission_mode || 'acceptEdits',
    model: sessionRow.model || DEFAULT_MODEL,
    mcpConnections: [],
    tmuxSessionName: null
  });

  session.resuming = true;
  activeSessions.set(sessionId, session);

  await query("UPDATE sessions SET status = 'working', ended_at = NULL, last_activity_at = NOW() WHERE id = $1", [sessionId]);

  session.broadcast({
    type: 'session_resuming',
    sessionId: sessionId,
    timestamp: new Date().toISOString()
  });

  const combinedPrompt = preamble
    ? `${preamble}\n\nUser's new message: ${newMessage}`
    : newMessage;

  await query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ($1, 'user', $2, NOW())", [sessionId, newMessage]);
  await query("UPDATE sessions SET user_message_count = user_message_count + 1, last_activity_at = NOW() WHERE id = $1", [sessionId]);

  session.status = 'working';
  session.updateDbStatus('working');

  session.broadcast({
    type: 'user_message',
    sessionId: sessionId,
    content: newMessage,
    timestamp: new Date().toISOString()
  });

  await session.spawnProcess(combinedPrompt);

  resumeInProgress.delete(sessionId);

  return session;
}

// --- Tmux Session Recovery ---

async function recoverTmuxSessions() {
  if (!tmuxAvailable) return;

  console.log('Recovering tmux sessions...');

  let tmuxSessions = [];
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8'
    }).trim();
    tmuxSessions = output.split('\n').filter(s => s.startsWith('mc-'));
  } catch (e) {
    return;
  }

  if (tmuxSessions.length === 0) {
    console.log('No tmux sessions to recover.');
    return;
  }

  for (const tmuxName of tmuxSessions) {
    const sessionResult = await query('SELECT * FROM sessions WHERE tmux_session_name = $1', [tmuxName]);
    const sessionRow = sessionResult.rows[0];
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
      model: sessionRow.model || DEFAULT_MODEL,
      mcpConnections: [],
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

const VALID_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6'];
const DEFAULT_MODEL = 'claude-opus-4-6';

async function createSession(options = {}) {
  const id = uuidv4();
  const name = options.name || 'New Session';

  if (options.model && !VALID_MODELS.includes(options.model)) {
    throw new Error(`Invalid model "${options.model}". Must be one of: ${VALID_MODELS.join(', ')}`);
  }
  options.model = options.model || DEFAULT_MODEL;

  await query(
    `INSERT INTO sessions (id, name, status, working_directory, branch, permission_mode, model, use_worktree, created_at, last_activity_at)
     VALUES ($1, $2, 'idle', $3, $4, $5, $6, $7, NOW(), NOW())`,
    [id, name, options.workingDirectory || null, options.branch || null, options.permissionMode || 'acceptEdits', options.model || 'claude-opus-4-6', options.useWorktree ? 1 : 0]
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
  tmuxAvailable,
  VALID_MODELS,
  DEFAULT_MODEL
};
