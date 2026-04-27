import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseBuildPlan } = require('../buildPlanParser');

describe('parseBuildPlan', () => {
  it('parses a single chunk', () => {
    const md = [
      '# Build plan',
      '',
      '## Chunk 1: Add api route',
      '- Files: server/routes/foo.js',
      '- QA Scenarios: GET /foo returns 200',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'Implement a new GET /foo endpoint that returns the foo list.',
    ].join('\n');
    const chunks = parseBuildPlan(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      index: 1,
      name: 'Add api route',
      complexity: 'small',
    });
    expect(chunks[0].body).toContain('Implement a new GET /foo endpoint');
    expect(chunks[0].files).toContain('server/routes/foo.js');
    expect(chunks[0].dependencies).toBe('none');
  });

  it('parses multiple chunks in order', () => {
    const md = [
      '## Chunk 1: First',
      '- Files: a.js',
      '- QA Scenarios: x',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'Body of first.',
      '',
      '## Chunk 2: Second',
      '- Files: b.js',
      '- QA Scenarios: y',
      '- Dependencies: 1',
      '- Complexity: medium',
      '',
      'Body of second.',
    ].join('\n');
    const chunks = parseBuildPlan(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].index).toBe(1);
    expect(chunks[1].index).toBe(2);
    expect(chunks[1].dependencies).toBe('1');
  });

  it('ignores content before the first chunk header', () => {
    const md = [
      '# Build plan for adding pagination',
      '',
      'This document explains the chunks.',
      '',
      '## Chunk 1: Database column',
      '- Files: schema.sql',
      '- QA Scenarios: migration runs cleanly',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'Add the column.',
    ].join('\n');
    const chunks = parseBuildPlan(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].name).toBe('Database column');
  });

  it('throws when no chunks are found', () => {
    expect(() => parseBuildPlan('# Plan\n\nJust prose, no chunks.')).toThrow(
      /no chunks/i
    );
  });

  it('throws when chunk numbering is out of order', () => {
    const md = [
      '## Chunk 1: a',
      '- Files: a',
      '- QA Scenarios: a',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'a',
      '',
      '## Chunk 3: c',
      '- Files: c',
      '- QA Scenarios: c',
      '- Dependencies: 1',
      '- Complexity: small',
      '',
      'c',
    ].join('\n');
    expect(() => parseBuildPlan(md)).toThrow(/chunk numbering/i);
  });

  it('treats the body as everything between the metadata and the next chunk', () => {
    const md = [
      '## Chunk 1: foo',
      '- Files: a',
      '- QA Scenarios: a',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'Line 1 of body.',
      '',
      'Line 2 of body.',
      '',
      '## Chunk 2: bar',
      '- Files: b',
      '- QA Scenarios: b',
      '- Dependencies: 1',
      '- Complexity: small',
      '',
      'Body 2.',
    ].join('\n');
    const chunks = parseBuildPlan(md);
    expect(chunks[0].body).toContain('Line 1 of body.');
    expect(chunks[0].body).toContain('Line 2 of body.');
    expect(chunks[0].body).not.toContain('Body 2');
  });

  it('handles missing optional fields by leaving them blank', () => {
    const md = [
      '## Chunk 1: minimal',
      '- Files: a.js',
      '',
      'Just do the thing.',
    ].join('\n');
    const chunks = parseBuildPlan(md);
    expect(chunks[0].name).toBe('minimal');
    expect(chunks[0].files).toBe('a.js');
    expect(chunks[0].qaScenarios).toBe('');
    expect(chunks[0].dependencies).toBe('');
    expect(chunks[0].complexity).toBe('');
  });

  it('accepts complexity in any case', () => {
    const md = [
      '## Chunk 1: foo',
      '- Files: a',
      '- QA Scenarios: a',
      '- Dependencies: none',
      '- Complexity: MEDIUM',
      '',
      'body',
    ].join('\n');
    const chunks = parseBuildPlan(md);
    expect(chunks[0].complexity).toBe('medium');
  });
});
