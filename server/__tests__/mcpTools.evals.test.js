/**
 * Unit tests for the MCP eval tools:
 *   mc_list_evals, mc_arm_folder, mc_run_evals, mc_get_eval_results,
 *   mc_author_eval, mc_edit_eval, mc_delete_eval.
 *
 * Each test creates a real temp directory with eval YAML files, mocks the
 * database to return that directory as the project's root_path, and runs the
 * tool through the MCP dispatcher (mirrors mcpTools.projectFiles.test.js).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATABASE_URL = 'postgresql://test:test@host.test/db';

const require = createRequire(import.meta.url);

const mockQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
const mockOrchestrator = {
  startPlanningSession: vi.fn(),
  sendAndAwait: vi.fn(),
  getStatus: vi.fn(),
};
const mockExecuteBatch = vi.fn(async () => ({
  batchId: 'batch-1',
  total: 0,
  passed: 0,
  failed: 0,
  errors: 0,
  status: 'complete',
  results: [],
}));

const databasePath = path.resolve(__dirname, '..', 'database.js');
const orchestratorPath = path.resolve(__dirname, '..', 'services', 'planningSessionOrchestrator.js');
const evalsRoutePath = path.resolve(__dirname, '..', 'routes', 'evals.js');

require.cache[databasePath] = {
  id: databasePath, filename: databasePath, loaded: true,
  exports: { query: mockQuery },
};
require.cache[orchestratorPath] = {
  id: orchestratorPath, filename: orchestratorPath, loaded: true,
  exports: mockOrchestrator,
};
require.cache[evalsRoutePath] = {
  id: evalsRoutePath, filename: evalsRoutePath, loaded: true,
  exports: { executeBatch: mockExecuteBatch, triggerEvalRun: vi.fn() },
};

const mcpServer = require('../services/mcpServer');
const mcpTools = require('../services/mcpTools');

// Stub the lazy ESM getter for the authoring service via the module.exports
// test seam so the AI authoring agent never spawns a real CLI subprocess.
// We also expose representative EVIDENCE_TYPES / CHECK_TYPES so the
// mc_get_eval_schema tool can be tested without loading the real ESM module.
const STUB_EVIDENCE_TYPES = {
  file: {
    description: 'Read the contents of a file',
    fields: { path: 'Required. Path to the file' },
  },
  db_query: {
    description: 'Run a SQL query against the project database',
    fields: { sql: 'Required. The SQL SELECT query to execute' },
  },
};
const STUB_CHECK_TYPES = {
  not_empty: {
    description: 'Evidence must not be empty or blank',
    fields: {},
  },
  regex_match: {
    description: 'Evidence must match a regular expression',
    fields: { pattern: 'Required. The regex pattern to match against the evidence' },
  },
};

mcpTools._getEvalAuthoring = async () => ({
  EVIDENCE_TYPES: STUB_EVIDENCE_TYPES,
  CHECK_TYPES: STUB_CHECK_TYPES,
  runAuthoring: async ({ description }) => ({
    eval: {
      name: 'authored_eval',
      description: description.slice(0, 80),
      evidence: { type: 'file', path: 'README.md' },
      input: {},
      checks: [{ type: 'not_empty' }],
    },
    reasoning: 'Mocked authoring result',
    error: null,
  }),
});

function makeTempProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-evals-'));
  fs.writeFileSync(path.join(tmp, 'README.md'), '# Hello\n');
  fs.mkdirSync(path.join(tmp, 'evals'));
  fs.mkdirSync(path.join(tmp, 'evals', 'group-a'));
  fs.writeFileSync(
    path.join(tmp, 'evals', 'group-a', 'check_one.yaml'),
    `name: check_one
description: Verify README is non-empty
evidence:
  type: file
  path: README.md
input: {}
checks:
  - type: not_empty
`
  );
  fs.writeFileSync(
    path.join(tmp, 'evals', 'group-a', 'wip.yaml.draft'),
    `name: wip
description: A work-in-progress draft eval
evidence:
  type: file
  path: README.md
input: {}
checks:
  - type: not_empty
`
  );
  return tmp;
}

function cleanupTmp(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

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
  mockExecuteBatch.mockClear();
});

describe('tools/list includes the eval tools', () => {
  it('exposes the seven eval-action tools and mc_get_eval_schema', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {}
    );
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('mc_list_evals');
    expect(names).toContain('mc_arm_folder');
    expect(names).toContain('mc_run_evals');
    expect(names).toContain('mc_get_eval_results');
    expect(names).toContain('mc_author_eval');
    expect(names).toContain('mc_edit_eval');
    expect(names).toContain('mc_delete_eval');
    expect(names).toContain('mc_get_eval_schema');
  });
});

describe('mc_get_eval_schema', () => {
  it('returns evidence types, check types, judge guidance, variables, rules, and an example', async () => {
    const res = await callTool('mc_get_eval_schema', {});
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);

    expect(Array.isArray(payload.valid_evidence_types)).toBe(true);
    expect(Array.isArray(payload.valid_check_types)).toBe(true);
    expect(payload.valid_evidence_types).toContain('log_query');
    expect(payload.valid_check_types).toContain('not_empty');

    expect(Array.isArray(payload.evidence_types)).toBe(true);
    const fileType = payload.evidence_types.find((e) => e.type === 'file');
    expect(fileType).toBeTruthy();
    expect(fileType.description).toMatch(/Read the contents/i);
    expect(fileType.fields.find((f) => f.name === 'path')).toBeTruthy();

    expect(Array.isArray(payload.check_types)).toBe(true);
    const regexCheck = payload.check_types.find((c) => c.type === 'regex_match');
    expect(regexCheck).toBeTruthy();
    expect(regexCheck.fields.find((f) => f.name === 'pattern')).toBeTruthy();

    expect(payload.judge.required_fields_when_used).toContain('judge_prompt');
    expect(payload.judge.required_fields_when_used).toContain('expected');

    expect(payload.required_fields).toContain('name');
    expect(payload.required_fields).toContain('evidence');
    expect(payload.one_of_required).toContain('checks');
    expect(payload.one_of_required).toContain('judge_prompt');
    expect(Array.isArray(payload.rules)).toBe(true);

    expect(payload.example).toContain('name:');
    expect(payload.example).toContain('evidence:');
    expect(payload.example).toContain('checks:');
  });
});

describe('mc_list_evals', () => {
  it('returns folders, live evals, and drafts with relative paths', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('FROM projects WHERE id')) {
        return { rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }] };
      }
      if (sql.includes('FROM eval_armed_folders')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const res = await callTool('mc_list_evals', { project_id: 'p1' });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.project_id).toBe('p1');
    expect(payload.folders).toHaveLength(1);
    const folder = payload.folders[0];
    expect(folder.folder_name).toBe('group-a');
    expect(folder.folder_path).toBe(path.join('evals', 'group-a'));
    expect(folder.armed).toBe(false);
    expect(folder.evals).toHaveLength(2);
    const live = folder.evals.find((e) => e.name === 'check_one');
    const draft = folder.evals.find((e) => e.name === 'wip');
    expect(live.is_draft).toBe(false);
    expect(draft.is_draft).toBe(true);
    expect(live.evidence_type).toBe('file');
    cleanupTmp(tmp);
  });

  it('marks folders as armed when present in eval_armed_folders', async () => {
    const tmp = makeTempProject();
    const absFolder = path.join(tmp, 'evals', 'group-a');
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('FROM projects WHERE id')) {
        return { rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }] };
      }
      if (sql.includes('FROM eval_armed_folders')) {
        return { rows: [{ folder_path: absFolder, triggers: 'manual,session_end', auto_send: 1 }] };
      }
      return { rows: [] };
    });
    const res = await callTool('mc_list_evals', { project_id: 'p1' });
    const folder = payloadOf(res).folders[0];
    expect(folder.armed).toBe(true);
    expect(folder.triggers).toBe('manual,session_end');
    expect(folder.auto_send).toBe(true);
    cleanupTmp(tmp);
  });

  it('rejects missing project_id', async () => {
    const res = await callTool('mc_list_evals', {});
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/project_id is required/);
  });
});

describe('mc_arm_folder', () => {
  it('arms a folder by inserting into eval_armed_folders', async () => {
    const tmp = makeTempProject();
    const absFolder = path.join(tmp, 'evals', 'group-a');
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('FROM projects WHERE id')) {
        return { rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }] };
      }
      if (sql.includes('INSERT INTO eval_armed_folders')) {
        return { rows: [{ folder_path: absFolder, folder_name: 'group-a', triggers: 'manual', auto_send: 0 }] };
      }
      return { rows: [] };
    });
    const res = await callTool('mc_arm_folder', {
      project_id: 'p1',
      folder_path: 'evals/group-a',
      armed: true,
    });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.armed).toBe(true);
    expect(payload.folder_name).toBe('group-a');
    cleanupTmp(tmp);
  });

  it('disarms a folder by deleting from eval_armed_folders', async () => {
    const tmp = makeTempProject();
    let deleted = false;
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('FROM projects WHERE id')) {
        return { rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }] };
      }
      if (sql.includes('DELETE FROM eval_armed_folders')) {
        deleted = true;
        return { rows: [] };
      }
      return { rows: [] };
    });
    const res = await callTool('mc_arm_folder', {
      project_id: 'p1',
      folder_path: 'evals/group-a',
      armed: false,
    });
    expect(res.result.isError).toBe(false);
    expect(payloadOf(res).armed).toBe(false);
    expect(deleted).toBe(true);
    cleanupTmp(tmp);
  });

  it('rejects nonexistent folder', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementation(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }],
    }));
    const res = await callTool('mc_arm_folder', {
      project_id: 'p1',
      folder_path: 'evals/does-not-exist',
      armed: true,
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/does not exist/);
    cleanupTmp(tmp);
  });
});

describe('mc_run_evals', () => {
  it('calls executeBatch with mcp_client trigger and returns the summary', async () => {
    mockExecuteBatch.mockImplementationOnce(async () => ({
      batchId: 'batch-42',
      total: 2,
      passed: 1,
      failed: 1,
      errors: 0,
      status: 'complete',
      results: [
        { evalName: 'check_one', evalFolder: '/abs/group-a', state: 'pass', duration: 100 },
        { evalName: 'check_two', evalFolder: '/abs/group-a', state: 'fail', failReason: 'mismatch', duration: 200 },
      ],
    }));
    const res = await callTool('mc_run_evals', { project_id: 'p1' });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.batch_id).toBe('batch-42');
    expect(payload.total).toBe(2);
    expect(payload.passed).toBe(1);
    expect(payload.failed).toBe(1);
    expect(payload.results).toHaveLength(2);
    expect(payload.results[1].state).toBe('fail');
    expect(payload.results[1].fail_reason).toBe('mismatch');
    expect(mockExecuteBatch).toHaveBeenCalledWith('p1', 'mcp_client', null, null);
  });

  it('handles no-armed-folders case gracefully', async () => {
    mockExecuteBatch.mockImplementationOnce(async () => ({
      message: 'No armed eval folders',
      total: 0,
    }));
    const res = await callTool('mc_run_evals', { project_id: 'p1' });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.total).toBe(0);
    expect(payload.status).toBe('no_armed_folders');
  });
});

describe('mc_get_eval_results', () => {
  it('returns the batch metadata and per-run details', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('FROM eval_batches WHERE id')) {
        return {
          rows: [{
            id: 'batch-7', project_id: 'p1', trigger_source: 'mcp_client',
            status: 'complete', total: 1, passed: 1, failed: 0, errors: 0,
            started_at: '2026-04-27T00:00:00Z', completed_at: '2026-04-27T00:01:00Z',
          }],
        };
      }
      if (sql.includes('FROM eval_runs WHERE batch_id')) {
        return {
          rows: [{
            eval_name: 'check_one', eval_folder: '/abs/group-a', state: 'pass',
            fail_reason: null, error_message: null, duration: 250, timestamp: '2026-04-27T00:00:30Z',
          }],
        };
      }
      return { rows: [] };
    });
    const res = await callTool('mc_get_eval_results', { batch_id: 'batch-7' });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.batch_id).toBe('batch-7');
    expect(payload.total).toBe(1);
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0].eval_name).toBe('check_one');
    expect(payload.runs[0].state).toBe('pass');
  });

  it('errors when batch_id is unknown', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [] }));
    const res = await callTool('mc_get_eval_results', { batch_id: 'missing' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Batch missing not found/);
  });
});

describe('mc_author_eval', () => {
  it('runs the authoring agent and writes a published .yaml', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementation(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }],
    }));
    const res = await callTool('mc_author_eval', {
      project_id: 'p1',
      folder_path: 'evals/group-a',
      description: 'Check that README contains a heading',
    });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.eval_name).toBe('authored_eval');
    expect(payload.file_path).toBe(path.join('evals', 'group-a', 'authored_eval.yaml'));
    // The file is actually written and parseable.
    const onDisk = fs.readFileSync(path.join(tmp, payload.file_path), 'utf8');
    expect(onDisk).toContain('name: authored_eval');
    expect(onDisk).toContain('type: file');
    cleanupTmp(tmp);
  });

  it('rejects when an eval with the same name already exists', async () => {
    const tmp = makeTempProject();
    // Pre-create an authored_eval.yaml so the next author call collides.
    fs.writeFileSync(
      path.join(tmp, 'evals', 'group-a', 'authored_eval.yaml'),
      'name: authored_eval\ndescription: pre-existing\nevidence:\n  type: file\n  path: README.md\ninput: {}\nchecks:\n  - type: not_empty\n'
    );
    mockQuery.mockImplementation(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }],
    }));
    const res = await callTool('mc_author_eval', {
      project_id: 'p1',
      folder_path: 'evals/group-a',
      description: 'Anything',
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/already exists/);
    cleanupTmp(tmp);
  });
});

describe('mc_edit_eval', () => {
  it('rewrites an existing eval with new content', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementation(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }],
    }));
    const res = await callTool('mc_edit_eval', {
      project_id: 'p1',
      file_path: path.join('evals', 'group-a', 'check_one.yaml'),
      name: 'check_one_revised',
      description: 'Updated description for the check',
      evidence: { type: 'file', path: 'README.md' },
      input: {},
      checks: [{ type: 'not_empty' }, { type: 'regex_match', pattern: '^# ' }],
    });
    expect(res.result.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.eval_name).toBe('check_one_revised');
    const onDisk = fs.readFileSync(path.join(tmp, 'evals', 'group-a', 'check_one.yaml'), 'utf8');
    expect(onDisk).toContain('name: check_one_revised');
    expect(onDisk).toContain('regex_match');
    cleanupTmp(tmp);
  });

  it('rolls back to prior content when the new YAML fails validation', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementation(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }],
    }));
    const filePath = path.join('evals', 'group-a', 'check_one.yaml');
    const before = fs.readFileSync(path.join(tmp, filePath), 'utf8');
    const res = await callTool('mc_edit_eval', {
      project_id: 'p1',
      file_path: filePath,
      name: 'broken',
      description: 'Trying to use an invalid evidence type',
      evidence: { type: 'not_a_real_type' },
      input: {},
      checks: [{ type: 'not_empty' }],
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Invalid evidence type/);
    const after = fs.readFileSync(path.join(tmp, filePath), 'utf8');
    expect(after).toBe(before);
    cleanupTmp(tmp);
  });

  it('errors when file_path does not exist', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementation(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }],
    }));
    const res = await callTool('mc_edit_eval', {
      project_id: 'p1',
      file_path: 'evals/group-a/missing.yaml',
      name: 'x',
      description: 'x',
      evidence: { type: 'file', path: 'README.md' },
      input: {},
      checks: [{ type: 'not_empty' }],
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/not found/);
    cleanupTmp(tmp);
  });
});

describe('mc_delete_eval', () => {
  it('deletes a published eval file', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementation(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }],
    }));
    const filePath = path.join('evals', 'group-a', 'check_one.yaml');
    expect(fs.existsSync(path.join(tmp, filePath))).toBe(true);
    const res = await callTool('mc_delete_eval', {
      project_id: 'p1',
      file_path: filePath,
    });
    expect(res.result.isError).toBe(false);
    expect(payloadOf(res).deleted).toBe(true);
    expect(fs.existsSync(path.join(tmp, filePath))).toBe(false);
    cleanupTmp(tmp);
  });

  it('deletes a draft eval file', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementation(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }],
    }));
    const filePath = path.join('evals', 'group-a', 'wip.yaml.draft');
    const res = await callTool('mc_delete_eval', {
      project_id: 'p1',
      file_path: filePath,
    });
    expect(res.result.isError).toBe(false);
    expect(fs.existsSync(path.join(tmp, filePath))).toBe(false);
    cleanupTmp(tmp);
  });

  it('rejects file paths that are not yaml/draft', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementation(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp, config: null }],
    }));
    const res = await callTool('mc_delete_eval', {
      project_id: 'p1',
      file_path: 'README.md',
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/must reference a/);
    cleanupTmp(tmp);
  });
});
