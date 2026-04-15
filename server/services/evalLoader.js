/**
 * Eval Loader — reads and validates YAML eval definition files.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export const VALID_CHECK_TYPES = [
  'regex_match',
  'not_empty',
  'json_valid',
  'json_schema',
  'http_status',
  'field_exists',
];

export const VALID_EVIDENCE_TYPES = ['log_query', 'db_query', 'sub_agent', 'file'];

/**
 * Load and validate a single YAML eval file.
 * @param {string} filePath - Absolute path to the YAML file
 * @returns {object} Parsed and validated eval definition
 */
export function loadEval(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid eval file: ${filePath} — not a valid YAML object`);
  }

  validate(parsed, filePath);

  // Attach source path for tracing
  parsed._source = filePath;
  return parsed;
}

/**
 * Load all YAML eval files from a folder.
 * @param {string} folderPath - Absolute path to folder containing .yaml/.yml files
 * @returns {object[]} Array of parsed eval definitions
 */
export function loadEvalFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    return [];
  }

  const files = fs.readdirSync(folderPath).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml')
  );

  return files.map((f) => loadEval(path.join(folderPath, f)));
}

/**
 * Discover eval folders from project config or by scanning the evals/ directory.
 * @param {string} projectRoot - Absolute path to project root
 * @param {object} [config] - Optional config with eval_dirs array
 * @returns {string[]} Array of absolute folder paths containing eval files
 */
export function discoverEvalFolders(projectRoot, config) {
  // If config specifies eval directories, use those
  if (config && Array.isArray(config.eval_dirs) && config.eval_dirs.length > 0) {
    return config.eval_dirs.map((dir) => path.resolve(projectRoot, dir));
  }

  // Default: scan for evals/ directory at project root
  const defaultDir = path.join(projectRoot, 'evals');
  if (fs.existsSync(defaultDir)) {
    return [defaultDir];
  }

  return [];
}

/**
 * Validate an eval definition object.
 */
function validate(evalDef, filePath) {
  const label = filePath || 'eval';

  if (!evalDef.name) {
    throw new Error(`${label}: missing required field "name"`);
  }
  if (!evalDef.description) {
    throw new Error(`${label}: missing required field "description"`);
  }
  if (!evalDef.evidence) {
    throw new Error(`${label}: missing required field "evidence"`);
  }

  // Must have at least checks or judge_prompt
  if (!evalDef.checks && !evalDef.judge_prompt) {
    throw new Error(
      `${label}: must have at least one of "checks" or "judge_prompt"`
    );
  }

  // If judge_prompt, expected is required
  if (evalDef.judge_prompt && !evalDef.expected) {
    throw new Error(
      `${label}: "expected" is required when "judge_prompt" is present`
    );
  }

  // Validate evidence type
  if (evalDef.evidence.type && !VALID_EVIDENCE_TYPES.includes(evalDef.evidence.type)) {
    throw new Error(
      `${label}: invalid evidence type "${evalDef.evidence.type}" — must be one of ${VALID_EVIDENCE_TYPES.join(', ')}`
    );
  }

  // Validate check types
  if (evalDef.checks && Array.isArray(evalDef.checks)) {
    for (const check of evalDef.checks) {
      if (check.type && !VALID_CHECK_TYPES.includes(check.type)) {
        throw new Error(
          `${label}: invalid check type "${check.type}" — must be one of ${VALID_CHECK_TYPES.join(', ')}`
        );
      }
    }
  }
}
