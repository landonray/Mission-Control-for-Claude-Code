const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getDb } = require('../database');

function getSettings() {
  const db = getDb();
  return db.prepare('SELECT projects_directory, github_username FROM app_settings WHERE id = 1').get();
}

function resolveHome(p) {
  return p.replace(/^~/, process.env.HOME || '');
}

// GET /api/projects — scan projects_directory, return subdirs with matched preset
router.get('/', (req, res) => {
  try {
    const settings = getSettings();
    if (!settings?.projects_directory) {
      return res.json([]);
    }
    const dir = resolveHome(settings.projects_directory);
    if (!fs.existsSync(dir)) {
      return res.json([]);
    }

    const db = getDb();
    const presets = db.prepare('SELECT id, name, icon, working_directory FROM presets').all();

    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const folderPath = path.join(dir, e.name);
        const matched = presets.find(p => resolveHome(p.working_directory) === folderPath) || null;
        return {
          name: e.name,
          path: folderPath,
          preset: matched ? { id: matched.id, name: matched.name, icon: matched.icon } : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/create — create folder + git init + gh repo + session
router.post('/create', (req, res) => {
  const { name, visibility = 'private' } = req.body;

  // Validate name
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 100) {
    return res.status(400).json({ error: 'Project name must be alphanumeric with hyphens/underscores, max 100 chars.' });
  }

  const settings = getSettings();
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

    // Step 4: Initial commit
    fs.writeFileSync(path.join(folderPath, 'README.md'), `# ${name}\n`);
    execSync('git add README.md', { cwd: folderPath, stdio: 'pipe' });
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

  // Step 6: Create Claude Code session (synchronous)
  try {
    const { createSession } = require('../services/sessionManager');
    const session = createSession({
      name,
      workingDirectory: folderPath,
      permissionMode: 'acceptEdits',
      autoAccept: false,
      planMode: false,
    });
    res.json({ sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: `Project created but failed to start session: ${err.message}` });
  }
});

module.exports = router;
