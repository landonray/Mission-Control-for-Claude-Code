const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { v4: uuidv4 } = require('uuid');

// List all MCP servers
router.get('/', async (req, res) => {
  const servers = (await query('SELECT * FROM mcp_servers ORDER BY name')).rows;
  res.json(servers);
});

// Get single MCP server
router.get('/:id', async (req, res) => {
  const server = (await query('SELECT * FROM mcp_servers WHERE id = $1', [req.params.id])).rows[0];

  if (!server) {
    return res.status(404).json({ error: 'MCP server not found' });
  }

  res.json(server);
});

// Create MCP server config
router.post('/', async (req, res) => {
  const id = uuidv4();
  const { name, command, args, env, auto_connect } = req.body;

  if (!name || !command) {
    return res.status(400).json({ error: 'name and command are required' });
  }

  try {
    await query(`
      INSERT INTO mcp_servers (id, name, command, args, env, auto_connect)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      id, name, command,
      args ? JSON.stringify(args) : null,
      env ? JSON.stringify(env) : null,
      auto_connect ? 1 : 0
    ]);

    const server = (await query('SELECT * FROM mcp_servers WHERE id = $1', [id])).rows[0];
    res.status(201).json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update MCP server config
router.put('/:id', async (req, res) => {
  const { name, command, args, env, auto_connect } = req.body;

  try {
    await query(`
      UPDATE mcp_servers SET
        name = COALESCE($1, name),
        command = COALESCE($2, command),
        args = COALESCE($3, args),
        env = COALESCE($4, env),
        auto_connect = COALESCE($5, auto_connect)
      WHERE id = $6
    `, [
      name || null, command || null,
      args ? JSON.stringify(args) : null,
      env ? JSON.stringify(env) : null,
      auto_connect !== undefined ? (auto_connect ? 1 : 0) : null,
      req.params.id
    ]);

    const server = (await query('SELECT * FROM mcp_servers WHERE id = $1', [req.params.id])).rows[0];
    if (!server) {
      return res.status(404).json({ error: 'MCP server not found' });
    }

    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete MCP server config
router.delete('/:id', async (req, res) => {
  const result = await query('DELETE FROM mcp_servers WHERE id = $1', [req.params.id]);

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'MCP server not found' });
  }

  res.json({ success: true });
});

// Toggle auto-connect
router.post('/:id/toggle-auto-connect', async (req, res) => {
  const server = (await query('SELECT * FROM mcp_servers WHERE id = $1', [req.params.id])).rows[0];

  if (!server) {
    return res.status(404).json({ error: 'MCP server not found' });
  }

  const newValue = server.auto_connect ? 0 : 1;
  await query('UPDATE mcp_servers SET auto_connect = $1 WHERE id = $2', [newValue, req.params.id]);

  res.json({ ...server, auto_connect: newValue });
});

module.exports = router;
