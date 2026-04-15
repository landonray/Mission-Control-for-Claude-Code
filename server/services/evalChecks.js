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
    case 'equals':
      return equals(base, check, evidence);
    case 'contains':
      return contains(base, check, evidence);
    case 'greater_than':
      return greaterThan(base, check, evidence);
    case 'less_than':
      return lessThan(base, check, evidence);
    case 'numeric_score':
      return numericScore(base, check, evidence);
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

/**
 * Extract a value from evidence, optionally from a JSON field using dot notation.
 * Returns { value, error } — error is a string if extraction fails.
 */
function extractValue(evidence, field) {
  if (!field) {
    return { value: evidence || '' };
  }
  let obj;
  try {
    obj = JSON.parse(evidence);
  } catch {
    return { error: 'Evidence is not valid JSON (required when "field" is specified)' };
  }
  const parts = field.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object' || !(part in current)) {
      return { error: `Field "${field}" not found in JSON evidence` };
    }
    current = current[part];
  }
  return { value: current };
}

function equals(base, check, evidence) {
  if (check.value === undefined) {
    return { ...base, passed: false, reason: 'No "value" specified in check config' };
  }
  const extracted = extractValue(evidence, check.field);
  if (extracted.error) {
    return { ...base, passed: false, reason: extracted.error };
  }
  const actual = extracted.value;
  const expected = check.value;
  const passed = String(actual) === String(expected);
  return {
    ...base,
    passed,
    reason: passed
      ? `Value equals "${expected}"`
      : `Expected "${expected}" but got "${actual}"`,
  };
}

function contains(base, check, evidence) {
  if (check.value === undefined) {
    return { ...base, passed: false, reason: 'No "value" specified in check config' };
  }
  const extracted = extractValue(evidence, check.field);
  if (extracted.error) {
    return { ...base, passed: false, reason: extracted.error };
  }
  const haystack = String(extracted.value);
  const needle = String(check.value);
  const passed = haystack.includes(needle);
  return {
    ...base,
    passed,
    reason: passed
      ? `Evidence contains "${needle}"`
      : `Evidence does not contain "${needle}"`,
  };
}

function parseNumeric(value, label) {
  const num = Number(value);
  if (isNaN(num)) {
    return { error: `${label} is not a number: "${value}"` };
  }
  return { num };
}

function greaterThan(base, check, evidence) {
  if (check.value === undefined) {
    return { ...base, passed: false, reason: 'No "value" specified in check config' };
  }
  const extracted = extractValue(evidence, check.field);
  if (extracted.error) {
    return { ...base, passed: false, reason: extracted.error };
  }
  const actual = parseNumeric(extracted.value, 'Evidence value');
  if (actual.error) return { ...base, passed: false, reason: actual.error };
  const threshold = parseNumeric(check.value, 'Threshold');
  if (threshold.error) return { ...base, passed: false, reason: threshold.error };

  const passed = actual.num > threshold.num;
  return {
    ...base,
    passed,
    reason: passed
      ? `${actual.num} > ${threshold.num}`
      : `${actual.num} is not greater than ${threshold.num}`,
  };
}

function lessThan(base, check, evidence) {
  if (check.value === undefined) {
    return { ...base, passed: false, reason: 'No "value" specified in check config' };
  }
  const extracted = extractValue(evidence, check.field);
  if (extracted.error) {
    return { ...base, passed: false, reason: extracted.error };
  }
  const actual = parseNumeric(extracted.value, 'Evidence value');
  if (actual.error) return { ...base, passed: false, reason: actual.error };
  const threshold = parseNumeric(check.value, 'Threshold');
  if (threshold.error) return { ...base, passed: false, reason: threshold.error };

  const passed = actual.num < threshold.num;
  return {
    ...base,
    passed,
    reason: passed
      ? `${actual.num} < ${threshold.num}`
      : `${actual.num} is not less than ${threshold.num}`,
  };
}

function numericScore(base, check, evidence) {
  const extracted = extractValue(evidence, check.field);
  if (extracted.error) {
    return { ...base, passed: false, reason: extracted.error };
  }
  const parsed = parseNumeric(extracted.value, 'Score value');
  if (parsed.error) return { ...base, passed: false, reason: parsed.error };

  const score = parsed.num;
  let passed = true;
  const violations = [];

  if (check.min !== undefined) {
    const minVal = parseNumeric(check.min, 'Min threshold');
    if (minVal.error) return { ...base, passed: false, reason: minVal.error };
    if (score < minVal.num) {
      passed = false;
      violations.push(`below min ${minVal.num}`);
    }
  }
  if (check.max !== undefined) {
    const maxVal = parseNumeric(check.max, 'Max threshold');
    if (maxVal.error) return { ...base, passed: false, reason: maxVal.error };
    if (score > maxVal.num) {
      passed = false;
      violations.push(`above max ${maxVal.num}`);
    }
  }

  return {
    ...base,
    passed,
    score,
    reason: passed
      ? `Score: ${score}` + (check.min !== undefined || check.max !== undefined
          ? ` (within range${check.min !== undefined ? ` min=${check.min}` : ''}${check.max !== undefined ? ` max=${check.max}` : ''})`
          : '')
      : `Score: ${score} — ${violations.join(', ')}`,
  };
}
