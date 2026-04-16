/**
 * Eval Authoring Service — builds prompts for the AI eval authoring agent,
 * parses its output, and orchestrates the full authoring flow.
 */

import fs from 'fs';
import path from 'path';
import cliAgent from './cliAgent.js';

// ─── Schema reference data ────────────────────────────────────────────────────

const EVIDENCE_TYPES = {
  log_query: {
    description: 'Read from a log file or session log',
    fields: {
      source: 'Required. "stdout", "stderr", or an absolute path to a log file',
      query: 'Optional. A search string or regex to filter log lines',
    },
  },
  db_query: {
    description: 'Run a SQL query against the project database',
    fields: {
      sql: 'Required. The SQL SELECT query to execute',
      connection: 'Optional. Override database connection string (defaults to DATABASE_URL)',
    },
  },
  sub_agent: {
    description: 'Spawn a sub-agent with a prompt and collect its output',
    fields: {
      prompt: 'Required. The prompt to send to the sub-agent',
      tools: 'Optional. Array of tool names to grant (e.g. ["Read", "Grep"])',
      timeout: 'Optional. Timeout in milliseconds (default 60000)',
    },
  },
  file: {
    description: 'Read the contents of a file',
    fields: {
      path: 'Required. Absolute or relative path to the file to read',
      allow_empty: 'Optional. If true, empty file does not count as a failure',
    },
  },
};

const CHECK_TYPES = {
  regex_match: {
    description: 'Evidence must match a regular expression',
    fields: {
      pattern: 'Required. The regex pattern to match against the evidence',
    },
  },
  not_empty: {
    description: 'Evidence must not be empty or blank',
    fields: {},
  },
  json_valid: {
    description: 'Evidence must be valid JSON',
    fields: {},
  },
  json_schema: {
    description: 'Evidence (as JSON) must match a JSON Schema',
    fields: {
      schema: 'Required. A JSON Schema object to validate the evidence against',
    },
  },
  http_status: {
    description: 'Evidence must contain an HTTP status code matching the expected value',
    fields: {
      expected: 'Required. The expected HTTP status code (e.g. 200)',
    },
  },
  field_exists: {
    description: 'A specific field must exist in the evidence (JSON path)',
    fields: {
      field: 'Required. Dot-notation path to the field (e.g. "data.user.id")',
    },
  },
  equals: {
    description: 'Evidence must exactly equal the expected value',
    fields: {
      expected: 'Required. The expected string value',
    },
  },
  contains: {
    description: 'Evidence must contain the expected substring',
    fields: {
      expected: 'Required. The substring that must appear in the evidence',
    },
  },
  greater_than: {
    description: 'Evidence (as a number) must be greater than the threshold',
    fields: {
      value: 'Required. The numeric threshold',
    },
  },
  less_than: {
    description: 'Evidence (as a number) must be less than the threshold',
    fields: {
      value: 'Required. The numeric threshold',
    },
  },
  numeric_score: {
    description: 'Evidence must be a number within the specified range',
    fields: {
      min: 'Optional. Minimum acceptable value (inclusive)',
      max: 'Optional. Maximum acceptable value (inclusive)',
    },
  },
};

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build a system prompt for the AI eval authoring agent.
 *
 * @param {object} options
 * @param {string} options.description - User's natural-language description
 * @param {string} options.folderPath - Absolute path to the target eval folder
 * @param {string} options.projectRoot - Absolute path to project root
 * @param {object} [options.missionControlConfig] - Parsed .mission-control.yaml
 * @param {string} [options.refinement] - "What would you like to change?" text
 * @param {object} [options.currentFormState] - Current form field values for refinement
 * @param {string} [options.hints] - Additional context hints
 * @returns {string} The full prompt string
 */
export function buildAuthoringPrompt(options) {
  const {
    description,
    folderPath,
    projectRoot,
    missionControlConfig,
    refinement,
    currentFormState,
    hints,
  } = options;

  const sections = [];

  // ── Task framing ──────────────────────────────────────────────────────────
  sections.push(`You are an expert at writing eval definitions for the Mission Control eval system.
Your job is to create a well-structured eval definition in JSON format based on the user's request.

Before drafting the eval, investigate the project:
- Use Read, Glob, and Grep to understand the codebase structure
- Look at the eval folder to understand existing eval style and conventions
- Find relevant code, logs, or database schemas that inform how to gather evidence

After investigating, output your eval as a JSON object inside a \`\`\`json code block.
Then write a REASONING: paragraph explaining your choices.`);

  // ── User request ──────────────────────────────────────────────────────────
  if (refinement && currentFormState) {
    sections.push(`## Original Request

${description}

## Current Eval State

${JSON.stringify(currentFormState, null, 2)}

## Refinement Request

${refinement}`);
  } else {
    sections.push(`## User Request

${description}`);
  }

  if (hints) {
    sections.push(`## Additional Context\n\n${hints}`);
  }

  // ── Project context ───────────────────────────────────────────────────────
  sections.push(`## Project Root\n\n${projectRoot}`);

  if (missionControlConfig) {
    sections.push(`## Project Configuration (.mission-control.yaml)\n\n${JSON.stringify(missionControlConfig, null, 2)}`);
  }

  // ── Eval folder listing ───────────────────────────────────────────────────
  const folderListing = getFolderListing(folderPath);
  sections.push(`## Eval Folder: ${folderPath}\n\n${folderListing}`);

  // ── Style references ──────────────────────────────────────────────────────
  const styleRefs = getStyleReferences(folderPath);
  if (styleRefs) {
    sections.push(`## Existing Eval Examples (for style reference)\n\n${styleRefs}`);
  }

  // ── Schema reference ──────────────────────────────────────────────────────
  sections.push(buildSchemaReference());

  // ── Output format instructions ────────────────────────────────────────────
  sections.push(`## Output Format

Output your eval definition as a JSON object inside a \`\`\`json code block.
The JSON should represent the full eval definition, not YAML.

After the code block, write:

REASONING: [one paragraph explaining why you chose this evidence type, these checks, and any other design decisions]`);

  return sections.join('\n\n');
}

