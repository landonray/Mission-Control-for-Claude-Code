/**
 * Evidence Gatherers — collects evidence from various sources for eval checks.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

// Default size caps in bytes
const DEFAULT_SIZE_CAPS = {
  log_query: 50 * 1024,    // 50KB
  db_query: 50 * 1024,     // 50KB
  sub_agent: 200 * 1024,   // 200KB
  file: 50 * 1024,         // 50KB
};

// Default timeouts in ms per spec: 5 min sub-agent, 30s log/db, no timeout for file (sync read)
const DEFAULT_TIMEOUTS = {
  log_query: 30_000,
  db_query: 30_000,
  sub_agent: 300_000,
  file: 30_000,
};

/**
 * Dispatch to the appropriate evidence gatherer based on type.
 * @param {object} evidenceConfig - Evidence config from eval definition
 * @param {object} context - Execution context
 * @returns {Promise<string>} Gathered evidence as a string
 */
export async function gatherEvidence(evidenceConfig, context) {
  const type = evidenceConfig.type;
  const timeoutMs = evidenceConfig.timeout || DEFAULT_TIMEOUTS[type] || 30_000;

  let gatherFn;
  switch (type) {
    case 'log_query':
      gatherFn = () => gatherLogQuery(evidenceConfig, context);
      break;
    case 'file':
      gatherFn = () => gatherFile(evidenceConfig, context);
      break;
    case 'db_query':
      gatherFn = () => gatherDbQuery(evidenceConfig, context);
      break;
    case 'sub_agent':
      gatherFn = () => gatherSubAgent(evidenceConfig, context);
      break;
    default:
      throw new Error(`Unknown evidence type: ${type}`);
  }

  return withTimeout(gatherFn(), timeoutMs, `${type} evidence gathering timed out after ${timeoutMs}ms`);
}

/**
 * Read log source and apply regex filter, returning matching content.
 * @param {object} config - Evidence config with source and optional filter
 * @param {object} context - Execution context with sessionLogPath, projectRoot
 * @returns {Promise<string>} Filtered log content
 */
export async function gatherLogQuery(config, context) {
  const logPath = resolveLogSource(config.source, context);

  let content;
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read log source "${config.source}": ${err.message}`);
  }

  // Apply regex filter if provided.
  // Spec format: filter: { regex: "pattern" } or filter: "pattern" (legacy string shorthand)
  if (config.filter) {
    let pattern, flags;
    if (typeof config.filter === 'object' && config.filter.regex) {
      pattern = config.filter.regex;
      flags = config.filter.flags || 'gm';
    } else if (typeof config.filter === 'string') {
      pattern = config.filter;
      flags = config.filter_flags || 'gm';
    }
    if (pattern) {
      const regex = new RegExp(pattern, flags);
      const matches = content.match(regex);
      content = matches ? matches.join('\n') : '';
    }
  }

  const maxBytes = config.max_bytes || DEFAULT_SIZE_CAPS.log_query;
  return truncateLogEvidence(content, maxBytes);
}

/**
 * Read a file from the project root.
 * @param {object} config - Evidence config with path
 * @param {object} context - Execution context with projectRoot
 * @returns {Promise<string>} File content
 */
export async function gatherFile(config, context) {
  const filePath = config.path
    ? path.resolve(context.projectRoot, interpolateVariables(config.path, context))
    : null;

  if (!filePath) {
    throw new Error('File evidence requires a "path" field');
  }

  // Prevent path traversal outside the project root
  assertPathWithinRoot(filePath, context.projectRoot);

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read file "${filePath}": ${err.message}`);
  }

  const maxBytes = config.max_bytes || DEFAULT_SIZE_CAPS.file;
  return truncateLogEvidence(content, maxBytes);
}

/**
 * Execute a SQL query using a read-only database connection.
 * @param {object} config - Evidence config with query
 * @param {object} context - Execution context with dbReadonlyUrl or createDbConnection
 * @returns {Promise<string>} JSON stringified query results
 */
