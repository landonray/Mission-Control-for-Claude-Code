const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');

const TOKEN_PREFIX = 'mc_';

function generateTokenString() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

async function createToken(projectId, name = 'Default') {
  const id = uuidv4();
  const token = generateTokenString();
  await query(
    `INSERT INTO mcp_tokens (id, project_id, token, name, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [id, projectId, token, name]
  );
  return { id, project_id: projectId, token, name };
}

async function listTokens(projectId) {
  const result = await query(
    `SELECT id, project_id, name, created_at, last_used_at, revoked_at,
            CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END AS active
     FROM mcp_tokens WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId]
  );
  return result.rows;
}

async function revokeToken(tokenId, projectId) {
  const result = await query(
    `UPDATE mcp_tokens SET revoked_at = NOW()
     WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL`,
    [tokenId, projectId]
  );
  return result.rowCount > 0;
}

async function findActiveToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
  const result = await query(
    `SELECT id, project_id, name FROM mcp_tokens
     WHERE token = $1 AND revoked_at IS NULL`,
    [rawToken]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  // Best-effort touch of last_used_at; failures don't block auth.
  query('UPDATE mcp_tokens SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
  return row;
}

function extractBearerToken(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (!auth) return null;
  const match = String(auth).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

module.exports = {
  TOKEN_PREFIX,
  generateTokenString,
  createToken,
  listTokens,
  revokeToken,
  findActiveToken,
  extractBearerToken,
};
