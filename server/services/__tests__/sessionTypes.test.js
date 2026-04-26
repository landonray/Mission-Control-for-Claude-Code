import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

// Stub DATABASE_URL so the database module can be required without crashing.
process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const require = createRequire(import.meta.url);
let sessionManager;

beforeAll(() => {
  sessionManager = require('../sessionManager');
});

describe('VALID_SESSION_TYPES', () => {
  it('includes the existing types', () => {
    expect(sessionManager.VALID_SESSION_TYPES).toEqual(
      expect.arrayContaining(['implementation', 'planning', 'extraction', 'eval_gatherer'])
    );
  });

  it('includes the new pipeline session types', () => {
    expect(sessionManager.VALID_SESSION_TYPES).toEqual(
      expect.arrayContaining(['spec_refinement', 'qa_design', 'implementation_planning', 'qa_execution', 'code_review'])
    );
  });
});
