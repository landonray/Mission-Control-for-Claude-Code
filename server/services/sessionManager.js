const { spawn, execSync, execFile, execFileSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const treeKill = require('tree-kill');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { query } = require('../database');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const qualityRunner = require('./qualityRunner');

const activeSessions = new Map();

/**
 * Build a message to send back to the agent when quality rules with
 * send_fail_to_agent fail. Combines all failures into a single directive.
 */
function buildQualityFailureMessage(failures) {
  const sections = failures.map(f => {
    let header = `**${f.ruleName}** failed`;
    if (f.specPath) {
      header += ` (spec: \`${f.specPath}\`)`;
    }
    return `### ${header}\n\n${f.analysis || f.details || 'No details available.'}`;
  });

  return `Quality check failed — you are not done.\n\n${sections.join('\n\n---\n\n')}\n\nContinue working on the issues listed above. Do not ask for permission — address every item, then stop when complete. The checks will run again automatically.`;
}

// Global event bus for broadcasting events that need to reach ALL WebSocket clients
// (not just those subscribed to a specific session)
const globalEvents = new EventEmitter();

// Resolve ~ to home directory (shell and Node spawn don't expand ~ in all contexts)
function resolvePath(p) {
  if (!p) return process.cwd();
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

/**
 * When resuming a worktree session whose directory was cleaned up,
 * attempt to recreate it from the branch. Returns the working directory to use.
 */
async function resolveWorktreeOnResume(sessionRow) {
  let workingDir = sessionRow.working_directory;

  if (!workingDir || fs.existsSync(resolvePath(workingDir))) {
    return workingDir;
  }

  const worktreeMatch = workingDir.match(/^(.+?)\/\.claude\/worktrees\/([^/]+)/);
  if (!worktreeMatch) {
    return workingDir;
  }

  const parentDir = worktreeMatch[1];
  const worktreeName = sessionRow.worktree_name || worktreeMatch[2];
  const branchName = `worktree-${worktreeName}`;

  // Check if branch exists locally
  let branchExists = false;
  try {
    const localResult = execFileSync('git', ['branch', '--list', branchName], {
      cwd: resolvePath(parentDir), encoding: 'utf-8', timeout: 5000,
    });
    branchExists = localResult.trim().length > 0;
  } catch { /* ignore */ }

  // If not local, check remote
  if (!branchExists) {
    try {
      const remoteResult = execFileSync('git', ['branch', '-r', '--list', `origin/${branchName}`], {
        cwd: resolvePath(parentDir), encoding: 'utf-8', timeout: 5000,
      });
      branchExists = remoteResult.trim().length > 0;
    } catch { /* ignore */ }
  }

  if (branchExists) {
    try {
      // Prune stale worktree records before recreation
      execFileSync('git', ['worktree', 'prune'], {
        cwd: resolvePath(parentDir), encoding: 'utf-8', timeout: 5000,
      });
      execFileSync('git', ['worktree', 'add', `.claude/worktrees/${worktreeName}`, branchName], {
        cwd: resolvePath(parentDir), encoding: 'utf-8', timeout: 15000,
      });
      console.log(`[Session ${sessionRow.id.slice(0, 8)}] Recreated worktree at .claude/worktrees/${worktreeName} from branch ${branchName}`);
      return workingDir;
    } catch (e) {
      console.error(`[Session ${sessionRow.id.slice(0, 8)}] Failed to recreate worktree:`, e.message);
    }
  }

  // Branch is gone — fall back to parent and update DB
  if (fs.existsSync(resolvePath(parentDir))) {
    console.log(`[Session ${sessionRow.id.slice(0, 8)}] Branch ${branchName} not found, falling back to project root: ${parentDir}`);
    await query('UPDATE sessions SET working_directory = $1 WHERE id = $2', [parentDir, sessionRow.id]);
    return parentDir;
  }

  return workingDir;
}

// Check if tmux is available on the system
let tmuxAvailable = false;
try {
  execSync('which tmux', { stdio: 'ignore' });
  tmuxAvailable = true;
} catch (e) {
  console.warn('WARNING: tmux not found. Sessions will not survive server restarts.');
}

// Directory where uploaded files are stored
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

// Copy uploaded files into the session's working directory and rewrite
// markdown references so Claude CLI can read them without extra permissions.
function resolveUploadPaths(text, workingDirectory) {
  return text.replace(/\(\/api\/uploads\/([^)]+)\)/g, (match, filename) => {
    const src = path.join(UPLOADS_DIR, filename);
    if (workingDirectory && fs.existsSync(src)) {
      const destDir = path.join(workingDirectory, '.uploads');
      try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {}
      const dest = path.join(destDir, filename);
      try { fs.copyFileSync(src, dest); } catch (e) {}
      return `(${dest})`;
    }
    return `(${src})`;
  });
}

// Directory for tmux output files and launch scripts
const TMUX_OUTPUT_DIR = path.join(__dirname, '..', '..', '.tmux-outputs');
const TMUX_SCRIPTS_DIR = path.join(__dirname, '..', '..', '.tmux-scripts');
if (tmuxAvailable) {
  try { fs.mkdirSync(TMUX_OUTPUT_DIR, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(TMUX_SCRIPTS_DIR, { recursive: true }); } catch (e) {}
}

// File-based logging for AutoName debugging
const AUTONAME_LOG = path.join(__dirname, '..', '..', 'autoname.log');
function autoNameLog(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  fs.appendFileSync(AUTONAME_LOG, line);
  console.log('[AutoName]', ...args);
}

// Use LLM Gateway for auto-naming (avoids Claude CLI stdin/stdout issues)
const { chatCompletion } = require('./llmGateway');

// Generate a short AI-powered session name from the first user message
async function generateSessionName(messageText) {
  try {
    autoNameLog('Generating name for:', messageText.slice(0, 80));
    const text = await chatCompletion({
      model: MODEL_ROLES.fast,
      max_tokens: 30,
      system: 'You are a session naming tool. Your ONLY job is to output a concise 3-6 word title summarizing the topic of the user message. Rules: output ONLY the title, no explanation, no quotes, no punctuation except spaces, no conversational response. Do NOT answer or respond to the message content. If the message is vague, output "General Chat". Examples: "Fix Login Button Styling", "Database Migration Script", "API Rate Limiting Setup".',
      messages: [{ role: 'user', content: messageText }],
    });
    const name = text?.trim() || '';
    autoNameLog('Generated name:', name || '(empty)');
    if (!name) return null;
    const wordCount = name.split(/\s+/).length;
    if (wordCount > 8 || name.length > 60) {
      autoNameLog(`Rejected name (too long: ${wordCount} words, ${name.length} chars)`);
      return null;
    }
    return name;
  } catch (e) {
    autoNameLog('ERROR:', e.message);
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
    this.permissionMode = options.permissionMode || 'auto';
    this.mcpConnections = options.mcpConnections || [];
    this.initialPrompt = options.initialPrompt || null;
    this.useWorktree = options.useWorktree || false;
    this.worktreeReady = !this.useWorktree; // non-worktree sessions are immediately ready
    this.model = options.model || DEFAULT_MODEL;
    this.pendingPermission = null;
    this.errorMessage = null;
    this.messageQueue = [];
    this.cliSessionId = null;
    this.tmuxSessionName = options.tmuxSessionName || null;
    this.outputTail = null; // file watcher for tmux output
    this.resuming = false; // true when restoring context for a resumed session
    this.streamEventHistory = []; // buffered stream events for replay on reconnect
    this.stderrBuffer = ''; // accumulates stderr for error reporting
    this._qualityStopDispatched = false; // guard against duplicate onSessionStop calls
    this.qualityReviewIteration = 0; // tracks quality review loop iterations (max 3)
    this._lastContextRatio = 0; // previous context window usage ratio
    this._compactionDetected = false; // set when context drops significantly (compaction happened)
    this._currentAssistantMsgId = null; // DB row id for the current assistant message
    this._currentAssistantCliMsgId = null; // CLI message ID (msg_xxx) to detect same vs new message
    this._processedToolUseIds = new Set(); // track which tool_use blocks we've already processed
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

    // --permission-mode is ignored on --resume, so use --dangerously-skip-permissions
    // for bypassPermissions/auto modes to ensure writes work on resumed sessions.
    // For plan mode on resumed sessions, we inject a prompt prefix instead.
    const mode = this.permissionMode || 'auto';
    if (mode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else if (mode === 'auto' || mode === 'acceptEdits') {
      args.push('--dangerously-skip-permissions');
      // Still pass permission-mode for new sessions (non-resume)
      args.push('--permission-mode', mode);
    } else {
      args.push('--permission-mode', mode);
    }

    // Model selection
    if (this.model) {
      args.push('--model', this.model);
    }

    const mcpConfig = await this.buildMcpConfig();
    if (mcpConfig) {
      args.push('--mcp-config', JSON.stringify(mcpConfig));
    }

    // On resumed sessions, --permission-mode plan is ignored by the CLI.
    // Enforce plan mode via prompt prefix so Claude won't make changes.
    let finalPrompt = prompt;
    if (mode === 'plan' && this.cliSessionId) {
      finalPrompt = `IMPORTANT: You are in plan/read-only mode. Do NOT edit, write, or create any files. Do not use the Edit, Write, or NotebookEdit tools. Only read, search, analyze, and discuss.\n\n${prompt}`;
    }

    args.push(resolveUploadPaths(finalPrompt, this.workingDirectory));

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
    // Convert relative upload URLs to absolute file paths so Claude can read them.
    const promptFile = this.getPromptFilePath();
    fs.writeFileSync(promptFile, resolveUploadPaths(prompt, this.workingDirectory), { mode: 0o600 });

    // Write a self-contained launch script. No user content is embedded
    // in the script — the prompt is read from the prompt file at runtime.
    const cwd = this.workingDirectory;
    const scriptPath = this.getScriptFilePath();
    const cliArgs = args.slice(0, -1); // everything except the final prompt arg

    const scriptLines = [
      '#!/usr/bin/env bash',
      '# Source shell profile to inherit PATH and tool configs (gh, git, etc.)',
      '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null',
      '[ -f "$HOME/.bash_profile" ] && source "$HOME/.bash_profile" 2>/dev/null',
      '',
      `OUTPUT_FILE=${JSON.stringify(outputFile)}`,
      `PROMPT_FILE=${JSON.stringify(promptFile)}`,
      '',
      '# Ensure the exit sentinel is written even when interrupted (Ctrl+C / SIGINT)',
      'on_interrupt() { echo \'{"type":"__process_exited__"}\' >> "$OUTPUT_FILE"; exit 130; }',
      'trap on_interrupt INT TERM',
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

      // Create tmux session with a clean environment — only pass through safe,
      // system-level vars. This prevents Command Center's secrets (DATABASE_URL,
      // API keys, etc.) from leaking into child projects via process inheritance.
      const ALLOWED_ENV_KEYS = [
        'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'LC_ALL',
        'LC_CTYPE', 'LOGNAME', 'DISPLAY', 'SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR',
        'EDITOR', 'VISUAL', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
        // Node/npm needs
        'NODE_ENV', 'NVM_DIR', 'NVM_BIN', 'NVM_INC',
        // macOS specifics
        'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY',
        '__CF_USER_TEXT_ENCODING', 'Apple_PubSub_Socket_Render',
      ];
      const cleanEnv = {};
      for (const key of ALLOWED_ENV_KEYS) {
        if (process.env[key] !== undefined) cleanEnv[key] = process.env[key];
      }

      execSync(`tmux new-session -d -s ${tmuxName} "bash '${scriptPath}'"`, {
        stdio: 'ignore',
        env: cleanEnv
      });

      // Verify the tmux session is actually running (it can exit immediately on failure
      // while still returning exit code 0)
      try {
        execSync(`tmux has-session -t ${tmuxName} 2>/dev/null`);
      } catch (e) {
        console.error(`[Session ${this.id.slice(0, 8)}] Tmux session ${tmuxName} exited immediately, falling back to direct spawn`);
        try { fs.unlinkSync(scriptPath); } catch (e2) {}
        try { fs.unlinkSync(promptFile); } catch (e2) {}
        await this.spawnDirectProcess(prompt);
        return;
      }

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
    // Cancel the result safety-net timer — normal exit path is firing
    if (this._resultIdleTimer) {
      clearTimeout(this._resultIdleTimer);
      this._resultIdleTimer = null;
    }
    this.stopOutputTail();
    this.process = null;
    this.pendingPermission = null;

    const wasInterrupted = this._interrupted;
    this._interrupted = false;

    if (wasInterrupted) {
      // User interrupted — skip quality checks, go straight to idle/queue drain
      console.log(`[Session ${this.id.slice(0, 8)}] Skipping quality checks (user interrupted)`);
      this.transitionToIdle();
    } else if (this.status !== 'error') {
      // Stay in 'reviewing' while quality checks run so the card stays green
      this.status = 'reviewing';
      this.updateDbStatus('reviewing');
      this.broadcast({
        type: 'session_status',
        sessionId: this.id,
        status: 'reviewing',
        timestamp: new Date().toISOString()
      });
      // Run Stop quality checks (--print mode doesn't fire Stop hooks)
      if (!this._qualityStopDispatched) {
        this._qualityStopDispatched = true;
        qualityRunner.onSessionStop(this.id, this.broadcast.bind(this)).then(failures => {
          if (failures && failures.length > 0) {
            if (this.qualityReviewIteration >= 3) {
              console.log(`[QualityRunner] ${failures.length} rule(s) still failing for session ${this.id.slice(0, 8)} but reached max iterations (3) — stopping review loop`);
              this.transitionToIdle();
              return;
            }
            this.qualityReviewIteration++;
            const message = buildQualityFailureMessage(failures);
            console.log(`[QualityRunner] ${failures.length} rule(s) failed with send_fail_to_agent for session ${this.id.slice(0, 8)} — sending agent back to work (iteration ${this.qualityReviewIteration}/3)`);
            setTimeout(() => this.sendMessage(message, null, { isQualityReview: true }), 500);
          } else {
            this.transitionToIdle();
          }
        }).catch(e => {
          console.error('[QualityRunner] onSessionStop error:', e.message);
          this.transitionToIdle();
        });
      } else {
        this.transitionToIdle();
      }
    }

    // Process queued messages
    if (this.messageQueue.length > 0) {
      const nextMsg = this.messageQueue.shift();
      this.broadcast({ type: 'message_dequeued', sessionId: this.id, content: nextMsg, timestamp: new Date().toISOString() });
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
      // Filter out the stdin pipe warning — prompt is passed as CLI argument, not via stdin
      if (text.includes('no stdin data received')) return;
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
      // Cancel the result safety-net timer — normal exit path is firing
      if (this._resultIdleTimer) {
        clearTimeout(this._resultIdleTimer);
        this._resultIdleTimer = null;
      }
      this.process = null;
      this.pendingPermission = null;

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
        // Stay in 'reviewing' while quality checks run so the card stays green
        this.status = 'reviewing';
        this.updateDbStatus('reviewing');
        this.broadcast({
          type: 'session_status',
          sessionId: this.id,
          status: 'reviewing',
          timestamp: new Date().toISOString()
        });
        // Run Stop quality checks (--print mode doesn't fire Stop hooks)
        if (!this._qualityStopDispatched) {
          this._qualityStopDispatched = true;
          qualityRunner.onSessionStop(this.id, this.broadcast.bind(this)).then(failures => {
            if (failures && failures.length > 0) {
              if (this.qualityReviewIteration >= 3) {
                console.log(`[QualityRunner] ${failures.length} rule(s) still failing for session ${this.id.slice(0, 8)} but reached max iterations (3) — stopping review loop`);
                this.transitionToIdle();
                return;
              }
              this.qualityReviewIteration++;
              const message = buildQualityFailureMessage(failures);
              console.log(`[QualityRunner] ${failures.length} rule(s) failed with send_fail_to_agent for session ${this.id.slice(0, 8)} — sending agent back to work (iteration ${this.qualityReviewIteration}/3)`);
              setTimeout(() => this.sendMessage(message, null, { isQualityReview: true }), 500);
            } else {
              this.transitionToIdle();
            }
          }).catch(e => {
            console.error('[QualityRunner] onSessionStop error:', e.message);
            this.transitionToIdle();
          });
        } else {
          this.transitionToIdle();
        }
      }

      // Drain message queue (matches tmux behavior)
      if (this.messageQueue.length > 0) {
        const nextMsg = this.messageQueue.shift();
        this.broadcast({ type: 'message_dequeued', sessionId: this.id, content: nextMsg, timestamp: new Date().toISOString() });
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
      // Drain message queue so queued messages aren't silently lost
      if (this.messageQueue.length > 0) {
        const nextMsg = this.messageQueue.shift();
        this.broadcast({ type: 'message_dequeued', sessionId: this.id, content: nextMsg, timestamp: new Date().toISOString() });
        setTimeout(() => this.sendMessage(nextMsg), 100);
      }
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
    // First try matching a full URL (http://localhost:PORT)
    let match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i);
    let url;

    if (match) {
      url = match[0].replace('0.0.0.0', 'localhost');
    } else {
      // Fallback: match port-only patterns from common dev server output
      // e.g. "localhost:5211", "port 5211", "Port: 5211", "on port 3000"
      const portMatch = text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})/i)
        || text.match(/(?:on |listening on |started on |running on |port[: ]+)(\d{4,5})\b/i);
      if (!portMatch) return;
      url = `http://localhost:${portMatch[1]}`;
    }

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

    const streamMsg = {
      type: 'stream_event',
      sessionId: this.id,
      event: event,
      status: this.status,
      timestamp: new Date().toISOString()
    };
    this.streamEventHistory.push(event);
    this.broadcast(streamMsg);

    // Persist stream event to DB for CLI history on reload
    if (event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'assistant' || event.type === 'user' || event.type === 'system' || event.type === 'result') {
      query(
        `INSERT INTO stream_events (session_id, event_type, event_data, timestamp) VALUES ($1, $2, $3, NOW())`,
        [this.id, event.type, JSON.stringify(event)]
      ).catch(e => console.error('Failed to persist stream event:', e.message));
    }
  }

  async _processStreamEventAsync(event) {
    switch (event.type) {
      case 'assistant':
        this.status = 'working';
        this.updateDbStatus('working');
        if (event.message) {
          // Extract context usage from assistant message usage data
          if (event.message.usage) {
            await this._updateContextUsage(event.message.usage);
          }

          let content;
          if (typeof event.message === 'string') {
            content = event.message;
          } else if (event.message.content && Array.isArray(event.message.content)) {
            content = event.message.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('\n');

            // Process tool_use blocks for diff stats and quality checks.
            // Only process blocks we haven't seen before (each assistant event
            // includes ALL content blocks, not just new ones).
            let totalAdded = 0, totalRemoved = 0;
            for (const block of event.message.content) {
              if (block.type === 'tool_use') {
                // Skip blocks we've already processed in a prior assistant event
                if (block.id && this._processedToolUseIds.has(block.id)) continue;
                if (block.id) this._processedToolUseIds.add(block.id);

                const toolName = block.name || 'unknown';
                const input = block.input || {};

                if ((toolName === 'Edit' || toolName === 'edit') && input.old_string != null && input.new_string != null) {
                  totalRemoved += input.old_string.split('\n').length;
                  totalAdded += input.new_string.split('\n').length;
                } else if ((toolName === 'Write' || toolName === 'write') && input.content != null) {
                  totalAdded += input.content.split('\n').length;
                }

                qualityRunner.onToolUse(this.id, block.name, block.input, this.broadcast.bind(this)).then(failures => {
                  if (failures && failures.length > 0) {
                    const message = buildQualityFailureMessage(failures);
                    console.log(`[QualityRunner] ${failures.length} rule(s) failed with send_fail_to_agent (onToolUse) for session ${this.id.slice(0, 8)} — sending message to agent`);
                    setTimeout(() => this.sendMessage(message, null, { isQualityReview: true }), 500);
                  }
                }).catch(e =>
                  console.error('[QualityRunner] onToolUse error:', e.message));
              }
            }
            if (totalAdded > 0 || totalRemoved > 0) {
              await query(
                `UPDATE sessions SET lines_added = lines_added + $1, lines_removed = lines_removed + $2 WHERE id = $3`,
                [totalAdded, totalRemoved, this.id]
              );
            }
          } else {
            content = JSON.stringify(event.message);
          }
          if (content) {
            this.detectDevServerUrl(content);
            // Claude CLI emits separate assistant events per content block — each
            // event has its OWN blocks (text, tool_use, thinking), NOT accumulated.
            // Events sharing the same message ID are part of the same turn.
            // We use the message ID to dedup: UPDATE if same msg, INSERT if new msg.
            const msgId = event.message?.id || null;

            if (msgId && msgId === this._currentAssistantCliMsgId && this._currentAssistantMsgId) {
              // Same CLI message — update to append/replace text
              await query(
                `UPDATE messages SET content = $1 WHERE id = $2`,
                [content, this._currentAssistantMsgId]
              );
              await query(
                `UPDATE sessions SET last_action_summary = $1, last_activity_at = NOW() WHERE id = $2`,
                [content.substring(0, 200), this.id]
              );
            } else {
              // New CLI message — insert a new row
              const result = await query(
                `INSERT INTO messages (session_id, role, content, timestamp) VALUES ($1, 'assistant', $2, NOW()) RETURNING id`,
                [this.id, content]
              );
              this._currentAssistantMsgId = result.rows[0].id;
              this._currentAssistantCliMsgId = msgId;
              await query(
                `UPDATE sessions SET assistant_message_count = assistant_message_count + 1, last_action_summary = $1, last_activity_at = NOW() WHERE id = $2`,
                [content.substring(0, 200), this.id]
              );
            }
          }
        }
        break;

      case 'tool_result':
        // tool_result doesn't need to reset anything — we track by CLI message ID
        // (msg_xxx) which changes naturally when a new assistant turn begins.
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
          // When --worktree is used, Claude CLI creates a worktree and reports
          // the actual cwd in the init event. Update our working directory so
          // the files panel and git operations point at the worktree, not main.
          if (event.cwd && event.cwd !== this.workingDirectory) {
            this.workingDirectory = event.cwd;
            this.worktreeReady = true;
            // Extract worktree_name from the path if this is a worktree session
            const wtMatch = event.cwd.match(/\/\.claude\/worktrees\/([^/]+)/);
            if (wtMatch) {
              query('UPDATE sessions SET working_directory = $1, worktree_name = $2 WHERE id = $3', [event.cwd, wtMatch[1], this.id])
                .catch(e => console.error('Failed to update working directory:', e.message));
            } else {
              query('UPDATE sessions SET working_directory = $1 WHERE id = $2', [event.cwd, this.id])
                .catch(e => console.error('Failed to update working directory:', e.message));
            }
          }
        }
        // Extract quality results from hook response output
        if (event.subtype === 'hook_response') {
          const hookOutput = event.stdout || event.output || '';
          this.parseQualityResults(hookOutput);
        }
        break;

      case 'result':
        // The 'result' event means Claude finished its turn. For direct processes,
        // the close handler fires almost immediately. For tmux, the __process_exited__
        // sentinel should follow. But if it's missed (race condition, file tail stopped),
        // the session gets permanently stuck in 'working'. Schedule a safety-net
        // transition to idle that gets cancelled if the normal exit path fires first.
        if (this._resultIdleTimer) clearTimeout(this._resultIdleTimer);
        this._resultIdleTimer = setTimeout(() => {
          this._resultIdleTimer = null;
          if (this.status === 'working') {
            console.log(`[Session ${this.id.slice(0, 8)}] Result safety-net: transitioning to idle (exit event was missed)`);
            // For tmux sessions where the process already exited, clean up
            if (this.process && this.process.tmux) {
              this.handleTmuxProcessExit();
            } else if (!this.process) {
              // Process already gone but status never transitioned
              this.status = 'idle';
              this.updateDbStatus('idle');
              this.broadcast({
                type: 'session_status',
                sessionId: this.id,
                status: 'idle',
                timestamp: new Date().toISOString()
              });
              if (this.messageQueue.length > 0) {
                const nextMsg = this.messageQueue.shift();
                this.broadcast({ type: 'message_dequeued', sessionId: this.id, content: nextMsg, timestamp: new Date().toISOString() });
                setTimeout(() => this.sendMessage(nextMsg), 100);
              }
            }
          }
        }, 5000);
        break;
    }
  }

  async _updateContextUsage(usage) {
    // input_tokens + cache_read + cache_creation = total prompt size for this API call
    const promptTokens = (usage.input_tokens || 0)
      + (usage.cache_read_input_tokens || 0)
      + (usage.cache_creation_input_tokens || 0);
    if (promptTokens === 0) return;
    const maxTokens = 200000;
    const usageRatio = Math.min(promptTokens / maxTokens, 1.0);

    // Detect compaction: context usage drops significantly (e.g. 0.7 → 0.2)
    if (this._lastContextRatio >= 0.4 && usageRatio < this._lastContextRatio * 0.6) {
      console.log(`[Compaction] Detected for session ${this.id.slice(0,8)}: ${Math.round(this._lastContextRatio * 100)}% → ${Math.round(usageRatio * 100)}%`);
      this._compactionDetected = true;
    }
    this._lastContextRatio = usageRatio;

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

  async sendMessage(text, attachments = null, { isQualityReview = false } = {}) {
    // Reset quality review iteration counter when a user sends a message manually
    if (!isQualityReview) {
      this.qualityReviewIteration = 0;
    }
    // New user message means next assistant event starts a completely fresh turn
    this._currentAssistantMsgId = null;
    this._currentAssistantCliMsgId = null;
    this._processedToolUseIds = new Set();

    if (this.process && this.status === 'working') {
      // A process is already running — queue the message but still show it in the UI
      this.messageQueue.push(text);

      // Insert into DB and broadcast so the user sees their message immediately
      if (attachments) {
        await query(
          `INSERT INTO messages (session_id, role, content, attachments, timestamp) VALUES ($1, 'user', $2, $3, NOW())`,
          [this.id, text, JSON.stringify(attachments)]
        );
      } else {
        await query(
          `INSERT INTO messages (session_id, role, content, timestamp) VALUES ($1, 'user', $2, NOW())`,
          [this.id, text]
        );
      }
      await query(
        `UPDATE sessions SET user_message_count = user_message_count + 1, last_activity_at = NOW() WHERE id = $1`,
        [this.id]
      );
      this.broadcast({
        type: 'user_message',
        sessionId: this.id,
        content: text,
        attachments: attachments || null,
        queued: true,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Check if this is the first user message — trigger AI name generation
    const msgCountResult = await query('SELECT user_message_count FROM sessions WHERE id = $1', [this.id]);
    const msgCount = msgCountResult.rows[0];
    if (msgCount && msgCount.user_message_count === 0) {
      // Set has_spec flag if the initial prompt includes a non-image attachment
      if (attachments && Array.isArray(attachments) && attachments.some(a => !a.isImage)) {
        this.hasSpec = true;
        query('UPDATE sessions SET has_spec = 1 WHERE id = $1', [this.id])
          .catch(e => console.error(`[SessionManager] Failed to set has_spec for ${this.id.slice(0,8)}:`, e.message));
      }
      generateSessionName(text).then(async (name) => {
        if (!name) {
          autoNameLog(`No name generated for session ${this.id.slice(0,8)}`);
          return;
        }
        const currentResult = await query('SELECT name, working_directory FROM sessions WHERE id = $1', [this.id]);
        const currentSession = currentResult.rows[0];
        if (!currentSession) {
          autoNameLog(`Session ${this.id.slice(0,8)} not found in DB`);
          return;
        }
        const wd = currentSession.working_directory || '';
        const wdBasename = wd ? path.basename(wd) : null;
        // For worktree sessions, the session name may match the project root (e.g. "Command Center")
        // while wdBasename is the worktree folder (e.g. "noble-forging-torvalds")
        const worktreeMatch = wd.includes('.claude/worktrees/') ? wd.match(/^(.+?)\/\.claude\/worktrees\//) : null;
        const projectBasename = worktreeMatch ? path.basename(worktreeMatch[1]) : null;
        const isDefaultName = (
          currentSession.name === 'New Session' ||
          (wdBasename && currentSession.name === wdBasename) ||
          (projectBasename && currentSession.name === projectBasename)
        );
        autoNameLog(`Session ${this.id.slice(0,8)}: current="${currentSession.name}", wdBasename="${wdBasename}", projectBasename="${projectBasename}", isDefault=${isDefaultName}, newName="${name}"`);
        if (isDefaultName) {
          await query('UPDATE sessions SET name = $1 WHERE id = $2', [name, this.id]);
          const event = {
            type: 'session_name_updated',
            sessionId: this.id,
            name,
            timestamp: new Date().toISOString()
          };
          // Broadcast to session-specific listeners (subscribed clients)
          this.broadcast(event);
          // ALSO broadcast globally so ALL connected clients update their sidebar
          // This ensures the name reaches clients even if no one is subscribed to this session
          globalEvents.emit('session_name_updated', event);
          autoNameLog(`Session ${this.id.slice(0,8)} renamed to "${name}" and broadcast`);
        } else {
          autoNameLog(`Session ${this.id.slice(0,8)} skipped — name "${currentSession.name}" is not default`);
        }
      }).catch(e => autoNameLog('Session name generation error:', e.message));
    }

    console.log(`sendMessage: inserting message for session ${this.id}, hasAttachments=${!!attachments}`);
    try {
      if (attachments) {
        await query(
          `INSERT INTO messages (session_id, role, content, attachments, timestamp) VALUES ($1, 'user', $2, $3, NOW())`,
          [this.id, text, JSON.stringify(attachments)]
        );
      } else {
        await query(
          `INSERT INTO messages (session_id, role, content, timestamp) VALUES ($1, 'user', $2, NOW())`,
          [this.id, text]
        );
      }
      console.log(`sendMessage: message inserted successfully for session ${this.id}`);
    } catch (dbErr) {
      console.error(`sendMessage: FAILED to insert message for session ${this.id}:`, dbErr.message);
      // Check if session exists
      const check = await query('SELECT id FROM sessions WHERE id = $1', [this.id]);
      console.error(`sendMessage: session exists in DB: ${check.rows.length > 0}`);
      throw dbErr;
    }

    await query(
      `UPDATE sessions SET user_message_count = user_message_count + 1, last_activity_at = NOW() WHERE id = $1`,
      [this.id]
    );

    // Clear stale error/permission state from previous process failures
    this.errorMessage = null;
    this.pendingPermission = null;
    this._qualityStopDispatched = false; // reset for the new work cycle

    this.status = 'working';
    this.updateDbStatus('working');

    this.broadcast({
      type: 'session_status',
      sessionId: this.id,
      status: 'working',
      errorMessage: null,
      timestamp: new Date().toISOString()
    });

    this.broadcast({
      type: 'user_message',
      sessionId: this.id,
      content: text,
      attachments: attachments || null,
      timestamp: new Date().toISOString()
    });

    // If compaction was detected (context usage dropped significantly), prepend
    // the full conversation history so Claude regains context that was lost.
    // This takes priority over the resume preamble since it's more complete.
    let prompt = text;
    if (this._compactionDetected) {
      this._compactionDetected = false;
      console.log(`[Compaction] Injecting conversation history for session ${this.id.slice(0,8)}`);
      try {
        const compactionPreamble = await buildCompactionPreamble(this.id);
        if (compactionPreamble) {
          prompt = `${compactionPreamble}\n\nUser's new message: ${text}`;
        }
      } catch (e) {
        console.error(`[Compaction] Failed to build preamble for session ${this.id.slice(0,8)}:`, e.message);
      }
    } else if (!this.cliSessionId && msgCount && msgCount.user_message_count > 0) {
      // No cliSessionId and prior messages means this is a fresh Claude CLI
      // invocation with no conversation history (e.g. after server restart /
      // tmux recovery). Build a context preamble so Claude knows what happened.
      this.broadcast({
        type: 'session_resuming',
        sessionId: this.id,
        timestamp: new Date().toISOString()
      });
      const preamble = await buildContextPreamble(this.id);
      if (preamble) {
        prompt = `${preamble}\n\nUser's new message: ${text}`;
      }
    }

    await this.spawnProcess(prompt);
  }

  /**
   * Delete a queued message that hasn't been processed yet.
   * Returns true if the message was found and removed, false otherwise.
   */
  deleteQueuedMessage(content) {
    const idx = this.messageQueue.lastIndexOf(content);
    if (idx === -1) return false;

    this.messageQueue.splice(idx, 1);

    // Delete only the most recent matching message from DB (not all with same content)
    query(
      'DELETE FROM messages WHERE id = (SELECT id FROM messages WHERE session_id = $1 AND role = $2 AND content = $3 ORDER BY timestamp DESC LIMIT 1)',
      [this.id, 'user', content]
    ).catch(e => console.error('[Session] Error deleting queued message from DB:', e.message));

    // Update message count
    query(
      'UPDATE sessions SET user_message_count = GREATEST(user_message_count - 1, 0) WHERE id = $1',
      [this.id]
    ).catch(e => console.error('[Session] Error updating message count:', e.message));

    // Broadcast deletion so all connected clients remove it
    this.broadcast({
      type: 'message_deleted',
      sessionId: this.id,
      content,
      timestamp: new Date().toISOString()
    });

    console.log(`[Session ${this.id.slice(0, 8)}] Deleted queued message: "${content.slice(0, 50)}..."`);
    return true;
  }

  /**
   * Interrupt the running Claude session by sending Escape via tmux.
   * The existing queue-drain logic will pick up any queued messages
   * once the session transitions to idle.
   * Returns true if Escape was sent, false otherwise.
   */
  interrupt() {
    if (this.status !== 'working') return false;
    if (!this.process || !this.process.tmux) return false;

    try {
      this._interrupted = true;
      execSync(`tmux send-keys -t ${this.process.sessionName} C-c`, {
        stdio: 'ignore',
      });
      console.log(`[Session ${this.id.slice(0, 8)}] Interrupted via SIGINT (Ctrl+C)`);
      return true;
    } catch (e) {
      this._interrupted = false;
      console.error(`[Session ${this.id.slice(0, 8)}] Failed to send interrupt: ${e.message}`);
      return false;
    }
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

    // Fire-and-forget: trigger eval run on session end
    this._triggerEvalsOnEnd().catch(err => {
      console.error(`[Evals] Failed to trigger evals on session end:`, err.message);
    });
  }

  async _triggerEvalsOnEnd() {
    try {
      const result = await query('SELECT project_id FROM sessions WHERE id = $1', [this.id]);
      const projectId = result.rows[0]?.project_id;
      if (!projectId) return;

      const { triggerEvalRun } = require('../routes/evals');
      triggerEvalRun(projectId, 'session_end', this.id, this.tmuxSessionName);
    } catch (err) {
      console.error(`[Evals] _triggerEvalsOnEnd error:`, err.message);
    }
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

  transitionToIdle() {
    this.status = 'idle';
    this.updateDbStatus('idle');
    this.broadcast({
      type: 'session_status',
      sessionId: this.id,
      status: 'idle',
      timestamp: new Date().toISOString()
    });
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

/**
 * Build a preamble that re-injects the full conversation history after
 * compaction is detected. Unlike buildContextPreamble (which is for server
 * restarts and uses summaries + truncated messages), this pulls the complete
 * user/assistant dialogue so Claude regains all context that was lost to
 * compaction.
 */
async function buildCompactionPreamble(sessionId) {
  const result = await query(
    `SELECT role, content, timestamp FROM messages WHERE session_id = $1 ORDER BY timestamp ASC`,
    [sessionId]
  );
  if (result.rows.length === 0) return null;

  const ROLE_LABELS = { user: 'User', assistant: 'Assistant', system: 'System' };
  // Cap at ~50k chars to avoid re-filling the context window.
  // Prioritize recent messages — build from the end and stop when we hit the limit.
  const MAX_CHARS = 50000;
  const lines = [];
  let totalChars = 0;
  for (let i = result.rows.length - 1; i >= 0; i--) {
    const m = result.rows[i];
    const label = ROLE_LABELS[m.role] || m.role;
    const line = `${label}: ${m.content}`;
    if (totalChars + line.length > MAX_CHARS && lines.length > 0) break;
    lines.unshift(line);
    totalChars += line.length;
  }

  const conversation = lines.join('\n\n');
  const truncated = lines.length < result.rows.length
    ? ` (showing ${lines.length} of ${result.rows.length} messages — oldest messages trimmed to fit)`
    : '';

  return `CONTEXT RECOVERY — COMPACTION DETECTED: Your context was just compacted and you may have lost conversation history. Here is the conversation so far${truncated}:\n\n${conversation}\n\nThe user's new message follows. Continue naturally — do not acknowledge this recovery unless the user asks about it.`;
}

// --- Resume a closed session ---

// Guard against concurrent resume calls for the same session
const resumeInProgress = new Set();

async function resumeSession(sessionId, newMessage, { listener } = {}) {
  if (resumeInProgress.has(sessionId)) {
    const existing = activeSessions.get(sessionId);
    if (existing) {
      if (listener) existing.addListener(listener);
      await existing.sendMessage(newMessage);
      return existing;
    }
    return null;
  }

  const alreadyActive = activeSessions.get(sessionId);
  if (alreadyActive) {
    if (listener) alreadyActive.addListener(listener);
    await alreadyActive.sendMessage(newMessage);
    return alreadyActive;
  }

  resumeInProgress.add(sessionId);

  try {
    const sessionResult = await query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    const sessionRow = sessionResult.rows[0];
    if (!sessionRow) {
      return null;
    }

    const preamble = await buildContextPreamble(sessionId);

    // If the worktree directory was cleaned up, try to recreate it from the branch.
    // Only falls back to parent dir (and updates DB) if the branch is also gone.
    const workingDir = await resolveWorktreeOnResume(sessionRow);

    const session = new SessionProcess(sessionId, {
      workingDirectory: workingDir,
      permissionMode: sessionRow.permission_mode || 'auto',
      model: sessionRow.model || DEFAULT_MODEL,
      mcpConnections: [],
      tmuxSessionName: sessionRow.tmux_session_name || null
    });

    session.resuming = true;
    activeSessions.set(sessionId, session);

    // Attach listener before any broadcasts so the client doesn't miss events
    if (listener) {
      session.addListener(listener);
    }

    await query("UPDATE sessions SET status = 'working', ended_at = NULL, last_activity_at = NOW() WHERE id = $1", [sessionId]);

    // Replay stream event history from DB so the CLI panel's dedup mechanism works.
    // Without this, the client never receives stream_events_history (because the session
    // wasn't in memory when subscribe_session ran), and dbEventCountRef blocks live events.
    const dbStreamEvents = await query(
      'SELECT event_data FROM stream_events WHERE session_id = $1 ORDER BY timestamp ASC',
      [sessionId]
    );
    if (dbStreamEvents.rows.length > 0) {
      const events = dbStreamEvents.rows.map(r => JSON.parse(r.event_data));
      session.streamEventHistory = events;
      session.broadcast({
        type: 'stream_events_history',
        sessionId: sessionId,
        events: events,
        timestamp: new Date().toISOString()
      });
    }

    session.broadcast({
      type: 'session_resuming',
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    });

    const combinedPrompt = preamble
      ? `${preamble}\n\nUser's new message: ${newMessage}`
      : newMessage;

    // Trigger auto-naming if this is the first user message (session lost memory due to server restart)
    if (sessionRow.user_message_count === 0) {
      const wd = sessionRow.working_directory || '';
      const wdBasename = wd ? path.basename(wd) : null;
      const worktreeMatch = wd.includes('.claude/worktrees/') ? wd.match(/^(.+?)\/\.claude\/worktrees\//) : null;
      const projectBasename = worktreeMatch ? path.basename(worktreeMatch[1]) : null;
      const isDefaultName = (
        sessionRow.name === 'New Session' ||
        (wdBasename && sessionRow.name === wdBasename) ||
        (projectBasename && sessionRow.name === projectBasename)
      );
      if (isDefaultName) {
        generateSessionName(newMessage).then(async (name) => {
          if (!name) {
            autoNameLog(`No name generated for resumed session ${sessionId.slice(0,8)}`);
            return;
          }
          await query('UPDATE sessions SET name = $1 WHERE id = $2', [name, sessionId]);
          const event = {
            type: 'session_name_updated',
            sessionId,
            name,
            timestamp: new Date().toISOString()
          };
          session.broadcast(event);
          globalEvents.emit('session_name_updated', event);
          autoNameLog(`Resumed session ${sessionId.slice(0,8)} renamed to "${name}" and broadcast`);
        }).catch(e => autoNameLog('Resumed session name generation error:', e.message));
      }
    }

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

    return session;
  } finally {
    resumeInProgress.delete(sessionId);
  }
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
      permissionMode: sessionRow.permission_mode || 'auto',
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

const { VALID_MODELS, DEFAULT_MODEL, MODEL_ROLES, isValidModel } = require('../config/models');

async function createSession(options = {}) {
  const id = uuidv4();
  const name = options.name || 'New Session';

  if (options.model && !isValidModel(options.model)) {
    throw new Error(`Invalid model "${options.model}". Must be one of: ${VALID_MODELS.join(', ')}`);
  }
  options.model = options.model || DEFAULT_MODEL;

  await query(
    `INSERT INTO sessions (id, name, status, working_directory, branch, permission_mode, model, use_worktree, created_at, last_activity_at)
     VALUES ($1, $2, 'idle', $3, $4, $5, $6, $7, NOW(), NOW())`,
    [id, name, options.workingDirectory || null, options.branch || null, options.permissionMode || 'auto', options.model || DEFAULT_MODEL, options.useWorktree ? 1 : 0]
  );

  // Link session to project if a .mission-control.yaml is found
  try {
    if (options.workingDirectory) {
      const { resolveProject } = await import('./projectDiscovery.js');
      const project = await resolveProject(options.workingDirectory);
      if (project) {
        await query('UPDATE sessions SET project_id = $1 WHERE id = $2', [project.id, id]);
      }
    }
  } catch (err) {
    // Non-fatal: project linking is best-effort
    console.warn('Failed to link session to project:', err.message);
  }

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
    pendingPermission: session.pendingPermission,
    worktreeReady: session.worktreeReady
  }));
}

async function endSession(id) {
  const session = activeSessions.get(id);
  if (session) {
    await session.end();
    activeSessions.delete(id);
    return;
  }

  // Session not in memory — update DB directly and kill any tmux session
  const result = await query('SELECT id, tmux_session_name, status FROM sessions WHERE id = $1', [id]);
  const dbSession = result.rows[0];
  if (!dbSession) {
    throw new Error('Session not found');
  }
  if (dbSession.status === 'ended') {
    return; // Already ended
  }

  // Kill tmux session if one exists
  if (dbSession.tmux_session_name) {
    try {
      execSync(`tmux kill-session -t ${dbSession.tmux_session_name}`, { stdio: 'ignore' });
    } catch (e) {}
  }

  await query("UPDATE sessions SET status = 'ended', ended_at = NOW(), last_activity_at = NOW() WHERE id = $1", [id]);
}

module.exports = {
  createSession,
  getSession,
  getAllActiveSessions,
  endSession,
  resumeSession,
  recoverTmuxSessions,
  activeSessions,
  globalEvents,
  tmuxAvailable,
};
