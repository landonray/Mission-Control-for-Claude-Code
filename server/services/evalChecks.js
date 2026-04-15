/**
 * Eval Check Runner — runs deterministic checks against gathered evidence.
 */

import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';

/**
 * Run a single check against evidence.
 * @param {object} check - Check definition with type, description, and type-specific fields
 * @param {string} evidence - The gathered evidence string
 * @param {object} [context] - Optional context with projectRoot for schema resolution
 * @returns {{ type: string, description: string, passed: boolean, reason: string }}
 */
export function runCheck(check, evidence, context) {
  const base = {
    type: check.type,
    description: check.description || check.type,
  };

  switch (check.type) {
    case 'regex_match':
      return regexMatch(base, check, evidence);
    case 'not_empty':
      return notEmpty(base, evidence);
    case 'json_valid':
      return jsonValid(base, evidence);
    case 'json_schema':
      return jsonSchema(base, check, evidence, context);
    case 'http_status':
      return httpStatus(base, check, evidence);
    case 'field_exists':
      return fieldExists(base, check, evidence);
    default:
      return { ...base, passed: false, reason: `Unknown check type: ${check.type}` };
  }
}

/**
 * Run all checks against evidence (no short-circuit — runs all even if some fail).
 * @param {object[]} checks - Array of check definitions
 * @param {string} evidence - The gathered evidence string
 * @param {object} [context] - Optional context with projectRoot for schema resolution
 * @returns {{ allPassed: boolean, results: object[], failures: object[] }}
 */
export function runAllChecks(checks, evidence, context) {
  const results = checks.map((check) => runCheck(check, evidence, context));
  const failures = results.filter((r) => !r.passed);
  return {
    allPassed: failures.length === 0,
    results,
    failures,
  };
}

// --- Check implementations ---

function regexMatch(base, check, evidence) {
  if (!check.pattern) {
    return { ...base, passed: false, reason: 'No pattern specified' };
  }
  try {
    const regex = new RegExp(check.pattern, check.flags || '');
    const passed = regex.test(evidence || '');
    return {
      ...base,
      passed,
      reason: passed
        ? `Pattern /${check.pattern}/ matched`
        : `Pattern /${check.pattern}/ did not match`,
    };
  } catch (err) {
    return { ...base, passed: false, reason: `Invalid regex: ${err.message}` };
  }
}

function notEmpty(base, evidence) {
  const passed = evidence != null && String(evidence).trim().length > 0;
  return {
    ...base,
    passed,
    reason: passed ? 'Evidence is non-empty' : 'Evidence is null or empty',
  };
}

function jsonValid(base, evidence) {
  try {
    JSON.parse(evidence);
    return { ...base, passed: true, reason: 'Valid JSON' };
  } catch {
    return { ...base, passed: false, reason: 'Evidence is not valid JSON' };
  }
}

function jsonSchema(base, check, evidence, context) {
  let parsed;
  try {
    parsed = JSON.parse(evidence);
  } catch {
    return { ...base, passed: false, reason: 'Evidence is not valid JSON' };
  }

  if (!check.schema) {
    return { ...base, passed: false, reason: 'No schema specified in check config' };
  }

  // Resolve schema path relative to project root
  const projectRoot = context && context.projectRoot;
  if (!projectRoot) {
    return { ...base, passed: false, reason: 'Cannot resolve schema path — no project root in context' };
  }

  const schemaPath = path.resolve(projectRoot, check.schema);

  // Prevent path traversal outside project root
  const resolvedRoot = path.resolve(projectRoot);
  if (!schemaPath.startsWith(resolvedRoot + path.sep) && schemaPath !== resolvedRoot) {
    return { ...base, passed: false, reason: `Path traversal denied: schema "${check.schema}" resolves outside project root` };
  }

  let schemaObj;
  try {
    const raw = fs.readFileSync(schemaPath, 'utf8');
    schemaObj = JSON.parse(raw);
  } catch (err) {
    return { ...base, passed: false, reason: `Failed to load schema "${check.schema}": ${err.message}` };
  }

  try {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schemaObj);
    const valid = validate(parsed);
    if (valid) {
      return { ...base, passed: true, reason: `Evidence conforms to schema "${check.schema}"` };
    }
    const errorDetails = validate.errors
      .map(e => `${e.instancePath || '/'}: ${e.message}`)
      .join('; ');
    return { ...base, passed: false, reason: `Schema validation failed: ${errorDetails}` };
  } catch (err) {
    return { ...base, passed: false, reason: `Schema compilation error: ${err.message}` };
  }
}

function httpStatus(base, check, evidence) {
  if (!check.status) {
    return { ...base, passed: false, reason: 'No status code specified' };
  }
  const statusStr = String(check.status);
  const passed = String(evidence || '').includes(statusStr);
  return {
    ...base,
    passed,
    reason: passed
      ? `Found status code ${statusStr} in evidence`
      : `Status code ${statusStr} not found in evidence`,
  };
}

function fieldExists(base, check, evidence) {
  if (!check.field) {
    return { ...base, passed: false, reason: 'No field specified' };
  }
  try {
    const obj = JSON.parse(evidence);
    // Support nested fields with dot notation
    const parts = check.field.split('.');
    let current = obj;
    for (const part of parts) {
      if (current == null || typeof current !== 'object' || !(part in current)) {
        return {
          ...base,
          passed: false,
          reason: `Field "${check.field}" not found in JSON evidence`,
        };
      }
      current = current[part];
    }
    return { ...base, passed: true, reason: `Field "${check.field}" exists` };
  } catch {
    return { ...base, passed: false, reason: 'Evidence is not valid JSON' };
  }
}
