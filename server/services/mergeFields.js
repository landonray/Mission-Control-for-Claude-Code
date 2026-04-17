/**
 * Merge-field system. Prompt text can contain {{field_name}} placeholders
 * that are resolved server-side just before the prompt is sent to Claude.
 *
 * Resolvers are registered here and reused by chat-send and quality-rule paths.
 */

const registry = new Map();

// Test-only override for `execFile`. Production code leaves this null and the
// resolver falls back to require('child_process').execFile. Set via
// _setExecFileForTests.
let _execFileImpl = null;

/**
 * Register a merge field.
 * @param {string} name - bare field name (no braces)
 * @param {{ description: string, resolve: (context) => Promise<string|null> }} spec
 */
function registerField(name, spec) {
  registry.set(name, spec);
}

/**
 * List registered fields as { name, description } for UI hints.
 */
function listFields() {
  return Array.from(registry.entries()).map(([name, spec]) => ({
    name,
    description: spec.description,
  }));
}

/**
 * Resolve all {{field}} placeholders in `text`.
 * @param {string} text
 * @param {object} context - resolver context (e.g. { workingDirectory })
 * @returns {Promise<{ text: string, unresolved: Array<{name, reason}> }>}
 */
async function resolvePrompt(text, context = {}) {
  if (!text || typeof text !== 'string') {
    return { text: text || '', unresolved: [] };
  }

  const pattern = /\{\{([a-z_][a-z0-9_]*)\}\}/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    return { text, unresolved: [] };
  }

  const unique = [...new Set(matches.map(m => m[1]))];
  const unresolved = [];
  const substitutions = new Map();

  for (const name of unique) {
    const spec = registry.get(name);
    if (!spec) {
      unresolved.push({ name, reason: 'unknown field' });
      continue;
    }
    try {
      const value = await spec.resolve(context);
      if (value === null || value === undefined) {
        unresolved.push({ name, reason: 'no value' });
      } else {
        substitutions.set(name, String(value));
      }
    } catch (err) {
      unresolved.push({ name, reason: err.message || 'resolver error' });
    }
  }

  let out = text.replace(pattern, (match, name) => {
    return substitutions.has(name) ? substitutions.get(name) : match;
  });

  if (unresolved.length > 0) {
    const notes = unresolved
      .map(u => `{{${u.name}}} could not be resolved — ${u.reason}`)
      .join('; ');
    out = `(note: merge field ${notes})\n\n${out}`;
  }

  return { text: out, unresolved };
}

/**
 * {{last_pr}} resolver — returns the number of the most recently updated
 * open PR in the session's working directory, using `gh pr list`.
 */
async function resolveLastPr(context) {
  const cwd = context.workingDirectory;
  if (!cwd) return null;
  // Lazy require so tests can replace the execFile implementation via
  // _setExecFileForTests (vi.mock of CJS built-ins is unreliable in Vitest 4).
  const execFile = _execFileImpl || require('child_process').execFile;
  return new Promise((resolve, reject) => {
    execFile('gh', [
      'pr', 'list',
      '--state', 'open',
      '--json', 'number,updatedAt',
      '--limit', '20',
    ], { cwd, timeout: 10000 }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') {
          reject(new Error('gh CLI not found'));
          return;
        }
        reject(new Error(`gh pr list failed: ${err.message}`));
        return;
      }
      try {
        const prs = JSON.parse(stdout || '[]');
        if (!Array.isArray(prs) || prs.length === 0) {
          reject(new Error('no open PRs'));
          return;
        }
        prs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        resolve(String(prs[0].number));
      } catch (e) {
        reject(new Error(`gh pr list parse error: ${e.message}`));
      }
    });
  });
  // NOTE: We intentionally do not catch rejections here. resolvePrompt wraps
  // resolver calls in try/catch and uses the error message as the unresolved
  // reason — that's what drives the human-readable (note: ...) block.
}

/**
 * Register built-in merge fields. Called once at server startup.
 */
function registerBuiltInFields() {
  registerField('last_pr', {
    description: 'most recently updated open PR number',
    resolve: resolveLastPr,
  });
}

/** Test-only: reset registry. Do not call from production code. */
function _clearRegistryForTests() {
  registry.clear();
}

/** Test-only: inject a fake execFile for the last_pr resolver. Pass null to restore default. */
function _setExecFileForTests(fn) {
  _execFileImpl = fn;
}

module.exports = { registerField, listFields, resolvePrompt, registerBuiltInFields, _clearRegistryForTests, _setExecFileForTests };
