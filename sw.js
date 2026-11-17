// Guarda uma cópia do app no celular para abrir mesmo sem internet.
// Arquivos do app: tenta a rede primeiro (pega atualizações) e usa a cópia se estiver offline.
// Biblioteca do Firebase (versão fixa): usa a cópia direto.
const CACHE = "minhas-compras-v1";
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const APP_FILES = [
  "./", "index.html", "app.js", "firebase-config.js", "manifest.webmanifest",
  "img/logo.png", "img/icon.png", "img/favicon-32.png", "img/icon-192.png"
];
const SDK_FILES = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map(f => SDK + f);

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll([...APP_FILES, ...SDK_FILES]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.href.startsWith(SDK)) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy));
        return response;
      }))
    );
    return;
  }

  // Só arquivos do próprio site. Firebase (login e banco) passa direto.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, {ignoreSearch: true})
        .then(hit => hit || (request.mode === "navigate" ? caches.match("index.html") : undefined))
        .then(hit => hit || Response.error()))
  );
});
