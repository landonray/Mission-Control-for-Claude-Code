/**
 * CLI Agent — runs prompts via `claude --print` subprocess.
 *
 * Uses the Claude CLI on the user's Max plan instead of the paid
 * LLM Gateway API. Each call spawns a short-lived subprocess that
 * takes a prompt on stdin and returns the response on stdout.
 */

const { execFile } = require('child_process');

/**
 * Run a prompt via the Claude CLI and return the text response.
 *
 * @param {string} prompt - The full prompt to send
 * @returns {Promise<string>} The CLI's text output
 */
function run(prompt) {
  return new Promise((resolve, reject) => {
    execFile('claude', ['--print', '-p', prompt], {
      maxBuffer: 1024 * 1024, // 1MB
      timeout: 120000, // 2 minutes
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`CLI agent failed: ${error.message}`));
        return;
      }
      resolve(stdout || '');
    });
  });
}

module.exports = { run };
