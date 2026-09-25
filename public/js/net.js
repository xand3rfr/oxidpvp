// Shared multiplayer layer. Every player opens a WebSocket to a room on our Cloudflare Worker
// (worker.js, one Durable Object per room code). The room relays messages between the host
// and the guests; the host's browser runs the game.
//
// Lobby.mount({ game, title, subtitle, spectate = true, onStart(link) -> stopFn })   1v1 games
//   link = { isHost, spectator, myName, oppName, names: [hostName, guestName], rtt,
//            send(obj), onData(fn), onRejoin(fn) }
//   Extra people who join a 1v1 room watch as spectators: they see the guest's view and their
//   link.send does nothing.
// Room.mount({ game, title, subtitle, min, max, lobbyExtra(el), onStart(room) -> stopFn })   2–N
//   room = { isHost, myId, players:[{id,name,av}], send(msg) (guest→host),
//            sendTo(id,msg), broadcast(msg) (host→guests), onData(fn(fromId,msg)),
//            onLeave(fn(id)), onRejoin(fn(id)) }
//   Guests always see messages as coming from id 0 (the host).
// onRejoin fires on the host when a player reconnects (or reloads the page); games should
// resend whatever that player needs to redraw the current state.
(() => {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const CODE_LEN = 5;
  const KEEPALIVE_MS = 25000;
  const RECONNECT_MS = 25000;  // how long a dropped client keeps trying to get back in
  const GRACE_MS = 20000;      // how long the host holds a dropped player's seat
  const HELLO_MS = 8000;

  // Every game on the site. min/max = players; duel games seat two and let the rest watch.
  const GAMES = [
    { id: "lastcard", page: "lastcard", title: "Last Card", min: 2, max: 6 },
    { id: "trivia", page: "trivia", title: "Quiz Battle", min: 2, max: 8 },
    { id: "draw", page: "draw", title: "Draw & Guess", min: 2, max: 8 },
    { id: "dice", page: "dice", title: "Liar's Dice", min: 2, max: 6 },
    { id: "bomb", page: "wordbomb", title: "Word Bomb", min: 2, max: 8 },
    { id: "spy", page: "spyfall", title: "Spyfall", min: 3, max: 8 },
    { id: "codewords", page: "codewords", title: "Codewords", min: 4, max: 10 },
    { id: "typing", page: "typing", title: "Type Race", min: 2, max: 8 },
    { id: "rps", page: "rps", title: "RPS Tournament", min: 2, max: 8 },
    { id: "snake", page: "snake", title: "Snake Battle", min: 2, max: 4 },
    { id: "royale", page: "royale", title: "Snake Royale", min: 2, max: 8 },
    { id: "vote", page: "mostlikely", title: "Most Likely To", min: 3, max: 10 },
    { id: "bluff", page: "bluff", title: "Bluff", min: 3, max: 8 },
    { id: "hangman", page: "hangman", title: "Hangman", min: 2, max: 8 },
    { id: "bingo", page: "bingo", title: "Bingo", min: 2, max: 10 },
    { id: "wave", page: "wavelength", title: "Wavelength", min: 3, max: 10 },
    { id: "imposter", page: "imposter", title: "Imposter", min: 3, max: 10 },
    { id: "phone", page: "telephone", title: "Telephone", min: 3, max: 8 },
    { id: "poker", page: "poker", title: "Poker", min: 2, max: 8 },
    { id: "cup", page: "tournament", title: "Tournament", min: 3, max: 8 },
    { id: "casino", page: "casino", title: "Casino", min: 1, max: 8 },
    { id: "chess", page: "chess", title: "Chess", duel: true },
    { id: "connect", page: "connect4", title: "Connect 4", duel: true },
    { id: "battleship", page: "battleship", title: "Battleship", duel: true, noSpectate: true },
    { id: "tron", page: "tron", title: "Light Cycles", duel: true },
    { id: "arena", page: "arena", title: "Arena", duel: true },
    { id: "pong", page: "pong", title: "Pong", duel: true },
    { id: "checkers", page: "checkers", title: "Checkers", duel: true },
    { id: "uttt", page: "ultimate", title: "Ultimate Tic-Tac-Toe", duel: true },
    { id: "dots", page: "dots", title: "Dots & Boxes", duel: true },
    { id: "golf", page: "golf", title: "Mini Golf", duel: true },
    { id: "hockey", page: "hockey", title: "Air Hockey", duel: true },
    { id: "tanks", page: "tanks", title: "Tank Duel", duel: true },
    { id: "reaction", page: "reaction", title: "Reaction Duel", duel: true },
  ];
  const gameById = (id) => GAMES.find((g) => g.id === id);
  const pageFor = (id, hash) => { const g = gameById(id); return g ? `${g.page}.html${hash ? "#" + hash : ""}` : "index.html"; };
  const fits = (g, n) => (g.duel ? n >= 2 && (n === 2 || !g.noSpectate) : n >= g.min && n <= g.max);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const makeCode = () => Array.from({ length: CODE_LEN }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

  const REASONS = {
    "not-found": "No room with that code. Double-check it.",
    "full": "That room is full.",
    "exists": "Room code collision, try again.",
    "gone": "The room closed.",
    "network": "Couldn't reach the game server. Check your connection.",
  };
  const reasonText = (r) => REASONS[r] || REASONS.network;

  // ---------- Storage ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const sess = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { sessionStorage.removeItem(k); } catch {} },
  };
  const tokenFor = (code) => {
    let t = sess.get("oxid-tok-" + code);
    if (!t) { t = randomId(); sess.set("oxid-tok-" + code, t); }
    return t;
  };

  // ---------- Identity: name + avatar ----------
  const NAME_KEY = "oxidpvp-name", AV_KEY = "oxidpvp-avatar";
  const AVATARS = ["😎", "🤖", "👻", "🐸", "🦊", "🐱", "🐼", "🦄", "🐙", "👽", "🔥", "⚡", "🍕", "🎮", "💀", "🌵", "🐧", "🦈", "🍩", "👑"];
  const AV_COLORS = ["#8b5cf6", "#ec4899", "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6", "#64748b"];
  const cleanName = (n) => String(n || "").replace(/\s+/g, " ").trim().slice(0, 16) || "Player";
  const savedName = () => store.get(NAME_KEY) || "";
  const cleanAv = (a) => ({
    e: a && AVATARS.includes(a.e) ? a.e : AVATARS[0],
    c: a && a.c >= 0 && a.c < AV_COLORS.length ? a.c | 0 : 0,
  });
  function myAvatar() {
    try { const a = JSON.parse(store.get(AV_KEY)); if (a) return cleanAv(a); } catch {}
    const a = { e: AVATARS[Math.floor(Math.random() * AVATARS.length)], c: Math.floor(Math.random() * AV_COLORS.length) };
    store.set(AV_KEY, JSON.stringify(a));
    return a;
  }
  // <span class="avatar"> for a player; falls back to their initial if they have no avatar.
  function avatarEl(p, cls = "") {
    const el = document.createElement("span");
    el.className = "avatar " + cls;
    if (p && p.av) {
      const a = cleanAv(p.av);
      el.textContent = a.e;
      el.style.background = AV_COLORS[a.c];
      el.classList.add("emoji");
    } else el.textContent = ((p && p.name) || "?")[0].toUpperCase();
    return el;
  }

  // ---------- Invite links + arrival ----------
  // Links carry the room in the hash: game.html#CODE (invite), #join=CODE / #host=CODE (switch game).
  const inviteUrl = (code) => location.origin + location.pathname.replace(/\.html$/, "") + "#" + code;
  function arrival(game) {
    const h = location.hash.slice(1);
    let m;
    if ((m = h.match(/^([A-Za-z0-9]{5})$/))) return { kind: "invite", code: m[1].toUpperCase() };
    if ((m = h.match(/^join=([A-Z0-9]{5})$/))) return { kind: "join", code: m[1] };
    if ((m = h.match(/^host=([A-Z0-9]{5})$/))) return { kind: "host", code: m[1] };
    const s = sess.get("oxid-session");
    if (s && s.game === game && s.code) return { kind: "resume", code: s.code };
    return null;
  }
  const clearHash = () => { if (location.hash) history.replaceState(null, "", location.pathname + location.search); };
  async function shareInvite(code, title) {
    const url = inviteUrl(code);
    // Phones get the native share sheet (Messages, Discord, …); desktops get the clipboard.
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try { await navigator.share({ title: `${title} on OXIDPVP`, text: `Join my ${title} room`, url }); return "shared"; }
      catch (e) { if (e && e.name === "AbortError") return false; }
    }
    try { await navigator.clipboard.writeText(url); return "copied"; } catch { return false; }
  }
  // Home page: find which game a code belongs to and go there.
  async function joinByCode(code) {
    code = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== CODE_LEN) return { error: `Codes are ${CODE_LEN} characters.` };
    try {
      const r = await fetch(`/api/lookup/${code}`, { cache: "no-store" });
      if (r.status === 404) return { error: REASONS["not-found"] };
      const { game } = await r.json();
      if (!gameById(game)) return { error: REASONS["not-found"] };
      location.href = pageFor(game, code);
      return { ok: true };
    } catch { return { error: REASONS.network }; }
  }

  // ---------- Sockets ----------
  // Opens a socket and waits for the server's welcome. Rejects with a reason string.
  function openSocket(game, code, role, token, resume) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      let ws, settled = false;
      const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      const q = `role=${role}&token=${encodeURIComponent(token)}${resume ? "&resume=1" : ""}`;
      try { ws = new WebSocket(`${proto}//${location.host}/api/room/${game}/${code}?${q}`); }
      catch { return reject("network"); }
      const timer = setTimeout(() => { try { ws.close(); } catch {} finish(reject, "network"); }, 10000);
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.sys === "welcome") finish(resolve, { ws, welcome: m });
        else {
          if (m.reason === "wrong-game" && m.game && gameById(m.game)) { location.href = pageFor(m.game, code); return; }
          finish(reject, m.reason);
          try { ws.close(); } catch {}
        }
      };
      ws.onerror = ws.onclose = () => finish(reject, "network");
    });
  }

  // A room connection that quietly reconnects when the network blips.
  // h = { msg(m), drop(), back(welcome), dead(reason) }
  async function connect(game, code, role, h) {
    const token = tokenFor(code);
    const first = await openSocket(game, code, role, token, false);
    const conn = { id: first.welcome.id, welcome: first.welcome, closed: false };
    let ws = null, keep = 0;

    function attach(sock) {
      ws = sock;
      clearInterval(keep);
      keep = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, KEEPALIVE_MS);
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        h.msg(m);
      };
      ws.onerror = null;
      ws.onclose = () => { clearInterval(keep); if (!conn.closed) reconnect(); };
    }
    async function reconnect() {
      h.drop && h.drop();
      const until = Date.now() + RECONNECT_MS;
      while (!conn.closed && Date.now() < until) {
        await sleep(1200);
        if (conn.closed) return;
        try {
          const r = await openSocket(game, code, role, token, role === "host");
          if (conn.closed) { r.ws.close(); return; }
          attach(r.ws);
          conn.id = r.welcome.id;
          h.back && h.back(r.welcome);
          return;
        } catch (reason) {
          if (reason === "not-found" || reason === "gone" || reason === "exists") break;
        }
      }
      if (!conn.closed) { conn.closed = true; h.dead && h.dead(); }
    }
    conn.send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
    // bye = tell the room we left on purpose (vs. a dropped connection that may come back)
    conn.close = (bye = true) => {
      if (conn.closed) return;
      conn.closed = true;
      clearInterval(keep);
      if (ws) {
        if (bye && ws.readyState === 1) { try { ws.send(JSON.stringify({ bye: true })); } catch {} }
        ws.onclose = null;
        try { ws.close(); } catch {}
      }
    };
    attach(first.ws);
    return conn;
  }

  // ---------- Sounds ----------
  const MUTE_KEY = "oxidpvp-muted";
  const TONES = {
    click: [[700, 0.04, "square", 0.03]],
    pop: [[420, 0.07, "sine", 0.12]],
    turn: [[523, 0.09, "sine", 0.12], [784, 0.14, "sine", 0.12, 0.08]],
    good: [[660, 0.08, "triangle", 0.14], [990, 0.14, "triangle", 0.14, 0.07]],
    bad: [[220, 0.14, "sawtooth", 0.06], [160, 0.22, "sawtooth", 0.06, 0.1]],
    win: [[523, 0.1, "triangle", 0.14], [659, 0.1, "triangle", 0.14, 0.1], [784, 0.1, "triangle", 0.14, 0.2], [1047, 0.3, "triangle", 0.14, 0.3]],
    lose: [[392, 0.16, "triangle", 0.12], [330, 0.16, "triangle", 0.12, 0.16], [262, 0.34, "triangle", 0.12, 0.32]],
    tick: [[1200, 0.03, "square", 0.025]],
    msg: [[880, 0.05, "sine", 0.06], [1320, 0.07, "sine", 0.05, 0.05]],
    start: [[392, 0.08, "square", 0.05], [523, 0.08, "square", 0.05, 0.1], [784, 0.16, "square", 0.05, 0.2]],
    boom: "noise",
  };
  const VOL_KEY = "oxidpvp-volume";
  const sfx = (() => {
    let ac = null, out = null, muted = store.get(MUTE_KEY) === "1";
    let vol = store.get(VOL_KEY) == null ? 0.8 : Math.max(0, Math.min(1, +store.get(VOL_KEY) || 0));
    const ctx = () => {
      if (!ac) {
        const C = window.AudioContext || window.webkitAudioContext; if (!C) return null;
        ac = new C();
        out = ac.createGain(); out.gain.value = vol; out.connect(ac.destination);
      }
      if (ac.state === "suspended") ac.resume();
      return ac;
    };
    addEventListener("pointerdown", () => { try { ctx(); } catch {} }, { once: true });
    function play(name) {
      if (muted || !TONES[name]) return;
      try {
        const a = ctx();
        if (!a) return;
        const now = a.currentTime;
        if (TONES[name] === "noise") {
          const buf = a.createBuffer(1, a.sampleRate * 0.5, a.sampleRate), d = buf.getChannelData(0);
          for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.5);
          const src = a.createBufferSource(), g = a.createGain(), f = a.createBiquadFilter();
          f.type = "lowpass"; f.frequency.value = 900;
          src.buffer = buf; g.gain.value = 0.35;
          src.connect(f).connect(g).connect(out);
          src.start(now);
          return;
        }
        for (const [freq, dur, type, vol, delay = 0] of TONES[name]) {
          const o = a.createOscillator(), g = a.createGain(), t = now + delay;
          o.type = type; o.frequency.value = freq;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(vol, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(g).connect(out);
          o.start(t); o.stop(t + dur + 0.03);
        }
      } catch {}
    }
    return {
      play,
      get muted() { return muted; },
      toggle() { muted = !muted; store.set(MUTE_KEY, muted ? "1" : "0"); if (!muted) play("pop"); music.refresh(); return muted; },
      get volume() { return vol; },
      setVolume(v) { vol = Math.max(0, Math.min(1, v)); store.set(VOL_KEY, String(vol)); if (out) out.gain.value = vol; },
      audio: () => { try { return ctx(); } catch { return null; } },
    };
  })();

  // ---------- Background music ----------
  // A soft generated loop (no audio files): pad chords, a bass note and a gentle arpeggio.
  // Off by default; turned on in Settings. Respects the mute button.
  const MUSIC_KEY = "oxidpvp-music", MUSIC_VOL_KEY = "oxidpvp-music-vol";
  const music = (() => {
    let on = store.get(MUSIC_KEY) === "1";
    let vol = store.get(MUSIC_VOL_KEY) == null ? 0.5 : Math.max(0, Math.min(1, +store.get(MUSIC_VOL_KEY) || 0));
    let gain = null, timer = 0, next = 0, step = 0, started = false;
    const STEP = 0.3; // seconds per eighth note (100 bpm)
    const CHORDS = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]]; // Am7 Fmaj7 Cmaj7 G7
    const ARP = [0, 1, 2, 3, 2, 1, 2, 3];
    const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
    function note(a, freq, t, dur, type, v) {
      const o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + Math.min(0.08, dur / 3));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(gain);
      o.start(t); o.stop(t + dur + 0.05);
    }
    function schedule() {
      const a = sfx.audio();
      if (!a || !gain) return;
      if (next < a.currentTime) next = a.currentTime + 0.05;
      while (next < a.currentTime + 0.6) {
        const chord = CHORDS[Math.floor(step / 16) % CHORDS.length], s16 = step % 16;
        if (s16 === 0) {
          for (const m of chord) note(a, mtof(m), next, STEP * 16, "sine", 0.035);
          note(a, mtof(chord[0] - 24), next, STEP * 8, "triangle", 0.09);
        }
        if (s16 === 8) note(a, mtof(chord[0] - 24), next, STEP * 8, "triangle", 0.07);
        note(a, mtof(chord[ARP[step % 8]] + 12), next, STEP * 1.6, "triangle", step % 2 ? 0.025 : 0.04);
        next += STEP; step++;
      }
    }
    function start() {
      if (started || !on || sfx.muted || document.hidden) return;
      const a = sfx.audio();
      if (!a) return;
      if (!gain) { gain = a.createGain(); gain.connect(a.destination); }
      gain.gain.cancelScheduledValues(a.currentTime);
      gain.gain.setValueAtTime(0, a.currentTime);
      gain.gain.linearRampToValueAtTime(vol, a.currentTime + 1.5);
      next = a.currentTime + 0.1;
      started = true;
      timer = setInterval(schedule, 150);
      schedule();
    }
    function stop() {
      if (!started) return;
      started = false;
      clearInterval(timer);
      const a = sfx.audio();
      if (a && gain) { gain.gain.cancelScheduledValues(a.currentTime); gain.gain.setValueAtTime(gain.gain.value, a.currentTime); gain.gain.linearRampToValueAtTime(0, a.currentTime + 0.3); }
    }
    const refresh = () => (on && !sfx.muted && !document.hidden ? start() : stop());
    // Browsers only allow audio after a click or key press.
    const kick = () => { refresh(); };
    addEventListener("pointerdown", kick, { once: true });
    addEventListener("keydown", kick, { once: true });
    document.addEventListener("visibilitychange", refresh);
    return {
      get on() { return on; },
      get volume() { return vol; },
      set(v) { on = !!v; store.set(MUSIC_KEY, on ? "1" : "0"); refresh(); },
      setVolume(v) { vol = Math.max(0, Math.min(1, v)); store.set(MUSIC_VOL_KEY, String(vol)); const a = sfx.audio(); if (gain && a && started) gain.gain.setValueAtTime(vol, a.currentTime); },
      refresh,
    };
  })();

  // ---------- Local win stats ----------
  const STATS_KEY = "oxidpvp-stats";
  const readStats = () => { try { return JSON.parse(store.get(STATS_KEY)) || {}; } catch { return {}; } };
  // The room we're in, so results also go to the global leaderboard (via the room server).
  let reportTo = null;
  function record(game, result) {
    const s = readStats();
    const g = s[game] || (s[game] = { w: 0, l: 0, d: 0 });
    if (result === "win") g.w++; else if (result === "loss") g.l++; else g.d++;
    store.set(STATS_KEY, JSON.stringify(s));
    const meta = readMeta();
    meta.streak = result === "win" ? (meta.streak || 0) + 1 : result === "loss" ? 0 : meta.streak || 0;
    meta.best = Math.max(meta.best || 0, meta.streak);
    store.set(META_KEY, JSON.stringify(meta));
    checkAchievements();
    if (reportTo && !reportTo.conn.closed) reportTo.conn.send({ rec: { r: result, name: reportTo.name } });
    // Let other OXIDPVP tabs know (a tournament tab uses this to fill in the bracket).
    try { new BroadcastChannel("oxidpvp").postMessage({ t: "result", game, result, code: reportTo && reportTo.code }); } catch {}
  }

  // ---------- Achievements ----------
  const META_KEY = "oxidpvp-meta", ACH_KEY = "oxidpvp-ach";
  const readMeta = () => { try { return JSON.parse(store.get(META_KEY)) || {}; } catch { return {}; } };
  const readAch = () => { try { return JSON.parse(store.get(ACH_KEY)) || {}; } catch { return {}; } };
  const sum = (st) => {
    let w = 0, played = 0, games = 0, wonGames = 0;
    for (const g of Object.values(st)) { const n = g.w + g.l + g.d; w += g.w; played += n; if (n) games++; if (g.w) wonGames++; }
    return { w, played, games, wonGames };
  };
  const winsIn = (st, id) => (st[id] ? st[id].w : 0);
  const ACHIEVEMENTS = [
    { id: "first", icon: "🏆", name: "First blood", desc: "Win a game", test: (t) => t.w >= 1 },
    { id: "w10", icon: "🔥", name: "On fire", desc: "Win 10 games", test: (t) => t.w >= 10 },
    { id: "w50", icon: "👑", name: "Champion", desc: "Win 50 games", test: (t) => t.w >= 50 },
    { id: "p25", icon: "🎮", name: "Regular", desc: "Play 25 games", test: (t) => t.played >= 25 },
    { id: "p100", icon: "💯", name: "No life", desc: "Play 100 games", test: (t) => t.played >= 100 },
    { id: "explore", icon: "🧭", name: "Explorer", desc: "Play 10 different games", test: (t) => t.games >= 10 },
    { id: "allround", icon: "🌈", name: "All-rounder", desc: "Win at 5 different games", test: (t) => t.wonGames >= 5 },
    { id: "streak3", icon: "⚡", name: "Hat trick", desc: "Win 3 games in a row", test: (t, m) => (m.best || 0) >= 3 },
    { id: "streak5", icon: "🌪️", name: "Unstoppable", desc: "Win 5 games in a row", test: (t, m) => (m.best || 0) >= 5 },
    { id: "chess", icon: "♞", name: "Grandmaster", desc: "Win 5 games of Chess", test: (t, m, st) => winsIn(st, "chess") >= 5 },
    { id: "poker", icon: "🃏", name: "High roller", desc: "Win a game of Poker", test: (t, m, st) => winsIn(st, "poker") >= 1 },
    { id: "party", icon: "🎉", name: "Life of the party", desc: "Win 10 party games", test: (t, m, st) => GAMES.filter((g) => !g.duel).reduce((a, g) => a + winsIn(st, g.id), 0) >= 10 },
    { id: "blackjack", icon: "🂡", name: "Natural", desc: "Get a blackjack in the Casino", special: true },
    { id: "jackpot", icon: "🎰", name: "Jackpot", desc: "Hit 7-7-7 on the slots", special: true },
    { id: "whale", icon: "🐋", name: "Whale", desc: "Hold 100,000 casino coins", special: true },
    { id: "ace", icon: "⛳", name: "Hole in one", desc: "Sink a Mini Golf hole in one stroke", special: true },
    { id: "fast", icon: "⏱️", name: "Lightning", desc: "React in under 200 ms", special: true },
    { id: "daily", icon: "📅", name: "Wordsmith", desc: "Solve a Daily Word", special: true },
    { id: "daily7", icon: "🗓️", name: "Dedicated", desc: "Solve the Daily Word 7 days in a row", special: true },
    { id: "sam", icon: "🟣", name: "Samuel Hines was here", desc: "Find the Sam corner", special: true, secret: true },
    { id: "konami", icon: "🕹️", name: "Cheat code", desc: "Enter the secret code", special: true, secret: true },
  ];
  function unlock(id) {
    const got = readAch();
    if (got[id]) return false;
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (!a) return false;
    got[id] = Date.now();
    store.set(ACH_KEY, JSON.stringify(got));
    setTimeout(() => { toast(`${a.icon} Achievement unlocked: ${a.name}`, 3200); sfx.play("win"); }, 600);
    return true;
  }
  function checkAchievements() {
    const st = readStats(), t = sum(st), m = readMeta();
    for (const a of ACHIEVEMENTS) if (!a.special && a.test(t, m, st)) unlock(a.id);
  }
  const achievements = () => { const got = readAch(); return ACHIEVEMENTS.map((a) => ({ ...a, got: got[a.id] || 0 })); };

  // ---------- Secret: the Konami code ----------
  (() => {
    const CODE = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "KeyB", "KeyA"];
    let i = 0;
    addEventListener("keydown", (e) => {
      i = e.code === CODE[i] ? i + 1 : e.code === CODE[0] ? 1 : 0;
      if (i < CODE.length) return;
      i = 0;
      const on = document.documentElement.classList.toggle("party");
      toast(on ? "🕹️ Party mode ON" : "Party mode off");
      unlock("konami");
    });
  })();

  // ---------- Settings panel: profile, look, sound ----------
  const THEME_KEY = "oxidpvp-theme";
  const ACCENTS = { violet: "#8b5cf6", blue: "#3b82f6", teal: "#14b8a6", green: "#22c55e", orange: "#f97316", red: "#ef4444", pink: "#ec4899" };
  const readTheme = () => { try { return { mode: "dark", accent: "violet", ...(JSON.parse(store.get(THEME_KEY)) || {}) }; } catch { return { mode: "dark", accent: "violet" }; } };
  function applyTheme(t) {
    const d = document.documentElement;
    if (t.mode === "light") d.dataset.theme = "light"; else delete d.dataset.theme;
    if (t.accent && t.accent !== "violet") d.dataset.accent = t.accent; else delete d.dataset.accent;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t.mode === "light" ? "#f4f4f7" : "#07070a";
  }
  applyTheme(readTheme());
  const nameListeners = [];
  function openSettings() {
    document.querySelector(".settings-overlay")?.remove();
    const ov = document.createElement("div");
    ov.className = "overlay settings-overlay";
    ov.innerHTML = `
      <div class="panel settings" role="dialog" aria-label="Settings">
        <div class="set-top"><h2>Settings</h2><button class="chat-close" type="button" aria-label="Close">&times;</button></div>
        <section><h3>Profile</h3>
          <div class="set-profile"><span class="set-av"></span><input class="set-name" maxlength="16" placeholder="Your name" aria-label="Your name"></div>
          <div class="set-emojis"></div><div class="set-colors"></div>
          <p class="set-note">Used in every game. Changes apply the next time you join a room.</p>
        </section>
        <section><h3>Look</h3>
          <div class="seg set-mode"><button type="button" data-v="dark">Dark</button><button type="button" data-v="light">Light</button></div>
          <div class="set-accents"></div>
        </section>
        <section><h3>Sound</h3>
          <label class="set-row"><span>Sound effects</span><input type="range" class="set-vol" min="0" max="100"></label>
          <label class="set-row"><span>Background music</span><input type="checkbox" class="set-music"></label>
          <label class="set-row"><span>Music volume</span><input type="range" class="set-mvol" min="0" max="100"></label>
        </section>
      </div>`;
    document.body.append(ov);
    const q = (sel) => ov.querySelector(sel);
    const close = () => { ov.remove(); removeEventListener("keydown", esc, true); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    addEventListener("keydown", esc, true);
    q(".chat-close").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    // profile
    let av = myAvatar();
    const nameIn = q(".set-name");
    nameIn.value = savedName();
    const paintAv = () => {
      const el = q(".set-av"); el.replaceWith(Object.assign(avatarEl({ av, name: nameIn.value }, "lg set-av")));
      ov.querySelectorAll(".set-emojis button").forEach((b) => b.classList.toggle("on", b.textContent === av.e));
      ov.querySelectorAll(".set-colors button").forEach((b, i) => b.classList.toggle("on", i === av.c));
    };
    for (const e of AVATARS) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = e;
      b.addEventListener("click", () => { av = { ...av, e }; store.set(AV_KEY, JSON.stringify(av)); paintAv(); sfx.play("click"); });
      q(".set-emojis").append(b);
    }
    AV_COLORS.forEach((c, i) => {
      const b = document.createElement("button"); b.type = "button"; b.style.background = c; b.setAttribute("aria-label", "Avatar color " + (i + 1));
      b.addEventListener("click", () => { av = { ...av, c: i }; store.set(AV_KEY, JSON.stringify(av)); paintAv(); sfx.play("click"); });
      q(".set-colors").append(b);
    });
    nameIn.addEventListener("input", () => { if (nameIn.value.trim()) store.set(NAME_KEY, cleanName(nameIn.value)); for (const f of nameListeners) f(); });
    nameIn.addEventListener("keydown", (e) => e.stopPropagation());
    paintAv();
    // look
    const t = readTheme();
    const paintLook = () => {
      ov.querySelectorAll(".set-mode button").forEach((b) => b.classList.toggle("on", b.dataset.v === t.mode));
      ov.querySelectorAll(".set-accents button").forEach((b) => b.classList.toggle("on", b.dataset.v === t.accent));
    };
    ov.querySelectorAll(".set-mode button").forEach((b) => b.addEventListener("click", () => { t.mode = b.dataset.v; store.set(THEME_KEY, JSON.stringify(t)); applyTheme(t); paintLook(); }));
    for (const [k, c] of Object.entries(ACCENTS)) {
      const b = document.createElement("button"); b.type = "button"; b.dataset.v = k; b.style.background = c; b.setAttribute("aria-label", k + " accent");
      b.addEventListener("click", () => { t.accent = k; store.set(THEME_KEY, JSON.stringify(t)); applyTheme(t); paintLook(); sfx.play("click"); });
      q(".set-accents").append(b);
    }
    paintLook();
    // sound
    const vol = q(".set-vol"), mOn = q(".set-music"), mVol = q(".set-mvol");
    vol.value = Math.round(sfx.volume * 100);
    mOn.checked = music.on;
    mVol.value = Math.round(music.volume * 100);
    vol.addEventListener("input", () => sfx.setVolume(vol.value / 100));
    vol.addEventListener("change", () => sfx.play("pop"));
    mOn.addEventListener("change", () => { music.set(mOn.checked); if (mOn.checked && sfx.muted) toast("Sound is muted. Unmute to hear the music."); });
    mVol.addEventListener("input", () => music.setVolume(mVol.value / 100));
  }

  // ---------- Friends + presence ----------
  // Each browser gets a public friend code and a secret key. Friends are saved locally; the
  // Presence server only says which codes are online, what they're playing, and relays invites.
  const FID_KEY = "oxidpvp-fid", FRIENDS_KEY = "oxidpvp-friends";
  const identity = (() => {
    let v = null;
    try { v = JSON.parse(store.get(FID_KEY)); } catch {}
    if (!v || !/^[A-Z0-9]{6}$/.test(v.id) || !/^[a-z0-9]{16,40}$/.test(v.key)) {
      const rnd = (chars, n) => { const a = new Uint32Array(n); crypto.getRandomValues(a); return [...a].map((x) => chars[x % chars.length]).join(""); };
      v = { id: rnd(ALPHABET, 6), key: rnd("abcdefghijklmnopqrstuvwxyz0123456789", 24) };
      store.set(FID_KEY, JSON.stringify(v));
    }
    return v;
  })();
  const readFriends = () => { try { return (JSON.parse(store.get(FRIENDS_KEY)) || []).filter((f) => f && /^[A-Z0-9]{6}$/.test(f.id)); } catch { return []; } };
  const saveFriends = (l) => store.set(FRIENDS_KEY, JSON.stringify(l.slice(0, 50)));
  const presence = (() => {
    let ws = null, retry = 1000, pingT = 0, status = new Map(), listeners = new Set(), sentCb = null;
    function connect() {
      if (!("WebSocket" in window)) return;
      try { ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/presence?id=${identity.id}&key=${identity.key}`); } catch { return; }
      ws.onopen = () => { retry = 1000; hello(); where(); query(); clearInterval(pingT); pingT = setInterval(() => { try { ws.send("ping"); } catch {} }, 25000); };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === "on") {
          const fr = readFriends();
          for (const x of m.list) {
            status.set(x.id, x);
            const f = fr.find((y) => y.id === x.id);
            if (f && x.name && f.name !== x.name) f.name = x.name;
          }
          saveFriends(fr);
          for (const f of listeners) f();
        } else if (m.t === "inv") showInvite(m);
        else if (m.t === "sent" && sentCb) sentCb(m);
      };
      ws.onclose = (e) => {
        clearInterval(pingT); ws = null;
        if (e.code === 4003 || e.code === 4000) return; // bad key: don't hammer the server
        setTimeout(connect, retry); retry = Math.min(30000, retry * 2);
      };
    }
    const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
    const hello = () => send({ t: "hi", name: savedName() || "Player" });
    function where() { send({ t: "where", game: reportTo && !reportTo.conn.closed ? reportTo.game : null }); }
    function query() { const ids = readFriends().map((f) => f.id); if (ids.length) send({ t: "q", ids }); }
    setTimeout(connect, 400);
    return {
      where, query, hello, status,
      invite(to, cb) { if (!reportTo) return false; sentCb = cb; send({ t: "inv", to, game: reportTo.game, code: reportTo.code }); return true; },
      onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    };
  })();
  nameListeners.push(() => presence.hello());

  function showInvite(m) {
    const g = GAMES.find((x) => x.id === m.game);
    if (!g) return;
    document.querySelector(".invite-card")?.remove();
    const el = document.createElement("div");
    el.className = "invite-card";
    el.innerHTML = `<b></b><span></span><div class="row"><button class="btn ghost" type="button">Not now</button><a class="btn primary">Join</a></div>`;
    el.querySelector("b").textContent = `${m.name} invited you`;
    el.querySelector("span").textContent = `to play ${g.title}`;
    el.querySelector("a").href = `${g.page}.html#${m.code}`;
    el.querySelector("button").addEventListener("click", () => el.remove());
    document.body.append(el);
    sfx.play("turn");
    setTimeout(() => el.remove(), 30000);
  }

  function openFriends() {
    document.querySelector(".settings-overlay")?.remove();
    const ov = document.createElement("div");
    ov.className = "overlay settings-overlay";
    ov.innerHTML = `
      <div class="panel settings friends" role="dialog" aria-label="Friends">
        <div class="set-top"><h2>Friends</h2><button class="chat-close" type="button" aria-label="Close">&times;</button></div>
        <section><h3>Your friend code</h3>
          <div class="fr-me"><code class="fr-code"></code><button class="btn" type="button" data-copy>Copy</button></div>
          <p class="set-note">Give this code to friends so they can add you. Anyone with it can see when you're online and what you're playing.</p>
        </section>
        <section><h3>Add a friend</h3>
          <form class="fr-add"><input class="set-name" maxlength="6" placeholder="Their code" aria-label="Friend code" autocomplete="off"><button class="btn primary" type="submit">Add</button></form>
        </section>
        <section><h3 class="fr-head">Friends</h3><div class="fr-list"></div></section>
      </div>`;
    document.body.append(ov);
    const q = (sel) => ov.querySelector(sel);
    let off = () => {}, poll = 0;
    const close = () => { off(); clearInterval(poll); ov.remove(); removeEventListener("keydown", esc, true); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    addEventListener("keydown", esc, true);
    q(".chat-close").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    q(".fr-code").textContent = identity.id;
    q("[data-copy]").addEventListener("click", async () => { try { await navigator.clipboard.writeText(identity.id); toast("Friend code copied"); } catch { toast("Your code: " + identity.id); } });
    const input = q(".fr-add input");
    input.addEventListener("input", () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    input.addEventListener("keydown", (e) => e.stopPropagation());
    q(".fr-add").addEventListener("submit", (e) => {
      e.preventDefault();
      const id = input.value.trim();
      if (!/^[A-Z0-9]{6}$/.test(id)) return toast("Friend codes are 6 letters and numbers");
      if (id === identity.id) return toast("That's your own code!");
      const fr = readFriends();
      if (fr.some((f) => f.id === id)) return toast("Already on your list");
      fr.unshift({ id, name: "" });
      saveFriends(fr);
      input.value = "";
      presence.query();
      render();
      sfx.play("good");
    });
    function render() {
      const list = q(".fr-list"), fr = readFriends();
      list.textContent = "";
      const online = fr.filter((f) => (presence.status.get(f.id) || {}).on).length;
      q(".fr-head").textContent = fr.length ? `Friends · ${online} online` : "Friends";
      if (!fr.length) { list.innerHTML = `<p class="set-note">No friends yet. Add someone's code above.</p>`; return; }
      const inRoom = reportTo && !reportTo.conn.closed;
      fr.sort((a, b) => ((presence.status.get(b.id) || {}).on ? 1 : 0) - ((presence.status.get(a.id) || {}).on ? 1 : 0));
      for (const f of fr) {
        const st = presence.status.get(f.id) || {};
        const g = st.game && GAMES.find((x) => x.id === st.game);
        const row = document.createElement("div");
        row.className = "fr-row" + (st.on ? " on" : "");
        row.innerHTML = `<i class="fr-dot"></i><div class="fr-who"><b></b><small></small></div>`;
        row.querySelector("b").textContent = f.name || f.id;
        row.querySelector("small").textContent = st.on ? (g ? `Playing ${g.title}` : "Online") : `Offline · ${f.id}`;
        if (inRoom && st.on) {
          const inv = document.createElement("button");
          inv.className = "btn primary sm"; inv.type = "button"; inv.textContent = "Invite";
          inv.addEventListener("click", () => {
            inv.disabled = true;
            presence.invite(f.id, (m) => { inv.textContent = m.ok ? "Sent!" : "Offline"; });
          });
          row.append(inv);
        }
        const rm = document.createElement("button");
        rm.className = "chat-close"; rm.type = "button"; rm.title = "Remove"; rm.innerHTML = "&times;";
        rm.addEventListener("click", () => { saveFriends(readFriends().filter((x) => x.id !== f.id)); render(); });
        row.append(rm);
        list.append(row);
      }
    }
    off = presence.onChange(render);
    presence.query();
    poll = setInterval(() => presence.query(), 10000);
    render();
  }

  // ---------- Public room listing (host only) ----------
  const PUB_KEY = "oxidpvp-public";
  function lister(conn, info) {
    let on = store.get(PUB_KEY) === "1", timer = 0;
    const push = () => { const c = conn(); if (c) c.send({ pub: on ? { on: true, ...info() } : { on: false } }); };
    const restart = () => { clearInterval(timer); if (on) timer = setInterval(push, 20000); };
    return {
      get on() { return on; },
      set(v) { on = !!v; store.set(PUB_KEY, on ? "1" : "0"); push(); restart(); },
      start() { restart(); if (on) push(); },
      update() { if (on) push(); },
      stop() { clearInterval(timer); },
    };
  }

  // ---------- Toasts + connection banner ----------
  function toast(msg, ms = 2200) {
    for (const old of document.querySelectorAll(".toast")) old.remove();
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
  let bannerEl = null;
  function banner(text) {
    if (!text) { if (bannerEl) bannerEl.hidden = true; return; }
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.className = "conn-banner";
      bannerEl.setAttribute("role", "status");
      document.body.appendChild(bannerEl);
    }
    bannerEl.textContent = text;
    bannerEl.hidden = false;
  }

  // ---------- Dock: mute, reactions, switch game, chat ----------
  const CHAT_MAX = 200, CHAT_GAP_MS = 600;
  const QUICK = ["gg", "nice!", "lol", "one more?", "brb"];
  const REACTIONS = ["😂", "🔥", "💀", "👏", "😭", "😡", "🤯", "👀"];
  const cleanText = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, CHAT_MAX);
  const ICON = {
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
    on: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    friends: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.8.7 3 2.4 3.5 5.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h13l-3-3M20 16H7l3 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  const dock = (() => {
    let el = null, sendFn = null, reactFn = null, switchCtx = null, unread = 0, lastSent = 0, peekTimer = 0;
    const $ = (s) => el.querySelector(s);

    function build() {
      el = document.createElement("div");
      el.className = "dock";
      el.innerHTML = `
        <div class="chat-peek" hidden></div>
        <div class="dock-pop react-pop" hidden></div>
        <div class="dock-pop switch-pop" role="dialog" aria-label="Switch game" hidden>
          <div class="chat-head"><span>Switch everyone to…</span><button class="chat-close" type="button" aria-label="Close">&times;</button></div>
          <div class="switch-list"></div>
        </div>
        <div class="chat-panel" role="dialog" aria-label="Chat" hidden>
          <div class="chat-head"><span>Chat</span><button class="chat-close" type="button" aria-label="Close chat">&times;</button></div>
          <ol class="chat-log" aria-live="polite"></ol>
          <div class="chat-quick"></div>
          <form class="chat-form">
            <input maxlength="${CHAT_MAX}" placeholder="Say something…" autocomplete="off" aria-label="Chat message">
            <button class="btn" type="submit">Send</button>
          </form>
        </div>
        <div class="dock-row">
          <button class="dock-btn friends-btn" type="button" title="Friends" aria-label="Friends">${ICON.friends}</button>
          <button class="dock-btn gear" type="button" title="Settings" aria-label="Settings">${ICON.gear}</button>
          <button class="dock-btn mute" type="button"></button>
          <button class="dock-btn react-btn" type="button" title="React" aria-label="React" hidden>😀</button>
          <button class="dock-btn switch-btn" type="button" title="Switch game" hidden>${ICON.swap}<span>Switch game</span></button>
          <button class="chat-toggle" type="button" aria-expanded="false" title="Chat (Enter)" hidden>${ICON.chat}<span>Chat</span><b class="chat-badge" hidden></b></button>
        </div>`;
      for (const q of QUICK) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = q;
        b.addEventListener("click", () => submit(q));
        $(".chat-quick").append(b);
      }
      for (const e of REACTIONS) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = e; b.setAttribute("aria-label", "React " + e);
        b.addEventListener("click", () => { if (reactFn) reactFn(e); pop(null); });
        $(".react-pop").append(b);
      }
      const muteBtn = $(".mute");
      const paintMute = () => { muteBtn.innerHTML = sfx.muted ? ICON.off : ICON.on; muteBtn.title = sfx.muted ? "Sound off" : "Sound on"; muteBtn.setAttribute("aria-label", muteBtn.title); };
      paintMute();
      muteBtn.addEventListener("click", () => { sfx.toggle(); paintMute(); });
      $(".gear").addEventListener("click", () => openSettings());
      $(".friends-btn").addEventListener("click", () => openFriends());
      $(".chat-toggle").addEventListener("click", () => toggle());
      $(".chat-panel .chat-close").addEventListener("click", () => toggle(false));
      $(".switch-pop .chat-close").addEventListener("click", () => pop(null));
      $(".react-btn").addEventListener("click", () => pop($(".react-pop").hidden ? "react" : null));
      $(".switch-btn").addEventListener("click", () => { if ($(".switch-pop").hidden) { renderSwitch(); pop("switch"); } else pop(null); });
      $(".chat-peek").addEventListener("click", () => toggle(true));
      $(".chat-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const input = $(".chat-form input");
        if (submit(input.value)) input.value = "";
      });
      $(".chat-form input").addEventListener("keydown", (e) => {
        if (e.key === "Escape") { toggle(false); e.target.blur(); }
        e.stopPropagation(); // typing never drives the game
      });
      // Enter opens chat from anywhere that isn't already a text field or button.
      addEventListener("keydown", (e) => {
        if (!sendFn || e.key !== "Enter" || e.repeat) return;
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || t.tagName === "A" || t.isContentEditable)) return;
        e.preventDefault();
        toggle(true);
      });
      document.body.appendChild(el);
    }
    const ensure = () => { if (!el) build(); };

    function pop(which) {
      $(".react-pop").hidden = which !== "react";
      $(".switch-pop").hidden = which !== "switch";
      if (which) toggle(false);
    }
    function isOpen() { return el && !$(".chat-panel").hidden; }
    function toggle(force) {
      const open = force ?? !isOpen();
      $(".chat-panel").hidden = !open;
      $(".chat-toggle").setAttribute("aria-expanded", open);
      if (open) {
        $(".react-pop").hidden = $(".switch-pop").hidden = true;
        unread = 0; badge();
        $(".chat-peek").hidden = true;
        const log = $(".chat-log");
        log.scrollTop = log.scrollHeight;
        $(".chat-form input").focus();
      } else if (document.activeElement && el.contains(document.activeElement)) document.activeElement.blur();
    }
    function badge() {
      const b = $(".chat-badge");
      b.hidden = !unread;
      b.textContent = unread > 9 ? "9+" : unread;
    }
    function submit(text) {
      text = cleanText(text);
      if (!text || !sendFn) return false;
      const now = Date.now();
      if (now - lastSent < CHAT_GAP_MS) return false;
      lastSent = now;
      sendFn(text);
      return true;
    }
    function renderSwitch() {
      const list = $(".switch-list");
      list.textContent = "";
      if (!switchCtx) return;
      const n = switchCtx.count();
      for (const g of GAMES) {
        if (g.id === switchCtx.game) continue;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "switch-item";
        const ok = fits(g, n);
        b.disabled = !ok;
        const t = document.createElement("b"); t.textContent = g.title;
        const s = document.createElement("span");
        s.textContent = g.duel ? (n > 2 ? (g.noSpectate ? "2 players only" : `1v1 + ${n - 2} watching`) : "1v1") : `${g.min}–${g.max} players`;
        b.append(t, s);
        b.addEventListener("click", () => { pop(null); switchCtx.go(g); });
        list.append(b);
      }
    }

    return {
      // Always-available bits (mute) show as soon as a game page mounts a lobby.
      init() { ensure(); },
      enter({ send, react }) {
        ensure();
        sendFn = send; reactFn = react;
        $(".chat-toggle").hidden = false;
        $(".react-btn").hidden = false;
      },
      setSwitch(ctx) { ensure(); switchCtx = ctx; $(".switch-btn").hidden = !ctx; if (!ctx) $(".switch-pop").hidden = true; },
      add(m) {
        if (!el || !sendFn) return;
        const text = cleanText(m.text);
        if (!text) return;
        const li = document.createElement("li");
        if (m.sys) { li.className = "sys"; li.textContent = text; }
        else {
          if (m.me) li.className = "me";
          if (m.av) li.append(avatarEl(m, "xs"));
          const who = document.createElement("b");
          who.textContent = m.me ? "You" : cleanName(m.name);
          const body = document.createElement("span");
          body.textContent = text;
          li.append(who, body);
        }
        const log = $(".chat-log");
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        log.append(li);
        while (log.children.length > 150) log.firstChild.remove();
        if (atBottom || m.me) log.scrollTop = log.scrollHeight;
        if (!isOpen() && !m.me) {
          if (!m.sys) { unread++; badge(); sfx.play("msg"); }
          const peek = $(".chat-peek");
          peek.textContent = m.sys ? text : `${cleanName(m.name)}: ${text}`;
          peek.hidden = false;
          clearTimeout(peekTimer);
          peekTimer = setTimeout(() => { peek.hidden = true; }, 3500);
        }
      },
      leave() {
        if (!el) return;
        sendFn = reactFn = switchCtx = null; unread = 0; badge();
        for (const s of [".chat-toggle", ".react-btn", ".switch-btn", ".chat-panel", ".chat-peek", ".react-pop", ".switch-pop"]) $(s).hidden = true;
        $(".chat-log").textContent = "";
      },
    };
  })();

  function floatReaction(m) {
    const el = document.createElement("div");
    el.className = "react-float";
    el.style.left = 20 + Math.random() * 60 + "%";
    const e = document.createElement("span"); e.textContent = m.e;
    const n = document.createElement("small"); n.textContent = m.me ? "You" : cleanName(m.name);
    el.append(e, n);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // Chat + reactions for a room. Guests send to the host; the host stamps names and relays.
  function social({ isHost, myId, people, toGuests, toHost }) {
    const seen = new Map();
    function show(m) {
      if (m.__sys === "chat") dock.add({ ...m, me: !m.sys && m.id === myId() });
      else if (m.__sys === "react") { floatReaction({ ...m, me: m.id === myId() }); if (m.id !== myId()) sfx.play("pop"); }
    }
    function relay(m) {
      if (m.__sys === "chat" && !m.text) return;
      if (!m.sys) {
        const now = Date.now();
        if (now - (seen.get(m.id) || 0) < 350) return;
        seen.set(m.id, now);
      }
      toGuests(m);
      show(m);
    }
    const person = (id) => people().find((p) => p.id === id);
    return {
      show,
      fromGuest(id, d) {
        const p = person(id);
        if (!p) return false;
        if (d.__sys === "chat") { relay({ __sys: "chat", id, name: p.name, av: p.av, text: cleanText(d.text) }); return true; }
        if (d.__sys === "react" && REACTIONS.includes(d.e)) { relay({ __sys: "react", id, name: p.name, e: d.e }); return true; }
        return false;
      },
      say(text) {
        if (isHost()) { const p = person(myId()); relay({ __sys: "chat", id: myId(), name: p ? p.name : "", av: p && p.av, text: cleanText(text) }); }
        else toHost({ __sys: "chat", text });
      },
      react(e) {
        if (isHost()) { const p = person(myId()); relay({ __sys: "react", id: myId(), name: p ? p.name : "", e }); }
        else toHost({ __sys: "react", e });
      },
      system(text) { if (isHost()) relay({ __sys: "chat", sys: true, text }); },
    };
  }

  // ---------- Lobby panel (shared markup for both kinds of room) ----------
  function shell({ game, title, subtitle, onHost, onJoin, onStart, onLeave }) {
    const root = document.createElement("div");
    root.className = "overlay lobby";
    root.innerHTML = `
      <div class="panel">
        <a class="back" href="index.html">&larr; All games</a>
        <h1></h1>
        <p class="sub"></p>
        <div data-view="menu">
          <div class="invited" hidden><span class="invited-dot"></span><span>You're invited to room <b></b></span></div>
          <div class="field"><span>You</span>
            <div class="profile">
              <button class="av-btn" type="button" title="Change avatar" aria-label="Change avatar"></button>
              <input class="name" maxlength="16" autocomplete="nickname" spellcheck="false" aria-label="Your name">
            </div>
          </div>
          <div class="av-picker" hidden>
            <div class="av-grid"></div>
            <div class="av-colors"></div>
          </div>
          <button class="btn primary full" data-act="host">Create room</button>
          <div class="or">or join</div>
          <form class="join">
            <input class="code-in" maxlength="${CODE_LEN}" placeholder="CODE" autocomplete="off" spellcheck="false" aria-label="Room code">
            <button class="btn" type="submit">Join</button>
          </form>
        </div>
        <div class="wait" data-view="room" hidden>
          <div class="label">Room code</div>
          <button class="code" title="Click to copy the code"></button>
          <button class="btn primary full" data-act="invite" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
            Copy invite link
          </button>
          <label class="pub-toggle" hidden><input type="checkbox"><span>List in <a href="rooms.html" target="_blank">public rooms</a> so anyone can join</span></label>
          <div class="plist-head"><span>Players</span><span class="pcount"></span></div>
          <ul class="plist"></ul>
          <div class="lobby-extra"></div>
          <button class="btn primary full" data-act="start" hidden>Start game</button>
          <p class="muted wait-msg" hidden></p>
          <button class="btn ghost full" data-act="leave">Leave room</button>
        </div>
        <p class="status" aria-live="polite"></p>
      </div>`;
    root.querySelector("h1").textContent = title;
    root.querySelector(".sub").textContent = subtitle;
    document.body.appendChild(root);
    const $ = (s) => root.querySelector(s);

    // profile
    const nameIn = $(".name"), avBtn = $(".av-btn");
    nameIn.value = savedName() || "Player" + Math.floor(100 + Math.random() * 900);
    let av = myAvatar();
    const paintAv = () => { avBtn.textContent = av.e; avBtn.style.background = AV_COLORS[av.c]; };
    paintAv();
    for (const e of AVATARS) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = e;
      b.addEventListener("click", () => { av = { ...av, e }; store.set(AV_KEY, JSON.stringify(av)); paintAv(); paintPicker(); });
      $(".av-grid").append(b);
    }
    AV_COLORS.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.style.background = c; b.setAttribute("aria-label", "Color " + (i + 1));
      b.addEventListener("click", () => { av = { ...av, c: i }; store.set(AV_KEY, JSON.stringify(av)); paintAv(); paintPicker(); });
      $(".av-colors").append(b);
    });
    const paintPicker = () => {
      [...$(".av-grid").children].forEach((b) => b.classList.toggle("on", b.textContent === av.e));
      [...$(".av-colors").children].forEach((b, i) => b.classList.toggle("on", i === av.c));
    };
    paintPicker();
    avBtn.addEventListener("click", () => { $(".av-picker").hidden = !$(".av-picker").hidden; });
    const profile = () => {
      const n = cleanName(nameIn.value);
      store.set(NAME_KEY, n);
      return { name: n, av };
    };

    const status = $(".status");
    const setStatus = (msg, cls = "") => { status.textContent = msg; status.className = "status " + cls; };
    const codeIn = $(".code-in"), codeBtn = $(".code");
    codeIn.addEventListener("input", () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    codeBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(codeBtn.textContent); setStatus("Code copied.", "ok"); } catch {}
    });
    $('[data-act="invite"]').addEventListener("click", async () => {
      const r = await shareInvite(codeBtn.textContent, title);
      if (r === "copied") setStatus("Invite link copied. Paste it to your friends.", "ok");
      else if (r === "shared") setStatus("Invite sent.", "ok");
      else if (r === false) setStatus("Couldn't copy. Share the code instead.", "error");
    });
    $('[data-act="host"]').addEventListener("click", () => { clearHash(); onHost(); });
    $(".join").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = codeIn.value.trim().toUpperCase();
      if (code.length !== CODE_LEN) return setStatus(`Codes are ${CODE_LEN} characters.`, "error");
      onJoin(code, {});
    });
    $('[data-act="start"]').addEventListener("click", () => onStart && onStart());
    $('[data-act="leave"]').addEventListener("click", () => onLeave());

    const api = {
      root, $, setStatus, profile,
      showMenu() { $('[data-view="menu"]').hidden = false; $('[data-view="room"]').hidden = true; root.hidden = false; },
      showRoom(code, { isHost, party }) {
        $('[data-view="menu"]').hidden = true; $('[data-view="room"]').hidden = false; root.hidden = false;
        codeBtn.textContent = code;
        $('[data-act="start"]').hidden = !(isHost && party);
        const wait = $(".wait-msg");
        wait.hidden = party && isHost;
        wait.textContent = party ? "Waiting for the host to start…" : "Waiting for an opponent. Anyone else who joins can watch.";
        $(".lobby-extra").hidden = !isHost;
      },
      people(list, { max, min, isHost, party, labels = {} }) {
        const ul = $(".plist");
        ul.textContent = "";
        for (const p of list) {
          const li = document.createElement("li");
          li.append(avatarEl(p));
          const nm = document.createElement("span");
          nm.className = "pname"; nm.textContent = p.name;
          li.append(nm);
          for (const tag of [p.id === 0 && "Host", labels[p.id], p.me && "You"]) {
            if (!tag) continue;
            const t = document.createElement("span");
            t.className = "ptag" + (tag === "You" ? " you" : "");
            t.textContent = tag;
            li.append(t);
          }
          ul.append(li);
        }
        $(".pcount").textContent = party ? `${list.length} / ${max}` : "";
        const sb = $('[data-act="start"]');
        if (party && isHost) {
          sb.disabled = list.length < min;
          sb.textContent = list.length < min ? `Need ${min - list.length} more player${min - list.length > 1 ? "s" : ""}` : `Start game (${list.length} player${list.length === 1 ? "" : "s"})`;
        }
      },
      hide() { root.hidden = true; },
      extra: () => $(".lobby-extra"),
      pubToggle(show, checked, onChange) {
        const t = $(".pub-toggle"), box = t.querySelector("input");
        t.hidden = !show;
        box.checked = !!checked;
        box.onchange = onChange ? () => onChange(box.checked) : null;
      },
    };

    // Arrivals: invite links, switch-game hops, and reloads that should rejoin.
    const a = arrival(game);
    clearHash();
    if (a) {
      if (a.kind === "host") setTimeout(() => onHost(a.code), 0);
      else if (a.kind === "join") setTimeout(() => onJoin(a.code, { retry: true }), 0);
      else if (a.kind === "resume") setTimeout(() => onJoin(a.code, { resume: true }), 0);
      else {
        const box = $(".invited");
        box.hidden = false;
        box.querySelector("b").textContent = a.code;
        codeIn.value = a.code;
        const joinBtn = $(".join button");
        joinBtn.classList.add("primary");
        joinBtn.textContent = "Join room";
        $('[data-act="host"]').classList.remove("primary");
        // Returning players already picked a name, so drop them straight in.
        if (savedName()) setTimeout(() => onJoin(a.code, {}), 0);
        else {
          setStatus("Pick a name, then hit Join room.");
          setTimeout(() => { nameIn.focus(); nameIn.select(); }, 50);
        }
      }
    }
    dock.init();
    return api;
  }

  // Joining can race the host on a switch-game hop, so optionally retry "not found" for a bit.
  async function connectGuest(game, code, h, retry) {
    const until = Date.now() + (retry ? 15000 : 0);
    for (;;) {
      try { return await connect(game, code, "join", h); }
      catch (reason) {
        if (reason === "not-found" && Date.now() < until) { await sleep(900); continue; }
        throw reason;
      }
    }
  }

  // Leaving via a link counts as leaving on purpose; a reload does not (so it can rejoin).
  function onPurposefulExit(fn) {
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a[href]");
      if (a && !a.target && !a.getAttribute("href").startsWith("#")) fn();
    }, true);
  }

  // =====================================================================
  // 1v1 lobby
  // =====================================================================
  function mount({ game, title, subtitle, onStart, spectate = true }) {
    const netEl = document.getElementById("net");
    let conn = null, isHost = false, gen = 0, code = null, started = false;
    let me = null, hostP = null, opp = null, specs = new Map(), spectator = false;
    let link = null, stopGame = null, handlers = [], rejoinHandlers = [];
    let pingTimer = 0, graceTimer = 0, moving = false;
    const helloTimers = new Map();
    const peopleList = () => [hostP, opp, ...specs.values()].filter(Boolean);
    const pub = lister(() => (isHost ? conn : null), () => ({ host: hostP ? hostP.name : "", players: opp ? 2 : 1, max: 2, started, watch: spectate }));

    const ui = shell({
      game, title, subtitle,
      onHost: (fixed) => hostRoom(fixed),
      onJoin: (c, o) => joinRoom(c, o),
      onLeave: () => { teardown(true); ui.showMenu(); ui.setStatus(""); },
    });

    const talk = social({
      isHost: () => isHost,
      myId: () => (isHost ? 0 : conn ? conn.id : -1),
      people: peopleList,
      toGuests: (m) => conn && conn.send({ to: "all", d: m }),
      toHost: (m) => conn && conn.send({ d: m }),
    });

    function renderPeople() {
      const myId = isHost ? 0 : conn ? conn.id : -1;
      const labels = {};
      if (opp) labels[opp.id] = "Player";
      for (const id of specs.keys()) labels[id] = "Watching";
      ui.people(peopleList().map((p) => ({ ...p, me: p.id === myId })), { labels });
    }
    function broadcastPeople() {
      if (isHost && conn) conn.send({ to: "all", d: { __sys: "people", host: hostP, opp, specs: [...specs.values()] } });
      renderPeople();
      pub.update();
    }

    function teardown(bye) {
      gen++; // invalidates any connection attempt still in flight
      clearInterval(pingTimer); clearTimeout(graceTimer);
      for (const t of helloTimers.values()) clearTimeout(t);
      helloTimers.clear();
      if (stopGame) { try { stopGame(); } catch {} stopGame = null; }
      pub.stop(); ui.pubToggle(false);
      if (reportTo && reportTo.conn === conn) { reportTo = null; presence.where(); }
      if (conn) { conn.close(bye); conn = null; }
      if (bye) sess.del("oxid-session");
      opp = hostP = null; specs = new Map(); started = false; spectator = false;
      handlers = []; rejoinHandlers = []; link = null;
      dock.leave(); banner(null);
      document.body.classList.remove("spectating");
      if (netEl) { netEl.className = "net"; netEl.lastChild.textContent = "offline"; }
    }
    function fail(msg) {
      teardown(true);
      ui.showMenu();
      ui.setStatus(msg, "error");
      sfx.play("bad");
    }

    function enterDock() {
      dock.enter({ send: (t) => talk.say(t), react: (e) => talk.react(e) });
      dock.setSwitch(isHost ? { game, count: () => peopleList().length, go: moveTo } : null);
    }
    function moveTo(g) {
      const next = makeCode();
      moving = true;
      conn.send({ to: "all", d: { __sys: "move", game: g.id, code: next } });
      setTimeout(() => { teardown(true); location.href = pageFor(g.id, "host=" + next); }, 150);
    }
    function follow(d) {
      if (!gameById(d.game) || !/^[A-Z0-9]{5}$/.test(d.code)) return;
      moving = true;
      teardown(false);
      location.href = pageFor(d.game, "join=" + d.code);
    }

    // ---------- Host ----------
    async function hostRoom(fixed, attempt = 0) {
      teardown(true);
      const my = gen;
      isHost = true;
      me = { id: 0, ...ui.profile() };
      hostP = me;
      code = fixed || makeCode();
      ui.setStatus("Creating room…", "pulse");
      let c;
      try {
        c = await connect(game, code, "host", {
          msg: (m) => onHostMsg(m),
          drop: () => banner("Connection lost. Reconnecting…"),
          back: (w) => {
            banner(null);
            const roster = w.roster || [];
            if (opp && !roster.includes(opp.id)) oppDropped(false);
            for (const id of [...specs.keys()]) if (!roster.includes(id)) specs.delete(id);
            broadcastPeople();
          },
          dead: () => fail("Lost connection to the game server."),
        });
      } catch (reason) {
        if (my !== gen) return;
        if (reason === "exists" && attempt < 4) return hostRoom(null, attempt + 1);
        return fail(reasonText(reason));
      }
      if (my !== gen) return c.close();
      conn = c;
      hostP = me;
      reportTo = { conn: c, name: me.name, game, code }; presence.where();
      ui.showRoom(code, { isHost: true, party: false });
      renderPeople();
      ui.setStatus("");
      enterDock();
      ui.pubToggle(true, pub.on, (v) => pub.set(v));
      pub.start();
    }
    function onHostMsg(m) {
      if (m.sys === "join" || m.sys === "rejoin") {
        clearTimeout(helloTimers.get(m.id));
        helloTimers.set(m.id, setTimeout(() => { if (conn && !isKnown(m.id)) conn.send({ kick: m.id }); }, HELLO_MS));
      } else if (m.sys === "leave") {
        clearTimeout(helloTimers.get(m.id));
        if (opp && m.id === opp.id) oppDropped(m.final);
        else if (specs.has(m.id)) {
          const p = specs.get(m.id);
          specs.delete(m.id);
          if (m.final) talk.system(`${p.name} stopped watching`);
          broadcastPeople();
        }
      } else if (m.from != null && m.d) onGuestData(m.from, m.d);
    }
    const isKnown = (id) => (opp && opp.id === id) || specs.has(id);
    function onGuestData(id, d) {
      if (d.__sys === "hello") {
        clearTimeout(helloTimers.get(id));
        const p = { id, name: cleanName(d.name), av: cleanAv(d.av) };
        if (opp && opp.id === id) { // our opponent reconnected (or reloaded)
          opp = p;
          clearTimeout(graceTimer); banner(null);
          accept(id, "player");
          broadcastPeople();
          for (const h of rejoinHandlers) h(id);
          return;
        }
        if (specs.has(id)) { specs.set(id, p); accept(id, "spectator"); broadcastPeople(); return; }
        if (!opp && !started) {
          opp = p;
          accept(id, "player");
          talk.system(`${p.name} joined`);
          start();
        } else if (spectate) {
          specs.set(id, p);
          accept(id, "spectator");
          broadcastPeople();
          talk.system(`${p.name} is watching`);
          for (const h of rejoinHandlers) h(id);
        } else reject(id, "That room is full.");
        return;
      }
      if (d.__sys) { talk.fromGuest(id, d); return; }
      if (opp && id === opp.id) deliver(d);
    }
    function accept(id, role) {
      conn.send({ to: id, d: { __sys: "accept", role, host: hostP, opp, specs: [...specs.values()] } });
    }
    function reject(id, reason) {
      conn.send({ to: id, d: { __sys: "reject", reason } });
      setTimeout(() => conn && conn.send({ kick: id }), 400);
    }
    function oppDropped(final) {
      if (!opp) return;
      const name = opp.name;
      if (final) return fail(`${name} left the game.`);
      banner(`${name} lost connection. Waiting for them…`);
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => fail(`${name} disconnected.`), GRACE_MS);
    }

    // ---------- Guest ----------
    async function joinRoom(c, { retry, resume } = {}) {
      teardown(true);
      const my = gen;
      isHost = false;
      me = ui.profile();
      code = c;
      ui.setStatus(resume ? "Rejoining…" : "Connecting…", "pulse");
      let cn;
      try {
        cn = await connectGuest(game, c, {
          msg: (m) => onGuestMsg(m),
          drop: () => banner("Connection lost. Reconnecting…"),
          back: () => { banner(null); hello(); },
          dead: () => fail("Lost connection to the game server."),
        }, retry);
      } catch (reason) {
        if (my !== gen) return;
        sess.del("oxid-session");
        if (resume) { ui.setStatus(""); return; }
        return fail(reasonText(reason));
      }
      if (my !== gen) return cn.close();
      conn = cn;
      reportTo = { conn: cn, name: me.name, game, code }; presence.where();
      sess.set("oxid-session", { game, code: c });
      if (cn.welcome.hostAway) banner("The host lost connection. Waiting for them…");
      ui.showRoom(c, { isHost: false, party: false });
      ui.setStatus("Joining…", "pulse");
      hello();
    }
    const hello = () => conn && conn.send({ d: { __sys: "hello", name: me.name, av: me.av } });
    function onGuestMsg(m) {
      if (m.sys === "host-left") return fail("The host left the room.");
      if (m.sys === "host-away") return banner("The host lost connection. Waiting for them…");
      if (m.sys === "host-back") return banner(null);
      const d = m.d;
      if (!d) return;
      if (d.__sys === "accept") {
        hostP = d.host; opp = d.opp;
        specs = new Map((d.specs || []).map((p) => [p.id, p]));
        spectator = d.role === "spectator";
        if (!started) start();
        return;
      }
      if (d.__sys === "people") { hostP = d.host; opp = d.opp; specs = new Map((d.specs || []).map((p) => [p.id, p])); renderPeople(); return; }
      if (d.__sys === "reject") return fail(d.reason);
      if (d.__sys === "move") return follow(d);
      if (d.__sys === "chat" || d.__sys === "react") return talk.show(d);
      deliver(d);
    }

    // ---------- Both ----------
    function deliver(d) {
      if (!link) return;
      if (d.__ping !== undefined) {
        // answer only the other player, never the spectators
        if (!spectator && conn) conn.send(isHost ? { to: opp && opp.id, d: { __pong: d.__ping } } : { d: { __pong: d.__ping } });
        return;
      }
      if (d.__pong !== undefined) {
        if (spectator) return;
        link.rtt = performance.now() - d.__pong;
        if (netEl) {
          const ms = Math.round(link.rtt);
          netEl.className = "net " + (ms < 80 ? "good" : ms < 180 ? "mid" : "bad");
          netEl.lastChild.textContent = ms + " ms";
        }
        return;
      }
      for (const h of handlers) h(d);
    }

    function start() {
      started = true;
      ui.hide();
      ui.setStatus("");
      const oppP = isHost ? opp : hostP;
      const guestP = opp || { name: "Guest" };
      link = {
        isHost, spectator,
        myName: spectator ? guestP.name : me.name,
        oppName: oppP ? oppP.name : "Opponent",
        names: [hostP ? hostP.name : "Host", guestP.name],
        rtt: 0,
        send: (o) => {
          if (!conn || spectator) return;
          if (isHost) conn.send({ to: opp ? [opp.id, ...specs.keys()] : "all", d: o });
          else conn.send({ d: o });
        },
        onData: (fn) => handlers.push(fn),
        onRejoin: (fn) => rejoinHandlers.push(fn),
      };
      if (!spectator) pingTimer = setInterval(() => link && link.send({ __ping: performance.now() }), 1000);
      enterDock();
      if (spectator) {
        document.body.classList.add("spectating");
        if (netEl) { netEl.className = "net"; netEl.lastChild.textContent = "watching"; }
        banner(null);
        toast(`Watching ${hostP.name} vs ${guestP.name}`, 3000);
      }
      renderPeople();
      pub.update();
      sfx.play("start");
      stopGame = onStart(link) || null;
    }

    onPurposefulExit(() => { if (conn && !moving) conn.close(true); });
    addEventListener("pagehide", () => { if (conn && !moving) conn.close(isHost); });
  }

  // =====================================================================
  // Multiplayer rooms (2–N players)
  // =====================================================================
  function mountRoom({ game, title, subtitle, min = 2, max = 6, lobbyExtra, onStart, lateJoin = false }) {
    let conn = null, isHost = false, myId = -1, players = [], started = false, gen = 0, code = null, moving = false;
    let stopGame = null, handlers = [], leaveHandlers = [], rejoinHandlers = [], joinHandlers = [], roomRef = null;
    const graceTimers = new Map(), helloTimers = new Map();

    const ui = shell({
      game, title, subtitle,
      onHost: (fixed) => createRoom(fixed),
      onJoin: (c, o) => joinRoom(c, o),
      onStart: () => {
        if (!isHost || players.length < min || started) return;
        toPlayers({ __sys: "start", players });
        begin();
      },
      onLeave: () => { teardown(true); ui.showMenu(); ui.setStatus(""); },
    });
    if (lobbyExtra) lobbyExtra(ui.extra());

    const talk = social({
      isHost: () => isHost,
      myId: () => myId,
      people: () => players,
      toGuests: (m) => toPlayers(m),
      toHost: (m) => conn && conn.send({ d: m }),
    });
    const toPlayers = (m) => {
      const ids = players.filter((p) => p.id !== myId).map((p) => p.id);
      if (conn && ids.length) conn.send({ to: ids, d: m });
    };
    const pub = lister(() => (isHost ? conn : null), () => ({ host: players[0] ? players[0].name : "", players: players.length, max, started }));

    function render() { ui.people(players.map((p) => ({ ...p, me: p.id === myId })), { min, max, isHost, party: true }); }

    function teardown(bye) {
      gen++; // invalidates any connection attempt still in flight
      for (const t of [...graceTimers.values(), ...helloTimers.values()]) clearTimeout(t);
      graceTimers.clear(); helloTimers.clear();
      if (stopGame) { try { stopGame(); } catch {} stopGame = null; }
      pub.stop(); ui.pubToggle(false);
      if (reportTo && reportTo.conn === conn) { reportTo = null; presence.where(); }
      if (conn) { conn.close(bye); conn = null; }
      if (bye) sess.del("oxid-session");
      handlers = []; leaveHandlers = []; rejoinHandlers = []; joinHandlers = []; roomRef = null;
      started = false; players = []; myId = -1;
      dock.leave(); banner(null);
    }
    function backToMenu(msg, cls = "error") {
      teardown(true);
      ui.showMenu();
      ui.setStatus(msg, cls);
      if (cls === "error") sfx.play("bad");
    }
    function enterDock() {
      dock.enter({ send: (t) => talk.say(t), react: (e) => talk.react(e) });
      dock.setSwitch(isHost ? { game, count: () => players.length, go: moveTo } : null);
    }
    function moveTo(g) {
      const next = makeCode();
      moving = true;
      toPlayers({ __sys: "move", game: g.id, code: next });
      setTimeout(() => { teardown(true); location.href = pageFor(g.id, "host=" + next); }, 150);
    }

    // --- Host ---
    async function createRoom(fixed, attempt = 0) {
      teardown(true);
      const my = gen;
      isHost = true;
      code = fixed || makeCode();
      ui.setStatus("Creating room…", "pulse");
      let c;
      try {
        c = await connect(game, code, "host", {
          msg: (m) => {
            if (m.sys === "join" || m.sys === "rejoin") {
              clearTimeout(helloTimers.get(m.id));
              helloTimers.set(m.id, setTimeout(() => { if (conn && !players.some((p) => p.id === m.id)) conn.send({ kick: m.id }); }, HELLO_MS));
            } else if (m.sys === "leave") playerDropped(m.id, m.final);
            else if (m.from != null && m.d) onGuestData(m.from, m.d);
          },
          drop: () => banner("Connection lost. Reconnecting…"),
          back: (w) => {
            banner(null);
            const roster = w.roster || [];
            for (const p of players) if (p.id !== 0 && !roster.includes(p.id)) playerDropped(p.id, false);
          },
          dead: () => backToMenu("Lost connection to the game server."),
        });
      } catch (reason) {
        if (my !== gen) return;
        if (reason === "exists" && attempt < 4) return createRoom(null, attempt + 1);
        return backToMenu(reasonText(reason));
      }
      if (my !== gen) return c.close();
      conn = c;
      myId = 0;
      players = [{ id: 0, ...ui.profile() }];
      reportTo = { conn: c, name: players[0].name, game, code }; presence.where();
      ui.showRoom(code, { isHost: true, party: true });
      render();
      ui.setStatus("Share the link. Start when everyone's in.");
      enterDock();
      ui.pubToggle(true, pub.on, (v) => pub.set(v));
      pub.start();
    }
    function onGuestData(id, d) {
      if (d.__sys === "hello") {
        clearTimeout(helloTimers.get(id));
        const known = players.find((p) => p.id === id);
        if (known) { // came back after a drop or a reload
          known.name = cleanName(d.name); known.av = cleanAv(d.av);
          if (graceTimers.has(id)) { clearTimeout(graceTimers.get(id)); graceTimers.delete(id); talk.system(`${known.name} is back`); }
          conn.send({ to: id, d: { __sys: "welcome", id } });
          if (started) {
            conn.send({ to: id, d: { __sys: "start", players } });
            for (const h of rejoinHandlers) h(id);
          } else broadcastLobby();
          return;
        }
        if (started && !lateJoin) return reject(id, "That game already started.");
        if (players.length >= max) return reject(id, "Room is full.");
        const p = { id, name: cleanName(d.name), av: cleanAv(d.av) };
        players.push(p);
        conn.send({ to: id, d: { __sys: "welcome", id } });
        if (started) {
          // Games that allow it (like the casino) let people sit down mid-session.
          conn.send({ to: id, d: { __sys: "start", players } });
          if (roomRef) roomRef.players.push({ ...p });
          talk.system(`${p.name} joined`);
          sfx.play("pop");
          for (const h of joinHandlers) h(p);
          pub.update();
          return;
        }
        broadcastLobby();
        talk.system(`${p.name} joined`);
        sfx.play("pop");
        return;
      }
      if (d.__sys) { talk.fromGuest(id, d); return; }
      if (!started || !players.some((p) => p.id === id)) return;
      for (const h of handlers) h(id, d);
    }
    function reject(id, reason) {
      conn.send({ to: id, d: { __sys: "reject", reason } });
      setTimeout(() => conn && conn.send({ kick: id }), 400);
    }
    function playerDropped(id, final) {
      clearTimeout(helloTimers.get(id));
      const p = players.find((x) => x.id === id);
      if (!p) return;
      if (!started || final) return removePlayer(id);
      if (graceTimers.has(id)) return;
      talk.system(`${p.name} lost connection…`);
      graceTimers.set(id, setTimeout(() => { graceTimers.delete(id); removePlayer(id); }, GRACE_MS));
    }
    function removePlayer(id) {
      const p = players.find((x) => x.id === id);
      if (!p) return;
      players = players.filter((x) => x.id !== id);
      talk.system(`${p.name} left`);
      if (!started) broadcastLobby();
      else { for (const h of leaveHandlers) h(id); toast(p.name + " left the game"); pub.update(); }
    }
    function broadcastLobby() {
      toPlayers({ __sys: "lobby", players });
      render();
      pub.update();
    }

    // --- Guest ---
    async function joinRoom(c, { retry, resume } = {}) {
      teardown(true);
      const my = gen;
      isHost = false;
      code = c;
      const me = ui.profile();
      ui.setStatus(resume ? "Rejoining…" : "Connecting…", "pulse");
      const hello = () => conn && conn.send({ d: { __sys: "hello", name: me.name, av: me.av } });
      const myName = me.name;
      let cn;
      try {
        cn = await connectGuest(game, c, {
          msg: (m) => {
            if (m.sys === "host-left") return backToMenu("The host left the room.");
            if (m.sys === "host-away") return banner("The host lost connection. Waiting for them…");
            if (m.sys === "host-back") return banner(null);
            const d = m.d;
            if (!d) return;
            if (d.__sys) {
              if (d.__sys === "welcome") {
                myId = d.id;
                if (!started) { ui.showRoom(c, { isHost: false, party: true }); ui.setStatus(""); enterDock(); }
              } else if (d.__sys === "chat" || d.__sys === "react") talk.show(d);
              else if (d.__sys === "lobby") { players = d.players; render(); }
              else if (d.__sys === "reject") backToMenu(d.reason);
              else if (d.__sys === "move") {
                if (!gameById(d.game) || !/^[A-Z0-9]{5}$/.test(d.code)) return;
                moving = true; teardown(false);
                location.href = pageFor(d.game, "join=" + d.code);
              } else if (d.__sys === "start" && myId >= 0) {
                players = d.players;
                if (!started) begin();
              }
              return;
            }
            if (started) for (const h of handlers) h(0, d);
          },
          drop: () => banner("Connection lost. Reconnecting…"),
          back: () => { banner(null); hello(); },
          dead: () => backToMenu("Lost connection to the game server."),
        }, retry);
      } catch (reason) {
        if (my !== gen) return;
        sess.del("oxid-session");
        if (resume) { ui.setStatus(""); return; }
        return backToMenu(reasonText(reason));
      }
      if (my !== gen) return cn.close();
      conn = cn;
      reportTo = { conn: cn, name: myName, game, code }; presence.where();
      sess.set("oxid-session", { game, code: c });
      if (cn.welcome.hostAway) banner("The host lost connection. Waiting for them…");
      hello();
    }

    function begin() {
      started = true;
      ui.hide();
      ui.setStatus("");
      const room = {
        isHost, myId,
        players: players.map((p) => ({ ...p })),
        send: (m) => { if (conn) conn.send({ d: m }); },
        sendTo: (id, m) => { if (conn) conn.send({ to: id, d: m }); },
        broadcast: (m) => toPlayers(m),
        onData: (fn) => handlers.push(fn),
        onLeave: (fn) => leaveHandlers.push(fn),
        onRejoin: (fn) => rejoinHandlers.push(fn),
        onJoin: (fn) => joinHandlers.push(fn),
      };
      roomRef = room;
      pub.update();
      sfx.play("start");
      stopGame = onStart(room) || null;
    }

    onPurposefulExit(() => { if (conn && !moving) conn.close(true); });
    addEventListener("pagehide", () => { if (conn && !moving) conn.close(isHost); });
  }

  // ---------- Shared helpers for games ----------
  function fitCanvas(canvas, W, H) {
    const stage = canvas.parentElement;
    const resize = () => {
      const r = stage.getBoundingClientRect();
      const pad = 32;
      const scale = Math.min((r.width - pad) / W, (r.height - pad) / H);
      const cssW = Math.max(200, Math.floor(W * scale)), cssH = Math.max(112, Math.floor(H * scale));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas._scale = canvas.width / W;
    };
    window.addEventListener("resize", resize);
    resize();
    return resize;
  }

  // Game loop that keeps running when the tab is hidden, minimized or covered. Browsers pause or
  // throttle rAF then, which would freeze the match for everyone if the host alt-tabs.
  // Worker timers aren't throttled like main-thread timers, so they take over whenever rAF stalls.
  function loop(step) {
    let running = true, rafId = 0, lastStep = performance.now();
    const worker = new Worker(URL.createObjectURL(
      new Blob(["setInterval(() => postMessage(0), 16)"], { type: "text/javascript" })));
    worker.onmessage = () => {
      const now = performance.now();
      if (running && now - lastStep > 34) { lastStep = now; step(now); } // ~2 missed frames
    };
    const tick = () => {
      if (!running) return;
      lastStep = performance.now();
      step(lastStep); // same clock as the worker path, so dt never goes negative
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(rafId); worker.terminate(); };
  }


  // ---------- Touch controls (touchscreen Chromebooks, tablets) ----------
  // On-screen controls for games that otherwise need a keyboard. They only show once someone
  // actually touches the screen, and hide again when a mouse or keyboard is used.
  let touchMode = false;
  const setTouch = (on) => { if (on !== touchMode) { touchMode = on; document.body.classList.toggle("touching", on); } };
  addEventListener("pointerdown", (e) => { if (e.pointerType === "touch" || e.pointerType === "pen") setTouch(true); }, true);
  addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" && (e.movementX || e.movementY)) setTouch(false); }, true);
  addEventListener("keydown", (e) => { if (!/^(Tab|Shift|Control|Alt|Meta)/.test(e.key) && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") setTouch(false); }, true);

  // opts: { dpad(dir 0..3), sticks: [{ side, label, onMove(x, y, active) }], buttons: [{ side, label, onDown, onUp }] }
  function touchControls(opts) {
    const root = document.createElement("div");
    root.className = "touch-ui";
    const zone = (side) => {
      let z = root.querySelector(".tz-" + side);
      if (!z) { z = document.createElement("div"); z.className = "tz tz-" + side; root.append(z); }
      return z;
    };
    const hold = (el, down, up) => {
      el.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId); el.classList.add("on"); down && down(); });
      const end = () => { if (el.classList.contains("on")) { el.classList.remove("on"); up && up(); } };
      el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end); el.addEventListener("lostpointercapture", end);
      el.addEventListener("contextmenu", (e) => e.preventDefault());
    };
    if (opts.dpad) {
      const pad = document.createElement("div");
      pad.className = "t-dpad";
      ["up", "right", "down", "left"].forEach((name, dir) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "t-btn t-" + name; b.setAttribute("aria-label", name);
        hold(b, () => opts.dpad(dir));
        pad.append(b);
      });
      zone(opts.dpadSide || "left").append(pad);
    }
    for (const st of opts.sticks || []) {
      const base = document.createElement("div");
      base.className = "t-stick";
      const knob = document.createElement("i");
      base.append(knob);
      if (st.label) { const l = document.createElement("span"); l.textContent = st.label; base.append(l); }
      let id = null;
      const move = (e) => {
        const r = base.getBoundingClientRect(), R = r.width / 2;
        let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
        const len = Math.hypot(x, y);
        if (len > 1) { x /= len; y /= len; }
        knob.style.transform = `translate(${x * R * 0.55}px, ${y * R * 0.55}px)`;
        st.onMove(x, y, true);
      };
      base.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); id = e.pointerId; base.setPointerCapture(id); base.classList.add("on"); move(e); });
      base.addEventListener("pointermove", (e) => { if (e.pointerId === id) move(e); });
      const end = (e) => { if (e.pointerId !== id) return; id = null; base.classList.remove("on"); knob.style.transform = ""; st.onMove(0, 0, false); };
      base.addEventListener("pointerup", end); base.addEventListener("pointercancel", end);
      zone(st.side || "left").append(base);
    }
    for (const bt of opts.buttons || []) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "t-btn t-action"; b.textContent = bt.label;
      hold(b, bt.onDown, bt.onUp);
      zone(bt.side || "right").append(b);
    }
    document.body.append(root);
    return { remove: () => root.remove() };
  }

  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  window.Lobby = { mount };
  window.Room = { mount: mountRoom };
  window.GameUtil = {
    fitCanvas, toast, loop, shuffle, touchControls, isTouch: () => touchMode, openSettings, openFriends, achieve: unlock, achievements, friendCode: () => identity.id,
    meta: readMeta, onNameChange: (f) => nameListeners.push(f), myName: savedName, myAvatar, avatar: avatarEl, cleanName,
    sfx: (n) => sfx.play(n), record, stats: readStats, games: GAMES, joinByCode, pageFor, gameById,
  };
})();
