/**
 * CLI Agent — runs prompts via `claude` subprocess.
 *
 * Uses the Claude CLI on the user's Max plan instead of the paid
 * LLM Gateway API. Each call spawns a short-lived subprocess that
 * takes a prompt on stdin and returns the response on stdout.
 *
 * Supports two modes:
 *   - print mode (default): `claude --print` — single-shot, no tools
 *   - agent mode: full Claude session with tool access (Read, Glob, Grep, etc.)
 */

const { execFile } = require('child_process');

/**
 * Run a prompt via the Claude CLI and return the text response.
 *
 * @param {string} prompt - The full prompt to send
 * @param {object} [options] - Optional settings
 * @param {string[]} [options.allowedTools] - Tools to grant (e.g. ['Read', 'Glob', 'Grep'])
 * @param {string} [options.cwd] - Working directory for the subprocess
 * @param {number} [options.timeout] - Timeout in ms (default 120000)
 * @param {AbortSignal} [options.signal] - AbortSignal to cancel the subprocess
 * @returns {Promise<string>} The CLI's text output
 */
function run(prompt, options = {}) {
  const { allowedTools, cwd, timeout = 120000, signal } = options;

  const args = ['--print', '-p', prompt];

  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const child = execFile('claude', args, {
      maxBuffer: 1024 * 1024, // 1MB
      timeout,
      cwd: cwd || undefined,
    }, (error, stdout, stderr) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      if (error) {
        reject(new Error(`CLI agent failed: ${error.message}`));
        return;
      }
      resolve(stdout || '');
    });

    if (signal) {
      const onAbort = () => {
        child.kill('SIGTERM');
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
      // Clean up listener if process exits normally
      child.on('exit', () => signal.removeEventListener('abort', onAbort));
    }
  });
}

module.exports = { run };
