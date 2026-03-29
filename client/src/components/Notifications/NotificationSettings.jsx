import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { Bell, BellOff, TestTube, Smartphone } from 'lucide-react';
import styles from './NotificationSettings.module.css';

export default function NotificationSettings() {
  const { notificationSettings, loadNotificationSettings } = useApp();
  const [settings, setSettings] = useState(null);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (notificationSettings) {
      setSettings(notificationSettings);
    }
  }, [notificationSettings]);

  useEffect(() => {
    setPushSupported('serviceWorker' in navigator && 'PushManager' in window);
    checkSubscription();
  }, []);

  const checkSubscription = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setPushSubscribed(!!sub);
    } catch (e) {}
  };

  const subscribePush = async () => {
    try {
      const { publicKey } = await api.get('/api/notifications/vapid-key');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api.post('/api/notifications/subscribe', sub.toJSON());
      setPushSubscribed(true);
    } catch (err) {
      alert('Failed to subscribe: ' + err.message);
    }
  };

  const unsubscribePush = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.post('/api/notifications/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setPushSubscribed(false);
    } catch (err) {
      alert('Failed to unsubscribe: ' + err.message);
    }
  };

  const updateSetting = async (key, value) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    setSaving(true);
    try {
      await api.put('/api/notifications/settings', { [key]: value });
      await loadNotificationSettings();
    } catch (e) {}
    setSaving(false);
  };

  const sendTest = async () => {
    try {
      await api.post('/api/notifications/test');
    } catch (e) {
      alert('Failed: ' + e.message);
    }
  };

  if (!settings) return null;

  return (
    <div className={styles.settings}>
      <h3>Notifications</h3>

      {/* Push subscription */}
      <div className={styles.section}>
        <h4><Smartphone size={14} /> Push Notifications</h4>
        {pushSupported ? (
          <div className={styles.pushRow}>
            {pushSubscribed ? (
              <>
                <span className={styles.subscribed}>
                  <Bell size={14} /> Subscribed
                </span>
                <button className="btn btn-secondary btn-sm" onClick={unsubscribePush}>
                  <BellOff size={14} /> Unsubscribe
                </button>
                <button className="btn btn-ghost btn-sm" onClick={sendTest}>
                  <TestTube size={14} /> Test
                </button>
              </>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={subscribePush}>
                <Bell size={14} /> Enable Push Notifications
              </button>
            )}
          </div>
        ) : (
          <p className={styles.unsupported}>Push notifications not supported in this browser</p>
        )}
      </div>

      {/* Notification types */}
      <div className={styles.section}>
        <h4>Event Types</h4>

        <ToggleRow
          label="Waiting for input"
          description="When a session needs your approval"
          checked={!!settings.waiting_for_input}
          onChange={v => updateSetting('waiting_for_input', v)}
        />

        <ToggleRow
          label="Task complete"
          description="When a session finishes its task"
          checked={!!settings.task_complete}
          onChange={v => updateSetting('task_complete', v)}
        />

        <ToggleRow
          label="Error events"
          description="When a session encounters an error"
          checked={!!settings.error_events}
          onChange={v => updateSetting('error_events', v)}
        />

        <ToggleRow
          label="Context window warning"
          description="When context usage exceeds threshold"
          checked={!!settings.context_window_warning}
          onChange={v => updateSetting('context_window_warning', v)}
        />
      </div>

      {/* Context threshold */}
      <div className={styles.section}>
        <h4>Context Warning Threshold</h4>
        <div className={styles.sliderRow}>
          <input
            type="range"
            min="0.5"
            max="0.95"
            step="0.05"
            value={settings.context_threshold || 0.8}
            onChange={e => updateSetting('context_threshold', parseFloat(e.target.value))}
            className={styles.slider}
          />
          <span className={styles.sliderValue}>
            {Math.round((settings.context_threshold || 0.8) * 100)}%
          </span>
        </div>
      </div>

      {/* Daily digest */}
      <div className={styles.section}>
        <ToggleRow
          label="Daily digest"
          description="End-of-day summary of all sessions"
          checked={!!settings.daily_digest}
          onChange={v => updateSetting('daily_digest', v)}
        />
      </div>
    </div>
  );
}

function ToggleRow({ label, description, checked, onChange }) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleInfo}>
        <span className={styles.toggleLabel}>{label}</span>
        {description && <span className={styles.toggleDesc}>{description}</span>}
      </div>
      <label className="toggle">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        <span className="toggle-slider" />
      </label>
    </div>
  );
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}
