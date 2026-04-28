require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { initializeDb } = require('./database');
const { setupWebSocket } = require('./websocket');
const { registerBuiltInFields } = require('./services/mergeFields');

registerBuiltInFields();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/files', require('./routes/files'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/mcp', require('./routes/mcp'));
app.use('/api/history', require('./routes/history'));
app.use('/api/quality', require('./routes/quality'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/slash-commands', require('./routes/slashCommands'));
app.use('/api/evals', require('./routes/evals'));
app.use('/api/merge-fields', require('./routes/mergeFields'));
app.use('/api/transcribe', require('./routes/transcribe'));
app.use('/api/mcp-tokens', require('./routes/mcpTokens'));
app.use('/api/planning', require('./routes/planning'));
app.use('/api/pipelines', require('./routes/pipelines'));
app.use('/api/decisions', require('./routes/decisions'));
app.use('/mcp', require('./routes/mcpServer'));

// Model config
const { MODEL_OPTIONS, DEFAULT_MODEL } = require('./config/models');
const { query } = require('./database');
app.get('/api/models', async (_req, res) => {
  let defaultEffort = 'high';
  try {
    const row = (await query('SELECT default_effort FROM app_settings WHERE id = 1')).rows[0];
    if (row && row.default_effort) defaultEffort = row.default_effort;
  } catch (_) { /* fall through to high */ }
  res.json({
    models: MODEL_OPTIONS,
    defaultModel: DEFAULT_MODEL,
    efforts: ['high', 'xhigh', 'max'],
    defaultEffort,
    xhighSupportedModels: ['claude-opus-4-7'],
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Serve React frontend in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
    res.sendFile(path.join(clientDist, 'index.html'));
  }
});

// Setup WebSocket
setupWebSocket(server);

// Wire the test run recorder so it can broadcast updates to all connected clients.
const { broadcastToAll } = require('./websocket');
const testRunRecorder = require('./services/testRunRecorder');
testRunRecorder.setBroadcast(broadcastToAll);

// Wire the context doc orchestrator so it can broadcast pipeline progress.
const contextDocOrchestrator = require('./services/contextDocOrchestrator');
contextDocOrchestrator.setBroadcast(broadcastToAll);

// Initialize database then start server
initializeDb().then(async () => {
  // Recover tmux sessions from previous server lifetime.
  // Must finish before server.listen() — otherwise the browser auto-reconnects
  // before recovery has populated the active map, and the websocket safety-net
  // path resets live sessions to 'idle' in the DB. (See websocket.js subscribe
  // handler.)
  const { recoverTmuxSessions } = require('./services/sessionManager');
  try {
    await recoverTmuxSessions();
  } catch (err) {
    console.error('Tmux session recovery failed:', err);
  }

  // Mark any context-doc runs that were mid-flight when the server died as
  // failed-with-interrupted, so the project is unblocked and the user can
  // click Resume to continue from cached extractions.
  try {
    const recovered = await contextDocOrchestrator.recoverInterruptedRuns();
    if (recovered > 0) {
      console.log(`Recovered ${recovered} interrupted context-doc run(s).`);
    }
  } catch (err) {
    console.error('Failed to recover interrupted context-doc runs:', err.message);
  }

  // Start the pipeline orchestration runtime (listens for session_complete events)
  const pipelineRuntime = require('./services/pipelineRuntime');
  pipelineRuntime.start();

  // Reconcile any pipeline sessions that were mid-flight when the server died.
  // tmux session recovery above rehydrates still-running ones; this sweep
  // handles orphans whose tmux process is gone but whose DB row never got the
  // session_complete signal.
  try {
    const reconciled = await pipelineRuntime.reconcileStuckSessions();
    if (reconciled.length > 0) {
      const summary = reconciled.map(r => `${r.sessionId.slice(0, 8)}→${r.action}`).join(', ');
      console.log(`Reconciled ${reconciled.length} stuck pipeline session(s): ${summary}`);
    }
  } catch (err) {
    console.error('Failed to reconcile stuck pipeline sessions:', err.message);
  }

  // Nightly safety-net sweep: catches PRs merged on GitHub directly (where
  // the bash watcher can't see them). Runs once a day; the orchestrator's
  // skip-if-running and per-PR extraction cache make repeat runs cheap.
  const contextDocAutoTrigger = require('./services/contextDocAutoTrigger');
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const nightlySweepTimer = setInterval(() => {
    contextDocAutoTrigger.runNightlySweep().catch(err =>
      console.error('Nightly context-doc sweep failed:', err.message)
    );
  }, ONE_DAY_MS);
  // Don't keep the process alive just for the sweep timer.
  if (typeof nightlySweepTimer.unref === 'function') nightlySweepTimer.unref();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Mission Control server running on http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  const { activeSessions } = require('./services/sessionManager');

  // Detach from active sessions without killing them
  for (const [id, session] of activeSessions) {
    if (session.process && session.process.tmux) {
      console.log(`  Detaching from tmux session ${id} (will survive restart)...`);
      session.stopOutputTail();
    } else if (session.process) {
      console.log(`  Ending direct-process session ${id}...`);
      session.end().catch(() => {});
    }
  }

  // Close server
  server.close(() => {
    // Neon serverless driver uses HTTP, no pool to close
    console.log('Server closed. Tmux sessions remain running.');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
