// Turns a failed Railway deploy into a Claude fix session.
//
// Called right after we observe a terminal failure (FAILED / CRASHED). The
// session runs in a fresh worktree+branch so the user can review the
// proposed fix in isolation before merging. The build log is embedded in
// the initial prompt so the session has enough context to start debugging
// immediately.

const TRIGGER_STATUSES = new Set(['FAILED', 'CRASHED']);

function getDefaultQuery() {
  return require('../database').query;
}

async function getDefaultCreateSession() {
  return (await import('./sessionManager.js')).createSession;
}

function buildFixPrompt({ projectName, deployStatus, logs }) {
  const trimmed = tailLog(logs, 200);
  return [
    `The Railway deploy for "${projectName}" just failed with status ${deployStatus}.`,
    '',
    'Here is the tail of the build log:',
    '```',
    trimmed || '(no log captured)',
    '```',
    '',
    'Please:',
    '1. Read the log above and figure out what broke the build.',
    '2. Make the minimum fix in this worktree.',
    '3. Commit and push the branch.',
    '4. Tell me (in plain English) what you changed and why so I can merge it.',
    '',
    'Do not edit anything outside this worktree.',
  ].join('\n');
}

function tailLog(logs, lines) {
  if (!logs) return '';
  const all = logs.split('\n');
  return all.slice(-lines).join('\n');
}

async function ensureFixSession(projectId, deps = {}) {
  const runQuery = deps.query || getDefaultQuery();
  const createSession = deps.createSession || (await getDefaultCreateSession());

  const { rows } = await runQuery(
    `SELECT id, name, root_path, last_deploy_status, last_deploy_logs, fix_session_id
       FROM projects WHERE id = $1`,
    [projectId]
  );
  const project = rows?.[0];
  if (!project) return null;
  if (!TRIGGER_STATUSES.has(project.last_deploy_status)) return null;
  if (project.fix_session_id) return project.fix_session_id;

  const sessionInfo = await createSession({
    name: `Fix Railway build for ${project.name}`,
    workingDirectory: project.root_path,
    initialPrompt: buildFixPrompt({
      projectName: project.name,
      deployStatus: project.last_deploy_status,
      logs: project.last_deploy_logs,
    }),
    useWorktree: true,
    permissionMode: 'auto',
  });

  // Claim the session only if no other caller raced us to it. If the claim
  // loses the race the created session is still valid — it just won't be
  // the "official" fix session for this deploy — so the user can close it.
  const result = await runQuery(
    `UPDATE projects
        SET fix_session_id = $1
      WHERE id = $2 AND fix_session_id IS NULL`,
    [sessionInfo.id, projectId]
  );

  if (result.rowCount === 0) {
    const { rows: refreshed } = await runQuery(
      'SELECT fix_session_id FROM projects WHERE id = $1',
      [projectId]
    );
    return refreshed?.[0]?.fix_session_id || sessionInfo.id;
  }

  return sessionInfo.id;
}

module.exports = {
  TRIGGER_STATUSES,
  buildFixPrompt,
  ensureFixSession,
};
