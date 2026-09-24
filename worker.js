// Cloudflare Worker for oxidpvp.net
// Serves the static site from public/, and runs game rooms at /api/room/<game>/<CODE>.
//
// Each room is a Durable Object that every player connects to over a WebSocket.
// The room is only a relay: the host's browser runs the game, and the room forwards
// messages host -> guest(s) and guest -> host. Because everyone connects to Cloudflare
// (not to each other), home routers and school firewalls can't block the connection.
import { DurableObject } from "cloudflare:workers";

const MAX_SOCKETS = 9;          // host + up to 8 guests (games enforce their own limits)
const MAX_MESSAGE = 64 * 1024;  // bytes
const HOST = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/room\/([a-z]{1,16})\/([A-Z0-9]{5})$/);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(`${m[1]}:${m[2]}`));
      return stub.fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the room up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // Sockets that joined successfully and haven't left.
  members() {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment();
      return a && !a.left;
    });
  }
  find(id) {
    return this.members().find((ws) => ws.deserializeAttachment().id === id);
  }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get("role");
    const members = this.members();
    const host = members.find((ws) => ws.deserializeAttachment().id === HOST);

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const done = () => new Response(null, { status: 101, webSocket: client });
    const refuse = (reason) => {
      server.send(JSON.stringify({ sys: "error", reason }));
      server.close(4000, reason);
      return done();
    };

    if (role === "host") {
      if (host) return refuse("exists"); // room code already in use
      await this.ctx.storage.put("next", 1);
      server.serializeAttachment({ id: HOST });
      server.send(JSON.stringify({ sys: "welcome", id: HOST }));
      return done();
    }

    if (!host) return refuse("not-found");
    if (members.length >= MAX_SOCKETS) return refuse("full");
    const id = (await this.ctx.storage.get("next")) || 1;
    await this.ctx.storage.put("next", id + 1);
    server.serializeAttachment({ id });
    server.send(JSON.stringify({ sys: "welcome", id }));
    send(host, { sys: "join", id });
    return done();
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return;
    const me = ws.deserializeAttachment();
    if (!me || me.left) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (me.id === HOST) {
      if (m.kick != null) {
        const target = this.find(m.kick);
        if (target && m.kick !== HOST) this.leave(target, 4001, "removed by host");
        return;
      }
      const out = JSON.stringify({ from: HOST, d: m.d });
      if (m.to === "all") {
        for (const s of this.members()) if (s !== ws) trySend(s, out);
      } else {
        const target = this.find(m.to);
        if (target) trySend(target, out);
      }
    } else {
      const host = this.find(HOST);
      if (host) send(host, { from: me.id, d: m.d });
    }
  }

  webSocketClose(ws) { this.leave(ws); }
  webSocketError(ws) { this.leave(ws); }

  leave(ws, code = 1000, reason = "") {
    const me = ws.deserializeAttachment();
    if (!me || me.left) return;
    ws.serializeAttachment({ ...me, left: true });
    try { ws.close(code, reason); } catch {}
    if (me.id === HOST) {
      // No host, no game: send everyone else home.
      for (const s of this.members()) {
        send(s, { sys: "host-left" });
        s.serializeAttachment({ ...s.deserializeAttachment(), left: true });
        try { s.close(4002, "host left"); } catch {}
      }
    } else {
      const host = this.find(HOST);
      if (host) send(host, { sys: "leave", id: me.id });
    }
  }
}

function send(ws, obj) { trySend(ws, JSON.stringify(obj)); }
function trySend(ws, str) { try { ws.send(str); } catch {} }
