const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { v4: uuidv4 } = require('uuid');

// List all presets
router.get('/', (req, res) => {
  const db = getDb();
  const presets = db.prepare('SELECT * FROM presets ORDER BY name').all();
  res.json(presets);
});

// Get single preset
router.get('/:id', (req, res) => {
  const db = getDb();
  const preset = db.prepare('SELECT * FROM presets WHERE id = ?').get(req.params.id);

  if (!preset) {
    return res.status(404).json({ error: 'Preset not found' });
  }

  res.json(preset);
});

// Create new preset
router.post('/', (req, res) => {
  const db = getDb();
  const id = req.body.id || uuidv4();
  const { name, description, working_directory, mcp_connections, claude_md_path, permission_mode, initial_prompt, icon } = req.body;

  if (!name || !working_directory) {
    return res.status(400).json({ error: 'name and working_directory are required' });
  }

  try {
    db.prepare(`
      INSERT INTO presets (id, name, description, working_directory, mcp_connections, claude_md_path, permission_mode, initial_prompt, icon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, description || null, working_directory,
      mcp_connections ? JSON.stringify(mcp_connections) : null,
      claude_md_path || null, permission_mode || 'default',
      initial_prompt || null, icon || 'folder'
    );

    const preset = db.prepare('SELECT * FROM presets WHERE id = ?').get(id);
    res.status(201).json(preset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update preset
router.put('/:id', (req, res) => {
  const db = getDb();
  const { name, description, working_directory, mcp_connections, claude_md_path, permission_mode, initial_prompt, icon } = req.body;

  try {
    db.prepare(`
      UPDATE presets SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        working_directory = COALESCE(?, working_directory),
        mcp_connections = COALESCE(?, mcp_connections),
        claude_md_path = COALESCE(?, claude_md_path),
        permission_mode = COALESCE(?, permission_mode),
        initial_prompt = COALESCE(?, initial_prompt),
        icon = COALESCE(?, icon),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name || null, description || null, working_directory || null,
      mcp_connections ? JSON.stringify(mcp_connections) : null,
      claude_md_path || null, permission_mode || null,
      initial_prompt || null, icon || null,
      req.params.id
    );

    const preset = db.prepare('SELECT * FROM presets WHERE id = ?').get(req.params.id);
    if (!preset) {
      return res.status(404).json({ error: 'Preset not found' });
    }

    res.json(preset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete preset
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM presets WHERE id = ?').run(req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Preset not found' });
  }

  res.json({ success: true });
});

module.exports = router;
