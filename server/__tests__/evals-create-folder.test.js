/**
 * Tests for the POST /folders/:projectId/create route logic and the getEvalsBaseDir helper.
 *
 * getEvalsBaseDir is tested by importing the real ESM module (no database side-effects).
 *
 * The route's validation and path-safety logic is tested inline, following the project's
 * established pattern (see files.safeResolvePath.test.js): the handler logic is replicated
 * here because the CJS router file calls neon() synchronously at load time, making it
 * impossible to mock via vitest ESM hoisting.
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
  default: { load: vi.fn() },
}));

// ─── Create-folder route validation logic ────────────────────────────────────
// Mirror the exact validation from the POST /folders/:projectId/create handler.

function validateFolderName(folder_name) {
  if (!folder_name || typeof folder_name !== 'string' || !folder_name.trim()) {
    return { error: 'folder_name is required', status: 400 };
  }
  const sanitized = folder_name.trim();
  if (/[\/\\\.]+/.test(sanitized) || sanitized.includes('..')) {
    return { error: 'Invalid folder name — no path separators or traversal allowed', status: 400 };
  }
  return { sanitized };
}

function isSafeFolderPath(folderPath, projectRoot) {
  const root = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  return folderPath.startsWith(root) || folderPath === projectRoot;
}

// ─── Tests: getEvalsBaseDir ───────────────────────────────────────────────────

describe('getEvalsBaseDir', () => {
  let getEvalsBaseDir;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../services/evalLoader.js');
    getEvalsBaseDir = mod.getEvalsBaseDir;
  });

  it('returns evals/ under project root when no config folders', () => {
    expect(getEvalsBaseDir('/project/root', {})).toBe('/project/root/evals');
  });

  it('returns evals/ when config is null', () => {
    expect(getEvalsBaseDir('/project/root', null)).toBe('/project/root/evals');
  });

  it('returns evals/ when folders array is empty', () => {
    expect(getEvalsBaseDir('/project/root', { evals: { folders: [] } })).toBe('/project/root/evals');
  });

  it('returns parent dir of first configured folder', () => {
    const result = getEvalsBaseDir('/project/root', {
      evals: { folders: ['evals/group-a', 'evals/group-b'] },
    });
    // dirname of /project/root/evals/group-a → /project/root/evals
    expect(result).toBe('/project/root/evals');
  });

  it('handles a top-level folder config (e.g. just "evals")', () => {
    const result = getEvalsBaseDir('/project/root', {
      evals: { folders: ['evals'] },
    });
    // dirname of /project/root/evals → /project/root
    expect(result).toBe('/project/root');
  });
});

// ─── Tests: create-folder route validation ────────────────────────────────────

describe('POST /folders/:projectId/create — folder_name validation', () => {
  it('rejects empty string', () => {
    const result = validateFolderName('');
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/folder_name is required/i);
  });

  it('rejects whitespace-only string', () => {
    const result = validateFolderName('   ');
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/folder_name is required/i);
  });

  it('rejects null / missing', () => {
    expect(validateFolderName(null).status).toBe(400);
    expect(validateFolderName(undefined).status).toBe(400);
  });

  it('rejects forward slash (path separator)', () => {
    const result = validateFolderName('foo/bar');
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/invalid folder name/i);
  });

  it('rejects backslash (path separator)', () => {
    const result = validateFolderName('foo\\bar');
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/invalid folder name/i);
  });

  it('rejects path traversal (../)', () => {
    const result = validateFolderName('../escape');
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/invalid folder name/i);
  });

  it('rejects names starting with a dot (.hidden)', () => {
    const result = validateFolderName('.hidden');
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/invalid folder name/i);
  });

  it('accepts a clean hyphenated name', () => {
    const result = validateFolderName('my-eval-group');
    expect(result.error).toBeUndefined();
    expect(result.sanitized).toBe('my-eval-group');
  });

  it('trims surrounding whitespace from valid names', () => {
    const result = validateFolderName('  my-folder  ');
    expect(result.error).toBeUndefined();
    expect(result.sanitized).toBe('my-folder');
  });

  it('accepts underscores and mixed case', () => {
    const result = validateFolderName('My_Eval_Group');
    expect(result.error).toBeUndefined();
    expect(result.sanitized).toBe('My_Eval_Group');
  });
});

describe('POST /folders/:projectId/create — path safety check', () => {
  it('allows folder path inside project root', () => {
    expect(isSafeFolderPath('/project/root/evals/new-folder', '/project/root')).toBe(true);
  });

  it('rejects folder path outside project root (traversal)', () => {
    expect(isSafeFolderPath('/etc/passwd', '/project/root')).toBe(false);
  });

  it('rejects sibling directory that starts with same prefix', () => {
    expect(isSafeFolderPath('/project/root-evil/evals', '/project/root')).toBe(false);
  });
});
