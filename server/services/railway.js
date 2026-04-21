const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseEnvFile } = require('./projectServers');

const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

// Env vars we refuse to copy up to Railway. Railway provisions its own PORT,
// and VITE_PORT only matters for local dev. DATABASE_URL pointing at localhost
// would also be nonsense in production, so we still copy it — the user chose
// "copy everything" and is aware of that trade-off.
const SKIP_ENV_KEYS = new Set(['PORT', 'VITE_PORT', 'NODE_ENV']);

async function railwayRequest(query, variables, token) {
  if (!token) throw new Error('RAILWAY_TOKEN is not set in the environment.');

  const res = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body.errors?.[0]?.message || `Railway API ${res.status}`;
    throw new Error(`Railway API error: ${message}`);
  }
  if (body.errors?.length) {
    throw new Error(`Railway API error: ${body.errors.map(e => e.message).join('; ')}`);
  }
  return body.data;
}

function getGithubRepoFromGitRemote(projectPath) {
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // git@github.com:owner/repo.git  OR  https://github.com/owner/repo(.git)
    const sshMatch = remote.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
    return null;
  } catch {
    return null;
  }
}

function collectEnvVars(projectPath) {
  const envPath = path.join(projectPath, '.env');
  if (!fs.existsSync(envPath)) return {};
  const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (SKIP_ENV_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

async function createProject(name, token, requestFn = railwayRequest) {
  const query = `
    mutation ProjectCreate($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        id
        name
        environments { edges { node { id name } } }
      }
    }
  `;
  const data = await requestFn(query, { input: { name } }, token);
  const project = data.projectCreate;
  const envNode = project.environments?.edges?.find(e => e.node.name === 'production')?.node
    || project.environments?.edges?.[0]?.node;
  if (!envNode) throw new Error('Railway project created but no environment returned.');
  return { projectId: project.id, environmentId: envNode.id };
}

async function createServiceFromRepo(projectId, repo, token, requestFn = railwayRequest) {
  const query = `
    mutation ServiceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) {
        id
      }
    }
  `;
  const data = await requestFn(
    query,
    { input: { projectId, source: { repo } } },
    token
  );
  return { serviceId: data.serviceCreate.id };
}

async function upsertEnvVars({ projectId, environmentId, serviceId, variables }, token, requestFn = railwayRequest) {
  if (!variables || Object.keys(variables).length === 0) return;
  const query = `
    mutation VariableCollectionUpsert($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `;
  await requestFn(
    query,
    { input: { projectId, environmentId, serviceId, variables, replace: false } },
    token
  );
}

async function deleteProject(projectId, token, requestFn = railwayRequest) {
  const query = `mutation ProjectDelete($id: String!) { projectDelete(id: $id) }`;
  try {
    await requestFn(query, { id: projectId }, token);
  } catch {
    // Cleanup is best-effort; if it fails the user will see an orphan in Railway
    // but we don't want to mask the real error that triggered cleanup.
  }
}

async function createServiceDomain(environmentId, serviceId, token, requestFn = railwayRequest) {
  const query = `
    mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) {
        domain
      }
    }
  `;
  try {
    const data = await requestFn(
      query,
      { input: { environmentId, serviceId } },
      token
    );
    const domain = data.serviceDomainCreate?.domain;
    return domain ? `https://${domain}` : null;
  } catch (err) {
    return null;
  }
}

async function deployProjectToRailway({ projectName, projectPath, githubRepo, token }, deps = {}) {
  const requestFn = deps.requestFn || railwayRequest;
  const repo = githubRepo || getGithubRepoFromGitRemote(projectPath);
  if (!repo) {
    throw new Error(
      'Could not find a GitHub remote for this project. Railway needs a GitHub repo to deploy from.'
    );
  }

  const { projectId, environmentId } = await createProject(projectName, token, requestFn);

  let serviceId;
  try {
    ({ serviceId } = await createServiceFromRepo(projectId, repo, token, requestFn));
  } catch (err) {
    await deleteProject(projectId, token, requestFn);
    const msg = err.message || '';
    if (/github|repo|install/i.test(msg)) {
      throw new Error(
        `Railway could not access the GitHub repo "${repo}". Install the Railway GitHub App and grant access to this repo by going to https://railway.com/ and creating a new project from GitHub (that triggers the install flow). Underlying error: ${msg}`
      );
    }
    throw err;
  }

  const variables = collectEnvVars(projectPath);
  await upsertEnvVars({ projectId, environmentId, serviceId, variables }, token, requestFn);

  const deploymentUrl = await createServiceDomain(environmentId, serviceId, token, requestFn);

  return {
    railwayProjectId: projectId,
    serviceId,
    deploymentUrl,
    repo,
    envVarCount: Object.keys(variables).length,
  };
}

module.exports = {
  RAILWAY_API_URL,
  SKIP_ENV_KEYS,
  railwayRequest,
  getGithubRepoFromGitRemote,
  collectEnvVars,
  createProject,
  createServiceFromRepo,
  deleteProject,
  upsertEnvVars,
  createServiceDomain,
  deployProjectToRailway,
};
