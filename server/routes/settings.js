const express = require('express');
const router = express.Router();
const { getDb } = require('../database');

// GET /api/settings/general
router.get('/general', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT projects_directory, github_username, setup_repo FROM app_settings WHERE id = 1').get();
    res.json(row || { projects_directory: null, github_username: null, setup_repo: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/general
router.put('/general', (req, res) => {
  try {
    const { projects_directory, github_username, setup_repo } = req.body;
    const db = getDb();
    db.prepare('UPDATE app_settings SET projects_directory = ?, github_username = ?, setup_repo = ? WHERE id = 1')
      .run(projects_directory ?? null, github_username ?? null, setup_repo ?? null);
    const row = db.prepare('SELECT projects_directory, github_username, setup_repo FROM app_settings WHERE id = 1').get();
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
