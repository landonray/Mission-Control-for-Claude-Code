/**
 * Unit tests for the MCP server dispatcher (JSON-RPC 2.0 protocol layer).
 *
 * Tokens are app-wide. Tools that operate on a project (mc_start_session etc.)
 * require an explicit project_id arg. mc_list_projects has no required args.
 *
 * The orchestrator and database are mocked so handlers run in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_URL = 'postgresql://test:test@host.test/db';

const require = createRequire(import.meta.url);

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

const mockQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));

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
      {}
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
      {}
    );
    expect(res.id).toBe(99);
    expect(res.result).toEqual({});
  });

  it('returns null for notifications (no id)', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', method: 'ping' },
      {}
    );
    expect(res).toBeNull();
  });

  it('lists all four Phase 1 tools including mc_list_projects', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {}
    );
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('mc_list_projects');
    expect(names).toContain('mc_start_session');
    expect(names).toContain('mc_send_message');
    expect(names).toContain('mc_get_session_status');
  });

  it('mc_list_projects returns the projects array', async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [
        { id: 'p1', name: 'Alpha', root_path: '/tmp/__definitely_not_a_real_path__/alpha', github_repo: null, deployment_url: null, last_deploy_status: null },
        { id: 'p2', name: 'Beta', root_path: '/tmp/__definitely_not_a_real_path__/beta', github_repo: 'me/beta', deployment_url: null, last_deploy_status: 'ok' },
      ],
      rowCount: 2,
    }));
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mc_list_projects', arguments: {} } },
      {}
    );
    expect(res.result.isError).toBe(false);
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.projects).toHaveLength(2);
    expect(payload.projects[0].id).toBe('p1');
    expect(payload.projects[1].github_repo).toBe('me/beta');
    // Files don't exist on the test paths, so booleans should be false.
    expect(payload.projects[0].product_md_exists).toBe(false);
    expect(payload.projects[0].architecture_md_exists).toBe(false);
  });

  it('mc_start_session requires project_id explicitly', async () => {
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'mc_start_session', arguments: { task: 'How do we paginate?' } },
      },
      {}
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/project_id is required/i);
  });

  it('mc_start_session forwards to orchestrator with the supplied project_id', async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ id: 'proj-A' }], rowCount: 1 }));
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'mc_start_session', arguments: { project_id: 'proj-A', task: 'How do we paginate?' } },
      },
      {}
    );
    expect(res.result.isError).toBe(false);
    expect(mockStartPlanningSession).toHaveBeenCalledTimes(1);
    expect(mockStartPlanningSession.mock.calls[0][0].projectId).toBe('proj-A');
    expect(mockStartPlanningSession.mock.calls[0][0].task).toBe('How do we paginate?');
    expect(res.result.content[0].text).toContain('test-session-id');
  });

  it('mc_start_session errors when project_id does not exist', async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: 'mc_start_session', arguments: { project_id: 'missing', task: 't' } },
      },
      {}
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Project not found/);
  });

  it('mc_start_session returns isError when task is missing', async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ id: 'proj-A' }], rowCount: 1 }));
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'mc_start_session', arguments: { project_id: 'proj-A' } },
      },
      {}
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/task is required/);
  });

  it('mc_send_message routes to orchestrator.sendAndAwait without scoping', async () => {
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'mc_send_message', arguments: { session_id: 'test-session-id', message: 'follow up?' } },
      },
      {}
    );
    expect(res.result.isError).toBe(false);
    expect(mockSendAndAwait).toHaveBeenCalledWith(
      'test-session-id',
      'follow up?',
      expect.any(Object)
    );
  });

  it('mc_get_session_status returns status from orchestrator', async () => {
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { name: 'mc_get_session_status', arguments: { session_id: 'sess' } },
      },
      {}
    );
    expect(res.result.isError).toBe(false);
    expect(mockGetStatus).toHaveBeenCalledWith('sess');
  });

  it('returns method-not-found for unknown method', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 11, method: 'no/such' },
      {}
    );
    expect(res.error.code).toBe(-32601);
  });

  it('tools/call with unknown tool returns method-not-found', async () => {
    const res = await mcpServer.handleRpcRequest(
      {
        jsonrpc: '2.0', id: 12, method: 'tools/call',
        params: { name: 'nope', arguments: {} },
      },
      {}
    );
    expect(res.error.code).toBe(-32601);
  });

  it('tools/call without name returns invalid-params', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: {} },
      {}
    );
    expect(res.error.code).toBe(-32602);
  });
});
