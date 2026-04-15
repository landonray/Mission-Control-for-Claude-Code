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

/**
 * Dispatch to the appropriate evidence gatherer based on type.
 * @param {object} evidenceConfig - Evidence config from eval definition
 * @param {object} context - Execution context
 * @returns {Promise<string>} Gathered evidence as a string
 */
export async function gatherEvidence(evidenceConfig, context) {
  const type = evidenceConfig.type;

  switch (type) {
    case 'log_query':
      return gatherLogQuery(evidenceConfig, context);
    case 'file':
      return gatherFile(evidenceConfig, context);
    case 'db_query':
      return gatherDbQuery(evidenceConfig, context);
    case 'sub_agent':
      return gatherSubAgent(evidenceConfig, context);
    default:
      throw new Error(`Unknown evidence type: ${type}`);
  }
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

  // Apply regex filter if provided
  if (config.filter) {
    const regex = new RegExp(config.filter, config.filter_flags || 'gm');
    const matches = content.match(regex);
    content = matches ? matches.join('\n') : '';
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

  // Use parameterized queries to prevent SQL injection.
  // Extract ${variable} placeholders, replace with $1/$2/etc., and pass values as params.
  const { sql, params } = buildParameterizedQuery(config.query, context);

  let rows;
  if (context.createDbConnection) {
    const db = context.createDbConnection(context.dbReadonlyUrl);
    try {
      const result = await db.query(sql, params);
      rows = result.rows || result;
    } finally {
      if (db.end) await db.end();
    }
  } else {
    throw new Error('No database connection available (need createDbConnection in context)');
  }

  const maxBytes = config.max_bytes || DEFAULT_SIZE_CAPS.db_query;
  return truncateDbEvidence(rows, maxBytes);
}

/**
 * Spawn a sandboxed Claude CLI session to gather evidence.
 * @param {object} config - Evidence config with prompt
 * @param {object} context - Execution context
 * @returns {Promise<string>} Sub-agent output
 */
export async function gatherSubAgent(config, context) {
  if (!config.prompt) {
    throw new Error('Sub-agent evidence requires a "prompt" field');
  }

  const prompt = interpolateVariables(config.prompt, context);

  return new Promise((resolve, reject) => {
    const args = ['--print', prompt];
    if (context.projectRoot) {
      args.unshift('--cwd', context.projectRoot);
    }

    const child = execFile('claude', args, {
      timeout: config.timeout || 120000,
      maxBuffer: DEFAULT_SIZE_CAPS.sub_agent,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Sub-agent failed: ${err.message}`));
        return;
      }
      const maxBytes = config.max_bytes || DEFAULT_SIZE_CAPS.sub_agent;
      resolve(truncateLogEvidence(stdout, maxBytes));
    });
  });
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

  const sql = queryTemplate.replace(/\$\{([^}]+)\}/g, (match, expr) => {
    const parts = expr.trim().split('.');
    let value = context.variables || {};

    if (parts[0] in context) {
      value = context;
    }

    for (const part of parts) {
      if (value == null || typeof value !== 'object') return match; // leave unresolved
      value = value[part];
    }

    if (value == null) return match; // leave unresolved placeholders as-is

    paramIndex++;
    params.push(value);
    return `$${paramIndex}`;
  });

  return { sql, params };
}

function resolveLogSource(source, context) {
  if (!source) {
    // Default to session log path
    if (context.sessionLogPath) return context.sessionLogPath;
    throw new Error('No log source specified and no sessionLogPath in context');
  }

  // Predefined source names
  switch (source) {
    case 'session':
    case 'stdout':
      if (!context.sessionLogPath) throw new Error(`Log source "${source}" requires sessionLogPath in context`);
      return context.sessionLogPath;
    case 'build':
      if (!context.buildOutputPath) throw new Error('Log source "build" requires buildOutputPath in context');
      return context.buildOutputPath;
    default:
      // Treat as a file path relative to project root
      return path.resolve(context.projectRoot || '.', source);
  }
}
