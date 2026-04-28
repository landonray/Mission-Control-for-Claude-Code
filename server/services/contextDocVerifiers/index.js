/**
 * Context-doc verifiers — extract authoritative lists of named identifiers
 * directly from a project's codebase so the synthesis pass can ground the
 * generated PRODUCT.md / ARCHITECTURE.md in current code instead of
 * trusting LLM enumeration through layers of summarization.
 *
 * Each verifier returns `{ category, items: [{ name, description? }], notes? }`.
 * Verifiers degrade gracefully when their canonical source isn't present —
 * they return an empty `items` array and a `notes` string, so they're safe
 * to run against any project layout.
 */

'use strict';

const mcpToolsVerifier = require('./mcpToolsVerifier');
const apiRoutesVerifier = require('./apiRoutesVerifier');
const dbTablesVerifier = require('./dbTablesVerifier');

const VERIFIERS = [mcpToolsVerifier, apiRoutesVerifier, dbTablesVerifier];

/**
 * Run every registered verifier against the given project root in parallel.
 * Per-verifier failures are caught and recorded in `notes` so one broken
 * verifier doesn't block the others.
 *
 * @param {string} projectRoot — absolute path to the project's root directory
 * @returns {Promise<Array<{ category, items, notes? }>>}
 */
async function runAllVerifiers(projectRoot) {
  const results = await Promise.all(
    VERIFIERS.map(async (v) => {
      try {
        return await v.extract(projectRoot);
      } catch (err) {
        return {
          category: v.SOURCE_REL_PATH || 'unknown',
          items: [],
          notes: `verifier failed: ${err && err.message ? err.message : String(err)}`,
        };
      }
    })
  );
  return results;
}

module.exports = { runAllVerifiers, VERIFIERS };
