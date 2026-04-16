/**
 * Tests for the POST /folders/:projectId/create-eval route.
 *
 * Because the CJS router calls neon() at load time (making supertest impossible),
 * we test the validation and business logic inline — the same pattern used in
 * evals-create-folder.test.js.
 *
 * We also test the VALID_EVIDENCE_TYPES / VALID_CHECK_TYPES constants by importing
 * the real ESM evalLoader module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock fs so evalLoader.js can be imported without touching the real filesystem
const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  default: {
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    readFileSync: mockReadFileSync,
  },
}));

vi.mock('js-yaml', () => ({
  load: vi.fn(),
  dump: vi.fn(),
  default: { load: vi.fn(), dump: vi.fn() },
}));

// ─── Route validation helpers (mirroring the actual route handler) ────────────

function validateCreateEvalInput({ folder_path, name, description, evidence, input, checks, judge_prompt, expected }) {
  if (!folder_path || typeof folder_path !== 'string' || !folder_path.trim()) {
    return { error: 'folder_path is required', status: 400 };
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { error: 'name is required', status: 400 };
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    return { error: 'description is required', status: 400 };
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { error: 'evidence is required and must be an object', status: 400 };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'input is required and must be a key-value map', status: 400 };
  }
  if (!checks && !judge_prompt) {
    return { error: 'At least one of "checks" or "judge_prompt" is required', status: 400 };
  }
  if (judge_prompt && !expected) {
    return { error: '"expected" is required when "judge_prompt" is provided', status: 400 };
  }
  return null; // no error
}

function isSafeEvalPath(folderPath, projectRoot) {
  const root = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  return folderPath.startsWith(root) || folderPath === projectRoot;
}

function sanitizeEvalName(name) {
  return name.trim().replace(/[^a-zA-Z0-9]+/g, '_');
}

// ─── Tests: evalLoader constants ──────────────────────────────────────────────

describe('VALID_EVIDENCE_TYPES and VALID_CHECK_TYPES', () => {
  let VALID_EVIDENCE_TYPES, VALID_CHECK_TYPES;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../services/evalLoader.js');
    VALID_EVIDENCE_TYPES = mod.VALID_EVIDENCE_TYPES;
    VALID_CHECK_TYPES = mod.VALID_CHECK_TYPES;
  });

  it('exports VALID_EVIDENCE_TYPES as a non-empty array', () => {
    expect(Array.isArray(VALID_EVIDENCE_TYPES)).toBe(true);
    expect(VALID_EVIDENCE_TYPES.length).toBeGreaterThan(0);
  });

  it('includes expected evidence types', () => {
    expect(VALID_EVIDENCE_TYPES).toContain('log_query');
    expect(VALID_EVIDENCE_TYPES).toContain('db_query');
    expect(VALID_EVIDENCE_TYPES).toContain('sub_agent');
    expect(VALID_EVIDENCE_TYPES).toContain('file');
  });

  it('exports VALID_CHECK_TYPES as a non-empty array', () => {
    expect(Array.isArray(VALID_CHECK_TYPES)).toBe(true);
    expect(VALID_CHECK_TYPES.length).toBeGreaterThan(0);
  });

  it('includes expected check types', () => {
    expect(VALID_CHECK_TYPES).toContain('regex_match');
    expect(VALID_CHECK_TYPES).toContain('not_empty');
    expect(VALID_CHECK_TYPES).toContain('json_valid');
  });
});

// ─── Tests: required field validation ────────────────────────────────────────

describe('POST /folders/:projectId/create-eval — required field validation', () => {
  const baseBody = {
    folder_path: '/project/root/evals/my-folder',
    name: 'My Test Eval',
    description: 'Checks something important',
    evidence: { type: 'log_query', query: 'error' },
    input: { key: 'value' },
    checks: [{ type: 'not_empty' }],
  };

  it('accepts a fully valid body with checks', () => {
    expect(validateCreateEvalInput(baseBody)).toBeNull();
  });

  it('accepts a fully valid body with judge_prompt and expected', () => {
    const body = { ...baseBody, checks: undefined, judge_prompt: 'Was the answer correct?', expected: 'yes' };
    expect(validateCreateEvalInput(body)).toBeNull();
  });

  it('accepts a body with both checks and judge_prompt', () => {
    const body = { ...baseBody, judge_prompt: 'Was the answer correct?', expected: 'yes' };
    expect(validateCreateEvalInput(body)).toBeNull();
  });

  it('rejects missing folder_path', () => {
    const { folder_path, ...rest } = baseBody;
    const result = validateCreateEvalInput(rest);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/folder_path/i);
  });

  it('rejects empty folder_path', () => {
    const result = validateCreateEvalInput({ ...baseBody, folder_path: '' });
    expect(result.status).toBe(400);
  });

  it('rejects missing name', () => {
    const { name, ...rest } = baseBody;
    const result = validateCreateEvalInput(rest);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/name/i);
  });

  it('rejects missing description', () => {
    const { description, ...rest } = baseBody;
    const result = validateCreateEvalInput(rest);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/description/i);
  });

  it('rejects missing evidence', () => {
    const { evidence, ...rest } = baseBody;
    const result = validateCreateEvalInput(rest);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/evidence/i);
  });

  it('rejects evidence as a string instead of an object', () => {
    const result = validateCreateEvalInput({ ...baseBody, evidence: 'log_query' });
    expect(result.status).toBe(400);
  });

  it('rejects missing input', () => {
    const { input, ...rest } = baseBody;
    const result = validateCreateEvalInput(rest);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/input/i);
  });

  it('rejects input as an array instead of a key-value map', () => {
    const result = validateCreateEvalInput({ ...baseBody, input: ['a', 'b'] });
    expect(result.status).toBe(400);
  });

  it('rejects when neither checks nor judge_prompt is provided', () => {
    const { checks, ...rest } = baseBody;
    const result = validateCreateEvalInput(rest);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/checks.*judge_prompt|judge_prompt.*checks/i);
  });

  it('rejects judge_prompt without expected', () => {
    const result = validateCreateEvalInput({
      ...baseBody,
      checks: undefined,
      judge_prompt: 'Was the outcome correct?',
    });
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/expected/i);
  });
});

// ─── Tests: path safety ───────────────────────────────────────────────────────

describe('POST /folders/:projectId/create-eval — path safety', () => {
  it('allows a folder inside the project root', () => {
    expect(isSafeEvalPath('/project/root/evals/my-folder', '/project/root')).toBe(true);
  });

  it('allows folder path exactly equal to project root', () => {
    expect(isSafeEvalPath('/project/root', '/project/root')).toBe(true);
  });

  it('rejects folder path outside the project root', () => {
    expect(isSafeEvalPath('/etc/passwd', '/project/root')).toBe(false);
  });

  it('rejects sibling directory starting with the same prefix', () => {
    expect(isSafeEvalPath('/project/root-evil/evals', '/project/root')).toBe(false);
  });

  it('rejects traversal attempt via /../', () => {
    // path.join collapses this but a naive check would pass — ensure normalization
    const normalized = path.resolve('/project/root/evals/../../../etc/passwd');
    expect(isSafeEvalPath(normalized, '/project/root')).toBe(false);
  });
});

// ─── Tests: eval name sanitization ───────────────────────────────────────────

describe('eval name sanitization', () => {
  it('keeps alphanumeric characters unchanged', () => {
    expect(sanitizeEvalName('MyEval123')).toBe('MyEval123');
  });

  it('replaces spaces with underscores', () => {
    expect(sanitizeEvalName('My Eval Name')).toBe('My_Eval_Name');
  });

  it('replaces hyphens with underscores', () => {
    expect(sanitizeEvalName('my-eval-name')).toBe('my_eval_name');
  });

  it('collapses consecutive non-alphanumeric chars to a single underscore', () => {
    expect(sanitizeEvalName('my  eval -- name')).toBe('my_eval_name');
  });

  it('trims leading/trailing whitespace before sanitizing', () => {
    expect(sanitizeEvalName('  my eval  ')).toBe('my_eval');
  });

  it('handles special characters', () => {
    expect(sanitizeEvalName('check: error! (fast)')).toBe('check_error_fast_');
  });
});

// ─── Tests: evidence type validation ─────────────────────────────────────────

describe('evidence type validation', () => {
  // Inline the constants to keep tests self-contained (they mirror evalLoader)
  const VALID_EVIDENCE_TYPES = ['log_query', 'db_query', 'sub_agent', 'file'];

  function validateEvidenceType(type) {
    return VALID_EVIDENCE_TYPES.includes(type);
  }

  it('accepts log_query', () => expect(validateEvidenceType('log_query')).toBe(true));
  it('accepts db_query', () => expect(validateEvidenceType('db_query')).toBe(true));
  it('accepts sub_agent', () => expect(validateEvidenceType('sub_agent')).toBe(true));
  it('accepts file', () => expect(validateEvidenceType('file')).toBe(true));
  it('rejects unknown type', () => expect(validateEvidenceType('magic_query')).toBe(false));
  it('rejects empty string', () => expect(validateEvidenceType('')).toBe(false));
});

// ─── Tests: check type validation ────────────────────────────────────────────

describe('check type validation', () => {
  const VALID_CHECK_TYPES = ['regex_match', 'not_empty', 'json_valid', 'json_schema', 'http_status', 'field_exists'];

  function validateChecks(checks) {
    if (!Array.isArray(checks)) return { valid: true }; // no checks is ok (validated separately)
    for (const check of checks) {
      if (check.type && !VALID_CHECK_TYPES.includes(check.type)) {
        return { valid: false, error: `Invalid check type "${check.type}"` };
      }
    }
    return { valid: true };
  }

  it('accepts valid check types', () => {
    expect(validateChecks([{ type: 'regex_match' }, { type: 'not_empty' }]).valid).toBe(true);
  });

  it('accepts checks without a type field', () => {
    expect(validateChecks([{ pattern: '.*' }]).valid).toBe(true);
  });

  it('rejects unknown check type', () => {
    const result = validateChecks([{ type: 'magic_check' }]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/magic_check/);
  });

  it('accepts json_schema type', () => {
    expect(validateChecks([{ type: 'json_schema' }]).valid).toBe(true);
  });
});
