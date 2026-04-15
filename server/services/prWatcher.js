/**
 * PR Watcher — polls GitHub for PR updates and triggers eval batches.
 *
 * Uses the `gh` CLI to check for new commits on open PRs associated with a project.
 * When a new commit is detected on a PR, it fires the `pr_updated` trigger
 * for any armed eval folders configured for that trigger.
 */

import { execFile } from 'child_process';

// Track last-seen commit SHA per PR (keyed by "owner/repo#number")
const lastSeenSha = new Map();

// Active polling intervals per project
const activePollers = new Map();

// Default poll interval: 2 minutes
const DEFAULT_POLL_INTERVAL = 2 * 60 * 1000;

/**
 * Start polling for PR updates for a project.
 * @param {string} projectId - The project ID
 * @param {string} projectRoot - Absolute path to the project root
 * @param {function} onPrUpdated - Callback: (projectId, prNumber, headSha) => void
 * @param {number} [intervalMs] - Poll interval in ms (default 2 min)
 */
export function startPrWatcher(projectId, projectRoot, onPrUpdated, intervalMs) {
  if (activePollers.has(projectId)) return; // Already watching

  const interval = intervalMs || DEFAULT_POLL_INTERVAL;

  const poll = async () => {
    try {
      const prs = await listOpenPrs(projectRoot);
      for (const pr of prs) {
        const key = `${projectId}:${pr.number}`;
        const prevSha = lastSeenSha.get(key);
        if (prevSha && prevSha !== pr.headSha) {
          // New commit detected on this PR
          console.log(`[PRWatcher] PR #${pr.number} updated: ${prevSha} → ${pr.headSha}`);
          try {
            onPrUpdated(projectId, pr.number, pr.headSha);
          } catch (err) {
            console.error(`[PRWatcher] Callback error for PR #${pr.number}:`, err.message);
          }
        }
        lastSeenSha.set(key, pr.headSha);
      }
    } catch (err) {
      console.error(`[PRWatcher] Poll error for project ${projectId}:`, err.message);
    }
  };

  // Initial poll to seed the SHA map (no triggers on first poll)
  poll();

  const timer = setInterval(poll, interval);
  activePollers.set(projectId, timer);
  console.log(`[PRWatcher] Started watching PRs for project ${projectId} (every ${interval / 1000}s)`);
}

/**
 * Stop polling for a project.
 */
export function stopPrWatcher(projectId) {
  const timer = activePollers.get(projectId);
  if (timer) {
    clearInterval(timer);
    activePollers.delete(projectId);
    console.log(`[PRWatcher] Stopped watching PRs for project ${projectId}`);
  }
}

/**
 * Stop all active watchers.
 */
export function stopAllPrWatchers() {
  for (const [projectId, timer] of activePollers) {
    clearInterval(timer);
    console.log(`[PRWatcher] Stopped watching PRs for project ${projectId}`);
  }
  activePollers.clear();
}

/**
 * Check if a project has an active PR watcher.
 */
export function isWatching(projectId) {
  return activePollers.has(projectId);
}

/**
 * List open PRs using `gh` CLI.
 * @param {string} cwd - The project root directory
 * @returns {Promise<Array<{number: number, headSha: string, title: string}>>}
 */
function listOpenPrs(cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', [
      'pr', 'list',
      '--state', 'open',
      '--json', 'number,headRefOid,title',
      '--limit', '20',
    ], { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        // gh not available or not in a git repo — gracefully return empty
        if (err.code === 'ENOENT') {
          reject(new Error('gh CLI not found — install GitHub CLI to use pr_updated trigger'));
          return;
        }
        reject(new Error(`gh pr list failed: ${stderr || err.message}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.map(pr => ({
          number: pr.number,
          headSha: pr.headRefOid,
          title: pr.title,
        })));
      } catch (parseErr) {
        reject(new Error(`Failed to parse gh output: ${parseErr.message}`));
      }
    });
  });
}
