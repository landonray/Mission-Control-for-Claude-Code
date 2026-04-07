const express = require('express');
const router = express.Router();
const { query } = require('../database');

// GET /api/slash-commands — list all slash commands
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM slash_commands ORDER BY sort_order ASC, name ASC');
    res.json({ commands: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/slash-commands — create a new slash command
router.post('/', async (req, res) => {
  try {
    const { name, message } = req.body;
    if (!name || !message) {
      return res.status(400).json({ error: 'Name and message are required' });
    }
    // Strip leading slash if provided
    const cleanName = name.replace(/^\//, '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!cleanName) {
      return res.status(400).json({ error: 'Invalid command name' });
    }
    const result = await query(
      'INSERT INTO slash_commands (name, message) VALUES ($1, $2) RETURNING *',
      [cleanName, message]
    );
    res.status(201).json({ command: result.rows[0] });
  } catch (err) {
    if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'A command with that name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/slash-commands/:id — update a slash command
router.put('/:id', async (req, res) => {
  try {
    const { name, message } = req.body;
    if (!name || !message) {
      return res.status(400).json({ error: 'Name and message are required' });
    }
    const cleanName = name.replace(/^\//, '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!cleanName) {
      return res.status(400).json({ error: 'Invalid command name' });
    }
    const result = await query(
      'UPDATE slash_commands SET name = $1, message = $2 WHERE id = $3 RETURNING *',
      [cleanName, message, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Command not found' });
    }
    res.json({ command: result.rows[0] });
  } catch (err) {
    if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'A command with that name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/slash-commands/:id — delete a slash command
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM slash_commands WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Command not found' });
    }
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
