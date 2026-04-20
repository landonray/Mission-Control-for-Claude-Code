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

function pathIsInside(child, parent) {
  if (!child || !parent) return false;
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
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

module.exports = {
  parseEnvFile,
  readEnvFile,
  getPinnedPorts,
  getListenerOnPort,
  getProcessCwd,
  pathIsInside,
  detectServers,
  killServer,
  ROLE_KEYS,
};
