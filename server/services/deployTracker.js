const {
  TERMINAL_DEPLOY_STATUSES,
  getLatestDeployment,
  getBuildLogs,
} = require('./railway');

// Lazy require so this module can be imported in tests without a DATABASE_URL.
// Tests pass a fake `query` via the deps argument; production code picks up
// the real one on first call.
function getDefaultQuery() {
  return require('../database').query;
}

// Minimum gap between outbound Railway status polls for the same project.
// Keeps us from hammering Railway when the UI auto-refreshes.
const MIN_POLL_INTERVAL_MS = 3000;

// When a deploy completes (terminal state), we fetch the build log this many
// lines deep. 500 is plenty for the kinds of errors we expect; Phase 2's
// auto-fix session will use the same log.
const LOG_LINE_LIMIT = 500;

function nowIso() {
  return new Date().toISOString();
}

function readProjectDeployRow(project) {
  return {
    projectId: project.id,
    railwayProjectId: project.railway_project_id || null,
    railwayServiceId: project.railway_service_id || null,
    railwayEnvironmentId: project.railway_environment_id || null,
    deploymentUrl: project.deployment_url || null,
    lastDeployId: project.last_deploy_id || null,
    lastDeployStatus: project.last_deploy_status || null,
    lastDeployLogs: project.last_deploy_logs || null,
    lastDeployStartedAt: project.last_deploy_started_at || null,
    lastDeployCheckedAt: project.last_deploy_checked_at || null,
    fixSessionId: project.fix_session_id || null,
  };
}

async function loadProjectRow(projectId, deps = {}) {
  const runQuery = deps.query || getDefaultQuery();
  const { rows } = await runQuery('SELECT * FROM projects WHERE id = $1', [projectId]);
  return rows?.[0] || null;
}

function isTerminal(status) {
  return status ? TERMINAL_DEPLOY_STATUSES.has(status) : false;
}

function shouldSkipPoll(row, nowMs) {
  if (!row.last_deploy_checked_at) return false;
  if (isTerminal(row.last_deploy_status)) return true;
  const lastMs = new Date(row.last_deploy_checked_at).getTime();
  if (Number.isNaN(lastMs)) return false;
  return (nowMs - lastMs) < MIN_POLL_INTERVAL_MS;
}

// Called right after deployProjectToRailway returns. Records the IDs so we
// can poll for this deployment later. Status starts as BUILDING since Railway
// kicks off a build immediately on service creation.
async function recordDeployStart({
  projectId,
  railwayProjectId,
  railwayServiceId,
  railwayEnvironmentId,
  repo,
}, deps = {}) {
  const runQuery = deps.query || getDefaultQuery();
  await runQuery(
    `UPDATE projects
        SET railway_project_id = $1,
            railway_service_id = $2,
            railway_environment_id = $3,
            github_repo = COALESCE(github_repo, $4),
            last_deploy_id = NULL,
            last_deploy_status = 'BUILDING',
            last_deploy_logs = NULL,
            last_deploy_started_at = $5,
            last_deploy_checked_at = $5,
            deployment_url = NULL,
            fix_session_id = NULL
      WHERE id = $6`,
    [railwayProjectId, railwayServiceId, railwayEnvironmentId, repo, nowIso(), projectId]
  );
}

// Look up the latest deployment on Railway for this project's service. When
// the build reaches a terminal state we also pull the build log so the UI
// and (in Phase 2) the auto-fix session have something to read.
async function refreshDeployStatus(projectId, token, deps = {}) {
  const runQuery = deps.query || getDefaultQuery();
  const fetchLatest = deps.getLatestDeployment || getLatestDeployment;
  const fetchLogs = deps.getBuildLogs || getBuildLogs;
  const nowMs = deps.now || Date.now();

  const row = await loadProjectRow(projectId, { query: runQuery });
  if (!row) return null;
  if (!row.railway_service_id) return readProjectDeployRow(row);

  if (shouldSkipPoll(row, nowMs)) return readProjectDeployRow(row);

  const latest = await fetchLatest(row.railway_service_id, token);
  if (!latest) {
    await runQuery(
      `UPDATE projects SET last_deploy_checked_at = $1 WHERE id = $2`,
      [nowIso(), projectId]
    );
    const refreshed = await loadProjectRow(projectId, { query: runQuery });
    return readProjectDeployRow(refreshed);
  }

  const status = latest.status || 'UNKNOWN';
  const deploymentUrl = status === 'SUCCESS' && latest.staticUrl
    ? `https://${latest.staticUrl}`
    : (status === 'SUCCESS' ? row.deployment_url : null);

  let logs = row.last_deploy_logs;
  if (isTerminal(status)) {
    try {
      logs = await fetchLogs(latest.id, token, { limit: LOG_LINE_LIMIT });
    } catch (err) {
      // Logs are best-effort; if Railway can't give them to us we still
      // record the status so the UI shows the failure.
      logs = logs || `(Could not fetch logs: ${err.message})`;
    }
  }

  await runQuery(
    `UPDATE projects
        SET last_deploy_id = $1,
            last_deploy_status = $2,
            last_deploy_logs = $3,
            last_deploy_checked_at = $4,
            deployment_url = COALESCE($5, deployment_url)
      WHERE id = $6`,
    [latest.id, status, logs, nowIso(), deploymentUrl, projectId]
  );

  const refreshed = await loadProjectRow(projectId, { query: runQuery });
  return readProjectDeployRow(refreshed);
}

module.exports = {
  MIN_POLL_INTERVAL_MS,
  LOG_LINE_LIMIT,
  readProjectDeployRow,
  recordDeployStart,
  refreshDeployStatus,
  shouldSkipPoll,
  isTerminal,
};
