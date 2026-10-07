// Be Better Bulletin — service worker
//
// Keeps the installed app usable with no signal, without ever standing
// between you and fresh stories while you ARE online. Strategy is
// network-first for everything: always try the real network first (so
// stories.json, community-spotlight.json, etc. are never served stale
// while there's a connection), and only fall back to whatever's cached
// when the network request actually fails. That fallback is what makes
// the installed app open to *something* with no connection, instead of
// a blank error.

const CACHE_NAME = "bbb-shell-v1";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        var resClone = res.clone();
        caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(event.request, resClone))
          .catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
