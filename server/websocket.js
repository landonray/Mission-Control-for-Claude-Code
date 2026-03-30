const WebSocket = require('ws');
const { getSession, activeSessions, resumeSession } = require('./services/sessionManager');
const { watchDirectory, unwatchDirectory } = require('./services/fileWatcher');
const { sendNotification } = require('./services/notificationService');

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // Mutable state object shared between all handlers for this connection.
    // Using an object (not bare variables) so handleMessage can mutate it
    // and the changes are visible to the close handler and future messages.
    const state = {
      sessionUnsubscribe: null,
      watchedDirs: new Set()
    };

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleMessage(ws, msg, state);

        if (msg.type === 'subscribe_session') {
          const session = getSession(msg.sessionId);
          if (session) {
            if (state.sessionUnsubscribe) state.sessionUnsubscribe();
            state.sessionUnsubscribe = session.addListener((event) => {
              safeSend(ws, event);
              handleNotifications(event);
            });

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
            const { query } = require('./database');
            query('SELECT status FROM sessions WHERE id = $1', [msg.sessionId]).then(result => {
              const dbSession = result.rows[0];
              safeSend(ws, {
                type: 'session_status',
                sessionId: msg.sessionId,
                status: dbSession ? dbSession.status : 'ended',
                resumable: true,
                timestamp: new Date().toISOString()
              });
            }).catch(() => {
              safeSend(ws, {
                type: 'session_status',
                sessionId: msg.sessionId,
                status: 'ended',
                resumable: true,
                timestamp: new Date().toISOString()
              });
            });
          }
        }
      } catch (e) {
        safeSend(ws, { type: 'error', message: 'Invalid message format' });
      }
    });

    ws.on('close', () => {
      if (state.sessionUnsubscribe) state.sessionUnsubscribe();
      for (const dir of state.watchedDirs) {
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

async function handleMessage(ws, msg, state) {
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
          try {
            await session.sendMessage(msg.content, msg.attachments || null);
          } catch (err) {
            console.error('sendMessage error:', err.message);
            safeSend(ws, {
              type: 'error',
              sessionId: msg.sessionId,
              error: 'Failed to send message: ' + err.message,
              timestamp: new Date().toISOString()
            });
          }
        } else {
          // Session not in memory — attempt to resume it
          try {
            const { query: dbQuery } = require('./database');
            const dbResult = await dbQuery('SELECT id FROM sessions WHERE id = $1', [msg.sessionId]);
            const dbSession = dbResult.rows[0];
            if (dbSession) {
              // Notify client that we're resuming
              safeSend(ws, {
                type: 'session_resuming',
                sessionId: msg.sessionId,
                timestamp: new Date().toISOString()
              });

              // Add listener BEFORE resuming so we don't miss events
              const resumed = await resumeSession(msg.sessionId, msg.content);
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
          } catch (err) {
            console.error('send_message resume error:', err.message);
            safeSend(ws, {
              type: 'error',
              sessionId: msg.sessionId,
              error: 'Failed to process message: ' + err.message,
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
