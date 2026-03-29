const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { getDb } = require('./database');
const { setupWebSocket } = require('./websocket');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database
getDb();

// API Routes
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/files', require('./routes/files'));
app.use('/api/presets', require('./routes/presets'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/mcp', require('./routes/mcp'));
app.use('/api/history', require('./routes/history'));
app.use('/api/quality', require('./routes/quality'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Serve React frontend in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
    res.sendFile(path.join(clientDist, 'index.html'));
  }
});

// Setup WebSocket
setupWebSocket(server);

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mission Control server running on http://0.0.0.0:${PORT}`);
});
