// Offline support. Pages load from the network first so updates show up right away; if the
// network is down we fall back to the last copy we saw. Multiplayer needs the internet, but the
// home page and the daily puzzles keep working offline.
const CACHE = "oxidpvp-v1";
const PRECACHE = [
  "/", "/daily", "/daily-sudoku", "/daily-chess", "/404.html",
  "/css/style.css", "/css/party.css", "/favicon.svg",
  "/js/net.js", "/js/party.js", "/js/changelog.js",
  "/js/daily.js", "/js/daily-sudoku.js", "/js/daily-chess.js", "/js/chess-puzzles.js",
  "/vendor/chess.js",
];

// Cloudflare serves /page.html as /page (a redirect). Store the final, non-redirected response.
async function clean(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
const keyOf = (url) => {
  const u = new URL(url);
  u.hash = ""; u.search = "";
  if (u.pathname.endsWith(".html")) u.pathname = u.pathname.slice(0, -5);
  if (u.pathname === "/index") u.pathname = "/";
  return u.toString();
};

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (p) => {
      try { const r = await fetch(p, { cache: "no-cache" }); if (r.ok) await c.put(keyOf(new URL(p, location.origin)), await clean(r)); } catch {}
    }));
    self.skipWaiting();
  })());
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith((async () => {
    const key = keyOf(req.url);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const copy = await clean(res.clone());
        caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key);
      if (hit) return hit;
      if (req.mode === "navigate") {
        const home = await caches.match(keyOf(new URL("/", location.origin)));
        if (home) return home;
      }
      throw err;
    }
  })());
});
