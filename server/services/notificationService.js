const webPush = require('web-push');
const { getDb } = require('../database');

const VAPID_SUBJECT = 'mailto:admin@mission-control.local';
let vapidKeys = null;

function initializeVapid() {
  if (!vapidKeys) {
    vapidKeys = webPush.generateVAPIDKeys();
    webPush.setVapidDetails(
      VAPID_SUBJECT,
      vapidKeys.publicKey,
      vapidKeys.privateKey
    );
  }
  return vapidKeys;
}

function getPublicKey() {
  const keys = initializeVapid();
  return keys.publicKey;
}

function subscribe(subscription) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO notification_subscriptions (endpoint, keys_p256dh, keys_auth)
    VALUES (?, ?, ?)
  `).run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
}

function unsubscribe(endpoint) {
  const db = getDb();
  db.prepare('DELETE FROM notification_subscriptions WHERE endpoint = ?').run(endpoint);
}

function getSettings() {
  const db = getDb();
  return db.prepare('SELECT * FROM notification_settings WHERE id = 1').get();
}

function updateSettings(settings) {
  const db = getDb();
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(settings)) {
    if (['waiting_for_input', 'task_complete', 'error_events', 'context_window_warning', 'context_threshold', 'daily_digest'].includes(key)) {
      fields.push(`${key} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
  }

  if (fields.length > 0) {
    values.push(1);
    db.prepare(`UPDATE notification_settings SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  return getSettings();
}

async function sendNotification(title, body, data = {}) {
  initializeVapid();
  const db = getDb();
  const subscriptions = db.prepare('SELECT * FROM notification_subscriptions').all();
  const settings = getSettings();

  const eventType = data.type;
  if (eventType === 'waiting_for_input' && !settings.waiting_for_input) return;
  if (eventType === 'task_complete' && !settings.task_complete) return;
  if (eventType === 'error' && !settings.error_events) return;
  if (eventType === 'context_warning' && !settings.context_window_warning) return;

  const payload = JSON.stringify({
    title,
    body,
    data,
    timestamp: new Date().toISOString()
  });

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth }
          },
          payload
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          db.prepare('DELETE FROM notification_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        }
        throw err;
      }
    })
  );

  return results;
}

module.exports = {
  getPublicKey,
  subscribe,
  unsubscribe,
  getSettings,
  updateSettings,
  sendNotification
};
