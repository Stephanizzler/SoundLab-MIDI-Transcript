// Keeps the app working offline once it has been opened. Pages are fetched
// fresh when online (so updates arrive); files are served from the cache.
const CACHE = "midi-transcript-v1";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./manifest.webmanifest", "./icon-192.png"]))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const save = (res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; };
  if (req.mode === "navigate") { e.respondWith(fetch(req).then(save).catch(() => caches.match(req).then((r) => r || caches.match("./")))); return; }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(save)));
});
