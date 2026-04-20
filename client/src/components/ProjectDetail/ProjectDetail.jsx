import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../utils/api';
import { ArrowLeft, Github, Folder, Rocket, ExternalLink, RefreshCw, X } from 'lucide-react';
import styles from './ProjectDetail.module.css';

const SERVER_POLL_INTERVAL_MS = 3000;

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [servers, setServers] = useState([]);
  const [killingPid, setKillingPid] = useState(null);
  const [hostStatus, setHostStatus] = useState('idle'); // idle | deploying | success | error
  const [hostError, setHostError] = useState(null);
  const [hostResult, setHostResult] = useState(null);
  const pollRef = useRef(null);

  const loadProject = useCallback(async () => {
    try {
      setError(null);
      const data = await api.get(`/api/projects/${id}`);
      setProject(data);
      setServers(data.servers || []);
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
    } catch {
      // Silent — next poll will retry
    }
  }, [id]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  useEffect(() => {
    pollRef.current = setInterval(pollServers, SERVER_POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [pollServers]);

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

  const handleHost = async () => {
    if (!confirm('Deploy this project to Railway? This will copy your local .env values to the Railway project.')) return;
    setHostStatus('deploying');
    setHostError(null);
    setHostResult(null);
    try {
      const result = await api.post(`/api/projects/${id}/host`, {});
      setHostResult(result);
      setHostStatus('success');
      await loadProject();
    } catch (err) {
      setHostError(err.message);
      setHostStatus('error');
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
        {project.deployment_url ? (
          <div className={styles.deployedCard}>
            <div className={styles.deployedStatus}>
              <span className={styles.badgeLive}>Live</span>
              <a
                href={project.deployment_url}
                target="_blank"
                rel="noreferrer"
                className={styles.metaLink}
              >
                {project.deployment_url} <ExternalLink size={12} />
              </a>
            </div>
            <p className={styles.hint}>
              Hosted on Railway. To update env vars or logs, open the Railway dashboard.
            </p>
          </div>
        ) : (
          <div className={styles.hostCard}>
            <button
              className="btn btn-primary"
              onClick={handleHost}
              disabled={hostStatus === 'deploying'}
            >
              <Rocket size={16} />
              {hostStatus === 'deploying' ? 'Deploying…' : 'Host This Project'}
            </button>
            <p className={styles.hint}>
              Deploys to Railway from your GitHub repo. Copies your local <code>.env</code>{' '}
              values up (except <code>PORT</code>, <code>VITE_PORT</code>, and <code>NODE_ENV</code>).
            </p>
            {hostStatus === 'success' && hostResult && (
              <div className={styles.hostSuccess}>
                Deployment started.{' '}
                {hostResult.deploymentUrl ? (
                  <>
                    Live URL:{' '}
                    <a href={hostResult.deploymentUrl} target="_blank" rel="noreferrer">
                      {hostResult.deploymentUrl}
                    </a>
                  </>
                ) : (
                  'Railway is building; the URL will appear once the first build finishes.'
                )}
              </div>
            )}
            {hostStatus === 'error' && (
              <div className={styles.hostError}>{hostError}</div>
            )}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHeader}>Running Servers</h2>
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
