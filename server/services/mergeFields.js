/**
 * Merge-field system. Prompt text can contain {{field_name}} placeholders
 * that are resolved server-side just before the prompt is sent to Claude.
 *
 * Resolvers are registered here and reused by chat-send and quality-rule paths.
 */

const registry = new Map();

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

/** Test-only: reset registry. Do not call from production code. */
function _clearRegistryForTests() {
  registry.clear();
}

module.exports = { registerField, listFields, resolvePrompt, _clearRegistryForTests };
