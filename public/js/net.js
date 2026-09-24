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

  // ---------- Names + invite links (shared by both lobbies) ----------
  const NAME_KEY = "oxidpvp-name";
  const cleanName = (n) => String(n || "").replace(/\s+/g, " ").trim().slice(0, 16) || "Player";
  const savedName = () => { try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; } };
  // Fills a name input and returns a getter that also remembers the name for next time.
  function nameField(input) {
    input.value = savedName() || "Player" + Math.floor(100 + Math.random() * 900);
    return () => {
      const n = cleanName(input.value);
      try { localStorage.setItem(NAME_KEY, n); } catch {}
      return n;
    };
  }

  // Invite links are just the game page with the room code in the hash: pong.html#AB3CD.
  // The hash never reaches the server, so this works with plain static hosting.
  const inviteUrl = (code) => location.origin + location.pathname + "#" + code;
  const invitedCode = () => {
    const m = location.hash.match(/^#([A-Za-z0-9]{5})$/);
    return m ? m[1].toUpperCase() : null;
  };
  const clearInvite = () => { if (location.hash) history.replaceState(null, "", location.pathname + location.search); };
  async function shareInvite(code, title) {
    const url = inviteUrl(code);
    // Phones get the native share sheet (Messages, Discord, …); desktops get the clipboard.
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try { await navigator.share({ title: `${title} on OXIDPVP`, text: `Join my ${title} room`, url }); return "shared"; }
      catch (e) { if (e && e.name === "AbortError") return false; }
    }
    try { await navigator.clipboard.writeText(url); return "copied"; } catch { return false; }
  }
  const INVITE_HTML = `
    <button class="btn primary full" data-act="invite" type="button">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      Copy invite link
    </button>`;
  const INVITED_HTML = `<div class="invited" hidden><span class="invited-dot"></span><span>You're invited to room <b></b></span></div>`;

  // ---------- Chat ----------
  // One floating chat per page. The lobbies call chat.open(sendFn) once there's someone to talk
  // to, chat.add(...) for each message, and chat.reset() when leaving the room.
  const CHAT_MAX = 200, CHAT_GAP_MS = 600;
  const QUICK = ["gg", "nice!", "lol", "one more?", "brb"];
  const cleanText = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, CHAT_MAX);

  const chat = (() => {
    let el = null, sendFn = null, unread = 0, lastSent = 0, peekTimer = 0;
    const $ = (s) => el.querySelector(s);

    function build() {
      el = document.createElement("div");
      el.className = "chat";
      el.hidden = true;
      el.innerHTML = `
        <div class="chat-peek" hidden></div>
        <div class="chat-panel" role="dialog" aria-label="Chat" hidden>
          <div class="chat-head"><span>Chat</span><button class="chat-close" type="button" aria-label="Close chat">&times;</button></div>
          <ol class="chat-log" aria-live="polite"></ol>
          <div class="chat-quick"></div>
          <form class="chat-form">
            <input maxlength="${CHAT_MAX}" placeholder="Say something…" autocomplete="off" aria-label="Chat message">
            <button class="btn" type="submit">Send</button>
          </form>
        </div>
        <button class="chat-toggle" type="button" aria-expanded="false" title="Chat (Enter)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>
          <span>Chat</span><b class="chat-badge" hidden></b>
        </button>`;
      for (const q of QUICK) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = q;
        b.addEventListener("click", () => submit(q));
        $(".chat-quick").append(b);
      }
      $(".chat-toggle").addEventListener("click", () => toggle());
      $(".chat-close").addEventListener("click", () => toggle(false));
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
        if (el.hidden || e.key !== "Enter" || e.repeat) return;
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || t.tagName === "A")) return;
        e.preventDefault();
        toggle(true);
      });
      document.body.appendChild(el);
    }

    function isOpen() { return el && !$(".chat-panel").hidden; }
    function toggle(force) {
      const open = force ?? !isOpen();
      $(".chat-panel").hidden = !open;
      $(".chat-toggle").setAttribute("aria-expanded", open);
      if (open) {
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

    return {
      open(send) {
        if (!el) build();
        sendFn = send;
        el.hidden = false;
      },
      // { name, text, me, sys }
      add(m) {
        if (!el) return;
        const text = cleanText(m.text);
        if (!text) return;
        const li = document.createElement("li");
        if (m.sys) { li.className = "sys"; li.textContent = text; }
        else {
          if (m.me) li.className = "me";
          const who = document.createElement("b");
          who.textContent = m.me ? "You" : cleanText(m.name).slice(0, 16) || "Player";
          const body = document.createElement("span");
          body.textContent = text;
          li.append(who, body);
        }
        const log = $(".chat-log");
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        log.append(li);
        while (log.children.length > 150) log.firstChild.remove();
        if (atBottom || m.me) log.scrollTop = log.scrollHeight;
        if (!isOpen() && !m.me && !el.hidden) {
          if (!m.sys) { unread++; badge(); }
          const peek = $(".chat-peek");
          peek.textContent = m.sys ? text : `${cleanText(m.name).slice(0, 16)}: ${text}`;
          peek.hidden = false;
          clearTimeout(peekTimer);
          peekTimer = setTimeout(() => { peek.hidden = true; }, 3500);
        }
      },
      reset() {
        if (!el) return;
        sendFn = null; unread = 0; badge();
        el.hidden = true;
        $(".chat-panel").hidden = true;
        $(".chat-peek").hidden = true;
        $(".chat-log").textContent = "";
      },
    };
  })();

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
          ${INVITED_HTML}
          <label class="field"><span>Your name</span><input class="name" maxlength="16" autocomplete="nickname" spellcheck="false"></label>
          <button class="btn primary full" data-act="host">Create room</button>
          <div class="or">or join</div>
          <form class="join">
            <input class="code-in" maxlength="${CODE_LEN}" placeholder="CODE" autocomplete="off" spellcheck="false" aria-label="Room code">
            <button class="btn" type="submit">Join</button>
          </form>
        </div>
        <div class="wait" data-view="wait" hidden>
          <div class="label">Room code</div>
          <button class="code" title="Click to copy the code"></button>
          ${INVITE_HTML}
          <p class="muted hint-sm">Send the link to your opponent, or have them type the code.</p>
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
    const input = $(".code-in");
    const codeBtn = $(".code");
    const netEl = document.getElementById("net");
    const myName = nameField($(".name"));

    let sock = null, opp = null, oppName = "Opponent", isHost = false, stopGame = null, pingTimer = null, gen = 0;
    let handlers = [], link = null, helloTimer = 0;

    const setStatus = (msg, cls = "") => { status.textContent = msg; status.className = "status " + cls; };
    const showMenu = () => { menuView.hidden = false; waitView.hidden = true; };
    const showWait = (code) => { menuView.hidden = true; waitView.hidden = false; codeBtn.textContent = code; };

    function teardown() {
      gen++; // invalidates any connection attempt still in flight
      clearInterval(pingTimer);
      if (stopGame) { try { stopGame(); } catch {} stopGame = null; }
      if (sock) { sock.close(); sock = null; }
      opp = null; handlers = []; link = null;
      clearTimeout(helloTimer);
      chat.reset();
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
          // Hold the seat until they tell us their name, then start.
          opp = m.id;
          setStatus("Opponent connecting…", "pulse");
          clearTimeout(helloTimer);
          helloTimer = setTimeout(() => {
            if (sock && opp === m.id && !link) { sock.send({ kick: m.id }); opp = null; setStatus("Waiting for opponent…", "pulse"); }
          }, 8000);
        } else if (m.sys === "leave") {
          if (m.id === opp && link) fail(`${oppName} disconnected.`);
          else if (m.id === opp) { opp = null; clearTimeout(helloTimer); setStatus("Waiting for opponent…", "pulse"); }
        } else if (m.from === opp && m.d) {
          if (m.d.__sys === "hello") {
            if (link) return;
            clearTimeout(helloTimer);
            oppName = cleanName(m.d.name);
            sock.send({ to: opp, d: { __sys: "accept", name: myName() } });
            start();
          } else deliver(m.d);
        }
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
        if (m.sys === "host-left") return fail(`${oppName} left the room.`);
        const d = m.d;
        if (!d) return;
        if (d.__sys === "accept") { oppName = cleanName(d.name); return start(); }
        if (d.__sys === "chat") return chat.add({ name: oppName, text: d.text });
        if (d.__sys === "reject") return fail(d.reason);
        deliver(d);
      }, () => { if (my === gen) fail("Lost connection to the game server."); });
      sock.send({ d: { __sys: "hello", name: myName() } });
    }

    function deliver(d) {
      if (d.__sys === "chat") return chat.add({ name: oppName, text: d.text });
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
      clearInvite();
      link = {
        isHost,
        myName: myName(),
        oppName,
        rtt: 0,
        send: (o) => { if (sock) sock.send(isHost ? { to: opp, d: o } : { d: o }); },
        onData: (fn) => handlers.push(fn),
      };
      pingTimer = setInterval(() => link && link.send({ __ping: performance.now() }), 1000);
      chat.open((text) => {
        if (!sock) return;
        sock.send(isHost ? { to: opp, d: { __sys: "chat", text } } : { d: { __sys: "chat", text } });
        chat.add({ text, me: true });
      });
      chat.add({ sys: true, text: `${oppName} joined. Say hi!` });
      stopGame = onStart(link) || null;
    }

    $('[data-act="host"]').addEventListener("click", () => { clearInvite(); hostRoom(); });
    $('[data-act="cancel"]').addEventListener("click", () => { teardown(); showMenu(); setStatus(""); });
    $(".join").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = input.value.trim().toUpperCase();
      if (code.length !== CODE_LEN) return setStatus(`Codes are ${CODE_LEN} characters.`, "error");
      joinRoom(code);
    });
    wireCodeUi(root, title, input, codeBtn, setStatus, (code) => joinRoom(code));
    window.addEventListener("beforeunload", teardown);
  }

  // Code input cleanup, copy buttons, and the invite-link arrival flow. Shared by both lobbies.
  function wireCodeUi(root, title, input, codeBtn, setStatus, join) {
    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
    codeBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(codeBtn.textContent); setStatus("Code copied.", "ok"); } catch {}
    });
    root.querySelector('[data-act="invite"]').addEventListener("click", async () => {
      const r = await shareInvite(codeBtn.textContent, title);
      if (r === "copied") setStatus("Invite link copied. Paste it to your friends.", "ok");
      else if (r === "shared") setStatus("Invite sent.", "ok");
      else if (r === false) setStatus("Couldn't copy. Share the code instead.", "error");
    });

    const invited = invitedCode();
    if (!invited) return;
    const box = root.querySelector(".invited");
    box.hidden = false;
    box.querySelector("b").textContent = invited;
    input.value = invited;
    const joinBtn = root.querySelector(".join button");
    joinBtn.classList.add("primary");
    joinBtn.textContent = "Join room";
    root.querySelector('[data-act="host"]').classList.remove("primary");
    // Returning players already picked a name, so drop them straight in.
    if (savedName()) setTimeout(() => join(invited), 0);
    else {
      setStatus("Pick a name, then hit Join room.");
      const nameIn = root.querySelector(".name");
      setTimeout(() => { nameIn.focus(); nameIn.select(); }, 50);
    }
  }

  // ---------- Multiplayer rooms (2–N players) ----------

  function mountRoom({ game, title, subtitle, min = 2, max = 6, onStart }) {
    const root = document.createElement("div");
    root.className = "overlay";
    root.innerHTML = `
      <div class="panel">
        <a class="back" href="index.html">&larr; All games</a>
        <h1></h1>
        <p class="sub"></p>
        <div data-view="menu">
          ${INVITED_HTML}
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
          <button class="code" title="Click to copy the code"></button>
          ${INVITE_HTML}
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

    const myName = nameField(nameIn);

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
      started = false; players = []; myId = -1; chatSeen.clear();
      chat.reset();
    }
    function backToMenu(msg, cls = "error") {
      root.hidden = false;
      teardown();
      showMenu();
      setStatus(msg, cls);
    }
    const toPlayers = (m) => { for (const p of players) if (p.id !== myId) sock.send({ to: p.id, d: m }); };

    // Chat goes through the host, which stamps the sender's name and relays it to everyone.
    const chatSeen = new Map(); // id -> last message time, to stop spam
    function hostChat(id, text, sys = false) {
      text = cleanText(text);
      if (!text || !sock) return;
      const p = players.find((x) => x.id === id);
      if (!sys) {
        if (!p) return;
        const now = Date.now();
        if (now - (chatSeen.get(id) || 0) < 400) return;
        chatSeen.set(id, now);
      }
      const m = { __sys: "chat", id, name: p ? p.name : "", text, sys };
      toPlayers(m);
      chat.add({ ...m, me: !sys && id === myId });
    }

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
      chat.open((text) => hostChat(0, text));
    }
    function onGuestData(id, d) {
      if (d.__sys === "hello") {
        if (started) return reject(id, "That game already started.");
        if (players.length >= max) return reject(id, "Room is full.");
        if (players.some((p) => p.id === id)) return;
        players.push({ id, name: cleanName(d.name) });
        sock.send({ to: id, d: { __sys: "welcome", id } });
        broadcastLobby();
        hostChat(0, `${cleanName(d.name)} joined`, true);
        return;
      }
      if (d.__sys === "chat") return hostChat(id, d.text);
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
      hostChat(0, `${p.name} left`, true);
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
          if (d.__sys === "welcome") {
            myId = d.id; showRoom(code); setStatus(""); clearInvite();
            chat.open((text) => sock && sock.send({ d: { __sys: "chat", text } }));
          }
          else if (d.__sys === "chat") chat.add({ name: d.name, text: d.text, sys: d.sys, me: !d.sys && d.id === myId });
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

    $('[data-act="host"]').addEventListener("click", () => { clearInvite(); createRoom(); });
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
    wireCodeUi(root, title, codeIn, codeBtn, setStatus, (code) => joinRoom(code));
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
    for (const old of document.querySelectorAll(".toast")) old.remove();
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
