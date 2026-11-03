// Keeps the page's own files for offline use. The snapshot itself lives in IndexedDB, not here.
// Network first, so a published change shows on the next open; the cached copy when offline.
// Bump VERSION when any file changes: the changed sw.js is what makes phones install the new version.
const VERSION = "finance-v3";
const FILES = ["./", "index.html", "app.js", "core.js", "style.css", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => e.respondWith(
  fetch(e.request).then((r) => {
    if (r.ok && e.request.method === "GET") { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request))));
