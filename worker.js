// Cloudflare Worker for oxidpvp.net
// Serves the static site from public/, and runs game rooms at /api/room/<game>/<CODE>.
//
// Each room is a Durable Object that every player connects to over a WebSocket.
// The room is only a relay: the host's browser runs the game, and the room forwards
// messages host -> guest(s) and guest -> host. Because everyone connects to Cloudflare
// (not to each other), home routers and school firewalls can't block the connection.
//
// Rooms are keyed by code alone, so /api/lookup/<CODE> can tell the home page which game a
// code belongs to. Every socket carries a token so a dropped player can reconnect into the
// same seat, and a host whose connection drops gets a short grace period to come back.
//
// Two singleton objects sit beside the rooms:
//   Directory   - public rooms that hosts chose to list (GET /api/rooms)
//   Leaderboard - wins/losses per name per game, reported by players in a live room
//                 (GET /api/leaderboard?game=<id>|all)
import { DurableObject } from "cloudflare:workers";

const MAX_SOCKETS = 12;         // host + guests + spectators (games enforce their own limits)
const MAX_MESSAGE = 64 * 1024;  // bytes
const HOST = 0;
const HOST_GRACE_MS = 30000;    // how long guests wait for a dropped host to come back
const CODE_RE = /^[A-Z0-9]{5}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.pathname.match(/^\/api\/room\/([a-z0-9]{1,16})\/([A-Z0-9]{5})$/);
    if (room) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });
      return stub(env, room[2]).fetch(request);
    }
    const look = url.pathname.match(/^\/api\/lookup\/([A-Za-z0-9]{5})$/);
    if (look) {
      const code = look[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: "bad-code" }, 400);
      return stub(env, code).fetch(new Request("https://room/lookup"));
    }
    if (url.pathname === "/api/rooms" && request.method === "GET") {
      return env.DIRECTORY.get(env.DIRECTORY.idFromName("dir")).fetch(new Request("https://dir/list"));
    }
    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      const game = (url.searchParams.get("game") || "all").slice(0, 16);
      if (!/^[a-z0-9]+$/.test(game)) return json({ error: "bad-game" }, 400);
      return env.BOARD.get(env.BOARD.idFromName("board")).fetch(new Request("https://board/top?game=" + game));
    }
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

