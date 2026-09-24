// Shared PeerJS lobby: room codes, connection, ping, disconnect handling.
// Usage: Lobby.mount({ game, title, subtitle, onStart(link) -> stopFn })
// link = { isHost, send(obj), onData(fn), rtt }
(() => {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const PREFIX = "oxidpvp-v1-";
  const CODE_LEN = 5;

  const makeCode = () =>
    Array.from({ length: CODE_LEN }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

  const errorText = (e) => ({
    "peer-unavailable": "No room with that code. Double-check it.",
    "unavailable-id": "Room code collision, try again.",
    "network": "Network problem. Check your connection.",
    "server-error": "Matchmaking server is unreachable. Try again shortly.",
    "socket-error": "Matchmaking server is unreachable. Try again shortly.",
    "browser-incompatible": "Your browser doesn't support WebRTC.",
  }[e.type] || "Connection error: " + (e.type || e.message || "unknown"));

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

    let peer = null, conn = null, stopGame = null, pingTimer = null;

    const setStatus = (msg, cls = "") => { status.textContent = msg; status.className = "status " + cls; };
    const showMenu = () => { menuView.hidden = false; waitView.hidden = true; };
    const showWait = (code) => { menuView.hidden = true; waitView.hidden = false; codeBtn.textContent = code; };

    function teardown() {
      clearInterval(pingTimer);
      if (stopGame) { try { stopGame(); } catch {} stopGame = null; }
      if (peer) { try { peer.destroy(); } catch {} peer = null; }
      conn = null;
      if (netEl) { netEl.className = "net"; netEl.lastChild.textContent = "offline"; }
    }

    function hostRoom(attempt = 0) {
      teardown();
      const code = makeCode();
      setStatus("Creating room…", "pulse");
      peer = new Peer(PREFIX + game + "-" + code);
      peer.on("open", () => { showWait(code); setStatus("Waiting for opponent…", "pulse"); });
      peer.on("connection", (c) => {
        if (conn) { c.on("open", () => c.close()); return; } // room full
        conn = c;
        c.on("open", () => start(c, true));
      });
      peer.on("error", (e) => {
        if (e.type === "unavailable-id" && attempt < 4) return hostRoom(attempt + 1);
        if (conn && conn.open) return; // ignore signaling hiccups mid-game
        setStatus(errorText(e), "error");
        showMenu();
        teardown();
      });
    }

    function joinRoom(code) {
      teardown();
      setStatus("Connecting…", "pulse");
      peer = new Peer();
      peer.on("open", () => {
        const c = peer.connect(PREFIX + game + "-" + code, { reliable: true });
        conn = c;
        const timeout = setTimeout(() => {
          if (!c.open) { setStatus("Couldn't reach that room. Check the code.", "error"); teardown(); }
        }, 12000);
        c.on("open", () => { clearTimeout(timeout); start(c, false); });
      });
      peer.on("error", (e) => {
        if (conn && conn.open) return;
        setStatus(errorText(e), "error");
        teardown();
      });
    }

    function start(c, isHost) {
      root.hidden = true;
      setStatus("");
      const handlers = [];
      const link = {
        isHost,
        rtt: 0,
        send: (o) => { if (c.open) c.send(o); },
        onData: (fn) => handlers.push(fn),
      };
      c.on("data", (d) => {
        if (d && d.__ping !== undefined) return c.send({ __pong: d.__ping });
        if (d && d.__pong !== undefined) {
          link.rtt = performance.now() - d.__pong;
          if (netEl) {
            const ms = Math.round(link.rtt);
            netEl.className = "net " + (ms < 80 ? "good" : ms < 180 ? "mid" : "bad");
            netEl.lastChild.textContent = ms + " ms";
          }
          return;
        }
        for (const h of handlers) h(d);
      });
      c.on("close", () => lost("Opponent disconnected."));
      c.on("error", () => lost("Connection lost."));
      pingTimer = setInterval(() => c.open && c.send({ __ping: performance.now() }), 1000);
      stopGame = onStart(link) || null;
    }

    function lost(msg) {
      if (!root.hidden) return;
      root.hidden = false;
      teardown();
      showMenu();
      setStatus(msg, "error");
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

  // ---------- Multiplayer rooms (2–N players, host is the hub) ----------
  // Usage: Room.mount({ game, title, subtitle, min, max, onStart(room) -> stopFn })
  // room = { isHost, myId, players:[{id,name}], send(msg) (guest→host),
  //          sendTo(id,msg), broadcast(msg) (host→guests), onData(fn(fromId,msg)), onLeave(fn(id)) }
  // Guests always see messages as coming from id 0 (the host).
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

    let peer = null, isHost = false, myId = -1, players = [], nextId = 1, started = false, inRoom = false;
    let conns = new Map(), hostConn = null, stopGame = null, handlers = [], leaveHandlers = [];

    const setStatus = (msg, cls = "") => { status.textContent = msg; status.className = "status " + cls; };
    const showMenu = () => { menuView.hidden = false; roomView.hidden = true; inRoom = false; };
    const showRoom = (code) => {
      menuView.hidden = true; roomView.hidden = false; inRoom = true;
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
      if (stopGame) { try { stopGame(); } catch {} stopGame = null; }
      if (peer) { try { peer.destroy(); } catch {} peer = null; }
      conns = new Map(); hostConn = null; handlers = []; leaveHandlers = [];
      started = false; players = []; myId = -1;
    }

    function backToMenu(msg, cls = "error") {
      root.hidden = false;
      teardown();
      showMenu();
      setStatus(msg, cls);
    }

    // --- Host ---
    function createRoom(attempt = 0) {
      teardown();
      isHost = true; myId = 0; nextId = 1;
      players = [{ id: 0, name: myName() }];
      const code = makeCode();
      setStatus("Creating room…", "pulse");
      peer = new Peer(PREFIX + game + "-" + code);
      peer.on("open", () => { showRoom(code); setStatus("Share the code. Start when everyone's in.", ""); });
      peer.on("connection", (c) => {
        c.on("data", (d) => onHostData(c, d));
        c.on("close", () => dropConn(c));
        c.on("error", () => dropConn(c));
      });
      peer.on("error", (e) => {
        if (e.type === "unavailable-id" && attempt < 4) return createRoom(attempt + 1);
        if (e.type === "peer-unavailable" || inRoom) return; // a guest vanished; not fatal
        backToMenu(errorText(e));
      });
    }
    function onHostData(c, d) {
      if (d && d.__sys === "hello") {
        if (started) return reject(c, "That game already started.");
        if (players.length >= max) return reject(c, "Room is full.");
        const id = nextId++;
        c._pid = id;
        conns.set(id, c);
        players.push({ id, name: cleanName(d.name) });
        c.send({ __sys: "welcome", id });
        broadcastLobby();
        return;
      }
      if (c._pid == null || !started) return;
      for (const h of handlers) h(c._pid, d);
    }
    function reject(c, reason) {
      if (c.open) c.send({ __sys: "reject", reason });
      setTimeout(() => c.close(), 400);
    }
    function dropConn(c) {
      const id = c._pid;
      if (id == null || !conns.has(id)) return;
      conns.delete(id);
      const p = players.find((x) => x.id === id);
      players = players.filter((x) => x.id !== id);
      if (!started) broadcastLobby();
      else { for (const h of leaveHandlers) h(id); if (p) toast(p.name + " left the game"); }
    }
    function broadcastLobby() {
      const msg = { __sys: "lobby", players };
      conns.forEach((c) => c.open && c.send(msg));
      renderPlayers();
    }

    // --- Guest ---
    function joinRoom(code) {
      teardown();
      isHost = false;
      let rejected = false;
      setStatus("Connecting…", "pulse");
      peer = new Peer();
      peer.on("open", () => {
        const c = peer.connect(PREFIX + game + "-" + code, { reliable: true });
        hostConn = c;
        const timeout = setTimeout(() => { if (!c.open) backToMenu("Couldn't reach that room. Check the code."); }, 12000);
        c.on("open", () => { clearTimeout(timeout); c.send({ __sys: "hello", name: myName() }); });
        c.on("data", (d) => {
          if (d && d.__sys) {
            if (d.__sys === "welcome") { myId = d.id; showRoom(code); setStatus(""); }
            else if (d.__sys === "lobby") { players = d.players; renderPlayers(); }
            else if (d.__sys === "reject") { rejected = true; backToMenu(d.reason); }
            else if (d.__sys === "start") { players = d.players; begin(); }
            return;
          }
          if (started) for (const h of handlers) h(0, d);
        });
        c.on("close", () => { if (!rejected && (inRoom || started)) backToMenu("The host left the room."); });
      });
      peer.on("error", (e) => {
        if (hostConn && hostConn.open) return;
        backToMenu(errorText(e));
      });
    }

    function begin() {
      started = true;
      root.hidden = true;
      setStatus("");
      const room = {
        isHost, myId,
        players: players.map((p) => ({ ...p })),
        send: (m) => { if (hostConn && hostConn.open) hostConn.send(m); },
        sendTo: (id, m) => { const c = conns.get(id); if (c && c.open) c.send(m); },
        broadcast: (m) => conns.forEach((c) => c.open && c.send(m)),
        onData: (fn) => handlers.push(fn),
        onLeave: (fn) => leaveHandlers.push(fn),
      };
      stopGame = onStart(room) || null;
    }

    $('[data-act="host"]').addEventListener("click", () => createRoom());
    startBtn.addEventListener("click", () => {
      if (!isHost || players.length < min) return;
      conns.forEach((c) => c.open && c.send({ __sys: "start", players }));
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

  // Shared helpers for games
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

  // Game loop that keeps running when the tab is hidden (rAF pauses in background tabs,
  // which would freeze the match for both players if the host alt-tabs).
  // Worker timers aren't throttled like main-thread timers, so they drive ticks while hidden.
  function loop(step) {
    let running = true, rafId = 0;
    const worker = new Worker(URL.createObjectURL(
      new Blob(["setInterval(() => postMessage(0), 16)"], { type: "text/javascript" })));
    worker.onmessage = () => { if (running && document.hidden) step(performance.now()); };
    const tick = (t) => {
      if (!running) return;
      if (!document.hidden) step(t);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(rafId); worker.terminate(); };
  }

  window.Lobby = { mount };
  window.Room = { mount: mountRoom };
  window.GameUtil = { fitCanvas, toast, loop };
})();
