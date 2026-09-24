// Word Bomb for 2–8 players. The bomb passes around the circle; on your turn you must type a
// real word that contains the letters shown (e.g. "ING") before it explodes. Explode and you
// lose a life; the last player standing wins. Use every letter A–V to earn a life back.
// Only the host downloads the dictionary and knows how long the fuse is.
(() => {
  const LIVES = 3, MAX_LIVES = 3, BOOM_MS = 2200;
  const FUSE_MIN = 10000, FUSE_MAX = 22000;
  const BONUS = "abcdefghijlmnopqrstuv"; // use them all to win a life
  const { h, results, hideResults } = Party;
  const $ = (id) => document.getElementById(id);

  let dictPromise = null;
  const loadDict = () => (dictPromise ||= fetch("data/words.txt").then((r) => r.text()).then((t) => new Set(t.split("\n"))));

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, dict, out) {
    const G = {
      players: room.players.map((p) => ({ id: p.id, name: p.name, av: p.av, lives: LIVES, out: false, letters: [] })),
      turn: null, chunk: "", used: new Set(), fuseEnds: 0, phase: "idle", last: null, winner: null, timer: 0, typing: "",
    };
    const byId = (id) => G.players.find((p) => p.id === id);
    const alive = () => G.players.filter((p) => !p.out);
    const nextAlive = (id) => {
      const L = G.players, i = L.findIndex((p) => p.id === id);
      for (let k = 1; k <= L.length; k++) { const p = L[(i + k + L.length) % L.length]; if (!p.out) return p.id; }
      return null;
    };
    const pickChunk = () => {
      const { two, three } = window.BOMB_CHUNKS;
      const list = Math.random() < 0.5 ? two : three;
      return list[Math.floor(Math.random() * list.length)];
    };

    function view(id) {
      const me = byId(id);
      return {
        t: "st", phase: G.phase, turn: G.turn, chunk: G.chunk, last: G.last, winner: G.winner, typing: G.typing,
        players: G.players.map(({ id, name, av, lives, out }) => ({ id, name, av, lives, out })),
        letters: me ? me.letters : [],
      };
    }
    const publish = () => { for (const p of G.players) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer);
      for (const p of G.players) { p.lives = LIVES; p.out = false; p.letters = []; }
      G.used = new Set(); G.winner = null; G.last = null;
      G.turn = G.players[Math.floor(Math.random() * G.players.length)].id;
      newBomb();
    }
    function newBomb() {
      G.phase = "play";
      G.chunk = pickChunk();
      G.typing = "";
      G.fuseEnds = Date.now() + FUSE_MIN + Math.random() * (FUSE_MAX - FUSE_MIN);
      clearTimeout(G.timer);
      G.timer = setTimeout(explode, G.fuseEnds - Date.now());
      publish();
    }
    function explode() {
      if (G.phase !== "play") return;
      const p = byId(G.turn);
      if (p) {
        p.lives--;
        if (p.lives <= 0) p.out = true;
      }
      G.phase = "boom";
      G.last = { k: "boom", id: G.turn, chunk: G.chunk };
      publish();
      G.timer = setTimeout(() => {
        const left = alive();
        if (left.length <= 1) return endGame(left[0] ? left[0].id : null);
        G.turn = nextAlive(G.turn);
        newBomb();
      }, BOOM_MS);
    }
    function typing(id, s) {
      if (G.phase !== "play" || id !== G.turn) return;
      G.typing = String(s || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 30);
      out.all({ t: "ty", id, s: G.typing });
    }
    function submit(id, word) {
      if (G.phase !== "play" || id !== G.turn) return;
      const w = String(word || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 30);
      let reason = null;
      if (!w.includes(G.chunk)) reason = `needs "${G.chunk.toUpperCase()}"`;
      else if (G.used.has(w)) reason = "already used";
      else if (!dict.has(w)) reason = "not a word";
      if (reason) { out.all({ t: "fx", k: "bad", id, w, reason }); return; }
      G.used.add(w);
      const p = byId(id);
      let bonus = false;
      for (const c of w) if (BONUS.includes(c) && !p.letters.includes(c)) p.letters.push(c);
      if (p.letters.length >= BONUS.length) {
        p.letters = [];
        if (p.lives < MAX_LIVES) { p.lives++; bonus = true; }
      }
      G.last = { k: "ok", id, w, bonus };
      G.chunk = pickChunk();
      G.typing = "";
      G.turn = nextAlive(id);
      publish();
    }
    function endGame(winner) {
      clearTimeout(G.timer);
      G.phase = "end"; G.winner = winner;
      publish();
    }
    function leave(id) {
      if (!byId(id)) return;
      const wasTurn = G.turn === id, next = nextAlive(id);
      G.players = G.players.filter((p) => p.id !== id);
      if (G.phase === "end") return publish();
      if (alive().length <= 1) return endGame(alive()[0] ? alive()[0].id : null);
      if (wasTurn && G.phase === "play") { G.turn = next; G.typing = ""; }
      publish();
    }
    return { G, newGame, typing, submit, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, tickTimer = 0, typeTimer = 0;
  const input = $("word");

  function layout() {
    const ring = $("ring");
    const seats = [...ring.querySelectorAll(".wb-seat")];
    const n = seats.length;
    const r = ring.getBoundingClientRect();
    const rx = r.width / 2 - 70, ry = r.height / 2 - 50;
    seats.forEach((el, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      el.style.left = r.width / 2 + Math.cos(a) * rx + "px";
      el.style.top = r.height / 2 + Math.sin(a) * ry + "px";
      el.dataset.angle = a;
    });
    const cur = seats.find((s) => s.classList.contains("turn"));
    $("arrow").style.transform = cur ? `rotate(${(+cur.dataset.angle * 180) / Math.PI - 90}deg)` : "";
    $("arrow").hidden = !cur;
  }
  addEventListener("resize", layout);

  function onState(v) {
    const prev = V;
    V = v;
    const myTurn = v.phase === "play" && v.turn === room.myId;
    const ring = $("ring");
    ring.querySelectorAll(".wb-seat").forEach((el) => el.remove());
    for (const p of v.players) {
      const seat = h("div", "wb-seat" + (p.id === v.turn && v.phase === "play" ? " turn" : "") + (p.out ? " out" : "") + (p.id === room.myId ? " me" : ""));
      seat.dataset.id = p.id;
      seat.append(GameUtil.avatar(p, "lg"), h("span", "pname", p.name));
      const hearts = h("span", "hearts");
      for (let i = 0; i < MAX_LIVES; i++) hearts.append(h("i", i < p.lives ? "on" : "", "♥"));
      seat.append(hearts);
      const typed = h("span", "typed", p.id === v.turn ? v.typing : "");
      seat.append(typed);
      if (v.last && v.last.id === p.id && v.last.k === "ok" && v.phase === "play") seat.append(h("span", "said", v.last.w));
      if (v.last && v.last.id === p.id && v.last.k === "boom" && v.phase === "boom") seat.append(h("span", "boom-tag", "💥"));
      ring.append(seat);
    }
    $("chunk").textContent = v.chunk.toUpperCase();
    $("bomb").classList.toggle("ticking", v.phase === "play");
    $("bomb").classList.toggle("exploded", v.phase === "boom");
    layout();

    // my input
    $("me").hidden = !myTurn;
    const turnP = v.players.find((p) => p.id === v.turn);
    $("status").textContent = v.phase === "boom" ? `💥 ${turnP ? turnP.name : ""} blew up!` : myTurn ? `Type a word with "${v.chunk.toUpperCase()}"` : turnP && v.phase === "play" ? `${turnP.name}'s turn` : "";
    if (myTurn && (!prev || prev.turn !== v.turn || prev.phase !== "play")) {
      input.value = "";
      input.focus();
      GameUtil.sfx("turn");
    }
    const letters = $("letters");
    letters.textContent = "";
    for (const c of BONUS) letters.append(h("span", v.letters.includes(c) ? "on" : "", c.toUpperCase()));

    clearInterval(tickTimer);
    if (myTurn) tickTimer = setInterval(() => GameUtil.sfx("tick"), 1000);

    if (prev) {
      if (v.phase === "boom" && prev.phase !== "boom") GameUtil.sfx("boom");
      else if (v.last && v.last.k === "ok" && (!prev.last || prev.last.w !== v.last.w)) GameUtil.sfx(v.last.bonus ? "win" : "good");
    }
    if (v.phase === "end") {
      clearInterval(tickTimer);
      if (!prev || prev.phase !== "end") {
        const won = v.winner === room.myId;
        GameUtil.sfx(won ? "win" : "lose");
        GameUtil.record("bomb", won ? "win" : "loss");
        const w = v.players.find((p) => p.id === v.winner);
        results({
          title: won ? "You win!" : w ? `${w.name} wins` : "Game over",
          rows: [...v.players].sort((a, b) => (b.id === v.winner) - (a.id === v.winner) || b.lives - a.lives).map((p) => ({ p, value: p.id === v.winner ? "last one standing" : "blew up", win: p.id === v.winner })),
          isHost: room.isHost, meId: room.myId,
        });
      }
    } else hideResults();
  }

  function onMsg(m) {
    if (m.t === "st") onState(m);
    else if (m.t === "ty") {
      const seat = document.querySelector(`.wb-seat[data-id="${m.id}"] .typed`);
      if (seat && m.id !== room.myId) seat.textContent = m.s;
    } else if (m.t === "fx" && m.k === "bad") {
      const seat = document.querySelector(`.wb-seat[data-id="${m.id}"]`);
      if (seat) { seat.classList.remove("shake"); void seat.offsetWidth; seat.classList.add("shake"); }
      if (m.id === room.myId) {
        $("status").textContent = `"${m.w}" ${m.reason}`;
        input.value = "";
        input.classList.remove("shake"); void input.offsetWidth; input.classList.add("shake");
        GameUtil.sfx("bad");
      }
    }
  }

  input.addEventListener("input", () => {
    input.value = input.value.toLowerCase().replace(/[^a-z]/g, "");
    const seat = document.querySelector(`.wb-seat[data-id="${room && room.myId}"] .typed`);
    if (seat) seat.textContent = input.value;
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => {
      if (!room || !V || V.turn !== room.myId) return;
      if (room.isHost) engine.typing(room.myId, input.value);
      else room.send({ t: "ty", s: input.value });
    }, 60);
  });
  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const w = input.value.trim();
    if (!w || !V || V.turn !== room.myId) return;
    if (room.isHost) engine.submit(room.myId, w);
    else room.send({ t: "sub", w });
  });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "bomb",
    title: "Word Bomb",
    subtitle: "Type a word containing the letters before the bomb goes off. Last one standing wins. 2 to 8 players.",
    min: 2,
    max: 8,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        $("status").textContent = "Loading dictionary…";
        const out = {
          to: (id, m) => (id === r.myId ? onMsg(m) : r.sendTo(id, m)),
          all: (m) => { r.broadcast(m); onMsg(m); },
        };
        loadDict().then((dict) => {
          if (room !== r) return;
          engine = createEngine(r, dict, out);
          r.onData((from, m) => {
            if (!m) return;
            if (m.t === "ty") engine.typing(from, m.s);
            else if (m.t === "sub") engine.submit(from, m.w);
          });
          r.onLeave((id) => engine.leave(id));
          r.onRejoin((id) => out.to(id, engine.view(id)));
          engine.newGame();
        }).catch(() => { $("status").textContent = "Couldn't load the dictionary. Refresh to try again."; });
      } else r.onData((_, m) => m && onMsg(m));
      return () => {
        if (engine) engine.stop();
        clearInterval(tickTimer);
        room = null; engine = null; V = null;
        hideResults();
      };
    },
  });
})();
