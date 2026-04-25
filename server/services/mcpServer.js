/**
 * Mission Control MCP server (JSON-RPC 2.0 over HTTP).
 *
 * Implements the minimum surface needed for Phase 1: `initialize`, `tools/list`,
 * `tools/call`, and `ping`. Each tool call is authenticated via a project-scoped
 * bearer token that is validated against the `mcp_tokens` table.
 *
 * The transport is plain HTTP POST returning a JSON body — Claude Code's
 * `http` MCP transport uses this exact pattern. Streaming/SSE is not required
 * for Phase 1 since the planning tools are request/response.
 */

const JSON_RPC_VERSION = '2.0';
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'mission-control', version: '1.0.0' };

const TOOL_DEFINITIONS = require('./mcpTools').TOOL_DEFINITIONS;

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSON_RPC_VERSION, id: id ?? null, error };
}

function rpcResult(id, result) {
  return { jsonrpc: JSON_RPC_VERSION, id: id ?? null, result };
}

async function dispatch(method, params, ctx) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
      };

    case 'ping':
      return {};

    case 'tools/list':
      return {
        tools: TOOL_DEFINITIONS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      if (!name) throw rpcInvalidParams('Missing tool name');
      const tool = TOOL_DEFINITIONS.find(t => t.name === name);
      if (!tool) throw rpcMethodNotFound(`Tool not found: ${name}`);
      try {
        const text = await tool.handler(args || {}, ctx);
        return {
          content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: err.message || 'Tool execution failed' }],
          isError: true,
        };
      }
    }

    default:
      throw rpcMethodNotFound(`Method not found: ${method}`);
  }
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function rpcMethodNotFound(message) { return new RpcError(-32601, message); }
function rpcInvalidParams(message) { return new RpcError(-32602, message); }

async function handleRpcRequest(payload, ctx) {
  if (!payload || payload.jsonrpc !== JSON_RPC_VERSION || !payload.method) {
    return rpcError(payload?.id ?? null, -32600, 'Invalid JSON-RPC request');
  }
  try {
    const result = await dispatch(payload.method, payload.params || {}, ctx);
    if (payload.id === undefined || payload.id === null) {
      // Notification — no response.
      return null;
    }
    return rpcResult(payload.id, result);
  } catch (err) {
    if (err instanceof RpcError) {
      return rpcError(payload.id, err.code, err.message, err.data);
    }
    return rpcError(payload.id, -32603, err.message || 'Internal error');
  }
}

module.exports = {
  JSON_RPC_VERSION,
  PROTOCOL_VERSION,
  SERVER_INFO,
  RpcError,
  handleRpcRequest,
};
