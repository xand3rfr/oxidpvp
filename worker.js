// Cloudflare Worker for oxidpvp.net
// Serves the static site, plus /api/ice which returns short-lived TURN relay credentials
// so players can connect even when their routers/firewalls block direct WebRTC links.
//
// Needs two secrets (Workers & Pages → oxidpvp → Settings → Variables and Secrets):
//   TURN_KEY_ID         – the TURN key ID from Cloudflare Realtime → TURN Server
//   TURN_KEY_API_TOKEN  – that key's API token
// Without them, /api/ice returns public STUN servers only.

const FALLBACK = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ice") return ice(request, env);
    return env.ASSETS.fetch(request);
  },
};

async function ice(request, env) {
  // Only hand credentials to our own pages.
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ error: "forbidden" }, 403);
  }
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return json({ iceServers: FALLBACK, turn: false });
  }

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 86400 }),
    },
  );
  if (!res.ok) return json({ iceServers: FALLBACK, turn: false, error: res.status });

  const data = await res.json();
  const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
  // Browsers block port 53, so drop those URLs; they'd only slow down connecting.
  const iceServers = list
    .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length);
  return json({ iceServers, turn: true });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
