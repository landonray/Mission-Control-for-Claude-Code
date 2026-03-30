const WebSocket = require('ws');
const { getSession, activeSessions, resumeSession } = require('./services/sessionManager');
const { watchDirectory, unwatchDirectory } = require('./services/fileWatcher');
const { sendNotification } = require('./services/notificationService');

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let sessionUnsubscribe = null;
    let watchedDirs = new Set();

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(ws, msg, { sessionUnsubscribe, watchedDirs });

        // Update closure references
        if (msg.type === 'subscribe_session') {
          const session = getSession(msg.sessionId);
          if (session) {
            if (sessionUnsubscribe) sessionUnsubscribe();
            sessionUnsubscribe = session.addListener((event) => {
              safeSend(ws, event);
              handleNotifications(event);
            });

            // Send current status
            safeSend(ws, {
              type: 'session_status',
              sessionId: msg.sessionId,
              status: session.status,
              pendingPermission: session.pendingPermission,
              errorMessage: session.errorMessage || null,
              timestamp: new Date().toISOString()
            });
          } else {
            // Session not in memory — check DB for its status
            const { getDb } = require('./database');
            const dbSession = getDb().prepare('SELECT status FROM sessions WHERE id = ?').get(msg.sessionId);
            safeSend(ws, {
              type: 'session_status',
              sessionId: msg.sessionId,
              status: dbSession ? dbSession.status : 'ended',
              resumable: true, // Ended sessions can be resumed by sending a message
              timestamp: new Date().toISOString()
            });
          }
        }
      } catch (e) {
        safeSend(ws, { type: 'error', message: 'Invalid message format' });
      }
    });

    ws.on('close', () => {
      if (sessionUnsubscribe) sessionUnsubscribe();
      for (const dir of watchedDirs) {
        unwatchDirectory(dir);
      }
    });
  });

  // Heartbeat to detect broken connections
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  // Broadcast session status updates periodically
  setInterval(() => {
    const statusUpdate = {
      type: 'sessions_status',
      sessions: Array.from(activeSessions.entries()).map(([id, session]) => ({
        id,
        status: session.status,
        pendingPermission: !!session.pendingPermission
      })),
      timestamp: new Date().toISOString()
    };

    broadcast(wss, statusUpdate);
  }, 5000);

  return wss;
}

function handleMessage(ws, msg, state) {
  switch (msg.type) {
    case 'subscribe_session':
      // Handled in the message handler above for closure access
      break;

    case 'unsubscribe_session':
      if (state.sessionUnsubscribe) {
        state.sessionUnsubscribe();
        state.sessionUnsubscribe = null;
      }
      break;

    case 'watch_directory':
      if (msg.path) {
        const resolvedPath = msg.path.replace(/^~/, process.env.HOME || '');
        state.watchedDirs.add(resolvedPath);
        watchDirectory(resolvedPath, (event) => {
          safeSend(ws, {
            type: 'file_change',
            ...event,
            timestamp: new Date().toISOString()
          });
        });
        safeSend(ws, { type: 'watching', path: resolvedPath });
      }
      break;

    case 'unwatch_directory':
      if (msg.path) {
        const resolvedPath = msg.path.replace(/^~/, process.env.HOME || '');
        unwatchDirectory(resolvedPath);
        state.watchedDirs.delete(resolvedPath);
        safeSend(ws, { type: 'unwatched', path: resolvedPath });
      }
      break;

    case 'send_message':
      if (msg.sessionId && msg.content) {
        let session = getSession(msg.sessionId);
        if (session) {
          session.sendMessage(msg.content);
        } else {
          // Session not in memory — attempt to resume it
          const { getDb } = require('./database');
          const dbSession = getDb().prepare('SELECT id FROM sessions WHERE id = ?').get(msg.sessionId);
          if (dbSession) {
            // Notify client that we're resuming
            safeSend(ws, {
              type: 'session_resuming',
              sessionId: msg.sessionId,
              timestamp: new Date().toISOString()
            });

            const resumed = resumeSession(msg.sessionId, msg.content);
            if (resumed) {
              // Resubscribe to the new session process
              if (state.sessionUnsubscribe) state.sessionUnsubscribe();
              state.sessionUnsubscribe = resumed.addListener((event) => {
                safeSend(ws, event);
                handleNotifications(event);
              });
            } else {
              safeSend(ws, {
                type: 'error',
                sessionId: msg.sessionId,
                error: 'Failed to resume session.',
                timestamp: new Date().toISOString()
              });
            }
          } else {
            safeSend(ws, {
              type: 'error',
              sessionId: msg.sessionId,
              error: 'Session not found.',
              timestamp: new Date().toISOString()
            });
          }
        }
      }
      break;

    case 'approve_permission':
      if (msg.sessionId) {
        const session = getSession(msg.sessionId);
        if (session) {
          session.respondToPermission(msg.approved !== false);
        }
      }
      break;

    case 'ping':
      safeSend(ws, { type: 'pong' });
      break;
  }
}

function handleNotifications(event) {
  switch (event.type) {
    case 'stream_event':
      if (event.event?.type === 'permission_request') {
        sendNotification(
          'Permission Required',
          `Session needs approval: ${event.event.tool || 'action'}`,
          { type: 'waiting_for_input', sessionId: event.sessionId }
        ).catch(() => {});
      }
      break;

    case 'session_ended':
      sendNotification(
        'Session Complete',
        'A Claude Code session has finished',
        { type: 'task_complete', sessionId: event.sessionId }
      ).catch(() => {});
      break;

    case 'error':
      sendNotification(
        'Session Error',
        event.error || 'An error occurred',
        { type: 'error', sessionId: event.sessionId }
      ).catch(() => {});
      break;
  }
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(wss, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

module.exports = { setupWebSocket };
