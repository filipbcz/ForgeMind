const CACHE_NAME = 'forgemind-mobile-v1';
const CORE_ASSETS = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/'))));
});

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event.data);
  const title = payload.title || 'ForgeMind update';
  const options = {
    body: payload.body || 'You have a new task update.',
    tag: payload.tag || 'forgemind-task-update',
    data: payload.data || { url: payload.url || '/?view=tasks' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  const url = event.notification?.data?.url || '/?view=tasks';
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => 'focus' in client);
      if (existing) {
        existing.focus();
        if ('navigate' in existing) {
          return existing.navigate(url);
        }
      }

      return self.clients.openWindow(url);
    })
  );
});

function parsePushPayload(data) {
  if (!data) return {};

  try {
    return data.json();
  } catch {
    return { body: data.text() };
  }
}

