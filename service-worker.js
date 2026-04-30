const CACHE_NAME = 'safespend-v36';

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

// ── Fetch strategy ────────────────────────────────────────────────
// index.html + service-worker.js → NETWORK-FIRST (ensures latest code is served)
// everything else                → CACHE-FIRST (fast offline behavior)
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const isHtmlNav = event.request.mode === 'navigate' ||
                      url.pathname.endsWith('/index.html') ||
                      url.pathname === '/' ||
                      url.pathname.endsWith('/service-worker.js');

    if (isHtmlNav) {
        // Network-first: always try fresh, fall back to cache if offline
        event.respondWith(
            fetch(event.request).then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            }).catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
        );
        return;
    }

    // Cache-first for everything else
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
//   Stored config from the latest SCHEDULE_NOTIFICATION message:
//     time    : 'HH:MM'  — local time
//     message : string   — custom body text (or default)
//     days    : [0..6]   — Sun=0..Sat=6, days the reminder fires on
let notifTimeout = null;
let notifConfig  = { time: '20:00', message: "Have you logged today's expenses?", days: [0,1,2,3,4,5,6] };

// v34 — per-activity reminders. The frontend posts SCHEDULE_ACTIVITY_REMINDERS
// with a list of { id, title, fireAt (epoch ms) }. We replace any prior schedule
// (the frontend sends the FULL set every time, never a delta) and arm a setTimeout
// per item. Posting an empty list cancels all pending reminders — used by the
// master notifications toggle to disable.
let activityTimeouts = {};   // { activityId: timeoutId }

self.addEventListener('message', event => {
    if (!event.data) return;
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    if (event.data.type === 'SCHEDULE_NOTIFICATION') {
        if (event.data.time)             notifConfig.time    = event.data.time;
        if (event.data.message)          notifConfig.message = event.data.message;
        if (Array.isArray(event.data.days)) notifConfig.days  = event.data.days;
        scheduleDailyNotification();
    }
    if (event.data.type === 'SCHEDULE_ACTIVITY_REMINDERS') {
        // Cancel anything previously scheduled — the frontend sends the
        // complete set every time so we don't need to diff.
        Object.values(activityTimeouts).forEach(t => clearTimeout(t));
        activityTimeouts = {};

        const list = Array.isArray(event.data.list) ? event.data.list : [];
        const now = Date.now();
        const HORIZON_MS = 24 * 60 * 60 * 1000;
        list.forEach(item => {
            if (!item || !item.id || !item.title) return;
            const delay = Number(item.fireAt) - now;
            if (delay <= 0 || delay > HORIZON_MS) return;
            activityTimeouts[item.id] = setTimeout(() => {
                self.registration.showNotification('SafeSpend Reminder ⏰', {
                    body:    item.title,
                    icon:    './icon-192.svg',
                    badge:   './icon-192.svg',
                    tag:     'activity-' + item.id,
                    renotify: true,
                    actions: [{ action: 'open', title: 'Open App' }]
                });
                delete activityTimeouts[item.id];
            }, delay);
        });
    }
});

function scheduleDailyNotification() {
    if (notifTimeout) { clearTimeout(notifTimeout); notifTimeout = null; }

    const [hours, minutes] = (notifConfig.time || '20:00').split(':').map(Number);
    const now    = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    // If today's slot has already passed OR today isn't an enabled day,
    // advance one day at a time until we hit an enabled day in the future.
    const days = (notifConfig.days && notifConfig.days.length) ? notifConfig.days : [0,1,2,3,4,5,6];
    if (target <= now) target.setDate(target.getDate() + 1);
    while (!days.includes(target.getDay())) {
        target.setDate(target.getDate() + 1);
    }

    const delay = target.getTime() - now.getTime();
    notifTimeout = setTimeout(() => {
        self.registration.showNotification('SafeSpend Reminder 💰', {
            body:    notifConfig.message || "Have you logged today's expenses?",
            icon:    './icon-192.svg',
            badge:   './icon-192.svg',
            tag:     'daily-reminder',
            renotify: true,
            actions: [{ action: 'open', title: 'Open App' }]
        });
        scheduleDailyNotification();
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
