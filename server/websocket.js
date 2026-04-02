const WebSocket = require('ws');
const { getSession, activeSessions, resumeSession, globalEvents } = require('./services/sessionManager');
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
              // Skip session_name_updated here — it's handled by the globalEvents
              // broadcast which sends to ALL clients reliably
              if (event.type !== 'session_name_updated') {
                safeSend(ws, event);
              }
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

            // Replay buffered stream events so CLI panel shows history
            if (session.streamEventHistory && session.streamEventHistory.length > 0) {
              safeSend(ws, {
                type: 'stream_events_history',
                sessionId: msg.sessionId,
                events: session.streamEventHistory,
                timestamp: new Date().toISOString()
              });
            }
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

  // Listen for global session name updates and broadcast to ALL connected clients.
  // This ensures the sidebar updates even if no client is subscribed to the specific session.
  globalEvents.on('session_name_updated', (event) => {
    broadcast(wss, event);
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
        const messageId = msg.messageId || null;
        // Immediately acknowledge receipt so the client knows the message arrived
        if (messageId) {
          safeSend(ws, {
            type: 'message_ack',
            messageId,
            status: 'received',
            timestamp: new Date().toISOString()
          });
        }
        let session = getSession(msg.sessionId);
        if (session) {
          try {
            await session.sendMessage(msg.content, msg.attachments || null);
            if (messageId) {
              safeSend(ws, {
                type: 'message_ack',
                messageId,
                status: 'processing',
                timestamp: new Date().toISOString()
              });
            }
          } catch (err) {
            console.error(`[WS] sendMessage failed for ${msg.sessionId.slice(0, 8)}:`, err.message);
            safeSend(ws, {
              type: 'message_ack',
              messageId,
              status: 'failed',
              error: 'Failed to send message: ' + err.message,
              timestamp: new Date().toISOString()
            });
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

              // Build listener before resuming so it's attached before any broadcasts
              if (state.sessionUnsubscribe) state.sessionUnsubscribe();
              const onEvent = (event) => {
                safeSend(ws, event);
                handleNotifications(event);
              };
              const resumed = await resumeSession(msg.sessionId, msg.content, { listener: onEvent });
              if (resumed) {
                // Use the stored unsubscribe if resumeSession attached it (fresh resume path),
                // otherwise attach the listener ourselves (already-active early-return paths)
                if (resumed._listenerUnsubscribe) {
                  state.sessionUnsubscribe = resumed._listenerUnsubscribe;
                } else {
                  state.sessionUnsubscribe = resumed.addListener(onEvent);
                }
                if (messageId) {
                  safeSend(ws, {
                    type: 'message_ack',
                    messageId,
                    status: 'processing',
                    timestamp: new Date().toISOString()
                  });
                }
              } else {
                safeSend(ws, {
                  type: 'message_ack',
                  messageId,
                  status: 'failed',
                  error: 'Failed to resume session.',
                  timestamp: new Date().toISOString()
                });
                safeSend(ws, {
                  type: 'error',
                  sessionId: msg.sessionId,
                  error: 'Failed to resume session.',
                  timestamp: new Date().toISOString()
                });
              }
            } else {
              safeSend(ws, {
                type: 'message_ack',
                messageId,
                status: 'failed',
                error: 'Session not found.',
                timestamp: new Date().toISOString()
              });
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
              type: 'message_ack',
              messageId,
              status: 'failed',
              error: 'Failed to process message: ' + err.message,
              timestamp: new Date().toISOString()
            });
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
