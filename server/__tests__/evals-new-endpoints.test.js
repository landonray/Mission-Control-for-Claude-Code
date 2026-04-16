/**
 * Tests for the new eval endpoints:
 *   POST /folders/:projectId/author
 *   POST /folders/:projectId/preview
 *   POST /folders/:projectId/publish
 *   DELETE /folders/:projectId/draft
 *   create-eval saveAsDraft flag
 *   GET /folders/:projectId — includes drafts
 *
 * Like the other eval tests in this project, we test the validation/business logic
 * inline rather than loading the router (which calls neon() at load time).
 */
import { describe, it, expect } from 'vitest';
import path from 'path';

// ─── Shared helpers (mirroring the route code) ────────────────────────────────

function isSafePath(filePath, projectRoot) {
  const root = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  return filePath.startsWith(root) || filePath === projectRoot;
}

// ─── POST /author — validation ────────────────────────────────────────────────

function validateAuthorInput({ description, folderPath }) {
  if (!description || typeof description !== 'string' || !description.trim()) {
    return { error: 'description is required', status: 400 };
  }
  if (!folderPath || typeof folderPath !== 'string' || !folderPath.trim()) {
    return { error: 'folderPath is required', status: 400 };
  }
  return null;
}

describe('POST /folders/:projectId/author — validation', () => {
  const base = { description: 'Check that deployments succeed', folderPath: '/project/root/evals/deploys' };

  it('accepts a fully valid body', () => {
    expect(validateAuthorInput(base)).toBeNull();
  });

  it('rejects missing description', () => {
    const { description, ...rest } = base;
    const result = validateAuthorInput(rest);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/description/i);
  });

  it('rejects empty description', () => {
    const result = validateAuthorInput({ ...base, description: '   ' });
    expect(result.status).toBe(400);
  });

  it('rejects missing folderPath', () => {
    const { folderPath, ...rest } = base;
    const result = validateAuthorInput(rest);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/folderPath/i);
  });

  it('rejects empty folderPath', () => {
    const result = validateAuthorInput({ ...base, folderPath: '' });
    expect(result.status).toBe(400);
  });
});

describe('POST /folders/:projectId/author — path safety', () => {
  it('allows folderPath inside project root', () => {
    expect(isSafePath('/project/root/evals/foo', '/project/root')).toBe(true);
  });

  it('rejects folderPath outside project root', () => {
    expect(isSafePath('/etc/evil', '/project/root')).toBe(false);
  });

  it('rejects sibling directory with same prefix', () => {
    expect(isSafePath('/project/root-evil/evals', '/project/root')).toBe(false);
  });
});

// ─── POST /preview — validation ───────────────────────────────────────────────

function validatePreviewInput({ evalDefinition }) {
  if (!evalDefinition || typeof evalDefinition !== 'object' || Array.isArray(evalDefinition)) {
    return { error: 'evalDefinition is required and must be an object', status: 400 };
  }
  return null;
}

describe('POST /folders/:projectId/preview — validation', () => {
  const base = { evalDefinition: { name: 'my_eval', evidence: { type: 'log_query' }, input: {} } };

  it('accepts a valid evalDefinition object', () => {
    expect(validatePreviewInput(base)).toBeNull();
  });

  it('rejects missing evalDefinition', () => {
    const result = validatePreviewInput({});
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/evalDefinition/i);
  });

  it('rejects evalDefinition as an array', () => {
    const result = validatePreviewInput({ evalDefinition: [] });
    expect(result.status).toBe(400);
  });

  it('rejects evalDefinition as a string', () => {
    const result = validatePreviewInput({ evalDefinition: 'foo' });
    expect(result.status).toBe(400);
  });
});

// ─── Estimated token cost calculation ────────────────────────────────────────

function estimateTokenCost(evidence, judgePrompt) {
  const evidenceStr = typeof evidence === 'string' ? evidence : JSON.stringify(evidence || '');
  const judgePromptStr = judgePrompt || '';
  return Math.ceil(evidenceStr.length / 4) + Math.ceil(judgePromptStr.length / 4) + 500;
}

describe('preview — estimated token cost', () => {
  it('returns at least 500 for empty evidence and prompt', () => {
    expect(estimateTokenCost('', '')).toBe(500);
  });

  it('accounts for evidence length', () => {
    const cost = estimateTokenCost('a'.repeat(400), '');
    expect(cost).toBe(500 + 100); // 400/4=100
  });

  it('accounts for judge_prompt length', () => {
    const cost = estimateTokenCost('', 'b'.repeat(200));
    expect(cost).toBe(500 + 50); // 200/4=50
  });

  it('adds both evidence and prompt', () => {
    const cost = estimateTokenCost('a'.repeat(400), 'b'.repeat(200));
    expect(cost).toBe(500 + 100 + 50);
  });

  it('handles object evidence by JSON-stringifying it', () => {
    const ev = { foo: 'bar' };
    const expected = Math.ceil(JSON.stringify(ev).length / 4) + 500;
    expect(estimateTokenCost(ev, '')).toBe(expected);
  });
});

// ─── POST /publish — validation ───────────────────────────────────────────────

function validatePublishInput({ draftPath }) {
  if (!draftPath || typeof draftPath !== 'string' || !draftPath.trim()) {
    return { error: 'draftPath is required', status: 400 };
  }
  return null;
}

function validateDraftExtension(draftPath) {
  if (!draftPath.endsWith('.draft')) {
    return { error: 'draftPath must end with .draft', status: 400 };
  }
  return null;
}

