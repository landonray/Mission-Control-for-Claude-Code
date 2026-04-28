/**
 * Test Run Detector — recognizes when a Bash command is a test run,
 * and identifies which framework it belongs to.
 *
 * Pure functions, no I/O. The session manager calls these on every Bash
 * tool_use to decide whether to record the result as a test run.
 */

// Each entry: { framework, patterns: RegExp[] }
// Order matters — first match wins. More specific patterns first.
const FRAMEWORK_PATTERNS = [
  {
    framework: 'vitest',
    patterns: [
      /\bvitest\b/i,
      /\bnpx\s+vitest\b/i,
      /\bnpm\s+(run\s+)?test(:\w+)?\b.*vitest/i,
    ],
  },
  {
    framework: 'jest',
    patterns: [
      /\bjest\b/i,
      /\bnpx\s+jest\b/i,
    ],
  },
  {
    framework: 'mocha',
    patterns: [
      /\bmocha\b/i,
      /\bnpx\s+mocha\b/i,
    ],
  },
  {
    framework: 'playwright',
    patterns: [
      /\bplaywright\s+test\b/i,
      /\bnpx\s+playwright\s+test\b/i,
    ],
  },
  {
    framework: 'cypress',
    patterns: [
      /\bcypress\s+run\b/i,
      /\bnpx\s+cypress\s+run\b/i,
    ],
  },
  {
    framework: 'pytest',
    patterns: [
      /\bpytest\b/i,
      /\bpython\s+-m\s+pytest\b/i,
    ],
  },
  {
    framework: 'unittest',
    patterns: [
      /\bpython\s+-m\s+unittest\b/i,
    ],
  },
  {
    framework: 'go',
    patterns: [
      /\bgo\s+test\b/i,
    ],
  },
  {
    framework: 'cargo',
    patterns: [
      /\bcargo\s+test\b/i,
    ],
  },
  {
    framework: 'rspec',
    patterns: [
      /\brspec\b/i,
      /\bbundle\s+exec\s+rspec\b/i,
    ],
  },
  {
    framework: 'phpunit',
    patterns: [
      /\bphpunit\b/i,
      /\b\.\/vendor\/bin\/phpunit\b/i,
    ],
  },
  // Generic npm/yarn/pnpm test scripts — checked last so framework-specific
  // matches above win when a script body shells out to (e.g.) vitest.
  {
    framework: 'npm-test',
    patterns: [
      /\bnpm\s+(run\s+)?test(:\w+)?\b/i,
      /\byarn\s+(run\s+)?test(:\w+)?\b/i,
      /\bpnpm\s+(run\s+)?test(:\w+)?\b/i,
      /\bbun\s+test\b/i,
    ],
  },
];

// Replace anything inside matched quotes with empty quotes so commit messages,
// PR titles/bodies, and --title/--body arguments don't trigger matches.
// e.g. `gh pr create --body "Test plan: npm test"` becomes
// `gh pr create --body ""` after stripping.
function stripQuotedContent(s) {
  return s
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// Strip leading env-var assignments (e.g. `FOO=bar BAZ=qux <cmd>`) so the
// command's actual executable is what we evaluate.
function removeLeadingEnvVars(s) {
  return s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '');
}

/**
 * Returns the framework name if the command looks like a test run,
 * or null if it doesn't.
 *
 * Handles common shell wrappers — chained commands (`cd /path && vitest`),
 * pipes (`vitest | tail`), env-var prefixes (`CI=1 vitest`), and quoted
 * arguments (so `gh pr create --body "...npm test..."` doesn't match).
 *
 * @param {string} command — the raw bash command string
 * @returns {string|null}
 */
function detectFramework(command) {
  if (!command || typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  const stripped = stripQuotedContent(trimmed);

  // Split into shell-separated segments (&&, ||, ;, |). Each segment is
  // evaluated independently — the first segment that matches wins. This lets
  // `cd /path && npx vitest run` succeed (the second segment matches) while
  // `git commit -m "..."` fails (no segment matches any test runner pattern).
  const segments = stripped.split(/&&|\|\||;|\|/);

  for (const rawSegment of segments) {
    const segment = removeLeadingEnvVars(rawSegment.trim());
    if (!segment) continue;

    for (const { framework, patterns } of FRAMEWORK_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(segment)) {
          return framework;
        }
      }
    }
  }
  return null;
}

/**
 * Convenience: returns true if the command is recognized as a test run.
 * @param {string} command
 * @returns {boolean}
 */
function isTestCommand(command) {
  return detectFramework(command) !== null;
}

module.exports = { detectFramework, isTestCommand };
