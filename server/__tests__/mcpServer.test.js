/**
 * Unit tests for the MCP server dispatcher (JSON-RPC 2.0 protocol layer).
 *
 * These tests exercise `handleRpcRequest` in isolation — the Express route is
 * a thin wrapper that does auth + call-dispatcher + return-JSON, and is best
 * validated by hitting the running server. We test the protocol shape and
 * tool dispatch wiring here.
 *
 * The orchestrator is mocked because tool handlers call into it directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_URL = 'postgresql://test:test@host.test/db';

const require = createRequire(import.meta.url);

// Mock the orchestrator first so the test-level require chain picks up the mock.
const mockStartPlanningSession = vi.fn(async () => ({
  sessionId: 'test-session-id',
  status: 'started',
  planningQuestionId: 'test-pq-id',
}));
const mockSendAndAwait = vi.fn(async () => ({
  response: 'Mocked planning answer.',
  status: 'completed',
  durationSeconds: 1.23,
}));
const mockGetStatus = vi.fn(async (sessionId) => ({
  sessionId,
  status: 'completed',
  durationSeconds: 5.0,
  lastResponse: 'last',
  sessionType: 'planning',
}));

// Mock the database.query so handlers that check session/project ownership
// don't touch the real DB.
const mockQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));

// Inject mocks into Node's module cache so CJS require() picks them up.
// vi.mock has been unreliable for our CJS chain, so we cache-poison directly.
const path = require('path');
const databasePath = path.resolve(__dirname, '..', 'database.js');
const orchestratorPath = path.resolve(__dirname, '..', 'services', 'planningSessionOrchestrator.js');

require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { query: mockQuery },
};
require.cache[orchestratorPath] = {
  id: orchestratorPath,
  filename: orchestratorPath,
  loaded: true,
  exports: {
    startPlanningSession: mockStartPlanningSession,
    sendAndAwait: mockSendAndAwait,
    getStatus: mockGetStatus,
  },
};

const mcpServer = require('../services/mcpServer');

describe('handleRpcRequest — protocol layer', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockStartPlanningSession.mockClear();
    mockSendAndAwait.mockClear();
    mockGetStatus.mockClear();
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  });

  it('returns invalid-request for missing jsonrpc field', async () => {
    const res = await mcpServer.handleRpcRequest({ id: 1, method: 'initialize' }, {});
    expect(res.error.code).toBe(-32600);
  });

  it('returns invalid-request when payload is null', async () => {
    const res = await mcpServer.handleRpcRequest(null, {});
    expect(res.error.code).toBe(-32600);
  });

  it('handles initialize with protocol version + capabilities', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { projectId: 'proj-A' }
    );
    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBeTruthy();
    expect(res.result.serverInfo.name).toBe('mission-control');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('handles ping', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 99, method: 'ping' },
      { projectId: 'proj-A' }
    );
    expect(res.id).toBe(99);
    expect(res.result).toEqual({});
  });

  it('returns null for notifications (no id)', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', method: 'ping' },
      { projectId: 'proj-A' }
    );
    expect(res).toBeNull();
  });

  it('lists the three Phase 1 tools', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { projectId: 'proj-A' }
    );
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('mc_start_session');
    expect(names).toContain('mc_send_message');
    expect(names).toContain('mc_get_session_status');
  });

  it('mc_start_session forwards to orchestrator with project from ctx', async () => {
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'mc_start_session', arguments: { task: 'How do we paginate?' } },
      },
      { projectId: 'proj-A' }
    );
    expect(res.result.isError).toBe(false);
    expect(mockStartPlanningSession).toHaveBeenCalledTimes(1);
    expect(mockStartPlanningSession.mock.calls[0][0].projectId).toBe('proj-A');
    expect(mockStartPlanningSession.mock.calls[0][0].task).toBe('How do we paginate?');
    expect(res.result.content[0].text).toContain('test-session-id');
  });

  it('mc_start_session returns isError when task is missing', async () => {
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'mc_start_session', arguments: {} },
      },
      { projectId: 'proj-A' }
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/task is required/);
  });

  it('mc_start_session blocks cross-project explicit project_id', async () => {
    // resolveProjectId verifies project exists; return rows so the project lookup succeeds
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ id: 'proj-X' }], rowCount: 1 }));
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'mc_start_session', arguments: { task: 't', project_id: 'proj-X' } },
      },
      { projectId: 'proj-A' }
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/different project/i);
  });

  it('mc_send_message routes to orchestrator.sendAndAwait', async () => {
    // Project-scope check: load session row to compare project_id
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ project_id: 'proj-A' }], rowCount: 1 }));
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'mc_send_message', arguments: { session_id: 'test-session-id', message: 'follow up?' } },
      },
      { projectId: 'proj-A' }
    );
    expect(res.result.isError).toBe(false);
    expect(mockSendAndAwait).toHaveBeenCalledWith(
      'test-session-id',
      'follow up?',
      expect.any(Object)
    );
  });

  it('mc_send_message blocks when session belongs to another project', async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ project_id: 'proj-B' }], rowCount: 1 }));
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 9, method: 'tools/call',
        params: { name: 'mc_send_message', arguments: { session_id: 'sess', message: 'x' } },
      },
      { projectId: 'proj-A' }
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/different project/i);
  });

  it('mc_get_session_status returns status from orchestrator', async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ project_id: 'proj-A' }], rowCount: 1 }));
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { name: 'mc_get_session_status', arguments: { session_id: 'sess' } },
      },
      { projectId: 'proj-A' }
    );
    expect(res.result.isError).toBe(false);
    expect(mockGetStatus).toHaveBeenCalledWith('sess');
  });

  it('returns method-not-found for unknown method', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 11, method: 'no/such' },
      { projectId: 'proj-A' }
    );
    expect(res.error.code).toBe(-32601);
  });

  it('tools/call with unknown tool returns method-not-found', async () => {
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 12, method: 'tools/call',
        params: { name: 'nope', arguments: {} },
      },
      { projectId: 'proj-A' }
    );
    expect(res.error.code).toBe(-32601);
  });

  it('tools/call without name returns invalid-params', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: {} },
      { projectId: 'proj-A' }
    );
    expect(res.error.code).toBe(-32602);
  });
});
