// Persistent storage for the per-session message queue.
//
// The in-memory queue lives on the SessionProcess instance; this table mirrors
// it so a server restart doesn't drop queued messages. Each row corresponds to
// one queued message that has been shown in the chat (with the "queued" badge)
// but not yet handed to the agent.

function getDefaultQuery() {
  return require('../database').query;
}

function parseAttachments(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function enqueue(sessionId, content, attachments, deps = {}) {
  const query = deps.query || getDefaultQuery();
  const serialized = attachments == null ? null : JSON.stringify(attachments);
  const { rows } = await query(
    `INSERT INTO queued_messages (session_id, content, attachments) VALUES ($1, $2, $3) RETURNING id`,
    [sessionId, content, serialized]
  );
  return { id: rows[0]?.id };
}

async function dequeue(sessionId, deps = {}) {
  const query = deps.query || getDefaultQuery();
  // Atomic dequeue: delete the oldest row for this session and return it
  const { rows } = await query(
    `DELETE FROM queued_messages WHERE id = (
       SELECT id FROM queued_messages WHERE session_id = $1 ORDER BY id ASC LIMIT 1
     ) RETURNING id, content, attachments`,
    [sessionId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    content: row.content,
    attachments: parseAttachments(row.attachments),
  };
}

async function peekAll(sessionId, deps = {}) {
  const query = deps.query || getDefaultQuery();
  const { rows } = await query(
    `SELECT id, content, attachments FROM queued_messages WHERE session_id = $1 ORDER BY id ASC`,
    [sessionId]
  );
  return rows.map(r => ({
    id: r.id,
    content: r.content,
    attachments: parseAttachments(r.attachments),
  }));
}

async function removeById(id, deps = {}) {
  const query = deps.query || getDefaultQuery();
  const result = await query(
    `DELETE FROM queued_messages WHERE id = $1`,
    [id]
  );
  return result.rowCount > 0;
}

async function clearForSession(sessionId, deps = {}) {
  const query = deps.query || getDefaultQuery();
  await query(
    `DELETE FROM queued_messages WHERE session_id = $1`,
    [sessionId]
  );
}

module.exports = {
  enqueue,
  dequeue,
  peekAll,
  removeById,
  clearForSession,
};
