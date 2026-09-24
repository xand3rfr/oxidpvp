// Shared multiplayer layer. Every player opens a WebSocket to a room on our Cloudflare Worker
// (worker.js, one Durable Object per room code). The room relays messages between the host
// and the guests; the host's browser runs the game.
//
// Lobby.mount({ game, title, subtitle, onStart(link) -> stopFn })          1v1 games
//   link = { isHost, send(obj), onData(fn), rtt }
// Room.mount({ game, title, subtitle, min, max, onStart(room) -> stopFn }) 2–N player games
//   room = { isHost, myId, players:[{id,name}], send(msg) (guest→host),
//            sendTo(id,msg), broadcast(msg) (host→guests), onData(fn(fromId,msg)), onLeave(fn(id)) }
//   Guests always see messages as coming from id 0 (the host).
(() => {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const CODE_LEN = 5;
  const KEEPALIVE_MS = 25000;

  const makeCode = () =>
    Array.from({ length: CODE_LEN }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

  const REASONS = {
    "not-found": "No room with that code. Double-check it.",
    "full": "That room is full.",
    "exists": "Room code collision, try again.",
    "network": "Couldn't reach the game server. Check your connection.",
  };
  const reasonText = (r) => REASONS[r] || REASONS.network;

  // Connects to a room. Resolves with { ws, id } once the server welcomes us,
  // rejects with a reason ("not-found", "full", "exists", "network").
  function openSocket(game, code, role) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      let ws, settled = false;
      const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      try { ws = new WebSocket(`${proto}//${location.host}/api/room/${game}/${code}?role=${role}`); }
      catch { return reject("network"); }
      const timer = setTimeout(() => { try { ws.close(); } catch {} finish(reject, "network"); }, 10000);
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.sys === "welcome") finish(resolve, { ws, id: m.id });
        else { finish(reject, m.reason); try { ws.close(); } catch {} }
      };
      ws.onerror = ws.onclose = () => finish(reject, "network");
    });
  }

  // Takes over a welcomed socket: JSON in/out, keepalive, and a close callback.
  function wrap(ws, onMsg, onClose) {
    const keep = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, KEEPALIVE_MS);
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onMsg(m);
    };
    ws.onerror = null;
    ws.onclose = () => { clearInterval(keep); onClose(); };
    return {
      send: (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      close: () => { clearInterval(keep); ws.onclose = null; try { ws.close(); } catch {} },
    };
  }

  // ---------- 1v1 lobby ----------
  function mount({ game, title, subtitle, onStart }) {
    const root = document.createElement("div");
    root.className = "overlay";
    root.innerHTML = `
      <div class="panel">
        <a class="back" href="index.html">&larr; All games</a>
        <h1></h1>
        <p class="sub"></p>
        <div data-view="menu">
          <button class="btn primary full" data-act="host">Create room</button>
          <div class="or">or join</div>
          <form class="join">
            <input maxlength="${CODE_LEN}" placeholder="CODE" autocomplete="off" spellcheck="false" aria-label="Room code">
            <button class="btn" type="submit">Join</button>
          </form>
        </div>
        <div class="wait" data-view="wait" hidden>
          <div class="label">Room code</div>
          <button class="code" title="Click to copy"></button>
          <p class="muted" style="font-size:13px">Send this code to your opponent. Click it to copy.</p>
          <button class="btn ghost full" data-act="cancel">Cancel</button>
        </div>
        <p class="status" aria-live="polite"></p>
      </div>`;
    root.querySelector("h1").textContent = title;
    root.querySelector(".sub").textContent = subtitle;
    document.body.appendChild(root);

    const $ = (s) => root.querySelector(s);
    const menuView = $('[data-view="menu"]');
    const waitView = $('[data-view="wait"]');
    const status = $(".status");
    const input = $(".join input");
    const codeBtn = $(".code");
    const netEl = document.getElementById("net");

    let sock = null, opp = null, isHost = false, stopGame = null, pingTimer = null, gen = 0;
    let handlers = [], link = null;

    const setStatus = (msg, cls = "") => { status.textContent = msg; status.className = "status " + cls; };
    const showMenu = () => { menuView.hidden = false; waitView.hidden = true; };
    const showWait = (code) => { menuView.hidden = true; waitView.hidden = false; codeBtn.textContent = code; };

    function teardown() {
      gen++; // invalidates any connection attempt still in flight
      clearInterval(pingTimer);
      if (stopGame) { try { stopGame(); } catch {} stopGame = null; }
      if (sock) { sock.close(); sock = null; }
      opp = null; handlers = []; link = null;
      if (netEl) { netEl.className = "net"; netEl.lastChild.textContent = "offline"; }
    }
    function fail(msg) {
      root.hidden = false;
      teardown();
      showMenu();
      setStatus(msg, "error");
    }

    async function hostRoom(attempt = 0) {
      teardown();
      const my = gen;
      isHost = true;
      const code = makeCode();
      setStatus("Creating room…", "pulse");
      let r;
      try { r = await openSocket(game, code, "host"); }
      catch (reason) {
        if (my !== gen) return;
        if (reason === "exists" && attempt < 4) return hostRoom(attempt + 1);
        return fail(reasonText(reason));
      }
      if (my !== gen) return r.ws.close();
      sock = wrap(r.ws, (m) => {
        if (m.sys === "join") {
          if (opp != null) { // room full: tell them, then have the server drop them
            sock.send({ to: m.id, d: { __sys: "reject", reason: "That room is full." } });
            setTimeout(() => sock && sock.send({ kick: m.id }), 300);
            return;
          }
          opp = m.id;
          sock.send({ to: opp, d: { __sys: "accept" } });
          start();
        } else if (m.sys === "leave") {
          if (m.id === opp) fail("Opponent disconnected.");
        } else if (m.from === opp && m.d) deliver(m.d);
      }, () => { if (my === gen) fail("Lost connection to the game server."); });
      showWait(code);
      setStatus("Waiting for opponent…", "pulse");
    }

    async function joinRoom(code) {
      teardown();
      const my = gen;
      isHost = false;
      setStatus("Connecting…", "pulse");
      let r;
      try { r = await openSocket(game, code, "join"); }
      catch (reason) { if (my === gen) fail(reasonText(reason)); return; }
      if (my !== gen) return r.ws.close();
      sock = wrap(r.ws, (m) => {
        if (m.sys === "host-left") return fail("Opponent disconnected.");
        const d = m.d;
        if (!d) return;
        if (d.__sys === "accept") return start();
        if (d.__sys === "reject") return fail(d.reason);
        deliver(d);
      }, () => { if (my === gen) fail("Lost connection to the game server."); });
    }

    function deliver(d) {
      if (!link) return;
      if (d.__ping !== undefined) return link.send({ __pong: d.__ping });
      if (d.__pong !== undefined) {
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
      root.hidden = true;
      setStatus("");
      link = {
        isHost,
        rtt: 0,
        send: (o) => { if (sock) sock.send(isHost ? { to: opp, d: o } : { d: o }); },
        onData: (fn) => handlers.push(fn),
      };
      pingTimer = setInterval(() => link && link.send({ __ping: performance.now() }), 1000);
      stopGame = onStart(link) || null;
    }

    $('[data-act="host"]').addEventListener("click", () => hostRoom());
    $('[data-act="cancel"]').addEventListener("click", () => { teardown(); showMenu(); setStatus(""); });
    $(".join").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = input.value.trim().toUpperCase();
      if (code.length !== CODE_LEN) return setStatus(`Codes are ${CODE_LEN} characters.`, "error");
      joinRoom(code);
    });
    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
    codeBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(codeBtn.textContent); setStatus("Copied! Waiting for opponent…", "pulse"); } catch {}
    });
    window.addEventListener("beforeunload", teardown);
  }

  // ---------- Multiplayer rooms (2–N players) ----------
  const NAME_KEY = "oxidpvp-name";
  const cleanName = (n) => String(n || "").replace(/\s+/g, " ").trim().slice(0, 16) || "Player";

  function mountRoom({ game, title, subtitle, min = 2, max = 6, onStart }) {
    const root = document.createElement("div");
    root.className = "overlay";
    root.innerHTML = `
      <div class="panel">
        <a class="back" href="index.html">&larr; All games</a>
        <h1></h1>
        <p class="sub"></p>
        <div data-view="menu">
          <label class="field"><span>Your name</span><input class="name" maxlength="16" autocomplete="nickname" spellcheck="false"></label>
          <button class="btn primary full" data-act="host">Create room</button>
          <div class="or">or join</div>
          <form class="join">
            <input class="code-in" maxlength="${CODE_LEN}" placeholder="CODE" autocomplete="off" spellcheck="false" aria-label="Room code">
            <button class="btn" type="submit">Join</button>
          </form>
        </div>
        <div class="wait" data-view="room" hidden>
          <div class="label">Room code</div>
          <button class="code" title="Click to copy"></button>
          <div class="plist-head"><span>Players</span><span class="pcount"></span></div>
          <ul class="plist"></ul>
          <button class="btn primary full" data-act="start" hidden>Start game</button>
          <p class="muted wait-msg" style="font-size:13px;margin-top:14px" hidden>Waiting for the host to start…</p>
          <button class="btn ghost full" data-act="leave" style="margin-top:10px">Leave room</button>
        </div>
        <p class="status" aria-live="polite"></p>
      </div>`;
    root.querySelector("h1").textContent = title;
    root.querySelector(".sub").textContent = subtitle;
    document.body.appendChild(root);

    const $ = (s) => root.querySelector(s);
    const menuView = $('[data-view="menu"]'), roomView = $('[data-view="room"]');
    const status = $(".status"), nameIn = $(".name"), codeIn = $(".code-in"), codeBtn = $(".code");
    const startBtn = $('[data-act="start"]'), waitMsg = $(".wait-msg");

    try { nameIn.value = localStorage.getItem(NAME_KEY) || ""; } catch {}
    if (!nameIn.value) nameIn.value = "Player" + Math.floor(100 + Math.random() * 900);
    const myName = () => {
      const n = cleanName(nameIn.value);
      try { localStorage.setItem(NAME_KEY, n); } catch {}
      return n;
    };

    let sock = null, isHost = false, myId = -1, players = [], started = false, gen = 0;
    let stopGame = null, handlers = [], leaveHandlers = [];

    const setStatus = (msg, cls = "") => { status.textContent = msg; status.className = "status " + cls; };
    const showMenu = () => { menuView.hidden = false; roomView.hidden = true; };
    const showRoom = (code) => {
      menuView.hidden = true; roomView.hidden = false;
      codeBtn.textContent = code;
      startBtn.hidden = !isHost; waitMsg.hidden = isHost;
      renderPlayers();
    };

    function renderPlayers() {
      const list = $(".plist");
      list.textContent = "";
      for (const p of players) {
        const li = document.createElement("li");
        const av = document.createElement("span");
        av.className = "avatar"; av.textContent = p.name[0].toUpperCase();
        const nm = document.createElement("span");
        nm.className = "pname"; nm.textContent = p.name;
        li.append(av, nm);
        if (p.id === 0) { const t = document.createElement("span"); t.className = "ptag"; t.textContent = "Host"; li.append(t); }
        if (p.id === myId) { const t = document.createElement("span"); t.className = "ptag you"; t.textContent = "You"; li.append(t); }
        list.append(li);
      }
      $(".pcount").textContent = players.length + " / " + max;
      startBtn.disabled = players.length < min;
      startBtn.textContent = players.length < min ? `Need ${min - players.length} more player${min - players.length > 1 ? "s" : ""}` : `Start game (${players.length} players)`;
    }

    function teardown() {
      gen++; // invalidates any connection attempt still in flight
      if (stopGame) { try { stopGame(); } catch {} stopGame = null; }
      if (sock) { sock.close(); sock = null; }
      handlers = []; leaveHandlers = [];
      started = false; players = []; myId = -1;
    }
    function backToMenu(msg, cls = "error") {
      root.hidden = false;
      teardown();
      showMenu();
      setStatus(msg, cls);
    }
    const toPlayers = (m) => { for (const p of players) if (p.id !== myId) sock.send({ to: p.id, d: m }); };

    // --- Host ---
    async function createRoom(attempt = 0) {
      teardown();
      const my = gen;
      isHost = true;
      const code = makeCode();
      setStatus("Creating room…", "pulse");
      let r;
      try { r = await openSocket(game, code, "host"); }
      catch (reason) {
        if (my !== gen) return;
        if (reason === "exists" && attempt < 4) return createRoom(attempt + 1);
        return backToMenu(reasonText(reason));
      }
      if (my !== gen) return r.ws.close();
      myId = 0;
      players = [{ id: 0, name: myName() }];
      sock = wrap(r.ws, (m) => {
        if (m.sys === "leave") return dropPlayer(m.id);
        if (m.from != null && m.d) onGuestData(m.from, m.d);
      }, () => { if (my === gen) backToMenu("Lost connection to the game server."); });
      showRoom(code);
      setStatus("Share the code. Start when everyone's in.");
    }
    function onGuestData(id, d) {
      if (d.__sys === "hello") {
        if (started) return reject(id, "That game already started.");
        if (players.length >= max) return reject(id, "Room is full.");
        if (players.some((p) => p.id === id)) return;
        players.push({ id, name: cleanName(d.name) });
        sock.send({ to: id, d: { __sys: "welcome", id } });
        broadcastLobby();
        return;
      }
      if (!started || !players.some((p) => p.id === id)) return;
      for (const h of handlers) h(id, d);
    }
    function reject(id, reason) {
      sock.send({ to: id, d: { __sys: "reject", reason } });
      setTimeout(() => sock && sock.send({ kick: id }), 400);
    }
    function dropPlayer(id) {
      const p = players.find((x) => x.id === id);
      if (!p) return;
      players = players.filter((x) => x.id !== id);
      if (!started) broadcastLobby();
      else { for (const h of leaveHandlers) h(id); toast(p.name + " left the game"); }
    }
    function broadcastLobby() {
      toPlayers({ __sys: "lobby", players });
      renderPlayers();
    }

    // --- Guest ---
    async function joinRoom(code) {
      teardown();
      const my = gen;
      isHost = false;
      setStatus("Connecting…", "pulse");
      let r;
      try { r = await openSocket(game, code, "join"); }
      catch (reason) { if (my === gen) backToMenu(reasonText(reason)); return; }
      if (my !== gen) return r.ws.close();
      sock = wrap(r.ws, (m) => {
        if (m.sys === "host-left") return backToMenu("The host left the room.");
        const d = m.d;
        if (!d) return;
        if (d.__sys) {
          if (d.__sys === "welcome") { myId = d.id; showRoom(code); setStatus(""); }
          else if (d.__sys === "lobby") { players = d.players; renderPlayers(); }
          else if (d.__sys === "reject") backToMenu(d.reason);
          else if (d.__sys === "start" && myId >= 0) { players = d.players; begin(); }
          return;
        }
        if (started) for (const h of handlers) h(0, d);
      }, () => { if (my === gen) backToMenu("Lost connection to the game server."); });
      sock.send({ d: { __sys: "hello", name: myName() } });
    }

    function begin() {
      started = true;
      root.hidden = true;
      setStatus("");
      const room = {
        isHost, myId,
        players: players.map((p) => ({ ...p })),
        send: (m) => { if (sock) sock.send({ d: m }); },
        sendTo: (id, m) => { if (sock) sock.send({ to: id, d: m }); },
        broadcast: (m) => { if (sock) toPlayers(m); },
        onData: (fn) => handlers.push(fn),
        onLeave: (fn) => leaveHandlers.push(fn),
      };
      stopGame = onStart(room) || null;
    }

    $('[data-act="host"]').addEventListener("click", () => createRoom());
    startBtn.addEventListener("click", () => {
      if (!isHost || players.length < min) return;
      toPlayers({ __sys: "start", players });
      begin();
    });
    $('[data-act="leave"]').addEventListener("click", () => { teardown(); showMenu(); setStatus(""); });
    $(".join").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = codeIn.value.trim().toUpperCase();
      if (code.length !== CODE_LEN) return setStatus(`Codes are ${CODE_LEN} characters.`, "error");
      joinRoom(code);
    });
    codeIn.addEventListener("input", () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    codeBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(codeBtn.textContent); setStatus("Code copied!", "ok"); } catch {}
    });
    window.addEventListener("beforeunload", teardown);
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

  function toast(msg, ms = 2200) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
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

  window.Lobby = { mount };
  window.Room = { mount: mountRoom };
  window.GameUtil = { fitCanvas, toast, loop };
})();