export async function gatherDbQuery(config, context) {
  if (!config.query) {
    throw new Error('DB query evidence requires a "query" field');
  }

  // Enforce read-only DB access: refuse to run without a dedicated readonly URL.
  // This is a spec requirement — evals must never be capable of writing to the database.
  if (!context.dbReadonlyUrl) {
    throw new Error(
      'DB query evidence requires a read-only database connection (dbReadonlyUrl). ' +
      'Set DATABASE_URL_READONLY in your project .env or .mission-control.yaml.'
    );
  }

  if (!context.createDbConnection) {
    throw new Error('No database connection factory available (need createDbConnection in context)');
  }

  // Resolve :param placeholders from the params map before parameterizing.
  // Spec example: query: "SELECT * FROM recipes WHERE source_url = :url"
  //               params: { url: "${input.url}" }
  let resolvedQuery = config.query;
  if (config.params && typeof config.params === 'object') {
    // First interpolate variables in each param value
    const resolvedParams = {};
    for (const [key, val] of Object.entries(config.params)) {
      resolvedParams[key] = interpolateVariables(String(val), context);
    }
    // Replace :param placeholders with ${_param.key} so buildParameterizedQuery can handle them
    resolvedQuery = resolvedQuery.replace(/:([a-zA-Z_]\w*)/g, (match, name) => {
      if (name in resolvedParams) return `\${_param.${name}}`;
      return match; // leave unrecognized :params as-is (will error later)
    });
    // Inject resolved params into context for buildParameterizedQuery
    context = { ...context, _param: resolvedParams, variables: { ...context.variables, _param: resolvedParams } };
  }

  // Use parameterized queries to prevent SQL injection.
  const { sql, params } = buildParameterizedQuery(resolvedQuery, context);

  let rows;
  const db = await context.createDbConnection(context.dbReadonlyUrl);
  try {
    const result = await db.query(sql, params);
    rows = result.rows || result;
  } finally {
    if (db.end) await db.end();
  }

  const maxBytes = config.max_bytes || DEFAULT_SIZE_CAPS.db_query;
  return truncateDbEvidence(rows, maxBytes);
}

/**
 * Spawn a sandboxed Claude CLI session to gather evidence.
 * Spec: accepts extraction_prompt (or prompt as fallback) and optional context_source.
 * If context_source is set, the source content is written to a temp file and
 * the path is injected into the extraction prompt as ${context_file}.
 * @param {object} config - Evidence config with extraction_prompt/prompt and optional context_source
 * @param {object} context - Execution context
 * @returns {Promise<string>} Sub-agent output
 */
export async function gatherSubAgent(config, context) {
  const promptTemplate = config.extraction_prompt || config.prompt;
  if (!promptTemplate) {
    throw new Error('Sub-agent evidence requires an "extraction_prompt" (or "prompt") field');
  }

  let contextFilePath = null;
  try {
    // If context_source is specified, resolve it to a file and write to temp
    if (config.context_source) {
      const os = await import('os');
      const sourcePath = resolveLogSource(config.context_source, context);
      const sourceContent = fs.readFileSync(sourcePath, 'utf8');
      contextFilePath = path.join(os.default.tmpdir(), `eval-subagent-context-${Date.now()}.txt`);
      fs.writeFileSync(contextFilePath, sourceContent, 'utf8');
    }

    // Interpolate variables in the prompt, including ${context_file} if we have one
    const extendedContext = contextFilePath
      ? { ...context, context_file: contextFilePath, variables: { ...context.variables, context_file: contextFilePath } }
      : context;
    const prompt = interpolateVariables(promptTemplate, extendedContext);

    return await new Promise((resolve, reject) => {
      const args = ['--print', prompt];
      if (context.projectRoot) {
        args.unshift('--cwd', context.projectRoot);
      }
      // Sub-agent isolation: restrict to read-only tools per spec
      const allowedTools = config.allowed_tools || ['Read', 'Glob', 'Grep', 'Bash(read-only)'];
      args.push('--allowedTools', allowedTools.join(','));

      execFile('claude', args, {
        timeout: config.timeout || DEFAULT_TIMEOUTS.sub_agent,
        maxBuffer: DEFAULT_SIZE_CAPS.sub_agent,
      }, (err, stdout) => {
        if (err) {
          reject(new Error(`Sub-agent failed: ${err.message}`));
          return;
        }
        const maxBytes = config.max_bytes || DEFAULT_SIZE_CAPS.sub_agent;
        resolve(truncateLogEvidence(stdout, maxBytes));
      });
    });
  } finally {
    // Clean up temp context file
    if (contextFilePath) {
      try { fs.unlinkSync(contextFilePath); } catch (_) {}
    }
  }
}

/**
 * Truncate log evidence using head+tail strategy.
 * Keeps the first half and last half if content exceeds maxBytes.
 * @param {string} content - The content to truncate
 * @param {number} maxBytes - Maximum size in bytes
 * @returns {string} Truncated content
 */
export function truncateLogEvidence(content, maxBytes) {
  if (!content) return '';
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= maxBytes) return content;

  const halfBytes = Math.floor(maxBytes / 2) - 30; // 30 bytes for separator
  const head = buf.subarray(0, halfBytes).toString('utf8');
  const tail = buf.subarray(buf.length - halfBytes).toString('utf8');
  return `${head}\n\n... [truncated ${buf.length - maxBytes} bytes] ...\n\n${tail}`;
}

