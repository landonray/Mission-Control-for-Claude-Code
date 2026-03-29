const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { v4: uuidv4 } = require('uuid');

// List all MCP servers
router.get('/', (req, res) => {
  const db = getDb();
  const servers = db.prepare('SELECT * FROM mcp_servers ORDER BY name').all();
  res.json(servers);
});

// Get single MCP server
router.get('/:id', (req, res) => {
  const db = getDb();
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id);

  if (!server) {
    return res.status(404).json({ error: 'MCP server not found' });
  }

  res.json(server);
});

// Create MCP server config
router.post('/', (req, res) => {
  const db = getDb();
  const id = uuidv4();
  const { name, command, args, env, auto_connect } = req.body;

  if (!name || !command) {
    return res.status(400).json({ error: 'name and command are required' });
  }

  try {
    db.prepare(`
      INSERT INTO mcp_servers (id, name, command, args, env, auto_connect)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id, name, command,
      args ? JSON.stringify(args) : null,
      env ? JSON.stringify(env) : null,
      auto_connect ? 1 : 0
    );

    const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    res.status(201).json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update MCP server config
router.put('/:id', (req, res) => {
  const db = getDb();
  const { name, command, args, env, auto_connect } = req.body;

  try {
    db.prepare(`
      UPDATE mcp_servers SET
        name = COALESCE(?, name),
        command = COALESCE(?, command),
        args = COALESCE(?, args),
        env = COALESCE(?, env),
        auto_connect = COALESCE(?, auto_connect)
      WHERE id = ?
    `).run(
      name || null, command || null,
      args ? JSON.stringify(args) : null,
      env ? JSON.stringify(env) : null,
      auto_connect !== undefined ? (auto_connect ? 1 : 0) : null,
      req.params.id
    );

    const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'MCP server not found' });
    }

    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete MCP server config
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'MCP server not found' });
  }

  res.json({ success: true });
});

// Toggle auto-connect
router.post('/:id/toggle-auto-connect', (req, res) => {
  const db = getDb();
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id);

  if (!server) {
    return res.status(404).json({ error: 'MCP server not found' });
  }

  const newValue = server.auto_connect ? 0 : 1;
  db.prepare('UPDATE mcp_servers SET auto_connect = ? WHERE id = ?').run(newValue, req.params.id);

  res.json({ ...server, auto_connect: newValue });
});

module.exports = router;
