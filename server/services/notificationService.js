const webPush = require('web-push');
const { query } = require('../database');

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

async function subscribe(subscription) {
  await query(
    `INSERT INTO notification_subscriptions (endpoint, keys_p256dh, keys_auth)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET keys_p256dh = EXCLUDED.keys_p256dh, keys_auth = EXCLUDED.keys_auth`,
    [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
  );
}

async function unsubscribe(endpoint) {
  await query('DELETE FROM notification_subscriptions WHERE endpoint = $1', [endpoint]);
}

async function getSettings() {
  const result = await query('SELECT * FROM notification_settings WHERE id = 1');
  return result.rows[0];
}

async function updateSettings(settings) {
  const fields = [];
  const values = [];
  let paramIdx = 1;

  for (const [key, value] of Object.entries(settings)) {
    if (['waiting_for_input', 'task_complete', 'error_events', 'context_window_warning', 'context_threshold', 'daily_digest'].includes(key)) {
      fields.push(`${key} = $${paramIdx++}`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
  }

  if (fields.length > 0) {
    values.push(1);
    await query(`UPDATE notification_settings SET ${fields.join(', ')} WHERE id = $${paramIdx}`, values);
  }

  return getSettings();
}

async function sendNotification(title, body, data = {}) {
  initializeVapid();
  const subsResult = await query('SELECT * FROM notification_subscriptions');
  const subscriptions = subsResult.rows;
  const settings = await getSettings();

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
          await query('DELETE FROM notification_subscriptions WHERE endpoint = $1', [sub.endpoint]);
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
