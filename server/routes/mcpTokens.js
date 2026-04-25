const express = require('express');
const router = express.Router();
const { query } = require('../database');
const tokens = require('../services/mcpTokens');

// GET /api/mcp-tokens/:projectId — list tokens for a project (token VALUE is hidden)
router.get('/:projectId', async (req, res) => {
  try {
    const list = await tokens.listTokens(req.params.projectId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mcp-tokens/:projectId — generate a new token. Returns the raw token
// value ONCE so the caller can copy it.
router.post('/:projectId', async (req, res) => {
  try {
    const project = (await query('SELECT id, name, root_path FROM projects WHERE id = $1', [req.params.projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const name = req.body?.name || 'Default';
    const created = await tokens.createToken(project.id, name);
    res.status(201).json({
      ...created,
      project_name: project.name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mcp-tokens/:projectId/:tokenId/revoke — revoke a token
router.post('/:projectId/:tokenId/revoke', async (req, res) => {
  try {
    const ok = await tokens.revokeToken(req.params.tokenId, req.params.projectId);
    if (!ok) return res.status(404).json({ error: 'Token not found or already revoked' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mcp-tokens/:projectId/connect-snippet?token=... — returns a copy-paste
// JSON snippet for the user to paste into Claude Code's .mcp.json. The token
// itself is supplied by the caller (we never store the cleartext beyond
// initial creation).
router.get('/:projectId/connect-snippet', async (req, res) => {
  try {
    const project = (await query('SELECT id, name FROM projects WHERE id = $1', [req.params.projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const token = req.query.token || '<paste your token here>';
    const baseUrl = req.query.baseUrl || `${req.protocol}://${req.get('host')}`;
    const snippet = {
      mcpServers: {
        'mission-control': {
          type: 'http',
          url: `${baseUrl}/mcp`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    };
    res.json({
      project: { id: project.id, name: project.name },
      mcpUrl: `${baseUrl}/mcp`,
      snippet,
      instructions:
        'Paste this into the project\'s `.mcp.json` (or merge into an existing file). ' +
        'Restart Claude Code in that project; the planning tools will appear automatically.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
