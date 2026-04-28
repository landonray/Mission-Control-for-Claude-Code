/**
 * Unit tests for the MCP session-history tools:
 *   mc_search_sessions, mc_get_session_summary.
 *
 * Mirrors the test pattern from mcpTools.projectFiles.test.js — mocks the DB
 * via require.cache and routes through the MCP dispatcher.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

process.env.DATABASE_URL = 'postgresql://test:test@host.test/db';

const require = createRequire(import.meta.url);

const mockQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
const mockOrchestrator = {
  startPlanningSession: vi.fn(),
  sendAndAwait: vi.fn(),
  getStatus: vi.fn(),
};

const databasePath = path.resolve(__dirname, '..', 'database.js');
const orchestratorPath = path.resolve(__dirname, '..', 'services', 'planningSessionOrchestrator.js');

require.cache[databasePath] = {
  id: databasePath, filename: databasePath, loaded: true,
  exports: { query: mockQuery },
};
require.cache[orchestratorPath] = {
  id: orchestratorPath, filename: orchestratorPath, loaded: true,
  exports: mockOrchestrator,
};

const mcpServer = require('../services/mcpServer');

async function callTool(name, args) {
  return mcpServer.handleRpcRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    {}
  );
}

function payloadOf(res) {
  return JSON.parse(res.result.content[0].text);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

describe('tools/list includes the session-history tools', () => {
  it('exposes mc_search_sessions, mc_get_session_summary, mc_get_session_messages', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {}
    );
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('mc_search_sessions');
    expect(names).toContain('mc_get_session_summary');
    expect(names).toContain('mc_get_session_messages');
  });
});

describe('mc_search_sessions', () => {
  it('runs an ILIKE search and returns formatted session summaries', async () => {
    mockQuery.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT id FROM projects WHERE id')) {
        return { rows: [{ id: 'p1' }] };
      }
      if (sql.includes('FROM sessions s')) {
        // The query should include the ILIKE pattern as the second param.
        expect(params[1]).toBe('%pagination%');
        return {
          rows: [
            {
              id: 's1', name: 'Pagination work', session_type: 'implementation',
              status: 'ended', created_at: '2026-04-20T10:00:00Z',
              ended_at: '2026-04-20T11:30:00Z',
              last_action_summary: 'Added pagination middleware',
              pipeline_id: null, pipeline_stage: null,
              summary: 'Implemented cursor-based pagination',
              files_modified: '["server/routes/feed.js","client/src/Feed.jsx"]',
              key_actions: '["added route","added UI"]',
              planning_question: null,
              pipeline_pr_url: null,
            },
            {
              id: 's2', name: 'Pagination planning', session_type: 'planning',
              status: 'completed', created_at: '2026-04-19T12:00:00Z',
              ended_at: '2026-04-19T12:05:00Z',
              last_action_summary: null,
              pipeline_id: 'pipe-1', pipeline_stage: 1,
              summary: null,
              files_modified: null,
              key_actions: null,
              planning_question: 'How should pagination be designed?',
              pipeline_pr_url: 'https://github.com/acme/repo/pull/42',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const res = await callTool('mc_search_sessions', {
      project_id: 'p1',
      query: 'pagination',
    });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.count).toBe(2);
    expect(payload.limit).toBe(10);
    expect(payload.sessions[0].session_id).toBe('s1');
    expect(payload.sessions[0].files_touched).toEqual(['server/routes/feed.js', 'client/src/Feed.jsx']);
    expect(payload.sessions[1].planning_question).toMatch(/pagination/);
    expect(payload.sessions[1].pr_url).toBe('https://github.com/acme/repo/pull/42');
  });

  it('caps limit at 50 and applies session_type filter', async () => {
    let capturedSql = null;
    let capturedParams = null;
    mockQuery.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT id FROM projects WHERE id')) {
        return { rows: [{ id: 'p1' }] };
      }
      if (sql.includes('FROM sessions s')) {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [] };
      }
      return { rows: [] };
    });
    await callTool('mc_search_sessions', {
      project_id: 'p1',
      query: 'auth',
      session_type: 'planning',
      limit: 999,
    });
    expect(capturedSql).toMatch(/AND s\.session_type = \$3/);
    expect(capturedParams).toContain('planning');
    // Last param is the limit, capped at 50.
    expect(capturedParams[capturedParams.length - 1]).toBe(50);
    // Regression: the join must reference real columns on planning_questions
    // (planning_session_id / asking_session_id), not a phantom session_id.
    expect(capturedSql).toMatch(/planning_questions\s+pq\s+ON\s+pq\.planning_session_id\s*=\s*s\.id\s+OR\s+pq\.asking_session_id\s*=\s*s\.id/);
    expect(capturedSql).not.toMatch(/pq\.session_id/);
  });

  it('rejects missing project_id and missing query', async () => {
    const res1 = await callTool('mc_search_sessions', { query: 'foo' });
    expect(res1.result.isError).toBe(true);
    expect(res1.result.content[0].text).toMatch(/project_id is required/);

    const res2 = await callTool('mc_search_sessions', { project_id: 'p1' });
    expect(res2.result.isError).toBe(true);
    expect(res2.result.content[0].text).toMatch(/query is required/);
  });
});

describe('mc_get_session_summary', () => {
  it('returns the merged session record with summary, planning, and eval batches', async () => {
    mockQuery.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM sessions s\n     LEFT JOIN pipelines')) {
        return {
          rows: [{
            id: 's1', name: 'Recipe extraction', session_type: 'implementation',
            status: 'ended', project_id: 'p1', pipeline_id: 'pipe-1', pipeline_stage: 4,
            pipeline_pr_url: 'https://github.com/acme/repo/pull/42',
            created_at: '2026-04-20T10:00:00Z', ended_at: '2026-04-20T11:30:00Z',
            last_activity_at: '2026-04-20T11:30:00Z',
            last_action_summary: 'Implemented extraction', branch: 'feature/extract',
            working_directory: '/projects/acme', lines_added: 120, lines_removed: 18,
            user_message_count: 5, assistant_message_count: 12, tool_call_count: 30,
          }],
        };
      }
      if (sql.includes('FROM session_summaries')) {
        return {
          rows: [{
            summary: 'Built the recipe extraction pipeline.',
            key_actions: '["added extractor","added tests"]',
            files_modified: '["server/extract.js"]',
            created_at: '2026-04-20T11:30:05Z',
          }],
        };
      }
      if (sql.includes('FROM planning_questions')) {
        return {
          rows: [{
            question: 'How should we model recipes?', answer: 'Use Zod schema',
            status: 'completed', asked_at: '2026-04-20T10:05:00Z',
            answered_at: '2026-04-20T10:07:00Z',
          }],
        };
      }
      if (sql.includes('FROM eval_batches')) {
        return {
          rows: [{
            id: 'batch-1', trigger_source: 'session_end', status: 'complete',
            total: 3, passed: 3, failed: 0, errors: 0,
            started_at: '2026-04-20T11:30:10Z', completed_at: '2026-04-20T11:30:30Z',
          }],
        };
      }
      return { rows: [] };
    });
    const res = await callTool('mc_get_session_summary', { session_id: 's1' });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.session_id).toBe('s1');
    expect(payload.summary).toMatch(/recipe extraction/i);
    expect(payload.files_touched).toEqual(['server/extract.js']);
    expect(payload.key_actions).toEqual(['added extractor', 'added tests']);
    expect(payload.planning_questions).toHaveLength(1);
    expect(payload.planning_questions[0].answer).toBe('Use Zod schema');
    expect(payload.eval_batches).toHaveLength(1);
    expect(payload.eval_batches[0].batch_id).toBe('batch-1');
    expect(payload.pr_url).toBe('https://github.com/acme/repo/pull/42');
  });

  it('handles a session with no summary, planning, or evals gracefully', async () => {
    let planningSql = null;
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('FROM sessions s\n     LEFT JOIN pipelines')) {
        return {
          rows: [{
            id: 's2', name: 'Bare session', session_type: 'implementation',
            status: 'idle', project_id: 'p1', pipeline_id: null, pipeline_stage: null,
            pipeline_pr_url: null, created_at: '2026-04-21T00:00:00Z', ended_at: null,
            last_activity_at: null, last_action_summary: null, branch: null,
            working_directory: null, lines_added: 0, lines_removed: 0,
            user_message_count: 0, assistant_message_count: 0, tool_call_count: 0,
          }],
        };
      }
      if (sql.includes('FROM planning_questions')) {
        planningSql = sql;
      }
      return { rows: [] };
    });
    const res = await callTool('mc_get_session_summary', { session_id: 's2' });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.summary).toBeNull();
    expect(payload.planning_questions).toEqual([]);
    expect(payload.eval_batches).toEqual([]);
    expect(payload.files_touched).toBeNull();
    // Regression: planning_questions has no `session_id` column — the lookup
    // must use planning_session_id / asking_session_id.
    expect(planningSql).toMatch(/planning_session_id\s*=\s*\$1\s+OR\s+asking_session_id\s*=\s*\$1/);
    expect(planningSql).not.toMatch(/WHERE\s+session_id\s*=/);
  });

  it('errors when the session_id is unknown', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [] }));
    const res = await callTool('mc_get_session_summary', { session_id: 'missing' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Session missing not found/);
  });

  it('rejects missing session_id', async () => {
    const res = await callTool('mc_get_session_summary', {});
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/session_id is required/);
  });
});

describe('mc_get_session_messages', () => {
  it('returns turn-by-turn messages with role/content/timestamp in chronological order by default', async () => {
    let messagesSql = null;
    let messagesParams = null;
    mockQuery.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM sessions WHERE id')) {
        return { rows: [{ id: 's1', name: 'Auth refactor', session_type: 'implementation' }] };
      }
      if (sql.includes('SELECT COUNT(*)') && sql.includes('FROM messages')) {
        return { rows: [{ total: 3 }] };
      }
      if (sql.includes('FROM messages')) {
        messagesSql = sql;
        messagesParams = params;
        return {
          rows: [
            { id: 1, role: 'user', content: 'change the auth flow', timestamp: '2026-04-20T10:00:00Z' },
            { id: 2, role: 'assistant', content: 'understood, refactoring now', timestamp: '2026-04-20T10:00:05Z' },
            { id: 3, role: 'user', content: 'great, also update the tests', timestamp: '2026-04-20T10:01:00Z' },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await callTool('mc_get_session_messages', { session_id: 's1' });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.session_id).toBe('s1');
    expect(payload.total).toBe(3);
    expect(payload.count).toBe(3);
    expect(payload.offset).toBe(0);
    expect(payload.limit).toBe(100);
    expect(payload.order).toBe('asc');
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[0].role).toBe('user');
    expect(payload.messages[0].content).toBe('change the auth flow');
    expect(payload.messages[1].role).toBe('assistant');
    expect(payload.messages[1].content).toBe('understood, refactoring now');
    // Default response must NOT include tool_calls/tool_results.
    expect(payload.messages[0]).not.toHaveProperty('tool_calls');
    expect(payload.messages[0]).not.toHaveProperty('tool_results');
    // Query shape: ASC default order, limit + offset bound.
    expect(messagesSql).toMatch(/ORDER BY timestamp ASC, id ASC/);
    expect(messagesParams).toEqual(['s1', 100, 0]);
    // Default columns must not include tool_calls or tool_results.
    expect(messagesSql).not.toMatch(/tool_calls/);
    expect(messagesSql).not.toMatch(/tool_results/);
  });

  it('supports limit/offset pagination, descending order, and include_tool_calls', async () => {
    let messagesSql = null;
    let messagesParams = null;
    mockQuery.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM sessions WHERE id')) {
        return { rows: [{ id: 's2', name: 'x', session_type: 'implementation' }] };
      }
      if (sql.includes('SELECT COUNT(*)') && sql.includes('FROM messages')) {
        return { rows: [{ total: 50 }] };
      }
      if (sql.includes('FROM messages')) {
        messagesSql = sql;
        messagesParams = params;
        return {
          rows: [
            {
              id: 50,
              role: 'assistant',
              content: 'done',
              tool_calls: '[{"name":"Edit","args":{"file":"a.js"}}]',
              tool_results: '[{"ok":true}]',
              timestamp: '2026-04-20T11:00:00Z',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await callTool('mc_get_session_messages', {
      session_id: 's2',
      limit: 10,
      offset: 40,
      order: 'desc',
      include_tool_calls: true,
    });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.total).toBe(50);
    expect(payload.count).toBe(1);
    expect(payload.offset).toBe(40);
    expect(payload.limit).toBe(10);
    expect(payload.order).toBe('desc');
    expect(messagesSql).toMatch(/ORDER BY timestamp DESC, id DESC/);
    expect(messagesSql).toMatch(/tool_calls/);
    expect(messagesSql).toMatch(/tool_results/);
    expect(messagesParams).toEqual(['s2', 10, 40]);
    expect(payload.messages[0].tool_calls).toEqual([{ name: 'Edit', args: { file: 'a.js' } }]);
    expect(payload.messages[0].tool_results).toEqual([{ ok: true }]);
  });

  it('caps limit at 500 and floors invalid offsets at 0', async () => {
    let messagesParams = null;
    mockQuery.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM sessions WHERE id')) {
        return { rows: [{ id: 's3', name: 'x', session_type: 'implementation' }] };
      }
      if (sql.includes('SELECT COUNT(*)') && sql.includes('FROM messages')) {
        return { rows: [{ total: 0 }] };
      }
      if (sql.includes('FROM messages')) {
        messagesParams = params;
        return { rows: [] };
      }
      return { rows: [] };
    });
    const res = await callTool('mc_get_session_messages', {
      session_id: 's3',
      limit: 99999,
      offset: -10,
    });
    expect(res.result.isError).toBe(false);
    expect(messagesParams).toEqual(['s3', 500, 0]);
  });

  it('errors when the session is unknown', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [] }));
    const res = await callTool('mc_get_session_messages', { session_id: 'missing' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Session missing not found/);
  });

  it('rejects missing session_id', async () => {
    const res = await callTool('mc_get_session_messages', {});
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/session_id is required/);
  });
});

// Regression: production session_summaries tables created before created_at was
// added would error with `column "created_at" does not exist`. The migration
// must add it on every startup so mc_get_session_summary keeps working on
// older databases.
describe('schema migration: session_summaries.created_at', () => {
  it('database.js migrates session_summaries to add created_at', () => {
    const src = fs.readFileSync(databasePath, 'utf8');
    expect(src).toMatch(
      /ALTER TABLE session_summaries ADD COLUMN IF NOT EXISTS created_at/
    );
  });
});

// Parses server/database.js to build the actual column set for planning_questions
// (CREATE TABLE + ALTER ADD COLUMN), so the assertions below catch any reference
// to a column that doesn't exist in the live schema — not just SQL shape.
function planningQuestionsColumnsFromSchema() {
  const src = fs.readFileSync(databasePath, 'utf8');
  const cols = new Set();
  const create = src.match(/CREATE TABLE IF NOT EXISTS planning_questions\s*\(([\s\S]*?)\)`/);
  if (create) {
    for (const raw of create[1].split('\n')) {
      const line = raw.trim();
      const m = line.match(/^([a-z_][a-z0-9_]*)\s+(?:TEXT|INTEGER|TIMESTAMPTZ|JSONB|SERIAL|REAL|BOOLEAN)/i);
      if (m) cols.add(m[1]);
    }
  }
  for (const m of src.matchAll(/ALTER TABLE planning_questions ADD COLUMN IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)) {
    cols.add(m[1]);
  }
  return cols;
}

// Extracts every column-like identifier the SQL references on planning_questions.
// Catches both qualified `pq.col` refs (used in JOIN'd queries) and bare idents
// in SELECT / ORDER BY / WHERE for single-table queries against planning_questions.
function planningQuestionsColumnRefs(sql) {
  const refs = new Set();
  for (const m of sql.matchAll(/\bpq\.([a-z_][a-z0-9_]*)/gi)) refs.add(m[1]);
  if (/FROM\s+planning_questions\b/i.test(sql)) {
    const sel = sql.match(/SELECT\s+([\s\S]*?)\s+FROM\s+planning_questions/i);
    if (sel) {
      for (const tok of sel[1].split(',')) {
        const ident = tok.trim().replace(/\s+AS\s+\w+/i, '').trim();
        if (/^[a-z_][a-z0-9_]*$/i.test(ident)) refs.add(ident);
      }
    }
    const order = sql.match(/ORDER\s+BY\s+([a-z_][a-z0-9_]*)/i);
    if (order) refs.add(order[1]);
    const where = sql.match(/WHERE\s+([\s\S]+?)(?:ORDER\s+BY|LIMIT|$)/i);
    if (where) {
      for (const m of where[1].matchAll(/\b([a-z_][a-z0-9_]*)\s*=/gi)) refs.add(m[1]);
    }
  }
  return refs;
}

describe('schema validation: MCP session tools reference real planning_questions columns', () => {
  it('every column referenced by mc_search_sessions and mc_get_session_summary exists in the schema', async () => {
    const validCols = planningQuestionsColumnsFromSchema();
    // Sanity: parser found the schema we expect.
    expect(validCols.has('asked_at')).toBe(true);
    expect(validCols.has('planning_session_id')).toBe(true);
    expect(validCols.has('asking_session_id')).toBe(true);
    expect(validCols.has('created_at')).toBe(false); // the bug we caught

    let searchSql = null;
    let summarySql = null;
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM projects WHERE id')) return { rows: [{ id: 'p1' }] };
      if (sql.includes('FROM sessions s\n      LEFT JOIN LATERAL') || sql.includes('LEFT JOIN planning_questions pq')) {
        searchSql = sql; return { rows: [] };
      }
      if (sql.includes('FROM sessions s\n     LEFT JOIN pipelines')) {
        return { rows: [{
          id: 's1', name: 'x', session_type: 'i', status: 'idle', project_id: 'p1',
          pipeline_id: null, pipeline_stage: null, pipeline_pr_url: null,
          created_at: 'x', ended_at: null, last_activity_at: null,
          last_action_summary: null, branch: null, working_directory: null,
          lines_added: 0, lines_removed: 0,
          user_message_count: 0, assistant_message_count: 0, tool_call_count: 0,
        }]};
      }
      if (sql.includes('FROM planning_questions')) { summarySql = sql; return { rows: [] }; }
      return { rows: [] };
    });

    await callTool('mc_search_sessions', { project_id: 'p1', query: 'x' });
    await callTool('mc_get_session_summary', { session_id: 's1' });

    expect(searchSql).toBeTruthy();
    expect(summarySql).toBeTruthy();

    for (const col of planningQuestionsColumnRefs(searchSql)) {
      expect(validCols.has(col), `mc_search_sessions references unknown planning_questions column: ${col}`).toBe(true);
    }
    for (const col of planningQuestionsColumnRefs(summarySql)) {
      expect(validCols.has(col), `mc_get_session_summary references unknown planning_questions column: ${col}`).toBe(true);
    }
  });
});
