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
//   Presence    - who's online, for the friends list, and invites between friends
//                 (WebSocket /api/presence?id=<friend code>&key=<secret>)
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
    if (url.pathname === "/api/suggestions" || url.pathname === "/api/suggestions/vote") {
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      const board = env.BOARD.get(env.BOARD.idFromName("board"));
      if (request.method === "GET") return board.fetch(new Request("https://board/sugg?sort=" + (url.searchParams.get("sort") === "new" ? "new" : "top") + "&ip=" + encodeURIComponent(ip)));
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });
      const body = await request.text();
      if (body.length > 2000) return json({ error: "too-long" }, 413);
      return board.fetch(new Request("https://board/" + (url.pathname.endsWith("vote") ? "vote" : "suggest") + "?ip=" + encodeURIComponent(ip), { method: "POST", body }));
    }
    if (url.pathname === "/api/announce" && request.method === "GET") {
      return env.BOARD.get(env.BOARD.idFromName("board")).fetch(new Request("https://board/announce"));
    }
    // Site owner tools (admin.html). Every call carries the admin password in a header.
    const adm = url.pathname.match(/^\/api\/admin\/([a-z-]{2,20})$/);
    if (adm) {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });
      const body = await request.text();
      if (body.length > 4000) return json({ error: "too-long" }, 413);
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      return env.BOARD.get(env.BOARD.idFromName("board")).fetch(new Request("https://board/admin/" + adm[1] + "?ip=" + encodeURIComponent(ip), {
        method: "POST", body, headers: { "x-admin-key": (request.headers.get("x-admin-key") || "").slice(0, 200) },
      }));
    }
    if (url.pathname === "/api/presence") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });
      return env.PRESENCE.get(env.PRESENCE.idFromName("presence")).fetch(request);
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
      started: !!p.started, watch: !!p.watch, locked: !!p.locked,
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
    // Suggestions box: ideas from players, upvoted once per visitor (keyed by a hash of their IP).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sugg (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, name TEXT NOT NULL, votes INTEGER NOT NULL DEFAULT 1,
      created INTEGER NOT NULL, who TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sugg_votes (sid INTEGER NOT NULL, who TEXT NOT NULL, PRIMARY KEY (sid, who))`);
    try { this.sql.exec(`ALTER TABLE sugg ADD COLUMN status TEXT NOT NULL DEFAULT ''`); } catch {} // added later: "planned" / "done"
    // Owner settings (admin password hash, announcement) and words the owner has banned.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS bans (word TEXT PRIMARY KEY)`);
    this.lastPost = new Map();
    this.fails = new Map();
  }
  kvGet(k) { const r = this.sql.exec(`SELECT v FROM kv WHERE k = ?`, k).toArray(); return r.length ? r[0].v : null; }
  kvSet(k, v) { if (v == null) this.sql.exec(`DELETE FROM kv WHERE k = ?`, k); else this.sql.exec(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v); }
  banned(text) {
    const flat = String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!flat) return false;
    return this.sql.exec(`SELECT word FROM bans`).toArray().some((r) => flat.includes(r.word));
  }
  bad(text) { return rude(text) || this.banned(text); }
  async hash(pw) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("oxidpvp-admin:" + pw));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // The admin password is ADMIN_KEY (a Worker secret) if set; otherwise the first person to open
  // admin.html picks one, and it's stored here (hashed).
  async admin(url, request) {
    const action = url.pathname.split("/")[2];
    const ip = url.searchParams.get("ip") || "local", now = Date.now();
    const f = this.fails.get(ip) || { n: 0, t: now };
    if (now - f.t > 600000) { f.n = 0; f.t = now; }
    let body = {};
    try { body = JSON.parse(await request.text() || "{}"); } catch { return json({ error: "bad-json" }, 400); }
    const envKey = this.env.ADMIN_KEY || "";
    const stored = this.kvGet("admin");
    if (action === "state") return json({ claimed: !!(envKey || stored) });
    if (f.n >= 10) return json({ error: "Too many wrong passwords. Wait 10 minutes." }, 429);
    const given = request.headers.get("x-admin-key") || "";
    if (action === "claim") {
      if (envKey || stored) return json({ error: "Already set up. Log in instead." }, 409);
      if (given.length < 8) return json({ error: "Use at least 8 characters." }, 400);
      this.kvSet("admin", await this.hash(given));
      return json({ ok: true });
    }
    const ok = envKey ? given === envKey : !!stored && (await this.hash(given)) === stored;
    if (!ok) { f.n++; this.fails.set(ip, f); return json({ error: "Wrong password." }, 401); }
    this.fails.delete(ip);
    switch (action) {
      case "login": return json({ ok: true });
      case "stats": {
        const one = (q) => this.sql.exec(q).one().n;
        let rooms = 0;
        try { rooms = (await (await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("dir")).fetch(new Request("https://dir/list"))).json()).rooms.length; } catch {}
        return json({
          suggestions: one(`SELECT COUNT(*) AS n FROM sugg`), votes: one(`SELECT COUNT(*) AS n FROM sugg_votes`),
          players: one(`SELECT COUNT(DISTINCT key) AS n FROM scores`), results: one(`SELECT COALESCE(SUM(w + l + d), 0) AS n FROM scores`),
          week: one(`SELECT COUNT(DISTINCT key) AS n FROM scores WHERE updated > ${now - 7 * 864e5}`),
          rooms, bans: this.sql.exec(`SELECT word FROM bans ORDER BY word`).toArray().map((r) => r.word),
          announce: this.kvGet("announce") || "",
          top: this.sql.exec(`SELECT game, SUM(w + l + d) AS n FROM scores GROUP BY game ORDER BY n DESC LIMIT 10`).toArray(),
        });
      }
      case "sugg": return json({ rows: this.sql.exec(`SELECT id, text, name, votes, created, status FROM sugg ORDER BY votes DESC, created DESC LIMIT 500`).toArray() });
      case "sugg-del": {
        const id = body.id | 0;
        this.sql.exec(`DELETE FROM sugg WHERE id = ?`, id);
        this.sql.exec(`DELETE FROM sugg_votes WHERE sid = ?`, id);
        return json({ ok: true });
      }
      case "sugg-status": {
        const st = ["", "planned", "done"].includes(body.status) ? body.status : "";
        this.sql.exec(`UPDATE sugg SET status = ? WHERE id = ?`, st, body.id | 0);
        return json({ ok: true });
      }
      case "lb-del": {
        const name = cleanName(body.name).toLowerCase();
        if (!name) return json({ error: "no-name" }, 400);
        const n = this.sql.exec(`SELECT COUNT(*) AS n FROM scores WHERE key = ?`, name).one().n;
        this.sql.exec(`DELETE FROM scores WHERE key = ?`, name);
        return json({ ok: true, removed: n });
      }
      case "ban": {
        const w = String(body.word || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
        if (w.length < 3) return json({ error: "Use at least 3 letters." }, 400);
        this.sql.exec(`INSERT OR IGNORE INTO bans (word) VALUES (?)`, w);
        // Clear anything already posted with it.
        const hit = this.sql.exec(`SELECT DISTINCT key FROM scores`).toArray().filter((r) => r.key.replace(/[^a-z0-9]/g, "").includes(w));
        for (const r of hit) this.sql.exec(`DELETE FROM scores WHERE key = ?`, r.key);
        const sg = this.sql.exec(`SELECT id, text, name FROM sugg`).toArray().filter((r) => (r.text + r.name).toLowerCase().replace(/[^a-z0-9]/g, "").includes(w));
        for (const r of sg) { this.sql.exec(`DELETE FROM sugg WHERE id = ?`, r.id); this.sql.exec(`DELETE FROM sugg_votes WHERE sid = ?`, r.id); }
        return json({ ok: true, cleared: hit.length + sg.length });
      }
      case "unban": this.sql.exec(`DELETE FROM bans WHERE word = ?`, String(body.word || "")); return json({ ok: true });
      case "announce": {
        const text = String(body.text || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 200);
        this.kvSet("announce", text ? JSON.stringify({ text, at: now }) : null);
        return json({ ok: true });
      }
      case "password": {
        if (envKey) return json({ error: "The password is set as a Cloudflare secret (ADMIN_KEY). Change it there." }, 400);
        const pw = String(body.password || "");
        if (pw.length < 8) return json({ error: "Use at least 8 characters." }, 400);
        this.kvSet("admin", await this.hash(pw));
        return json({ ok: true });
      }
    }
    return json({ error: "not-found" }, 404);
  }
  async who(ip) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("oxidpvp:" + ip));
    return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async suggestions(url, request) {
    const who = await this.who(url.searchParams.get("ip") || "local");
    if (url.pathname === "/sugg") {
      const order = url.searchParams.get("sort") === "new" ? "created DESC" : "votes DESC, created DESC";
      const rows = this.sql.exec(`SELECT id, text, name, votes, created, status FROM sugg ORDER BY ${order} LIMIT 200`).toArray();
      const mine = new Set(this.sql.exec(`SELECT sid FROM sugg_votes WHERE who = ?`, who).toArray().map((r) => r.sid));
      return json({ rows: rows.map((r) => ({ ...r, voted: mine.has(r.id) })), total: this.sql.exec(`SELECT COUNT(*) AS n FROM sugg`).one().n });
    }
    let body;
    try { body = JSON.parse(await request.text()); } catch { return json({ error: "bad-json" }, 400); }
    if (url.pathname === "/suggest") {
      const text = String(body.text || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 280);
      const name = cleanName(body.name) || "Anonymous";
      if (text.length < 6) return json({ error: "Write a bit more than that." }, 400);
      if (this.bad(text) || this.bad(name)) return json({ error: "Keep it friendly, please." }, 400);
      const now = Date.now(), last = this.lastPost.get(who) || 0;
      if (now - last < 60000) return json({ error: "One suggestion a minute, please." }, 429);
      const today = this.sql.exec(`SELECT COUNT(*) AS n FROM sugg WHERE who = ? AND created > ?`, who, now - 86400000).one().n;
      if (today >= 10) return json({ error: "That's plenty for today. Thanks!" }, 429);
      if (this.sql.exec(`SELECT COUNT(*) AS n FROM sugg WHERE lower(text) = lower(?)`, text).one().n) return json({ error: "Someone already suggested that. Upvote it instead!" }, 409);
      this.lastPost.set(who, now);
      const id = this.sql.exec(`INSERT INTO sugg (text, name, votes, created, who) VALUES (?, ?, 1, ?, ?) RETURNING id`, text, name, now, who).one().id;
      this.sql.exec(`INSERT OR IGNORE INTO sugg_votes (sid, who) VALUES (?, ?)`, id, who);
      return json({ ok: true, id });
    }
    if (url.pathname === "/vote") {
      const id = body.id | 0;
      if (!this.sql.exec(`SELECT COUNT(*) AS n FROM sugg WHERE id = ?`, id).one().n) return json({ error: "not-found" }, 404);
      const had = this.sql.exec(`SELECT COUNT(*) AS n FROM sugg_votes WHERE sid = ? AND who = ?`, id, who).one().n;
      if (had) { this.sql.exec(`DELETE FROM sugg_votes WHERE sid = ? AND who = ?`, id, who); this.sql.exec(`UPDATE sugg SET votes = votes - 1 WHERE id = ?`, id); }
      else { this.sql.exec(`INSERT INTO sugg_votes (sid, who) VALUES (?, ?)`, id, who); this.sql.exec(`UPDATE sugg SET votes = votes + 1 WHERE id = ?`, id); }
      return json({ ok: true, voted: !had, votes: this.sql.exec(`SELECT votes FROM sugg WHERE id = ?`, id).one().votes });
    }
    return json({ error: "not-found" }, 404);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/sugg" || url.pathname === "/suggest" || url.pathname === "/vote") return this.suggestions(url, request);
    if (url.pathname.startsWith("/admin/")) return this.admin(url, request);
    if (url.pathname === "/announce") { const a = this.kvGet("announce"); return json(a ? JSON.parse(a) : {}); }
    if (url.pathname === "/add" && request.method === "POST") {
      const { game, name, r } = await request.json();
      const col = { win: "w", loss: "l", draw: "d" }[r];
      if (!col || !game || !name || this.banned(name)) return json({ ok: false }, 400);
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

// ---------------------------------------------------------------------------
// Presence: every open OXIDPVP tab keeps one socket here, tagged with its friend code.
// A friend code is public (you share it); the key is a secret only that browser knows, so
// nobody else can pretend to be you. Friends lists live in each browser; this object only
// answers "which of these codes are online, and what are they playing?" and relays invites.
// ---------------------------------------------------------------------------
const FID_RE = /^[A-Z0-9]{6}$/, KEY_RE = /^[a-z0-9]{16,40}$/;

export class Presence extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "", key = url.searchParams.get("key") || "";
    const [client, server] = Object.values(new WebSocketPair());
    const done = () => new Response(null, { status: 101, webSocket: client });
    if (!FID_RE.test(id) || !KEY_RE.test(key)) {
      server.accept();
      server.close(4000, "bad-id");
      return done();
    }
    const saved = await this.ctx.storage.get("k:" + id);
    if (saved && saved !== key) {
      server.accept();
      server.close(4003, "bad-key");
      return done();
    }
    if (!saved) await this.ctx.storage.put("k:" + id, key);
    // Cap tabs per code so one browser can't pile up sockets.
    const mine = this.ctx.getWebSockets(id);
    if (mine.length >= 6) mine[0].close(4001, "too many tabs");
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id, name: "", game: null, lastInv: 0 });
    return done();
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 2000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const a = ws.deserializeAttachment();
    if (m.t === "hi") {
      a.name = cleanName(m.name);
      ws.serializeAttachment(a);
    } else if (m.t === "where") {
      a.game = typeof m.game === "string" && /^[a-z0-9]{1,16}$/.test(m.game) ? m.game : null;
      ws.serializeAttachment(a);
    } else if (m.t === "q" && Array.isArray(m.ids)) {
      const list = m.ids.slice(0, 60).filter((x) => FID_RE.test(x)).map((fid) => {
        const socks = this.ctx.getWebSockets(fid).map((s) => s.deserializeAttachment()).filter(Boolean);
        if (!socks.length) return { id: fid, on: false };
        const playing = socks.find((x) => x.game);
        return { id: fid, on: true, name: (playing || socks[0]).name, game: playing ? playing.game : null };
      });
      trySend(ws, JSON.stringify({ t: "on", list }));
    } else if (m.t === "inv" && FID_RE.test(m.to) && m.to !== a.id) {
      const now = Date.now();
      if (now - a.lastInv < 2000) return;
      a.lastInv = now;
      ws.serializeAttachment(a);
      if (typeof m.game !== "string" || !/^[a-z0-9]{1,16}$/.test(m.game) || !CODE_RE.test(m.code || "")) return;
      const out = JSON.stringify({ t: "inv", from: a.id, name: a.name || "A friend", game: m.game, code: m.code });
      let n = 0;
      for (const s of this.ctx.getWebSockets(m.to)) { trySend(s, out); n++; }
      trySend(ws, JSON.stringify({ t: "sent", to: m.to, ok: n > 0 }));
    }
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {}
  }
  webSocketError() {}
}
