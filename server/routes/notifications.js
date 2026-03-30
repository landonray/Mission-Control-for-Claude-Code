const express = require('express');
const router = express.Router();
const notificationService = require('../services/notificationService');

// Get VAPID public key for push subscription
router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: notificationService.getPublicKey() });
});

// Subscribe to push notifications
router.post('/subscribe', (req, res) => {
  try {
    notificationService.subscribe(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unsubscribe from push notifications
router.post('/unsubscribe', (req, res) => {
  try {
    notificationService.unsubscribe(req.body.endpoint);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get notification settings
router.get('/settings', (req, res) => {
  try {
    const settings = notificationService.getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update notification settings
router.put('/settings', (req, res) => {
  try {
    const settings = notificationService.updateSettings(req.body);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send test notification
router.post('/test', async (req, res) => {
  try {
    await notificationService.sendNotification(
      'Mission Control',
      'Test notification - push notifications are working!',
      { type: 'test' }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push notification endpoint (called by lifecycle hooks)
router.post('/push', async (req, res) => {
  try {
    const { title, body, type, session_id } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'title and body required' });
    }

    await notificationService.sendNotification(
      title,
      body,
      { type: type || 'info', session_id: session_id || null }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
