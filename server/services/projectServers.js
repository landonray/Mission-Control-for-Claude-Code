const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROLE_KEYS = [
  { key: 'PORT', role: 'Backend' },
  { key: 'VITE_PORT', role: 'Frontend' },
];

function parseEnvFile(envContent) {
  const out = {};
  for (const raw of envContent.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readEnvFile(projectPath) {
  const envPath = path.join(projectPath, '.env');
  if (!fs.existsSync(envPath)) return {};
  try {
    return parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}

function getPinnedPorts(projectPath) {
  const env = readEnvFile(projectPath);
  const ports = {};
  for (const { key } of ROLE_KEYS) {
    const raw = env[key];
    if (!raw) continue;
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) ports[key] = n;
  }
  return ports;
}

function getListenerOnPort(port) {
  let out;
  try {
    out = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -P -n -Fpcn`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  let pid = null;
  let command = null;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const prefix = line[0];
    const value = line.slice(1);
    if (prefix === 'p') {
      if (pid !== null) break;
      pid = parseInt(value, 10);
    } else if (prefix === 'c' && pid !== null && command === null) {
      command = value;
    }
  }
  if (pid === null) return null;
  return { pid, command };
}

function getProcessCwd(pid) {
  let out;
  try {
    out = execSync(`lsof -a -p ${pid} -d cwd -Fn`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1);
  }
  return null;
}

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function pathIsInside(child, parent) {
  if (!child || !parent) return false;
  let resolvedParent = path.resolve(parent);
  let resolvedChild = path.resolve(child);
  if (CASE_INSENSITIVE_FS) {
    resolvedParent = resolvedParent.toLowerCase();
    resolvedChild = resolvedChild.toLowerCase();
  }
  if (resolvedChild === resolvedParent) return true;
  const withSep = resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep;
  return resolvedChild.startsWith(withSep);
}

function detectServers(projectPath, deps = {}) {
  const listener = deps.getListenerOnPort || getListenerOnPort;
  const cwdFn = deps.getProcessCwd || getProcessCwd;
  const pinned = deps.getPinnedPorts ? deps.getPinnedPorts(projectPath) : getPinnedPorts(projectPath);

  return ROLE_KEYS.map(({ key, role }) => {
    const port = pinned[key] || null;
    if (!port) {
      return { key, role, port: null, running: false };
    }
    const info = listener(port);
    if (!info) {
      return { key, role, port, running: false };
    }
    const cwd = cwdFn(info.pid);
    return {
      key,
      role,
      port,
      running: true,
      pid: info.pid,
      command: info.command,
      cwd,
      belongsToProject: pathIsInside(cwd, projectPath),
    };
  });
}

function killServer(projectPath, pid, deps = {}) {
  const cwdFn = deps.getProcessCwd || getProcessCwd;
  const kill = deps.kill || ((p, sig) => process.kill(p, sig));

  const numericPid = parseInt(pid, 10);
  if (!Number.isInteger(numericPid) || numericPid <= 1) {
    throw new Error(`Invalid PID: ${pid}`);
  }

  const cwd = cwdFn(numericPid);
  if (!cwd) {
    throw new Error(`Process ${numericPid} not found or has no cwd`);
  }
  if (!pathIsInside(cwd, projectPath)) {
    throw new Error(
      `Refusing to kill PID ${numericPid}: its working directory (${cwd}) is not inside this project (${projectPath}).`
    );
  }
  kill(numericPid, 'SIGTERM');
  return { killed: true, pid: numericPid };
}

// Process names we treat as "dev-server-related" when looking for orphans /
// duplicates. Matched against the command field from `ps`, so prefixes like
// `/path/to/.bin/vite` still match.
const DEV_PROCESS_RE = /(^|[\/\s])(node|npm|npx|tsx|vite|concurrently|esbuild)(\s|$)/i;

function listAllProcesses() {
  let out;
  try {
    out = execSync('ps -axo pid=,ppid=,command=', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const procs = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/^\s+/, '');
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      command: m[3],
    });
  }
  return procs;
}

// Returns every dev-related process whose working directory is inside the
// project. Used to find orphans, zombies, and duplicate `npm run dev` trees
// that the port-holder view (detectServers) cannot see.
function listProjectProcesses(projectPath, deps = {}) {
  const listAll = deps.listAllProcesses || listAllProcesses;
  const cwdFn = deps.getProcessCwd || getProcessCwd;
  const ownPid = process.pid;

  const candidates = listAll().filter(
    (p) => p.pid !== ownPid && DEV_PROCESS_RE.test(p.command)
  );
  const inProject = [];
  for (const p of candidates) {
    const cwd = cwdFn(p.pid);
    if (pathIsInside(cwd, projectPath)) {
      inProject.push({ ...p, cwd });
    }
  }
  return inProject;
}

// All project-owned dev processes that are NOT one of the pinned-port
// listeners. These are the rows the user can prune to clean up the
// environment.
function detectExtras(projectPath, deps = {}) {
  const servers = deps.detectServers
    ? deps.detectServers(projectPath, deps)
    : detectServers(projectPath, deps);
  const portHolderPids = new Set(
    servers.filter((s) => s.running && s.pid).map((s) => s.pid)
  );
  const all = (deps.listProjectProcesses || listProjectProcesses)(projectPath, deps);
  return all.filter((p) => !portHolderPids.has(p.pid));
}

// Sweep every project-owned dev process (port holders + extras). Each kill
// re-runs the same per-PID safety check killServer enforces, so a process
// whose cwd is no longer inside the project is silently skipped.
function killAllProjectProcesses(projectPath, deps = {}) {
  const all = (deps.listProjectProcesses || listProjectProcesses)(projectPath, deps);
  const killed = [];
  const failed = [];
  for (const p of all) {
    try {
      killServer(projectPath, p.pid, deps);
      killed.push(p.pid);
    } catch (err) {
      failed.push({ pid: p.pid, error: err.message });
    }
  }
  return { killed, failed };
}

module.exports = {
  parseEnvFile,
  readEnvFile,
  getPinnedPorts,
  getListenerOnPort,
  getProcessCwd,
  pathIsInside,
  detectServers,
  killServer,
  listAllProcesses,
  listProjectProcesses,
  detectExtras,
  killAllProjectProcesses,
  DEV_PROCESS_RE,
  ROLE_KEYS,
};
