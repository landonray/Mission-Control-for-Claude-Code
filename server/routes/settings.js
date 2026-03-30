const express = require('express');
const router = express.Router();
const { query } = require('../database');

// GET /api/settings/general
router.get('/general', async (req, res) => {
  try {
    const row = (await query('SELECT projects_directory, github_username, setup_repo FROM app_settings WHERE id = 1')).rows[0];
    res.json(row || { projects_directory: null, github_username: null, setup_repo: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/general
router.put('/general', async (req, res) => {
  try {
    const { projects_directory, github_username, setup_repo } = req.body;
    await query(
      'UPDATE app_settings SET projects_directory = $1, github_username = $2, setup_repo = $3 WHERE id = 1',
      [projects_directory ?? null, github_username ?? null, setup_repo ?? null]
    );
    const row = (await query('SELECT projects_directory, github_username, setup_repo FROM app_settings WHERE id = 1')).rows[0];
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/restart — gracefully restart the server process
router.post('/restart', (req, res) => {
  const { spawn } = require('child_process');
  const path = require('path');

  res.json({ status: 'restarting' });

  // Give the response time to flush, then restart
  setTimeout(() => {
    const serverScript = path.join(__dirname, '..', 'index.js');
    const child = spawn(process.execPath, [serverScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();

    // Exit current process (tmux sessions survive per existing graceful shutdown)
    process.kill(process.pid, 'SIGTERM');
  }, 500);
});

module.exports = router;
