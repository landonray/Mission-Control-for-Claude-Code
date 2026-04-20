const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { query } = require('../database');
const { parseGithubRepo } = require('../utils/githubUrl');

// projectDiscovery is ESM — use lazy dynamic import
// Some runtimes (e.g. tsx) wrap ESM named exports under .default when imported from CJS
function unwrapDefault(mod) {
  return mod && mod.default && typeof mod.default === 'object' ? mod.default : mod;
}

let _projectDiscovery;
async function getProjectDiscovery() {
  if (!_projectDiscovery) {
    _projectDiscovery = unwrapDefault(await import('../services/projectDiscovery.js'));
  }
  return _projectDiscovery;
}

async function getSettings() {
  const result = await query('SELECT projects_directory, github_username, setup_repo FROM app_settings WHERE id = 1');
  return result.rows[0];
}

function resolveHome(p) {
  return p.replace(/^~/, process.env.HOME || '');
}


// GET /api/projects — scan projects_directory, return subdirs
router.get('/', async (req, res) => {
  try {
    const settings = await getSettings();
    if (!settings?.projects_directory) {
      return res.json([]);
    }
    const dir = resolveHome(settings.projects_directory);
    if (!fs.existsSync(dir)) {
      return res.json([]);
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .filter(e => {
        // Git worktrees have a .git file (not directory) — exclude them
        const dotGit = path.join(dir, e.name, '.git');
        try {
          return fs.statSync(dotGit).isDirectory();
        } catch {
          return true; // no .git at all — still show it
        }
      })
      .map(e => ({
        name: e.name,
        path: path.join(dir, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/setup-readme — fetch README content from the configured setup repo
router.get('/setup-readme', async (req, res) => {
  try {
    const settings = await getSettings();
    if (!settings?.setup_repo) {
      return res.status(400).json({ error: 'No setup repo configured.' });
    }

    // Parse owner/repo from URL or "owner/repo" format
    let owner, repo;
    const match = settings.setup_repo.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) {
      owner = match[1];
      repo = match[2];
    } else if (/^[^/]+\/[^/]+$/.test(settings.setup_repo)) {
      [owner, repo] = settings.setup_repo.split('/');
    } else {
      return res.status(400).json({ error: 'Invalid setup repo format. Use "owner/repo" or a GitHub URL.' });
    }

    // Use gh CLI to fetch README content
    const readmeContent = execSync(
      `gh api repos/${owner}/${repo}/readme --jq '.content' | base64 -d`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    res.json({ content: readmeContent, owner, repo });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch README: ${err.stderr?.toString() || err.message}` });
  }
});

// POST /api/projects/create — create folder + git init + gh repo + session
router.post('/create', async (req, res) => {
  const { name, visibility = 'private', model, autoSetup = true } = req.body;

  // Validate name (reject leading/trailing hyphens — GitHub strips them, causing push failures)
  if (!name || !/^[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(name) || name.length > 100) {
    return res.status(400).json({ error: 'Project name must be alphanumeric with hyphens/underscores, cannot start or end with a hyphen, max 100 chars.' });
  }

  const settings = await getSettings();
  if (!settings?.projects_directory) {
    return res.status(400).json({ error: 'Projects directory not configured. Go to Settings > General.' });
  }
  if (!settings?.github_username) {
    return res.status(400).json({ error: 'GitHub username not configured. Go to Settings > General.' });
  }

  const projectsDir = resolveHome(settings.projects_directory);
  const folderPath = path.join(projectsDir, name);

  if (fs.existsSync(folderPath)) {
    return res.status(400).json({ error: `A folder named "${name}" already exists.` });
  }

  let folderCreated = false;
  try {
    // Step 2: Create folder
    fs.mkdirSync(folderPath, { recursive: true });
    folderCreated = true;

    // Step 3: git init
    execSync('git init', { cwd: folderPath, stdio: 'pipe' });

    // Step 4: Initial commit (includes .mission-control.yaml for project linking)
    fs.writeFileSync(path.join(folderPath, 'README.md'), `# ${name}\n`);
    const yaml = require('js-yaml');
    const defaultConfig = {
      project: { name },
      evals: { folders: [] },
      quality_rules: { enabled: [], disabled: [] }
    };
    fs.writeFileSync(
      path.join(folderPath, '.mission-control.yaml'),
      yaml.dump(defaultConfig, { flowLevel: -1, lineWidth: 120 }),
      'utf8'
    );
    execSync('git add README.md .mission-control.yaml', { cwd: folderPath, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', {
      cwd: folderPath,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Mission Control', GIT_AUTHOR_EMAIL: 'mc@local', GIT_COMMITTER_NAME: 'Mission Control', GIT_COMMITTER_EMAIL: 'mc@local' },
    });

    // Step 5: gh repo create + push
    const ghVisibility = visibility === 'public' ? '--public' : '--private';
    execSync(
      `gh repo create ${settings.github_username}/${name} ${ghVisibility} --source="${folderPath}" --remote=origin --push`,
      { stdio: 'pipe' }
    );
  } catch (err) {
    // Rollback: delete folder if it was created (steps 2-5 failed)
    if (folderCreated) {
      try { fs.rmSync(folderPath, { recursive: true, force: true }); } catch {}
    }
    return res.status(500).json({ error: err.stderr?.toString() || err.message });
  }

  // Step 6: Optionally fetch setup repo README for initial prompt
  let initialPrompt = undefined;
  if (autoSetup && settings.setup_repo) {
    try {
      let owner, repo;
      const match = settings.setup_repo.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (match) {
        owner = match[1];
        repo = match[2];
      } else if (/^[^/]+\/[^/]+$/.test(settings.setup_repo)) {
        [owner, repo] = settings.setup_repo.split('/');
      }
      if (owner && repo) {
        const readmeContent = execSync(
          `gh api repos/${owner}/${repo}/readme --jq '.content' | base64 -d`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        initialPrompt = `Follow the instructions in this setup guide to configure this new project. The project directory is already created at ${folderPath} and the git repo is initialized.\n\n---\n\n${readmeContent}`;
      }
    } catch (err) {
      // Non-fatal: proceed without auto-setup if README fetch fails
      console.warn('Failed to fetch setup repo README:', err.message);
    }
  }

  // Step 7: Create Claude Code session
  try {
    const { createSession } = require('../services/sessionManager');
    const session = await createSession({
      name,
      workingDirectory: folderPath,
      permissionMode: 'acceptEdits',
      model,
      initialPrompt,
    });
    res.json({ sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: `Project created but failed to start session: ${err.message}` });
  }
});

// POST /api/projects/clone — clone an existing GitHub repo into projects_directory
router.post('/clone', async (req, res) => {
  const { url, model, autoSetup = true } = req.body;

  const parsed = parseGithubRepo(url);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid GitHub URL. Use https://github.com/owner/repo or owner/repo.' });
  }
  const { owner, repo } = parsed;

  const settings = await getSettings();
  if (!settings?.projects_directory) {
    return res.status(400).json({ error: 'Projects directory not configured. Go to Settings > General.' });
  }

  const projectsDir = resolveHome(settings.projects_directory);
  if (!fs.existsSync(projectsDir)) {
    try { fs.mkdirSync(projectsDir, { recursive: true }); } catch (err) {
      return res.status(500).json({ error: `Failed to create projects directory: ${err.message}` });
    }
  }

  const folderPath = path.join(projectsDir, repo);
  if (fs.existsSync(folderPath)) {
    return res.status(400).json({ error: `A folder named "${repo}" already exists in your projects directory.` });
  }

  let folderCreated = false;
  try {
    execSync(`gh repo clone ${owner}/${repo} "${folderPath}"`, { stdio: 'pipe' });
    folderCreated = true;

    // Add .mission-control.yaml so the project is discoverable with default config.
    const yamlPath = path.join(folderPath, '.mission-control.yaml');
    if (!fs.existsSync(yamlPath)) {
      const yaml = require('js-yaml');
      const defaultConfig = {
        project: { name: repo },
        evals: { folders: [] },
        quality_rules: { enabled: [], disabled: [] }
      };
      fs.writeFileSync(yamlPath, yaml.dump(defaultConfig, { flowLevel: -1, lineWidth: 120 }), 'utf8');
      try {
        execSync('git add .mission-control.yaml', { cwd: folderPath, stdio: 'pipe' });
        execSync('git commit -m "Add Mission Control config"', {
          cwd: folderPath,
          stdio: 'pipe',
          env: { ...process.env, GIT_AUTHOR_NAME: 'Mission Control', GIT_AUTHOR_EMAIL: 'mc@local', GIT_COMMITTER_NAME: 'Mission Control', GIT_COMMITTER_EMAIL: 'mc@local' },
        });
      } catch {
        // Non-fatal: the file is still on disk, just uncommitted.
      }
    }
  } catch (err) {
    if (folderCreated) {
      try { fs.rmSync(folderPath, { recursive: true, force: true }); } catch {}
    }
    const msg = err.stderr?.toString() || err.message || 'Clone failed.';
    return res.status(500).json({ error: `Clone failed: ${msg.trim()}` });
  }

  let initialPrompt;
  if (autoSetup) {
    initialPrompt = `This project was just cloned from https://github.com/${owner}/${repo} into ${folderPath}.\n\nRead the README and any setup docs (package.json, requirements.txt, .env.example, setup scripts, etc.) and perform whatever steps are required to prepare this project for local development — install dependencies, copy example env files (leave secret values as placeholders for the user to fill in), set up local databases if applicable, etc.\n\nPort selection rules — this machine runs multiple projects simultaneously, so do NOT use default ports without checking:\n1. If the project already has a PORT value set in .env (or equivalent config), use that — it's this project's assigned port.\n2. If no port is set, pick one in the range 4100–4999 and check it is free first with \`lsof -i :PORT\`. If occupied, pick a different one.\n3. Persist the chosen port in .env (e.g. \`PORT=4237\`) so it stays consistent across sessions, and record it in the project's CLAUDE.md as its assigned port.\n4. Never kill or interfere with processes on ports that don't belong to this project.\n5. When reporting a running server, always give the full URL including the port (e.g. http://localhost:4237) — never just say "the server is running".\n\nDo not run or deploy the app. Stop once the project is ready for development and summarize what you did and any env vars or manual steps the user still needs to complete.`;
  }

  try {
    const { createSession } = require('../services/sessionManager');
    const session = await createSession({
      name: repo,
      workingDirectory: folderPath,
      permissionMode: 'acceptEdits',
      model,
      initialPrompt,
    });
    res.json({ sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: `Project cloned but failed to start session: ${err.message}` });
  }
});

// GET /api/projects/by-session/:sessionId — get the project for a session
router.get('/by-session/:sessionId', async (req, res) => {
  try {
    const result = await query(
      `SELECT p.* FROM projects p
       JOIN sessions s ON s.project_id = p.id
       WHERE s.id = $1`,
      [req.params.sessionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No project found for this session' });
    }
    const project = result.rows[0];
    try {
      const { loadProjectConfig } = await getProjectDiscovery();
      project.config = loadProjectConfig(project.root_path);
    } catch {
      project.config = { project: {}, evals: { folders: [] }, quality_rules: { enabled: [], disabled: [] } };
    }
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id — get a single project with config
router.get('/:id', async (req, res) => {
  try {
    const { getProject } = await getProjectDiscovery();
    const project = await getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/projects/:id/settings — update project settings
router.put('/:id/settings', async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Request body must include a settings object' });
    }
    const { updateProjectSettings } = await getProjectDiscovery();
    const project = await updateProjectSettings(req.params.id, settings);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
