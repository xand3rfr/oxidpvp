// Bingo for 2–10 players. Classic 75-ball cards (B 1–15, I 16–30, N 31–45 with a free centre,
// G 46–60, O 61–75). The host calls a number every few seconds; mark it on your card and hit
// BINGO when you complete a row, column or diagonal. The host deals the cards and checks every
// claim against the numbers actually called. A false claim locks you out for a few seconds.
(() => {
  const CALL_MS = 3800, LOCK_MS = 6000;
  const LETTERS = "BINGO";
  const { h, results, hideResults } = Party;
  const $ = (id) => document.getElementById(id);
  const letterOf = (n) => LETTERS[Math.floor((n - 1) / 15)];

  function makeCard() {
    const cols = [];
    for (let c = 0; c < 5; c++) {
      const pool = GameUtil.shuffle(Array.from({ length: 15 }, (_, i) => c * 15 + i + 1));
      cols.push(pool.slice(0, 5));
    }
    const card = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) card.push(r === 2 && c === 2 ? 0 : cols[c][r]);
    return card; // row-major, 0 = free space
  }
  const LINES = (() => {
    const L = [];
    for (let i = 0; i < 5; i++) {
      L.push([0, 1, 2, 3, 4].map((c) => i * 5 + c));
      L.push([0, 1, 2, 3, 4].map((r) => r * 5 + i));
    }
    L.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
    return L;
  })();
  const winningLine = (card, isMarked) => LINES.find((line) => line.every((i) => card[i] === 0 || isMarked(card[i])));

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], bag: [], called: [], phase: "idle", winner: null, line: null, timer: 0, locks: {} };
    const byId = (id) => G.players.find((p) => p.id === id);
    function view(id) {
      const p = byId(id);
      return {
        // copies, so the host's own screen never shares arrays with the engine
        t: "st", phase: G.phase, called: G.called.slice(), winner: G.winner, line: G.line,
        card: p ? p.card.slice() : null,
        lock: Math.max(0, (G.locks[id] || 0) - Date.now()),
        players: G.players.map(({ id, name, av }) => ({ id, name, av })),
      };
    }
    const publish = () => { for (const p of G.players) out.to(p.id, view(p.id)); };
    function newGame() {
      clearInterval(G.timer);
      G.players = room.players.filter((p) => !(G.gone && G.gone.has(p.id))).map((p) => ({ id: p.id, name: p.name, av: p.av, card: makeCard() }));
      G.bag = GameUtil.shuffle(Array.from({ length: 75 }, (_, i) => i + 1));
      G.called = []; G.winner = null; G.line = null; G.locks = {};
      G.phase = "play";
      publish();
      G.timer = setInterval(call, CALL_MS);
    }
    function call() {
      if (G.phase !== "play") return;
      if (!G.bag.length) { clearInterval(G.timer); G.phase = "end"; return publish(); }
      G.called.push(G.bag.pop());
      out.all({ t: "call", n: G.called[G.called.length - 1], count: G.called.length });
    }
    function claim(id) {
      const p = byId(id);
      if (G.phase !== "play" || !p || (G.locks[id] || 0) > Date.now()) return;
      const line = winningLine(p.card, (n) => G.called.includes(n));
      if (!line) {
        G.locks[id] = Date.now() + LOCK_MS;
        out.to(id, { t: "false", lock: LOCK_MS });
        out.all({ t: "fx", text: `${p.name} called a false bingo!` });
        return;
      }
      clearInterval(G.timer);
      G.phase = "end"; G.winner = id; G.line = line;
      publish();
    }
    function leave(id) {
      (G.gone ||= new Set()).add(id);
      G.players = G.players.filter((p) => p.id !== id);
      if (G.players.length < 1 && G.phase === "play") { clearInterval(G.timer); G.phase = "end"; }
      publish();
    }
    return { G, newGame, claim, leave, view, stop: () => clearInterval(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, marks = new Set(), lockUntil = 0, lockTimer = 0;
  const AUTO_KEY = "oxidpvp-bingo-auto";
  let auto = localStorage.getItem(AUTO_KEY) !== "0";
  $("auto").checked = auto;
  $("auto").addEventListener("change", () => { auto = $("auto").checked; try { localStorage.setItem(AUTO_KEY, auto ? "1" : "0"); } catch {} if (auto) autoMark(); renderCard(); });

  function autoMark() { if (V && V.card) for (const n of V.card) if (n && V.called.includes(n)) marks.add(n); }

  function renderCard() {
    if (!V || !V.card) return;
    const grid = $("card");
    grid.textContent = "";
    for (const L of LETTERS) grid.append(h("div", "bg-head", L));
    V.card.forEach((n, i) => {
      const called = n === 0 || V.called.includes(n);
      const b = h("button", "bg-cell" + (n === 0 ? " free" : "") + (marks.has(n) || n === 0 ? " marked" : "") + (V.line && V.winner === room.myId && V.line.includes(i) ? " line" : ""), n === 0 ? "★" : n);
      b.type = "button";
      b.disabled = n === 0 || V.phase !== "play";
      b.addEventListener("click", () => {
        if (!called) { GameUtil.toast(`${letterOf(n)} ${n} hasn't been called yet`); GameUtil.sfx("bad"); return; }
        marks.has(n) ? marks.delete(n) : marks.add(n);
        GameUtil.sfx("click");
        renderCard();
      });
      grid.append(b);
    });
    const ready = !!winningLine(V.card, (n) => marks.has(n) && V.called.includes(n));
    const locked = lockUntil > performance.now();
    $("bingo").disabled = V.phase !== "play" || locked;
    $("bingo").classList.toggle("ready", ready && !locked);
  }

  function renderCalled() {
    const last = V.called[V.called.length - 1];
    $("ball").textContent = last ? `${letterOf(last)}${last}` : "–";
    $("ball").dataset.l = last ? letterOf(last) : "";
    $("count").textContent = `${V.called.length} of 75 called`;
    const recent = $("recent");
    recent.textContent = "";
    for (const n of V.called.slice(-8, -1).reverse()) recent.append(h("span", "bg-mini l" + letterOf(n), `${letterOf(n)}${n}`));
    const board = $("allCalled");
    board.textContent = "";
    for (let c = 0; c < 5; c++) {
      const row = h("div", "bg-row");
      row.append(h("b", "", LETTERS[c]));
      for (let n = c * 15 + 1; n <= c * 15 + 15; n++) row.append(h("span", V.called.includes(n) ? "on" : "", n));
      board.append(row);
    }
  }

  function onMsg(m) {
    if (m.t === "st") {
      const prev = V;
      V = m;
      if (!prev || (prev.phase === "end" && m.phase === "play") || JSON.stringify(prev.card) !== JSON.stringify(m.card)) marks = new Set();
      lockUntil = performance.now() + m.lock;
      if (auto) autoMark();
      renderCalled(); renderCard();
      $("players").textContent = m.players.length + " playing";
      if (m.phase === "end" && (!prev || prev.phase !== "end")) {
        const won = m.winner === room.myId;
        const w = m.players.find((p) => p.id === m.winner);
        GameUtil.sfx(won ? "win" : "lose");
        if (m.winner != null) GameUtil.record("bingo", won ? "win" : "loss");
        results({
          title: won ? "BINGO! You win!" : w ? `${w.name} got bingo!` : "No bingo this time",
          rows: [...m.players].sort((a, b) => (b.id === m.winner) - (a.id === m.winner)).map((p) => ({ p, value: p.id === m.winner ? "🎉 bingo" : "", win: p.id === m.winner })),
          isHost: room.isHost, meId: room.myId,
        });
      } else if (m.phase !== "end") hideResults();
    } else if (m.t === "call") {
      if (!V) return;
      V.called = [...V.called, m.n];
      if (auto) autoMark();
      renderCalled(); renderCard();
      const onCard = V.card && V.card.includes(m.n);
      GameUtil.sfx(onCard ? "good" : "tick");
      $("ball").classList.remove("pop"); void $("ball").offsetWidth; $("ball").classList.add("pop");
    } else if (m.t === "false") {
      lockUntil = performance.now() + m.lock;
      GameUtil.toast("Not a bingo! Locked out for a few seconds.");
      GameUtil.sfx("bad");
      renderCard();
      clearTimeout(lockTimer);
      lockTimer = setTimeout(renderCard, m.lock + 50);
    } else if (m.t === "fx") GameUtil.toast(m.text);
  }

  $("bingo").addEventListener("click", () => {
    if (!V || V.phase !== "play") return;
    if (room.isHost) engine.claim(room.myId); else room.send({ t: "bingo" });
  });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "bingo",
    title: "Bingo",
    subtitle: "Numbers get called, you mark your card. First to a full row, column or diagonal who hits BINGO wins. 2 to 10 players.",
    min: 2,
    max: 10,
    onStart(r) {
      room = r; V = null; marks = new Set();
      if (r.isHost) {
        const out = {
          to: (id, m) => (id === r.myId ? onMsg(m) : r.sendTo(id, m)),
          all: (m) => { r.broadcast(m); onMsg(m); },
        };
        engine = createEngine(r, out);
        r.onData((from, m) => { if (m && m.t === "bingo") engine.claim(from); });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => out.to(id, engine.view(id)));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => m && onMsg(m));
      return () => { if (engine) engine.stop(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
