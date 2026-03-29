const CACHE_NAME = 'mission-control-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: data.data,
    vibrate: [200, 100, 200],
    actions: []
  };

  if (data.data?.type === 'waiting_for_input') {
    options.actions = [
      { action: 'approve', title: 'Approve' },
      { action: 'deny', title: 'Deny' }
    ];
    options.requireInteraction = true;
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Mission Control', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data;
  let url = '/';

  if (data?.sessionId) {
    url = `/session/${data.sessionId}`;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({
            type: 'notification_click',
            action: event.action,
            data
          });
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