// ─── Helpers for prompt construction ─────────────────────────────────────────

function getFolderListing(folderPath) {
  if (!fs.existsSync(folderPath)) {
    return '(folder does not exist yet — this will be the first eval in it)';
  }

  const files = fs.readdirSync(folderPath).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml')
  );

  if (files.length === 0) {
    return '(no eval files yet — this will be the first)';
  }

  return files.map((f) => `- ${f}`).join('\n');
}

function getStyleReferences(folderPath) {
  if (!fs.existsSync(folderPath)) {
    return null;
  }

  const files = fs.readdirSync(folderPath)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .slice(0, 2); // Max 2 style references

  if (files.length === 0) {
    return null;
  }

  return files.map((f) => {
    const fullPath = path.join(folderPath, f);
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
      if (content.length > 2000) {
        content = content.slice(0, 2000) + '\n... (truncated)';
      }
    } catch {
      return null;
    }
    return `### ${f}\n\n\`\`\`yaml\n${content}\n\`\`\``;
  }).filter(Boolean).join('\n\n');
}

function buildSchemaReference() {
  const lines = ['## Eval Schema Reference'];

  // Evidence types
  lines.push('\n### Evidence Types\n');
  lines.push('The `evidence` field defines how to collect data to evaluate. Choose one type:\n');

  for (const [type, info] of Object.entries(EVIDENCE_TYPES)) {
    lines.push(`**${type}** — ${info.description}`);
    for (const [field, desc] of Object.entries(info.fields)) {
      lines.push(`  - \`${field}\`: ${desc}`);
    }
    lines.push('');
  }

  // Check types
  lines.push('\n### Check Types\n');
  lines.push('The `checks` array defines assertions to run against the evidence. Available types:\n');

  for (const [type, info] of Object.entries(CHECK_TYPES)) {
    lines.push(`**${type}** — ${info.description}`);
    for (const [field, desc] of Object.entries(info.fields)) {
      lines.push(`  - \`${field}\`: ${desc}`);
    }
    lines.push('');
  }

  // Judge configuration
  lines.push('\n### Judge Configuration (alternative to checks)\n');
  lines.push(`Instead of (or in addition to) \`checks\`, you can use an AI judge:

- \`judge_prompt\`: A question or instruction for the judge to evaluate the evidence
- \`expected\`: Required when judge_prompt is set. What the judge should conclude.
- \`judge.model\`: Optional. Model tier to use: \`default\` | \`fast\` | \`strong\` (default: \`default\`)`);

  // Variable interpolation
  lines.push('\n### Variable Interpolation\n');
  lines.push(`Use these variables anywhere in your eval definition (they are substituted at runtime):

- \`\${input.key}\` — Any field from the eval's \`input\` map
- \`\${eval.name}\` — The name of the current eval
- \`\${run.commit_sha}\` — The git commit SHA of the current run
- \`\${run.trigger}\` — What triggered the eval run (e.g. "manual", "pr", "push")
- \`\${project.root}\` — The absolute path to the project root`);

  return lines.join('\n');
}

// ─── Output parser ────────────────────────────────────────────────────────────

/**
 * Extract a JSON eval definition and reasoning from the agent's text output.
 *
 * @param {string} output - The agent's full text output
 * @returns {{ eval: object|null, reasoning: string|null, error: string|null }}
 */
export function parseAuthoringOutput(output) {
  // Extract JSON from ```json ... ``` code block
  const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    return {
      eval: null,
      reasoning: null,
      error: 'No JSON code block found in output — the agent did not produce a valid eval definition',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[1].trim());
  } catch (err) {
    return {
      eval: null,
      reasoning: null,
      error: `Invalid JSON in code block: ${err.message}`,
    };
  }

  // Extract reasoning paragraph (text after "REASONING:")
  const reasoningMatch = output.match(/REASONING:\s*([\s\S]*?)(?:\n\n|$)/);
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : null;

  return {
    eval: parsed,
    reasoning,
    error: null,
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run the full eval authoring flow: build prompt, spawn CLI agent, parse output.
 *
 * @param {object} options - Same as buildAuthoringPrompt, plus:
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @returns {Promise<{ eval: object|null, reasoning: string|null, error: string|null }>}
 */
export async function runAuthoring(options) {
  const { signal, ...promptOptions } = options;

  const prompt = buildAuthoringPrompt(promptOptions);

  let output;
  try {
    output = await cliAgent.run(prompt, {
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash(read-only)'],
      cwd: promptOptions.projectRoot,
      timeout: 180000,
      signal,
    });
  } catch (err) {
    return {
      eval: null,
      reasoning: null,
      error: `CLI agent failed: ${err.message}`,
    };
  }

  return parseAuthoringOutput(output);
}
