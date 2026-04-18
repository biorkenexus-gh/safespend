const CACHE_NAME = 'safespend-v5';

const PRECACHE_URLS = [
    './',
    './index.html',
    './logo.png',
    'https://cdn.tailwindcss.com',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap'
];

// ── Install: pre-cache app shell ──────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.allSettled(PRECACHE_URLS.map(url => cache.add(url)))
        )
    );
    self.skipWaiting();
});

// ── Activate: remove old caches ───────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// ── Fetch: cache-first, fall back to network ──────────────────────
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => caches.match('./index.html'));
        })
    );
});

// ── Daily notification scheduling ────────────────────────────────
let notifTimeout = null;

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SCHEDULE_NOTIFICATION') {
        scheduleDailyNotification(event.data.time);
    }
});

function scheduleDailyNotification(time) {
    if (notifTimeout) { clearTimeout(notifTimeout); notifTimeout = null; }

    const [hours, minutes] = time.split(':').map(Number);
    const now    = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);

    const delay = target.getTime() - now.getTime();
    notifTimeout = setTimeout(() => {
        self.registration.showNotification('SafeSpend Reminder 💰', {
            body:    "Have you logged today's expenses?",
            icon:    './icon-192.svg',
            badge:   './icon-192.svg',
            tag:     'daily-reminder',
            renotify: true,
            actions: [{ action: 'open', title: 'Open App' }]
        });
        scheduleDailyNotification(time);
    }, delay);
}

// ── Notification click: open or focus app ─────────────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            for (const client of clientList) {
                if (client.url.includes('index.html') && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) return clients.openWindow('./index.html');
        })
    );
});
