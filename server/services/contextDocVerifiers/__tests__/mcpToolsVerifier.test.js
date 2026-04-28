import { describe, it, expect } from 'vitest';

const verifier = await import('../mcpToolsVerifier.js');

describe('mcpToolsVerifier.parseTools', () => {
  it('extracts every mc_* tool name from a TOOL_DEFINITIONS-style array', () => {
    const content = `
      const TOOL_DEFINITIONS = [
        {
          name: 'mc_list_projects',
          description: 'Lists all projects.',
          handler: foo,
        },
        {
          name: 'mc_start_session',
          description:
            'Starts a session in a project. Returns the session ID.',
          handler: bar,
        },
        {
          name: 'mc_send_message',
          description: 'Sends a follow-up message to a session.',
          handler: baz,
        },
      ];
    `;
    const tools = verifier.parseTools(content);
    expect(tools.map(t => t.name)).toEqual(['mc_list_projects', 'mc_start_session', 'mc_send_message']);
  });

  it('keeps only the first sentence of multi-sentence descriptions', () => {
    const content = `
      { name: 'mc_foo', description: 'First sentence. Second sentence about details.', handler: x },
    `;
    const [tool] = verifier.parseTools(content);
    expect(tool.description).toBe('First sentence.');
  });

  it('ignores non-mc_ names like utility helpers', () => {
    const content = `
      { name: 'mc_yes', description: 'kept', handler: x },
      { name: 'helper_no', description: 'dropped', handler: y },
    `;
    const [...names] = verifier.parseTools(content).map(t => t.name);
    expect(names).toEqual(['mc_yes']);
  });

  it('deduplicates if the same name appears twice', () => {
    const content = `
      { name: 'mc_foo', description: 'first', handler: x },
      { name: 'mc_foo', description: 'second', handler: y },
    `;
    expect(verifier.parseTools(content).map(t => t.name)).toEqual(['mc_foo']);
  });

  it('truncates very long descriptions to 240 chars', () => {
    const longDesc = 'A'.repeat(400);
    const content = `{ name: 'mc_long', description: '${longDesc}', handler: x }`;
    const [tool] = verifier.parseTools(content);
    expect(tool.description.length).toBeLessThanOrEqual(240);
    expect(tool.description.endsWith('…')).toBe(true);
  });
});

describe('mcpToolsVerifier.extract', () => {
  it('returns empty + notes when source file is missing', async () => {
    const result = await verifier.extract('/does/not/exist');
    expect(result.category).toBe('MCP tools');
    expect(result.items).toEqual([]);
    expect(result.notes).toMatch(/not found/);
  });
});
