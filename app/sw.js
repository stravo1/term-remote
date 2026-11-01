"use strict";

const CACHE_NAME = "web-terminal-v1";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/vendor/xterm.js",
  "/vendor/xterm.css",
  "/vendor/addon-fit.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

// The terminal needs a live socket, so only shell assets are cached. The pty
// token is never cached and WebSocket traffic never reaches a fetch handler.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) {
    return;
  }
  if (url.pathname === "/token" || url.pathname === "/ws") {
    return;
  }
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      await store(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = (await caches.match(request)) || (request.mode === "navigate" ? await caches.match("/") : undefined);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function store(request, response) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response);
}
