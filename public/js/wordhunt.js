// Word Hunt, 1–8 players. Everyone gets the same 4×4 letter grid and two minutes to find words by
// chaining neighboring tiles (including diagonals, no tile twice). Drag across tiles or type.
// Longer words score more; a word more than one player found scores for nobody. The host checks
// every word against the grid and the dictionary (data/words.txt, loaded on this page only).
(() => {
  const ROUND_MS = 120000, SHOW_MS = 12000, ROUNDS = 3;
  // Letter dice (the classic 16-die set, with Q as "Qu").
  const DICE = ["AAEEGN", "ELRTTY", "AOOTTW", "ABBJOO", "EHRTVW", "CIMOTU", "DISTTY", "EIOSST", "DELRVY", "ACHOPS", "HIMNQU", "EEINSU", "EEGHNW", "AFFKPS", "HLNNRZ", "DEILRX"];
  const points = (w) => (w.length <= 4 ? 1 : w.length === 5 ? 2 : w.length === 6 ? 3 : w.length === 7 ? 5 : 11);
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);

  // ---------- dictionary ----------
  let WORDS = null, PREFIX = null;
  const dictReady = fetch("data/words.txt").then((r) => r.text()).then((t) => { WORDS = new Set(t.split("\n")); }).catch(() => { WORDS = new Set(); });
  function prefixes() {
    if (PREFIX) return PREFIX;
    PREFIX = new Set();
    for (const w of WORDS) for (let i = 1; i < w.length; i++) PREFIX.add(w.slice(0, i));
    return PREFIX;
  }

  // ---------- grid helpers ----------
  const tile = (g, i) => (g[i] === "Q" ? "qu" : g[i].toLowerCase());
  const adj = (a, b) => a !== b && Math.abs((a >> 2) - (b >> 2)) <= 1 && Math.abs((a & 3) - (b & 3)) <= 1;
  // Can `word` be traced on grid g? Returns the path or null.
  function trace(g, word) {
    const walk = (pos, i, used) => {
      if (pos === word.length) return [];
      for (let k = 0; k < 16; k++) {
        if (used.has(k) || (i >= 0 && !adj(i, k))) continue;
        const t = tile(g, k);
        if (!word.startsWith(t, pos)) continue;
        used.add(k);
        const rest = walk(pos + t.length, k, used);
        used.delete(k);
        if (rest) return [k, ...rest];
      }
      return null;
    };
    return walk(0, -1, new Set());
  }
  function solveAll(g) {
    const found = new Set(), P = prefixes();
    const dfs = (i, used, s) => {
      s += tile(g, i);
      if (s.length >= 3 && WORDS.has(s)) found.add(s);
      if (!P.has(s)) return;
      for (let k = 0; k < 16; k++) if (!used.has(k) && adj(i, k)) { used.add(k); dfs(k, used, s); used.delete(k); }
    };
    for (let i = 0; i < 16; i++) dfs(i, new Set([i]), "");
    return [...found];
  }

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], round: 0, phase: "idle", grid: [], ends: 0, words: {}, reveal: null, timer: 0, gone: new Set() };
    const byId = (id) => G.players.find((p) => p.id === id);
    const view = (id) => ({
      t: "st", phase: G.phase, round: G.round, rounds: ROUNDS, grid: G.grid, left: Math.max(0, G.ends - Date.now()),
      players: G.players.map((p) => ({ id: p.id, name: p.name, av: p.av, score: p.score, n: (G.words[p.id] || []).length })),
      mine: G.words[id] || [], reveal: G.reveal,
    });
    const publish = () => { for (const p of room.players) if (!G.gone.has(p.id)) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer);
      G.players = room.players.filter((p) => !G.gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 }));
      G.round = 0;
      nextRound();
    }
    function nextRound() {
      clearTimeout(G.timer);
      G.round++;
      if (G.round > ROUNDS) { G.phase = "end"; return publish(); }
      G.grid = GameUtil.shuffle(DICE.map((d) => d[Math.floor(Math.random() * 6)]));
      G.words = {}; G.reveal = null;
      G.phase = "play";
      G.ends = Date.now() + ROUND_MS;
      G.timer = setTimeout(endRound, ROUND_MS);
      publish();
    }
    async function submit(id, word) {
      if (G.phase !== "play" || !byId(id)) return;
      word = String(word || "").toLowerCase().replace(/[^a-z]/g, "");
      await dictReady;
      const list = G.words[id] || (G.words[id] = []);
      let ok = word.length >= 3 && !list.includes(word) && WORDS.has(word) && trace(G.grid, word);
      out.to(id, { t: "ack", word, ok: !!ok });
      if (ok) { list.push(word); publish(); }
    }
    async function endRound() {
      if (G.phase !== "play") return;
      await dictReady;
      const count = {};
      for (const list of Object.values(G.words)) for (const w of list) count[w] = (count[w] || 0) + 1;
      const solo = G.players.length === 1;
      const per = {};
      for (const p of G.players) {
        const list = G.words[p.id] || [];
        const scored = list.map((w) => ({ w, pts: solo || count[w] === 1 ? points(w) : 0 }));
        const gain = scored.reduce((a, x) => a + x.pts, 0);
        p.score += gain;
        per[p.id] = { words: scored.sort((a, b) => b.w.length - a.w.length), gain };
      }
      const all = solveAll(G.grid).sort((a, b) => b.length - a.length || a.localeCompare(b));
      G.reveal = { per, best: all.slice(0, 12), total: all.length };
      G.phase = "show";
      G.ends = Date.now() + SHOW_MS;
      G.timer = setTimeout(nextRound, SHOW_MS);
      publish();
    }
    function leave(id) {
      G.gone.add(id);
      G.players = G.players.filter((p) => p.id !== id);
      if (!G.players.length) { clearTimeout(G.timer); return; }
      publish();
    }
    return { G, newGame, submit, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null, path = [], dragging = false;
  const send = (word) => { if (room.isHost) engine.submit(room.myId, word); else room.send({ t: "w", word }); };

  function renderGrid() {
    const g = $("grid");
    if (g.childElementCount !== 16) {
      g.textContent = "";
      for (let i = 0; i < 16; i++) { const b = h("div", "wh-tile"); b.dataset.i = i; g.append(b); }
    }
    [...g.children].forEach((b, i) => {
      b.textContent = V && V.grid[i] ? (V.grid[i] === "Q" ? "Qu" : V.grid[i]) : "";
      b.classList.toggle("on", path.includes(i));
      b.classList.toggle("head", path[path.length - 1] === i);
    });
    $("current").textContent = V ? path.map((i) => tile(V.grid, i)).join("").toUpperCase() : "";
  }
  function render() {
    const v = V;
    $("round").textContent = v.phase === "end" ? "Game over" : `Round ${v.round} of ${v.rounds}`;
    renderGrid();
    $("playBox").hidden = v.phase !== "play";
    $("showBox").hidden = v.phase !== "show";
    const mine = $("mine");
    mine.textContent = "";
    for (const w of [...v.mine].reverse()) mine.append(h("span", "wh-word", w.toUpperCase()));
    $("mineCount").textContent = `${v.mine.length} word${v.mine.length === 1 ? "" : "s"} · ${v.mine.reduce((a, w) => a + points(w), 0)} pts if nobody else finds them`;
    if (v.phase === "show" && v.reveal) {
      const box = $("reveal");
      box.textContent = "";
      for (const p of [...v.players].sort((a, b) => (v.reveal.per[b.id]?.gain || 0) - (v.reveal.per[a.id]?.gain || 0))) {
        const r = v.reveal.per[p.id] || { words: [], gain: 0 };
        const col = h("div", "wh-col");
        const head = h("div", "wh-head");
        head.append(GameUtil.avatar(p, "xs"), h("b", "", p.id === room.myId ? "You" : p.name), h("span", "", `+${r.gain}`));
        col.append(head);
        const ws = h("div", "wh-words");
        for (const x of r.words) ws.append(h("span", "wh-word" + (x.pts ? "" : " dup"), x.w.toUpperCase()));
        col.append(ws);
        box.append(col);
      }
      $("best").textContent = `Best words on this board: ${v.reveal.best.map((w) => w.toUpperCase()).join(", ")} (${v.reveal.total} in all)`;
    }
    const board = $("board");
    board.textContent = "";
    for (const p of [...v.players].sort((a, b) => b.score - a.score)) {
      const el = h("div", "pl" + (p.id === room.myId ? " me" : ""));
      el.append(GameUtil.avatar(p), h("span", "", p.name), h("span", "pts", p.score), h("span", "gain", v.phase === "play" ? `${p.n} found` : ""));
      board.append(el);
    }
  }
  function onState(v) {
    const prev = V;
    V = v;
    if (!prev || prev.round !== v.round) path = [];
    if (v.phase !== "end") render();
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase === "play" ? fmt(left) : ""; });
    if (prev && prev.phase !== v.phase && v.phase === "play") { GameUtil.sfx("start"); setTimeout(() => $("typeIn").focus(), 50); }
    if (prev && prev.phase !== v.phase && v.phase === "show") GameUtil.sfx("pop");
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const top = sorted[0] ? sorted[0].score : 0, solo = v.players.length === 1;
      const won = sorted.some((p) => p.id === room.myId && p.score === top);
      GameUtil.sfx(won ? "win" : "lose");
      if (!solo) GameUtil.record("wordhunt", won ? "win" : "loss");
      results({ title: solo ? `${top} points!` : won ? "Word wizard!" : `${sorted[0].name} wins`, rows: sorted.map((p) => ({ p, value: p.score + " pts", win: p.score === top })), isHost: room.isHost, meId: room.myId });
    } else if (v.phase !== "end") hideResults();
  }
  function onAck(m) {
    const f = $("flash");
    f.textContent = m.ok ? `+ ${m.word.toUpperCase()}` : `✗ ${m.word.toUpperCase() || "?"}`;
    f.className = "wh-flash " + (m.ok ? "good" : "bad");
    GameUtil.sfx(m.ok ? "good" : "bad");
  }

  // Drag across tiles (mouse or touch). Pointer capture keeps events coming while we check
  // which tile is under the pointer; only the tile's inner circle counts, so diagonals are easy.
  const grid = $("grid");
  function tileAt(x, y) {
    for (const b of grid.children) {
      const r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (Math.hypot(x - cx, y - cy) < r.width * 0.42) return +b.dataset.i;
    }
    return -1;
  }
  grid.addEventListener("pointerdown", (e) => {
    if (!V || V.phase !== "play") return;
    e.preventDefault();
    grid.setPointerCapture(e.pointerId);
    dragging = true;
    const i = tileAt(e.clientX, e.clientY);
    path = i >= 0 ? [i] : [];
    renderGrid();
  });
  grid.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const i = tileAt(e.clientX, e.clientY);
    if (i < 0) return;
    if (path.length >= 2 && path[path.length - 2] === i) { path.pop(); renderGrid(); return; } // slide back to undo
    if (!path.includes(i) && (!path.length || adj(path[path.length - 1], i))) { path.push(i); GameUtil.sfx("click"); renderGrid(); }
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    const word = path.map((i) => tile(V.grid, i)).join("");
    path = [];
    renderGrid();
    if (word.length >= 3) send(word);
  };
  grid.addEventListener("pointerup", finish);
  grid.addEventListener("pointercancel", finish);
  $("typeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const w = $("typeIn").value.trim();
    $("typeIn").value = "";
    if (w.length >= 3) send(w);
  });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "wordhunt",
    title: "Word Hunt",
    subtitle: "Find words in a 4×4 letter grid by chaining neighboring tiles. Unique words score. 1 to 8 players.",
    min: 1,
    max: 8,
    onStart(r) {
      room = r; V = null; path = [];
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? (m.t === "ack" ? onAck(m) : onState(m)) : r.sendTo(id, m)) };
        engine = createEngine(r, out);
        r.onData((from, m) => { if (m && m.t === "w") engine.submit(from, m.word); });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view(id)));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (!m) return; if (m.t === "st") onState(m); else if (m.t === "ack") onAck(m); });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
