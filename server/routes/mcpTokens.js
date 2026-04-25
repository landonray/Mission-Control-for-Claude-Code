const express = require('express');
const router = express.Router();
const tokens = require('../services/mcpTokens');

// GET /api/mcp-tokens — list app-wide tokens (token VALUE is hidden)
router.get('/', async (req, res) => {
  try {
    const list = await tokens.listTokens();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mcp-tokens — generate a new app-wide token. Returns the raw token
// value ONCE so the caller can copy it.
router.post('/', async (req, res) => {
  try {
    const name = req.body?.name || 'Default';
    const created = await tokens.createToken(name);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mcp-tokens/:tokenId/revoke — revoke a token
router.post('/:tokenId/revoke', async (req, res) => {
  try {
    const ok = await tokens.revokeToken(req.params.tokenId);
    if (!ok) return res.status(404).json({ error: 'Token not found or already revoked' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mcp-tokens/connect-snippet?token=... — returns a copy-paste
// JSON snippet for the user to paste into Claude Code's MCP config. The token
// itself is supplied by the caller (we never store the cleartext beyond
// initial creation).
router.get('/connect-snippet', async (req, res) => {
  try {
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
      mcpUrl: `${baseUrl}/mcp`,
      snippet,
      instructions:
        'Paste this into Claude Code\'s MCP config (`~/.claude.json` or a project\'s `.mcp.json`). ' +
        'Restart Claude Code; the Mission Control tools (mc_list_projects, mc_start_session, etc.) will appear automatically. ' +
        'Claude Code will call mc_list_projects to discover projects, then specify project_id on every other call.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