const stub = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(`room:${code}`));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

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
    const url = new URL(request.url);
    const game = await this.ctx.storage.get("game");
    const away = await this.ctx.storage.get("away");
    const host = this.find(HOST);

    if (url.pathname === "/lookup") {
      return host || away ? json({ game }) : json({ error: "not-found" }, 404);
    }

    const reqGame = url.pathname.split("/")[3];
    const role = url.searchParams.get("role");
    const token = (url.searchParams.get("token") || "").slice(0, 40);

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const done = () => new Response(null, { status: 101, webSocket: client });
    const refuse = (reason, extra = {}) => {
      server.send(JSON.stringify({ sys: "error", reason, ...extra }));
      server.close(4000, reason);
      return done();
    };

    if (role === "host") {
      if (host) return refuse("exists");
      // A host reconnecting after a drop must not silently start a brand new room.
      if (url.searchParams.get("resume") && !away) return refuse("gone");
      if (away) {
        // Only the original host (same token, same game) may take the room back.
        const hostToken = await this.ctx.storage.get("hostToken");
        if (!token || token !== hostToken || reqGame !== game) return refuse("exists");
        await this.ctx.storage.delete("away");
        await this.ctx.storage.deleteAlarm();
        server.serializeAttachment({ id: HOST, token });
        const guests = this.members().filter((s) => s !== server).map((s) => s.deserializeAttachment().id);
        server.send(JSON.stringify({ sys: "welcome", id: HOST, resumed: true, roster: guests }));
        for (const s of this.members()) if (s !== server) send(s, { sys: "host-back" });
        return done();
      }
      // Fresh room: drop anything left over from an old room with this code.
      for (const s of this.members()) if (s !== server) this.retire(s, 4002, "room reset");
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put({ game: reqGame, hostToken: token, next: 1, code: url.pathname.split("/")[4] });
      server.serializeAttachment({ id: HOST, token });
      server.send(JSON.stringify({ sys: "welcome", id: HOST }));
      return done();
    }

    if (!host && !away) return refuse("not-found");
    if (reqGame !== game) return refuse("wrong-game", { game });
    const members = this.members().filter((s) => s !== server);
    if (members.length >= MAX_SOCKETS) return refuse("full");

    // A known token whose seat is empty gets that seat back.
    let id = token ? await this.ctx.storage.get("t:" + token) : undefined;
    let rejoin = id != null && !members.some((s) => s.deserializeAttachment().id === id);
    if (!rejoin) {
      id = (await this.ctx.storage.get("next")) || 1;
      await this.ctx.storage.put("next", id + 1);
      if (token) await this.ctx.storage.put("t:" + token, id);
    }
    server.serializeAttachment({ id, token });
    server.send(JSON.stringify({ sys: "welcome", id, rejoin, hostAway: !host }));
    if (host) send(host, { sys: rejoin ? "rejoin" : "join", id });
    return done();
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return;
    const me = ws.deserializeAttachment();
    if (!me || me.left) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.bye) return this.leave(ws, true);
    if (m.rec) return this.record(ws, me, m.rec);

    if (me.id === HOST) {
      if (m.pub) return this.publish(m.pub);
      if (m.kick != null) {
        const target = this.find(m.kick);
        if (target && m.kick !== HOST) {
          this.retire(target, 4001, "removed by host");
          send(ws, { sys: "leave", id: m.kick, final: true });
        }
        return;
      }
      const out = JSON.stringify({ from: HOST, d: m.d });
      if (m.to === "all") {
        for (const s of this.members()) if (s !== ws) trySend(s, out);
      } else if (Array.isArray(m.to)) {
        for (const id of m.to.slice(0, MAX_SOCKETS)) { const t = this.find(id); if (t) trySend(t, out); }
      } else {
        const target = this.find(m.to);
        if (target) trySend(target, out);
      }
    } else {
      const host = this.find(HOST);
      if (host) send(host, { from: me.id, d: m.d });
    }
  }

  webSocketClose(ws) { return this.leave(ws, false); }
  webSocketError(ws) { return this.leave(ws, false); }

  // final = the player chose to leave; otherwise their connection dropped and they may be back.
  async leave(ws, final) {
    const me = ws.deserializeAttachment();
    if (!me || me.left) return;
    this.retire(ws, 1000, "");
    if (me.id === HOST) {
      if (final || !this.members().length) return this.endRoom();
      await this.ctx.storage.put("away", true);
      await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
      for (const s of this.members()) send(s, { sys: "host-away" });
    } else {
      const host = this.find(HOST);
      if (host) send(host, { sys: "leave", id: me.id, final });
    }
  }

  async alarm() {
    if (!this.find(HOST) && (await this.ctx.storage.get("away"))) await this.endRoom();
  }

  // Host asks to list (or unlist) this room in the public directory.
  async publish(p) {
    const code = await this.ctx.storage.get("code");
    const game = await this.ctx.storage.get("game");
    if (!code || !game || !p || typeof p !== "object") return;
    const entry = p.on ? {
      code, game,
      host: cleanName(p.host),
      players: clampInt(p.players, 0, MAX_SOCKETS), max: clampInt(p.max, 1, MAX_SOCKETS),
      started: !!p.started, watch: !!p.watch,
    } : null;
    await this.ctx.storage.put("listed", !!entry);
    await dirCall(this.env, entry ? { add: entry } : { remove: code });
  }

  // A player reports their own result. Needs a real game in progress (2+ people connected)
  // and is rate-limited per socket, so the board can't be spammed from one tab.
  async record(ws, me, rec) {
    const game = await this.ctx.storage.get("game");
    const r = rec && rec.r;
    if (!game || !["win", "loss", "draw"].includes(r) || this.members().length < 2) return;
    const now = Date.now();
    if (me.lastRec && now - me.lastRec < 15000) return;
    ws.serializeAttachment({ ...me, lastRec: now });
    const name = cleanName(rec.name);
    if (!name || /^player\d*$/i.test(name) || rude(name)) return;
    await this.env.BOARD.get(this.env.BOARD.idFromName("board")).fetch(new Request("https://board/add", {
      method: "POST", body: JSON.stringify({ game, name, r }),
    }));
  }

  async endRoom() {
    // No host, no game: send everyone else home.
    for (const s of this.members()) {
      send(s, { sys: "host-left" });
      this.retire(s, 4002, "host left");
    }
    const code = await this.ctx.storage.get("code");
    if (code && (await this.ctx.storage.get("listed"))) await dirCall(this.env, { remove: code });
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  retire(ws, code, reason) {
    ws.serializeAttachment({ ...ws.deserializeAttachment(), left: true });
    try { ws.close(code, reason); } catch {}
  }
}

