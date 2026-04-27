#!/usr/bin/env node
/**
 * Stdio-to-HTTP MCP bridge for Claude Desktop.
 *
 * Claude Desktop only supports stdio MCP servers. This script bridges the gap:
 * it reads JSON-RPC messages from stdin, forwards them to Command Center's
 * HTTP MCP endpoint, and writes responses to stdout.
 *
 * The token and URL are read from environment variables so the bridge works
 * for any user without editing this file. Set them in the Claude Desktop config:
 *
 *   "mission-control": {
 *     "command": "/path/to/node",
 *     "args": ["/path/to/mcp-stdio-bridge.js"],
 *     "env": {
 *       "MC_MCP_TOKEN": "mc_...",
 *       "MC_MCP_URL": "http://localhost:3001/mcp"
 *     }
 *   }
 *
 * If env vars are not set, defaults to the local server with no token (will fail auth).
 */
const TOKEN = process.env.MC_MCP_TOKEN || '';
const URL = process.env.MC_MCP_URL || 'http://localhost:3001/mcp';

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });

let pending = 0;
let closed = false;

function maybeExit() {
  if (closed && pending === 0) process.exit(0);
}

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`[mc-bridge] Bad JSON: ${line.substring(0, 100)}\n`);
    return;
  }

  pending++;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

    const res = await fetch(URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
    });

    if (res.status !== 204) {
      const body = await res.json();
      process.stdout.write(JSON.stringify(body) + '\n');
    }
  } catch (err) {
    process.stderr.write(`[mc-bridge] ${err.message}\n`);
    if (msg.id !== undefined && msg.id !== null) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: `Bridge error: ${err.message}` },
      }) + '\n');
    }
  }
  pending--;
  maybeExit();
});

rl.on('close', () => {
  closed = true;
  maybeExit();
});
