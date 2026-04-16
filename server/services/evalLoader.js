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
  'equals',
  'contains',
  'greater_than',
  'less_than',
  'numeric_score',
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
  // Config structure from .mission-control.yaml: { evals: { folders: [...] } }
  if (config && config.evals && Array.isArray(config.evals.folders) && config.evals.folders.length > 0) {
    return config.evals.folders.map((dir) => path.resolve(projectRoot, dir));
  }

  // Default: scan for evals/ directory at project root.
  // The spec says each subfolder is a logical group (the unit of arming),
  // so return subdirectories that contain YAML files, or the evals/ dir itself
  // if it directly contains YAML files.
  const defaultDir = path.join(projectRoot, 'evals');
  if (!fs.existsSync(defaultDir)) {
    return [];
  }

  const entries = fs.readdirSync(defaultDir, { withFileTypes: true });
  const subfolders = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(defaultDir, e.name));

  // If there are subfolders, use them as eval folders (spec: each subfolder = a group)
  if (subfolders.length > 0) {
    return subfolders;
  }

  // Fallback: if YAML files are directly in evals/ (flat structure), use that
  const hasYaml = entries.some((e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')));
  if (hasYaml) {
    return [defaultDir];
  }

  return [];
}

/**
 * Resolve the base directory where new eval folders should be created.
 * If config specifies eval folders, we use the parent of the first configured folder
 * (so new folders are siblings of existing ones). Otherwise, default to evals/ at
 * the project root.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {object} [config] - Optional project config with evals.folders array
 * @returns {string} Absolute path to the evals base directory
 */
export function getEvalsBaseDir(projectRoot, config) {
  if (config && config.evals && Array.isArray(config.evals.folders) && config.evals.folders.length > 0) {
    const firstFolder = path.resolve(projectRoot, config.evals.folders[0]);
    return path.dirname(firstFolder);
  }
  return path.join(projectRoot, 'evals');
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
  if (!evalDef.input || typeof evalDef.input !== 'object' || Array.isArray(evalDef.input)) {
    throw new Error(`${label}: missing or invalid "input" field — must be a key-value map`);
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

  // Validate evidence type — required field per spec
  if (!evalDef.evidence.type) {
    throw new Error(
      `${label}: missing required field "evidence.type" — must be one of ${VALID_EVIDENCE_TYPES.join(', ')}`
    );
  }
  if (!VALID_EVIDENCE_TYPES.includes(evalDef.evidence.type)) {
    throw new Error(
      `${label}: invalid evidence type "${evalDef.evidence.type}" — must be one of ${VALID_EVIDENCE_TYPES.join(', ')}`
    );
  }

  // Validate judge.model if provided — must be a tier key, not a model name
  if (evalDef.judge && evalDef.judge.model) {
    const validModelTiers = ['default', 'fast', 'strong'];
    if (!validModelTiers.includes(evalDef.judge.model)) {
      throw new Error(
        `${label}: invalid judge model "${evalDef.judge.model}" — must be one of ${validModelTiers.join(', ')} (not a model name)`
      );
    }
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