function send(ws, obj) { trySend(ws, JSON.stringify(obj)); }
function trySend(ws, str) { try { ws.send(str); } catch {} }
const cleanName = (n) => String(n || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));
const dirCall = (env, body) =>
  env.DIRECTORY.get(env.DIRECTORY.idFromName("dir")).fetch(new Request("https://dir/set", { method: "POST", body: JSON.stringify(body) }));

// Names that never go on the public leaderboard or rooms list.
const RUDE = ["fuck", "shit", "bitch", "cunt", "dick", "cock", "pussy", "nigg", "fag", "slut", "whore", "rape", "nazi", "retard", "penis", "vagina", "porn", "sex", "kys"];
const rude = (name) => {
  const flat = name.toLowerCase().replace(/[^a-z]/g, "").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e");
  return RUDE.some((w) => flat.includes(w));
};

// ---------- Public rooms ----------
// Kept in memory: hosts re-send their entry every 20s, so a restart refills within seconds.
const LISTING_TTL_MS = 60000;
export class Directory extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.rooms = new Map(); }
  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    for (const [code, r] of this.rooms) if (now - r.ts > LISTING_TTL_MS) this.rooms.delete(code);
    if (url.pathname === "/set" && request.method === "POST") {
      const b = await request.json();
      if (b.remove) this.rooms.delete(b.remove);
      if (b.add && b.add.code) {
        if (rude(b.add.host)) b.add.host = "Someone";
        this.rooms.set(b.add.code, { ...b.add, ts: now });
      }
      if (this.rooms.size > 500) this.rooms.delete(this.rooms.keys().next().value);
      return json({ ok: true });
    }
    const list = [...this.rooms.values()].sort((a, b) => b.ts - a.ts).slice(0, 100)
      .map(({ ts, ...r }) => r);
    return json({ rooms: list });
  }
}

// ---------- Leaderboard ----------
export class Leaderboard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS scores (
      game TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
      w INTEGER NOT NULL DEFAULT 0, l INTEGER NOT NULL DEFAULT 0, d INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL, PRIMARY KEY (game, key))`);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/add" && request.method === "POST") {
      const { game, name, r } = await request.json();
      const col = { win: "w", loss: "l", draw: "d" }[r];
      if (!col || !game || !name) return json({ ok: false }, 400);
      this.sql.exec(
        `INSERT INTO scores (game, key, name, ${col}, updated) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(game, key) DO UPDATE SET ${col} = ${col} + 1, name = excluded.name, updated = excluded.updated`,
        game, name.toLowerCase(), name, Date.now());
      return json({ ok: true });
    }
    const game = url.searchParams.get("game") || "all";
    const rows = game === "all"
      ? this.sql.exec(`SELECT MAX(name) AS name, SUM(w) AS w, SUM(l) AS l, SUM(d) AS d FROM scores
          GROUP BY key ORDER BY w DESC, l ASC LIMIT 50`).toArray()
      : this.sql.exec(`SELECT name, w, l, d FROM scores WHERE game = ? ORDER BY w DESC, l ASC LIMIT 50`, game).toArray();
    return json({ game, rows });
  }
}
