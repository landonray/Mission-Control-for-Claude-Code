import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../utils/api';
import { ArrowLeft, Github, Folder, Rocket, ExternalLink, RefreshCw, X, Wrench, Trash2 } from 'lucide-react';
import styles from './ProjectDetail.module.css';

const SERVER_POLL_INTERVAL_MS = 3000;
const DEPLOY_POLL_INTERVAL_MS = 5000;
const TERMINAL_DEPLOY_STATUSES = new Set(['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [servers, setServers] = useState([]);
  const [extras, setExtras] = useState([]);
  const [killingPid, setKillingPid] = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const [hostError, setHostError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [deploy, setDeploy] = useState(null);
  const [refreshingDeploy, setRefreshingDeploy] = useState(false);
  const pollRef = useRef(null);
  const deployPollRef = useRef(null);

  const loadProject = useCallback(async () => {
    try {
      setError(null);
      const data = await api.get(`/api/projects/${id}`);
      setProject(data);
      setServers(data.servers || []);
      setExtras(data.extra_processes || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const pollServers = useCallback(async () => {
    try {
      const data = await api.get(`/api/projects/${id}/servers`);
      setServers(data.servers || []);
      setExtras(data.extras || []);
    } catch {
      // Silent — next poll will retry
    }
  }, [id]);

  const refreshDeploy = useCallback(async ({ background = false } = {}) => {
    if (!background) setRefreshingDeploy(true);
    try {
      const data = await api.get(`/api/projects/${id}/deploy-status`);
      setDeploy(data);
      return data;
    } catch (err) {
      if (!background) setHostError(err.message);
      return null;
    } finally {
      if (!background) setRefreshingDeploy(false);
    }
  }, [id]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  useEffect(() => {
    refreshDeploy({ background: true });
  }, [refreshDeploy]);

  useEffect(() => {
    pollRef.current = setInterval(pollServers, SERVER_POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [pollServers]);

  // Poll the deploy status only while a deploy is actually in progress. Once
  // the status is terminal we stop hitting the endpoint so we aren't chatty
  // with Railway for no reason.
  useEffect(() => {
    const status = deploy?.lastDeployStatus;
    const inProgress = !!deploy?.railwayServiceId && !TERMINAL_DEPLOY_STATUSES.has(status);
    if (!inProgress) {
      if (deployPollRef.current) {
        clearInterval(deployPollRef.current);
        deployPollRef.current = null;
      }
      return undefined;
    }
    deployPollRef.current = setInterval(() => refreshDeploy({ background: true }), DEPLOY_POLL_INTERVAL_MS);
    return () => {
      if (deployPollRef.current) {
        clearInterval(deployPollRef.current);
        deployPollRef.current = null;
      }
    };
  }, [deploy?.lastDeployStatus, deploy?.railwayServiceId, refreshDeploy]);

  const handleKill = async (pid) => {
    if (!confirm(`Kill process ${pid}? This will stop the server.`)) return;
    setKillingPid(pid);
    try {
      await api.post(`/api/projects/${id}/kill-server`, { pid });
      await pollServers();
    } catch (err) {
      alert(`Failed to kill process: ${err.message}`);
    } finally {
      setKillingPid(null);
    }
  };

  const handleKillAll = async () => {
    const total = servers.filter((s) => s.running && s.belongsToProject).length + extras.length;
    if (total === 0) return;
    if (!confirm(
      `Kill all ${total} dev process${total === 1 ? '' : 'es'} for this project? ` +
      `This stops the running server(s) and any orphan/duplicate processes.`
    )) return;
    setSweeping(true);
    try {
      const result = await api.post(`/api/projects/${id}/kill-all-processes`, {});
      if (result.failed && result.failed.length > 0) {
        alert(
          `Killed ${result.killed.length}, failed ${result.failed.length}. ` +
          `First error: ${result.failed[0].error}`
        );
      }
      await pollServers();
    } catch (err) {
      alert(`Failed to sweep processes: ${err.message}`);
    } finally {
      setSweeping(false);
    }
  };

  const handleHost = async () => {
    if (!confirm('Deploy this project to Railway? This will copy your local .env values to the Railway project.')) return;
    setStarting(true);
    setHostError(null);
    try {
      await api.post(`/api/projects/${id}/host`, {});
      await refreshDeploy({ background: false });
    } catch (err) {
      setHostError(err.message);
    } finally {
      setStarting(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading project…</div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
            <ArrowLeft size={14} /> Back
          </button>
        </div>
        <div className={styles.errorBlock}>{error || 'Project not found.'}</div>
      </div>
    );
  }

  const githubUrl = project.github_repo ? `https://github.com/${project.github_repo}` : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          <ArrowLeft size={14} /> Back
        </button>
        <h1>{project.name}</h1>
        <button
          className="btn btn-ghost btn-icon"
          onClick={loadProject}
          title="Refresh"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      <div className={styles.metaRow}>
        {githubUrl ? (
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer"
            className={styles.metaLink}
          >
            <Github size={14} /> {project.github_repo}
            <ExternalLink size={12} />
          </a>
        ) : (
          <span className={styles.metaMuted}>
            <Github size={14} /> No GitHub remote
          </span>
        )}
        <span className={styles.metaPath}>
          <Folder size={14} /> {project.root_path}
        </span>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionHeader}>Hosting</h2>
        <DeployStatus
          deploy={deploy}
          starting={starting}
          refreshing={refreshingDeploy}
          hostError={hostError}
          onHost={handleHost}
          onRefresh={() => refreshDeploy({ background: false })}
          onOpenFixSession={(sid) => navigate(`/session/${sid}`)}
        />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeaderRow}>
          <h2 className={styles.sectionHeader}>Running Servers</h2>
          {(servers.some((s) => s.running && s.belongsToProject) || extras.length > 0) && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleKillAll}
              disabled={sweeping}
              title="Kill every dev process for this project, including orphans and duplicates"
            >
              <Trash2 size={14} /> {sweeping ? 'Killing…' : 'Kill all dev processes'}
            </button>
          )}
        </div>
        <div className={styles.serverList}>
          {servers.length === 0 ? (
            <div className={styles.empty}>
              No pinned ports found in this project's <code>.env</code>. Add{' '}
              <code>PORT=</code> or <code>VITE_PORT=</code> and a server on that port will show up
              here.
            </div>
          ) : (
            servers.map((s) => (
              <ServerRow
                key={s.key}
                server={s}
                onKill={handleKill}
                killing={killingPid === s.pid}
              />
            ))
          )}
        </div>

        {extras.length > 0 && (
          <div className={styles.extrasBlock}>
            <div className={styles.extrasHeader}>
              Other project processes ({extras.length})
              <span className={styles.extrasHint}>
                — orphans, duplicate <code>npm run dev</code> trees, or background helpers
              </span>
            </div>
            <div className={styles.serverList}>
              {extras.map((p) => (
                <ExtraRow
                  key={p.pid}
                  proc={p}
                  onKill={handleKill}
                  killing={killingPid === p.pid}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHeader}>Sessions ({project.sessions?.length || 0})</h2>
        {project.sessions && project.sessions.length > 0 ? (
          <ul className={styles.sessionList}>
            {project.sessions.map((s) => (
              <li
                key={s.id}
                className={styles.sessionItem}
                onClick={() => navigate(`/session/${s.id}`)}
              >
                <div className={styles.sessionName}>{s.name}</div>
                <div className={styles.sessionMeta}>
                  <span className={`${styles.statusBadge} ${styles[`status_${s.status}`] || ''}`}>
                    {s.status}
                  </span>
                  {s.branch && <span className={styles.sessionBranch}>{s.branch}</span>}
                  {s.archived && <span className={styles.archivedBadge}>archived</span>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.empty}>No sessions for this project yet.</div>
        )}
      </section>
    </div>
  );
}

const DEPLOY_STATUS_LABEL = {
  BUILDING: 'Building',
  DEPLOYING: 'Deploying',
  INITIALIZING: 'Starting',
  QUEUED: 'Queued',
  WAITING: 'Waiting',
  SUCCESS: 'Live',
  FAILED: 'Build failed',
  CRASHED: 'Crashed',
  REMOVED: 'Removed',
  SKIPPED: 'Skipped',
};

function DeployStatus({ deploy, starting, refreshing, hostError, onHost, onRefresh, onOpenFixSession }) {
  const status = deploy?.lastDeployStatus || null;
  const inProgress = deploy?.railwayServiceId && !TERMINAL_DEPLOY_STATUSES.has(status);
  const isSuccess = status === 'SUCCESS';
  const isFailure = status === 'FAILED' || status === 'CRASHED';
  const neverDeployed = !deploy?.railwayServiceId;
  const fixSessionId = deploy?.fixSessionId || null;
  const label = DEPLOY_STATUS_LABEL[status] || status || 'Not deployed';

  const badgeStyle = isSuccess
    ? styles.badgeLive
    : isFailure
    ? styles.badgeFailed
    : inProgress
    ? styles.badgeBuilding
    : styles.badgeIdle;

  return (
    <div className={styles.deployCard}>
      <div className={styles.deployHeader}>
        <span className={badgeStyle}>{label}</span>
        {isSuccess && deploy?.deploymentUrl && (
          <a
            href={deploy.deploymentUrl}
            target="_blank"
            rel="noreferrer"
            className={styles.metaLink}
          >
            {deploy.deploymentUrl} <ExternalLink size={12} />
          </a>
        )}
        {inProgress && <span className={styles.deployProgressText}>Railway is building the app…</span>}
        <div className={styles.deployActions}>
          {isFailure && fixSessionId && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => onOpenFixSession(fixSessionId)}
              title="Open the Claude session working on the build fix"
            >
              <Wrench size={14} /> View Fix Session
            </button>
          )}
          {!neverDeployed && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={onRefresh}
              disabled={refreshing}
              title="Refresh deploy status"
            >
              <RefreshCw size={14} /> {refreshing ? 'Checking…' : 'Refresh'}
            </button>
          )}
          {(neverDeployed || isFailure || status === 'REMOVED') && (
            <button
              className="btn btn-primary btn-sm"
              onClick={onHost}
              disabled={starting || inProgress}
            >
              <Rocket size={14} />
              {starting ? 'Starting…' : neverDeployed ? 'Host This Project' : 'Re-deploy'}
            </button>
          )}
        </div>
      </div>

      {neverDeployed && !starting && !hostError && (
        <p className={styles.hint}>
          Deploys to Railway from your GitHub repo. Copies your local <code>.env</code>{' '}
          values up (except <code>PORT</code>, <code>VITE_PORT</code>, and <code>NODE_ENV</code>).
        </p>
      )}

      {isFailure && fixSessionId && (
        <p className={styles.hint}>
          A Claude session has been started with these logs to fix the build.
          Review its branch, merge when happy, then Re-deploy.
        </p>
      )}

      {hostError && <div className={styles.hostError}>{hostError}</div>}

      {isFailure && deploy?.lastDeployLogs && (
        <div className={styles.logBlock}>
          <div className={styles.logLabel}>Build log (tail)</div>
          <pre className={styles.logPre}>{tailLog(deploy.lastDeployLogs)}</pre>
        </div>
      )}
    </div>
  );
}

function tailLog(logs, lines = 40) {
  if (!logs) return '';
  const all = logs.split('\n');
  return all.slice(-lines).join('\n');
}

function ServerRow({ server, onKill, killing }) {
  const { role, port, running, pid, command, belongsToProject } = server;
  return (
    <div className={styles.serverRow}>
      <div className={styles.serverInfo}>
        <span className={styles.serverRole}>{role}</span>
        {port ? (
          <span className={styles.serverPort}>port {port}</span>
        ) : (
          <span className={styles.serverPort}>not configured</span>
        )}
        {running ? (
          <span className={styles.badgeRunning}>Running · PID {pid}</span>
        ) : port ? (
          <span className={styles.badgeIdle}>Not running</span>
        ) : null}
        {running && command && (
          <span className={styles.serverCmd}>{command}</span>
        )}
      </div>
      <div className={styles.serverActions}>
        {running && belongsToProject && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onKill(pid)}
            disabled={killing}
            title="Stop this server"
          >
            <X size={14} /> {killing ? 'Killing…' : 'Kill'}
          </button>
        )}
        {running && !belongsToProject && (
          <span className={styles.foreign} title={`cwd: ${server.cwd || 'unknown'}`}>
            Another project
          </span>
        )}
      </div>
    </div>
  );
}

function ExtraRow({ proc, onKill, killing }) {
  const { pid, ppid, command } = proc;
  return (
    <div className={styles.serverRow}>
      <div className={styles.serverInfo}>
        <span className={styles.serverRole}>PID {pid}</span>
        <span className={styles.serverPort}>parent {ppid}</span>
        <span className={styles.serverCmd} title={command}>{command}</span>
      </div>
      <div className={styles.serverActions}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => onKill(pid)}
          disabled={killing}
          title="Stop this process"
        >
          <X size={14} /> {killing ? 'Killing…' : 'Kill'}
        </button>
      </div>
    </div>
  );
}
