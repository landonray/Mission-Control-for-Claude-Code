/**
 * Unit tests for the MCP project-file tools:
 *   mc_list_project_files, mc_read_project_file, mc_write_project_context.
 *
 * Each test creates a real temp directory, mocks the database to return that
 * directory as the project's root_path, and runs the tool through the
 * MCP dispatcher (mirrors the Phase 1 test style).
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
  exports: mockOrchestrator,
};

const mcpServer = require('../services/mcpServer');

function makeTempProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-'));
  fs.writeFileSync(path.join(tmp, 'README.md'), '# Hello\n');
  fs.writeFileSync(path.join(tmp, 'PRODUCT.md'), '# Product\n\nOriginal product doc.\n');
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'index.js'), 'console.log("hi");\n');
  fs.mkdirSync(path.join(tmp, 'src', 'sub'));
  fs.writeFileSync(path.join(tmp, 'src', 'sub', 'deep.js'), '// deep\n');
  // Ignored stuff:
  fs.mkdirSync(path.join(tmp, 'node_modules'));
  fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg.json'), '{}');
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(tmp, '.env'), 'SECRET=shh');
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

beforeEach(() => {
  // mockReset clears the mockImplementationOnce queue too — important because
  // some tests short-circuit before query() runs and would otherwise leak a
  // queued impl into the next test.
  mockQuery.mockReset();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

describe('tools/list includes the three new file tools', () => {
  it('exposes mc_list_project_files, mc_read_project_file, mc_write_project_context', async () => {
    const res = await mcpServer.handleRpcRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {}
    );
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('mc_list_project_files');
    expect(names).toContain('mc_read_project_file');
    expect(names).toContain('mc_write_project_context');
  });
});

describe('mc_list_project_files', () => {
  it('lists the project root with sensible defaults', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_list_project_files', { project_id: 'p1' });
    expect(res.result.isError).toBe(false);
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.project_id).toBe('p1');
    expect(payload.path).toBe('');
    const names = payload.tree.map((n) => n.name);
    // Directories sort before files; ignored entries excluded.
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(names).toContain('PRODUCT.md');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
    expect(names).not.toContain('.env');
    const src = payload.tree.find((n) => n.name === 'src');
    expect(src.type).toBe('dir');
    expect(src.children.find((c) => c.name === 'index.js').type).toBe('file');
    cleanupTmp(tmp);
  });

  it('lists a subdirectory when path is supplied', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_list_project_files', { project_id: 'p1', path: 'src' });
    expect(res.result.isError).toBe(false);
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.path).toBe('src');
    const names = payload.tree.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(['index.js', 'sub']));
  });

  it('respects the depth parameter', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_list_project_files', { project_id: 'p1', depth: 1 });
    const payload = JSON.parse(res.result.content[0].text);
    const src = payload.tree.find((n) => n.name === 'src');
    expect(src.type).toBe('dir');
    // depth=1 means only the top level — deeper children are truncated.
    expect(src.children).toBeUndefined();
    expect(src.children_truncated).toBe(true);
  });

  it('rejects path that escapes the project root', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_list_project_files', { project_id: 'p1', path: '../..' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/outside the project root/i);
  });

  it('errors when path is not a directory', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_list_project_files', { project_id: 'p1', path: 'README.md' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/not a directory/i);
  });

  it('errors when project does not exist', async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    const res = await callTool('mc_list_project_files', { project_id: 'missing' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Project not found/);
  });

  it('errors when project_id is missing', async () => {
    const res = await callTool('mc_list_project_files', {});
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/project_id is required/i);
  });
});

describe('mc_read_project_file', () => {
  it('reads a UTF-8 file as text', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_read_project_file', { project_id: 'p1', path: 'src/index.js' });
    expect(res.result.isError).toBe(false);
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.encoding).toBe('utf8');
    expect(payload.content).toContain('console.log');
    expect(payload.path).toBe(path.join('src', 'index.js'));
    expect(payload.truncated).toBe(false);
  });

  it('returns binary files as base64', async () => {
    const tmp = makeTempProject();
    fs.writeFileSync(path.join(tmp, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_read_project_file', { project_id: 'p1', path: 'blob.bin' });
    expect(res.result.isError).toBe(false);
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.encoding).toBe('base64');
    expect(payload.content).toBe(Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64'));
  });

  it('rejects path that escapes the project root', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_read_project_file', { project_id: 'p1', path: '../etc/passwd' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/outside the project root/i);
  });

  it('rejects absolute paths', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_read_project_file', { project_id: 'p1', path: '/etc/passwd' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/outside the project root|relative/i);
  });

  it('errors when the file does not exist', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_read_project_file', { project_id: 'p1', path: 'no/such.txt' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/File not found/i);
  });

  it('errors when path points to a directory', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_read_project_file', { project_id: 'p1', path: 'src' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/directory/i);
  });

  it('requires project_id and path', async () => {
    const r1 = await callTool('mc_read_project_file', { path: 'README.md' });
    expect(r1.result.isError).toBe(true);
    expect(r1.result.content[0].text).toMatch(/project_id is required/i);
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: '/tmp/__nope__' }],
      rowCount: 1,
    }));
    const r2 = await callTool('mc_read_project_file', { project_id: 'p1' });
    expect(r2.result.isError).toBe(true);
    expect(r2.result.content[0].text).toMatch(/path is required/i);
  });
});

describe('mc_write_project_context', () => {
  it('updates an existing PRODUCT.md', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const newContent = '# Product\n\nNew product doc.\n';
    const res = await callTool('mc_write_project_context', {
      project_id: 'p1',
      document: 'product',
      content: newContent,
    });
    expect(res.result.isError).toBe(false);
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.document).toBe('product');
    expect(payload.path).toBe('PRODUCT.md');
    expect(payload.created).toBe(false);
    expect(payload.updated).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'PRODUCT.md'), 'utf8')).toBe(newContent);
  });

  it('creates ARCHITECTURE.md if it does not exist', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_write_project_context', {
      project_id: 'p1',
      document: 'architecture',
      content: '# Arch\n',
    });
    expect(res.result.isError).toBe(false);
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.created).toBe(true);
    expect(payload.updated).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'ARCHITECTURE.md'))).toBe(true);
  });

  it('rejects unsupported document values', async () => {
    const tmp = makeTempProject();
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: tmp }],
      rowCount: 1,
    }));
    const res = await callTool('mc_write_project_context', {
      project_id: 'p1',
      document: 'decisions',
      content: 'nope',
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/document must be one of/i);
  });

  it('requires content to be a string', async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'p1', name: 'Alpha', root_path: '/tmp/__nope__' }],
      rowCount: 1,
    }));
    const res = await callTool('mc_write_project_context', {
      project_id: 'p1',
      document: 'product',
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/content is required/i);
  });

  it('errors when project does not exist', async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    const res = await callTool('mc_write_project_context', {
      project_id: 'missing',
      document: 'product',
      content: 'x',
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Project not found/);
  });
});
