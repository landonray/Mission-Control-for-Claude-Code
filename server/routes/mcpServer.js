const express = require('express');
const router = express.Router();
const { extractBearerToken, findActiveToken } = require('../services/mcpTokens');
const mcpServer = require('../services/mcpServer');

async function authenticate(req, res, next) {
  const raw = extractBearerToken(req);
  if (!raw) {
    res.set('WWW-Authenticate', 'Bearer realm="mission-control-mcp"');
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Missing Bearer token' },
    });
  }
  const token = await findActiveToken(raw);
  if (!token) {
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Invalid or revoked token' },
    });
  }
  req.mcpAuth = { projectId: token.project_id, tokenId: token.id, tokenName: token.name };
  next();
}

// MCP JSON-RPC endpoint. Claude Code's `http` MCP transport POSTs JSON-RPC
// envelopes here. We respond with a single JSON-RPC response (no SSE/streaming
// in Phase 1 — every Phase 1 tool is request/response).
router.post('/', authenticate, async (req, res) => {
  const ctx = {
    projectId: req.mcpAuth.projectId,
    tokenId: req.mcpAuth.tokenId,
  };

  // Support a single envelope OR a batch. Most clients send a single envelope.
  const payload = req.body;
  if (Array.isArray(payload)) {
    const responses = [];
    for (const msg of payload) {
      const r = await mcpServer.handleRpcRequest(msg, ctx);
      if (r) responses.push(r);
    }
    return res.json(responses);
  }

  const response = await mcpServer.handleRpcRequest(payload, ctx);
  if (!response) {
    // Notification — no body to send
    return res.status(204).end();
  }
  res.json(response);
});

// Lightweight discovery endpoint so users can sanity-check that the MCP server
// is reachable without going through full JSON-RPC. Does not require auth.
router.get('/info', (req, res) => {
  res.json({
    name: mcpServer.SERVER_INFO.name,
    version: mcpServer.SERVER_INFO.version,
    protocolVersion: mcpServer.PROTOCOL_VERSION,
    transport: 'http',
    auth: 'bearer',
  });
});

module.exports = router;
