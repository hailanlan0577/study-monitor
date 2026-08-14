// 专注监督 Service Worker：离线缓存，秒开体验
const VERSION = "sm-v2.0";
const CORE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v2.0/style.css",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v2.0/app.js",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v2.0/models/face_landmarker.task",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v2.0/models/hand_landmarker.task",
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(() => caches.match("./index.html"))
    );
    return;
  }
  if (url.origin === location.origin || url.hostname.includes("jsdelivr")) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      }))
    );
  }
});