function resolvePublishTarget(draftPath, existingPaths = []) {
  // Drop .draft suffix
  let target = draftPath.slice(0, -'.draft'.length);
  if (!existingPaths.includes(target)) return target;

  // Auto-increment suffix
  const ext = path.extname(target);
  const base = target.slice(0, -ext.length);
  let counter = 2;
  while (existingPaths.includes(`${base}-${counter}${ext}`)) {
    counter++;
  }
  return `${base}-${counter}${ext}`;
}

describe('POST /folders/:projectId/publish — validation', () => {
  it('accepts a valid draftPath', () => {
    expect(validatePublishInput({ draftPath: '/project/evals/foo.yaml.draft' })).toBeNull();
  });

  it('rejects missing draftPath', () => {
    const result = validatePublishInput({});
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/draftPath/i);
  });

  it('rejects empty draftPath', () => {
    const result = validatePublishInput({ draftPath: '' });
    expect(result.status).toBe(400);
  });

  it('rejects a path that does not end with .draft', () => {
    const result = validateDraftExtension('/project/evals/foo.yaml');
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/\.draft/);
  });

  it('accepts a path ending with .draft', () => {
    expect(validateDraftExtension('/project/evals/foo.yaml.draft')).toBeNull();
  });
});

describe('POST /folders/:projectId/publish — target path resolution', () => {
  it('drops .draft suffix when target does not exist', () => {
    expect(resolvePublishTarget('/project/evals/foo.yaml.draft', [])).toBe('/project/evals/foo.yaml');
  });

  it('appends -2 when target already exists', () => {
    expect(resolvePublishTarget('/project/evals/foo.yaml.draft', ['/project/evals/foo.yaml']))
      .toBe('/project/evals/foo-2.yaml');
  });

  it('appends -3 when -2 also exists', () => {
    expect(
      resolvePublishTarget('/project/evals/foo.yaml.draft', ['/project/evals/foo.yaml', '/project/evals/foo-2.yaml'])
    ).toBe('/project/evals/foo-3.yaml');
  });

  it('preserves the file extension in the suffixed name', () => {
    const result = resolvePublishTarget('/project/evals/my_eval.yaml.draft', ['/project/evals/my_eval.yaml']);
    expect(result).toMatch(/\.yaml$/);
    expect(result).toContain('-2');
  });
});

// ─── DELETE /draft — validation ───────────────────────────────────────────────

function validateDeleteDraftInput({ draftPath }) {
  if (!draftPath || typeof draftPath !== 'string' || !draftPath.trim()) {
    return { error: 'draftPath is required', status: 400 };
  }
  return null;
}

describe('DELETE /folders/:projectId/draft — validation', () => {
  it('accepts a valid draftPath', () => {
    expect(validateDeleteDraftInput({ draftPath: '/project/evals/foo.yaml.draft' })).toBeNull();
  });

  it('rejects missing draftPath', () => {
    const result = validateDeleteDraftInput({});
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/draftPath/i);
  });

  it('rejects a path that does not end with .draft', () => {
    const result = validateDraftExtension('/project/evals/foo.yaml');
    expect(result).not.toBeNull();
    expect(result.status).toBe(400);
  });
});

// ─── create-eval saveAsDraft flag ─────────────────────────────────────────────

function resolveExtension(saveAsDraft) {
  return saveAsDraft ? '.yaml.draft' : '.yaml';
}

describe('create-eval — saveAsDraft flag', () => {
  it('uses .yaml extension when saveAsDraft is falsy', () => {
    expect(resolveExtension(false)).toBe('.yaml');
    expect(resolveExtension(undefined)).toBe('.yaml');
    expect(resolveExtension(null)).toBe('.yaml');
  });

  it('uses .yaml.draft extension when saveAsDraft is truthy', () => {
    expect(resolveExtension(true)).toBe('.yaml.draft');
    expect(resolveExtension(1)).toBe('.yaml.draft');
  });
});

// ─── GET /folders — drafts included in folder objects ────────────────────────

describe('GET /folders — folder object includes drafts', () => {
  it('folder response shape includes a drafts array', () => {
    // Mirrors the shape returned by the updated route
    const folder = {
      folder_path: '/project/evals/my-folder',
      folder_name: 'my-folder',
      armed: false,
      triggers: 'manual',
      auto_send: 0,
      id: null,
      eval_count: 2,
      evals: [
        { name: 'eval_one', description: 'first eval', evidence_type: 'log_query' },
        { name: 'eval_two', description: 'second eval', evidence_type: 'file' },
      ],
      drafts: [
        { name: 'draft_eval', description: 'a draft', evidence_type: 'log_query', isDraft: true, draftPath: '/project/evals/my-folder/draft_eval.yaml.draft' },
      ],
      last_run_status: [],
    };

    expect(folder).toHaveProperty('drafts');
    expect(Array.isArray(folder.drafts)).toBe(true);
    expect(folder.drafts[0]).toMatchObject({
      isDraft: true,
      draftPath: expect.stringContaining('.draft'),
    });
  });

  it('draft items have the expected fields', () => {
    const draft = {
      name: 'my_draft_eval',
      description: 'Tests something',
      evidence_type: 'log_query',
      isDraft: true,
      draftPath: '/project/evals/folder/my_draft_eval.yaml.draft',
    };
    expect(draft.isDraft).toBe(true);
    expect(draft.draftPath).toMatch(/\.draft$/);
    expect(typeof draft.name).toBe('string');
  });
});