/**
 * Truncate database evidence by reducing row count.
 * @param {object[]} rows - Query result rows
 * @param {number} maxBytes - Maximum size in bytes
 * @returns {string} JSON stringified rows, truncated if necessary
 */
export function truncateDbEvidence(rows, maxBytes) {
  if (!rows || !Array.isArray(rows)) return JSON.stringify(rows);

  let json = JSON.stringify(rows, null, 2);
  if (Buffer.from(json, 'utf8').length <= maxBytes) return json;

  // Progressively remove rows from the end until we fit
  let truncated = [...rows];
  while (truncated.length > 1) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.75) || 1);
    const candidate = JSON.stringify(truncated, null, 2);
    const note = `\n\n[truncated: showing ${truncated.length} of ${rows.length} rows]`;
    if (Buffer.from(candidate + note, 'utf8').length <= maxBytes) {
      return candidate + note;
    }
  }

  // Down to 1 row — check if it fits, otherwise give up
  const singleCandidate = JSON.stringify(truncated, null, 2);
  const singleNote = `\n\n[truncated: showing 1 of ${rows.length} rows]`;
  if (Buffer.from(singleCandidate + singleNote, 'utf8').length <= maxBytes) {
    return singleCandidate + singleNote;
  }

  return `[truncated: ${rows.length} rows exceeded ${maxBytes} byte limit]`;
}

/**
 * Ensure a resolved file path stays within the project root directory.
 * Prevents path traversal attacks via ../../ or absolute paths in eval YAML.
 */
function assertPathWithinRoot(filePath, projectRoot) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(projectRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path traversal denied: "${filePath}" resolves outside project root`);
  }
}

/**
 * Interpolate ${input.field} and other context variables in a string.
 * @param {string} str - String with variable placeholders
 * @param {object} context - Context object containing variables
 * @returns {string} Interpolated string
 */
export function interpolateVariables(str, context) {
  if (!str || typeof str !== 'string') return str;

  return str.replace(/\$\{([^}]+)\}/g, (match, expr) => {
    const parts = expr.trim().split('.');
    let value = context.variables || {};

    // Also check top-level context properties
    if (parts[0] in context) {
      value = context;
    }

    for (const part of parts) {
      if (value == null || typeof value !== 'object') return match;
      value = value[part];
    }

    return value != null ? String(value) : match;
  });
}

// --- Internal helpers ---

/**
 * Convert a query with ${variable} placeholders into a parameterized query.
 * Returns { sql, params } where sql uses $1, $2, etc. and params is the values array.
 * This prevents SQL injection by never inlining user values into the query string.
 */
export function buildParameterizedQuery(queryTemplate, context) {
  const params = [];
  let paramIndex = 0;
  const unresolved = [];

  const sql = queryTemplate.replace(/\$\{([^}]+)\}/g, (match, expr) => {
    const parts = expr.trim().split('.');
    let value = context.variables || {};

    if (parts[0] in context) {
      value = context;
    }

    for (const part of parts) {
      if (value == null || typeof value !== 'object') {
        unresolved.push(expr.trim());
        return match;
      }
      value = value[part];
    }

    if (value == null) {
      unresolved.push(expr.trim());
      return match;
    }

    paramIndex++;
    params.push(value);
    return `$${paramIndex}`;
  });

  if (unresolved.length > 0) {
    throw new Error(`Unresolved variable(s) in DB query: ${unresolved.join(', ')}`);
  }

  return { sql, params };
}

/**
 * Race a promise against a timeout. Rejects with an Error if the timeout fires first.
 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function resolveLogSource(source, context) {
  if (!source) {
    // Default to session log path
    if (context.sessionLogPath) return context.sessionLogPath;
    throw new Error('No log source specified and no sessionLogPath in context');
  }

  // Predefined source names
  switch (source) {
    case 'session_log':
    case 'session':
    case 'stdout':
      if (!context.sessionLogPath) throw new Error(`Log source "${source}" requires sessionLogPath in context`);
      return context.sessionLogPath;
    case 'build':
    case 'build_output':
      if (!context.buildOutputPath) throw new Error(`Log source "${source}" requires buildOutputPath in context`);
      return context.buildOutputPath;
    case 'pr_diff':
      if (!context.prDiffPath) throw new Error('Log source "pr_diff" requires prDiffPath in context');
      return context.prDiffPath;
    default: {
      // Treat as a file path relative to project root
      const resolved = path.resolve(context.projectRoot || '.', source);
      assertPathWithinRoot(resolved, context.projectRoot || '.');
      return resolved;
    }
  }
}
