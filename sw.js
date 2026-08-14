// 专注监督 Service Worker：离线缓存，秒开体验
const VERSION = "sm-v1.3";
const CORE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v1.3/style.css",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v1.3/app.js",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v1.3/js/face-api.min.js",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v1.3/models/tiny_face_detector_model-weights_manifest.json",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v1.3/models/tiny_face_detector_model-shard1",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v1.3/models/face_landmark_68_model-weights_manifest.json",
  "https://cdn.jsdelivr.net/gh/hailanlan0577/study-monitor@v1.3/models/face_landmark_68_model-shard1",
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
  // 页面导航：网络优先，失败回退缓存
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(() => caches.match("./index.html"))
    );
    return;
  }
  // 静态资源：缓存优先
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
