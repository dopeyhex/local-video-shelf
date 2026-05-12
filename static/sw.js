const CACHE_NAME = 'video-app-v4';
const OFFLINE_URL = '/offline.html';

// Files to cache for offline use
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/admin.html',
  '/styles.css',
  '/app.js',
  '/admin.js',
  '/offline.html'
];

// Install event - cache essential files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch event - serve from cache or network, show offline page on failure
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (
    requestUrl.pathname.startsWith('/media/') ||
    requestUrl.pathname.startsWith('/thumb/') ||
    requestUrl.pathname.startsWith('/folder-thumb/') ||
    requestUrl.pathname.startsWith('/api/')
  ) {
    return;
  }

  // For navigation requests (HTML pages)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(OFFLINE_URL);
      })
    );
    return;
  }

  // For other requests: try network first, then cache, then offline page
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for static assets
        if (response.ok && shouldCache(event.request.url)) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // For API requests that fail, return a simple error response
          if (event.request.url.includes('/api/')) {
            return new Response(JSON.stringify({ error: 'Offline' }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
          return caches.match(OFFLINE_URL);
        });
      })
  );
});

// Helper to determine if a URL should be cached
function shouldCache(url) {
  const cacheableExtensions = ['.css', '.js', '.html', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2'];
  return cacheableExtensions.some(ext => url.endsWith(ext));
}
