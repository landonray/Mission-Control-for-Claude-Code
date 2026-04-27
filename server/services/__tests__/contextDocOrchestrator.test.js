import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const orchestrator = await import('../contextDocOrchestrator.js');

function flushPromises() {
  return new Promise(resolve => setImmediate(resolve));
}

// A minimal fake DB that simulates the rows the orchestrator reads/writes.
function createFakeDb({ project, existingExtractions = [] }) {
  // run row state
  const runs = new Map();
  const extractions = new Map(existingExtractions.map(e => [e.pr_number, e]));

  const query = vi.fn(async (sql, params = []) => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();

    if (trimmed.startsWith('SELECT id, name, root_path, github_repo FROM projects')) {
      return { rows: project ? [project] : [], rowCount: project ? 1 : 0 };
    }

    if (trimmed.startsWith('SELECT id FROM context_doc_runs')) {
      // Looking for active run — only return one if status==='running' exists
      const active = [...runs.values()].find(r => r.status === 'running' && r.project_id === params[0]);
      return { rows: active ? [{ id: active.id }] : [], rowCount: active ? 1 : 0 };
    }

    if (trimmed.startsWith('SELECT id, project_id, status, phase')) {
      // Either getRunById (where id = $1) or getLatestRun (where project_id = $1).
      const looksLikeId = sql.includes('WHERE id = $1');
      const target = looksLikeId
        ? runs.get(params[0])
        : [...runs.values()].filter(r => r.project_id === params[0]).sort((a, b) => b.created_at - a.created_at)[0];
      return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
    }

    if (trimmed.startsWith('SELECT log_lines FROM context_doc_runs')) {
      const r = runs.get(params[0]);
      return { rows: [{ log_lines: r?.log_lines || [] }], rowCount: 1 };
    }

    if (trimmed.startsWith('INSERT INTO context_doc_runs')) {
      const [id, project_id, , phase] = params;
      runs.set(id, {
        id, project_id, status: 'running', phase,
        prs_total: 0, prs_extracted: 0,
        batches_total: 0, batches_done: 0,
        log_lines: [], created_at: Date.now(), completed_at: null,
        error_message: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (trimmed.startsWith('UPDATE context_doc_runs SET log_lines')) {
      // params: [JSON string, runId]
      const r = runs.get(params[1]);
      if (r) r.log_lines = JSON.parse(params[0]);
      return { rows: [], rowCount: 1 };
    }

    if (trimmed.startsWith('UPDATE context_doc_runs SET status = \'completed\'')) {
      const r = runs.get(params[0]);
      if (r) { r.status = 'completed'; r.phase = 'completed'; r.completed_at = Date.now(); }
      return { rows: [], rowCount: 1 };
    }

    if (trimmed.startsWith('UPDATE context_doc_runs SET status = \'failed\'')) {
      const r = runs.get(params[1]);
      if (r) { r.status = 'failed'; r.phase = 'failed'; r.error_message = params[0]; r.completed_at = Date.now(); }
      return { rows: [], rowCount: 1 };
    }

    if (trimmed.startsWith('UPDATE context_doc_runs SET')) {
      // Generic field update — params end with runId. Parse field names from SQL.
      const setClause = sql.match(/SET (.+?) WHERE/i)?.[1] || '';
      const parts = setClause.split(',').map(p => p.trim());
      const runId = params[params.length - 1];
      const r = runs.get(runId);
      if (r) {
        parts.forEach((p, i) => {
          const fieldName = p.split('=')[0].trim();
          r[fieldName] = params[i];
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (trimmed.startsWith('SELECT pr_number FROM context_doc_extractions')) {
      const projectId = params[0];
      const numbers = params[1] || [];
      const matched = [...extractions.values()]
        .filter(e => e.project_id === projectId && numbers.includes(e.pr_number));
      return { rows: matched.map(e => ({ pr_number: e.pr_number })), rowCount: matched.length };
    }

    if (trimmed.startsWith('SELECT pr_number, pr_title, pr_url, pr_merged_at, extraction')) {
      const projectId = params[0];
      const numbers = params[1] || [];
      const matched = [...extractions.values()]
        .filter(e => e.project_id === projectId && numbers.includes(e.pr_number))
        .sort((a, b) => String(a.pr_merged_at).localeCompare(String(b.pr_merged_at)));
      return { rows: matched, rowCount: matched.length };
    }

    if (trimmed.startsWith('INSERT INTO context_doc_extractions')) {
      const [project_id, pr_number, pr_title, pr_url, pr_merged_at, extraction] = params;
      extractions.set(pr_number, {
        project_id, pr_number, pr_title, pr_url, pr_merged_at,
        extraction: typeof extraction === 'string' ? JSON.parse(extraction) : extraction,
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in fake db: ${trimmed.slice(0, 120)}`);
  });

  return { query, runs, extractions };
}

describe('contextDocOrchestrator', () => {
  let db;
  let writes;
  let broadcasts;
  let project;

  beforeEach(() => {
    project = { id: 'p1', name: 'Project One', root_path: '/tmp/p1', github_repo: 'octo/p1' };
    db = createFakeDb({ project });
    writes = [];
    broadcasts = [];

    orchestrator._setForTests({
      query: db.query,
      listMergedPRs: vi.fn().mockResolvedValue([
        { number: 1, title: 'first', body: '', merged_at: '2026-01-01', url: 'u1' },
        { number: 2, title: 'second', body: '', merged_at: '2026-01-02', url: 'u2' },
      ]),
      fetchPRDetails: vi.fn().mockImplementation(async (_repo, n) => ({
        number: n, diff: 'D', diff_truncated: false,
      })),
      extractPR: vi.fn().mockImplementation(async (pr) => ({
        extraction: {
          what_changed: `pr ${pr.number}`,
          why: '',
          product_decisions: [],
          architectural_decisions: [],
          patterns_established: [],
          patterns_broken: [],
          files_touched: [],
          is_mechanical: false,
        },
        raw: '{}',
      })),
      rollupBatch: vi.fn().mockResolvedValue('# Batch\n'),
      rollupFinal: vi.fn().mockResolvedValue({ product: '# Product\n', architecture: '# Architecture\n' }),
      writeFile: vi.fn().mockImplementation(async (p, c) => { writes.push({ path: p, content: c }); }),
    });

    orchestrator.setBroadcast(msg => broadcasts.push(msg));
  });

  afterEach(() => {
    orchestrator._resetForTests();
    orchestrator.setBroadcast(null);
  });

  it('starts a run and runs the full pipeline to completion', async () => {
    const runId = await orchestrator.startGeneration('p1');
    expect(runId).toMatch(/-/);

    // Wait for the background pipeline to complete.
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    // Run should be marked completed
    const finalRun = [...db.runs.values()][0];
    expect(finalRun.status).toBe('completed');
    expect(finalRun.prs_total).toBe(2);
    expect(finalRun.prs_extracted).toBe(2);
    expect(finalRun.batches_total).toBe(1);
    expect(finalRun.batches_done).toBe(1);

    // Files should have been written
    expect(writes).toHaveLength(2);
    const productWrite = writes.find(w => w.path.endsWith('PRODUCT.md'));
    const archWrite = writes.find(w => w.path.endsWith('ARCHITECTURE.md'));
    expect(productWrite.content).toContain('# Product');
    expect(archWrite.content).toContain('# Architecture');

    // Broadcasts should include start, progress, and completed events
    const types = broadcasts.map(b => b.type);
    expect(types).toContain('context_doc_run_started');
    expect(types).toContain('context_doc_run_completed');

    // Two extractions persisted
    expect(db.extractions.size).toBe(2);
  });

  it('rejects a second run while one is already in progress', async () => {
    // Start a run; don't wait for it to complete.
    const firstId = await orchestrator.startGeneration('p1');
    expect(firstId).toBeDefined();

    await expect(orchestrator.startGeneration('p1')).rejects.toMatchObject({ code: 'CONCURRENT_RUN' });

    // Drain the pipeline so we don't leak.
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();
  });

  it('throws PROJECT_NOT_FOUND when the project does not exist', async () => {
    db = createFakeDb({ project: null });
    orchestrator._setForTests({ query: db.query });
    await expect(orchestrator.startGeneration('missing'))
      .rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('throws NO_GITHUB_REPO when the project has no github_repo and no git remote', async () => {
    project = { id: 'p1', name: 'p1', root_path: '/x', github_repo: null };
    db = createFakeDb({ project });
    orchestrator._setForTests({
      query: db.query,
      detectGithubRepoFromGit: vi.fn().mockReturnValue(null),
    });
    await expect(orchestrator.startGeneration('p1'))
      .rejects.toMatchObject({ code: 'NO_GITHUB_REPO' });
  });

  it('falls back to detecting github_repo from the project folder git remote', async () => {
    project = { id: 'p1', name: 'Project One', root_path: '/tmp/p1', github_repo: null };
    db = createFakeDb({ project });
    const detectGithubRepoFromGit = vi.fn().mockReturnValue('octo/p1');
    const listMergedPRs = vi.fn().mockResolvedValue([
      { number: 1, title: 'first', body: '', merged_at: '2026-01-01', url: 'u1' },
    ]);

    orchestrator._setForTests({
      query: db.query,
      detectGithubRepoFromGit,
      listMergedPRs,
      fetchPRDetails: vi.fn().mockImplementation(async (_repo, n) => ({
        number: n, diff: 'D', diff_truncated: false,
      })),
      extractPR: vi.fn().mockResolvedValue({
        extraction: {
          what_changed: 'x', why: '',
          product_decisions: [], architectural_decisions: [],
          patterns_established: [], patterns_broken: [],
          files_touched: [], is_mechanical: false,
        },
        raw: '{}',
      }),
      rollupBatch: vi.fn().mockResolvedValue('# Batch\n'),
      rollupFinal: vi.fn().mockResolvedValue({ product: '# P\n', architecture: '# A\n' }),
      writeFile: vi.fn().mockResolvedValue(undefined),
    });

    const runId = await orchestrator.startGeneration('p1');
    expect(runId).toMatch(/-/);

    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(detectGithubRepoFromGit).toHaveBeenCalledWith('/tmp/p1');
    expect(listMergedPRs).toHaveBeenCalledWith('octo/p1');
  });

  it('marks the run as failed when no merged PRs are found', async () => {
    orchestrator._setForTests({
      query: db.query,
      listMergedPRs: vi.fn().mockResolvedValue([]),
    });

    await orchestrator.startGeneration('p1');
    await flushPromises();
    await flushPromises();

    const r = [...db.runs.values()][0];
    expect(r.status).toBe('failed');
    expect(r.error_message).toMatch(/No merged PRs/);
  });

  it('reuses cached extractions on retry', async () => {
    const cached = [{
      project_id: 'p1', pr_number: 1, pr_title: 'first', pr_url: 'u1', pr_merged_at: '2026-01-01',
      extraction: { what_changed: 'cached', is_mechanical: false, files_touched: [], product_decisions: [], architectural_decisions: [], patterns_established: [], patterns_broken: [], why: '' },
    }];
    db = createFakeDb({ project, existingExtractions: cached });
    const extractPR = vi.fn().mockImplementation(async (pr) => ({
      extraction: { what_changed: `pr ${pr.number}` },
      raw: '{}',
    }));

    orchestrator._setForTests({
      query: db.query,
      listMergedPRs: vi.fn().mockResolvedValue([
        { number: 1, title: 'first', body: '', merged_at: '2026-01-01', url: 'u1' },
        { number: 2, title: 'second', body: '', merged_at: '2026-01-02', url: 'u2' },
      ]),
      fetchPRDetails: vi.fn().mockImplementation(async (_r, n) => ({ number: n, diff: '', diff_truncated: false })),
      extractPR,
      rollupBatch: vi.fn().mockResolvedValue('batch'),
      rollupFinal: vi.fn().mockResolvedValue({ product: 'P', architecture: 'A' }),
      writeFile: vi.fn(),
    });

    await orchestrator.startGeneration('p1');
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    // Only PR #2 should have been extracted; #1 was reused from cache.
    expect(extractPR).toHaveBeenCalledTimes(1);
    expect(extractPR.mock.calls[0][0].number).toBe(2);
  });

  describe('recoverInterruptedRuns', () => {
    it('marks orphaned running rows as failed with an "interrupted" message', async () => {
      // Seed two running rows and one already-completed row.
      const queryFn = vi.fn(async (sql) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        if (trimmed.startsWith("SELECT id, project_id FROM context_doc_runs WHERE status = 'running'")) {
          return { rows: [
            { id: 'run-a', project_id: 'p1' },
            { id: 'run-b', project_id: 'p2' },
          ], rowCount: 2 };
        }
        if (trimmed.startsWith("UPDATE context_doc_runs SET status = 'failed'")) {
          return { rows: [], rowCount: 1 };
        }
        if (trimmed.startsWith('SELECT id, project_id, status, phase')) {
          // getRunById call after the UPDATE — return a representative row.
          return { rows: [{
            id: 'x', project_id: 'p', status: 'failed', phase: 'failed',
            prs_total: 0, prs_extracted: 0, batches_total: 0, batches_done: 0,
            error_message: 'Interrupted by server restart', log_lines: [],
            created_at: '2026-04-26', completed_at: '2026-04-26',
          }], rowCount: 1 };
        }
        throw new Error(`Unhandled SQL: ${trimmed}`);
      });

      orchestrator._setForTests({ query: queryFn });
      const captured = [];
      orchestrator.setBroadcast(msg => captured.push(msg));

      const recovered = await orchestrator.recoverInterruptedRuns();

      expect(recovered).toBe(2);
      // The function should have issued one UPDATE per orphaned row marking
      // it as failed with a clear interruption message that the frontend can
      // detect (used to label the button "Resume").
      const updateCalls = queryFn.mock.calls.filter(c =>
        c[0].includes("status = 'failed'")
      );
      expect(updateCalls).toHaveLength(2);
      for (const call of updateCalls) {
        const params = call[1];
        // params: [errorMessage, runId]
        expect(params[0]).toMatch(/Interrupted by server restart/i);
      }
      // Should broadcast a completion event for each so the UI updates live.
      const completedBroadcasts = captured.filter(b => b.type === 'context_doc_run_completed');
      expect(completedBroadcasts).toHaveLength(2);
    });

    it('returns 0 and does nothing when there are no orphaned runs', async () => {
      const queryFn = vi.fn(async (sql) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        if (trimmed.startsWith("SELECT id, project_id FROM context_doc_runs WHERE status = 'running'")) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`Unhandled SQL: ${trimmed}`);
      });

      orchestrator._setForTests({ query: queryFn });

      const recovered = await orchestrator.recoverInterruptedRuns();
      expect(recovered).toBe(0);
      // No update calls were issued.
      const updateCalls = queryFn.mock.calls.filter(c =>
        String(c[0]).includes("UPDATE context_doc_runs")
      );
      expect(updateCalls).toHaveLength(0);
    });
  });

  it('records a failure when the final rollup throws', async () => {
    orchestrator._setForTests({
      query: db.query,
      listMergedPRs: vi.fn().mockResolvedValue([
        { number: 1, title: 't', body: '', merged_at: '2026-01-01', url: 'u' },
      ]),
      fetchPRDetails: vi.fn().mockResolvedValue({ number: 1, diff: '', diff_truncated: false }),
      extractPR: vi.fn().mockResolvedValue({ extraction: { what_changed: 'x' }, raw: '{}' }),
      rollupBatch: vi.fn().mockResolvedValue('batch'),
      rollupFinal: vi.fn().mockRejectedValue(new Error('synthesis blew up')),
      writeFile: vi.fn(),
    });

    await orchestrator.startGeneration('p1');
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    const r = [...db.runs.values()][0];
    expect(r.status).toBe('failed');
    expect(r.error_message).toMatch(/synthesis blew up/);
  });
});
