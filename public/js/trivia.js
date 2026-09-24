// Quiz Battle: multiple-choice trivia for 2–8 players.
// The host picks the questions, times the answers and keeps score. The correct answer is only
// sent out at reveal time, so guests can't read it from the network traffic.
(() => {
  const ANSWER_MS = 15000, REVEAL_MS = 4200, MAX_PTS = 1000, MIN_PTS = 500;
  const LETTERS = ["A", "B", "C", "D"];
  const $ = (id) => document.getElementById(id);

  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(players, send, settings) {
    const G = { players: players.map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 })), n: 0, total: 10, phase: "idle", timer: null };
    let deck = [], cur = null, last = { q: null, in: null, r: null, end: null };

    const scores = () => G.players.map((p) => ({ id: p.id, name: p.name, av: p.av, score: p.score }));

    function newGame() {
      clearTimeout(G.timer);
      for (const p of G.players) p.score = 0;
      const cfg = settings();
      deck = shuffle(cfg.pool.slice()).slice(0, cfg.count);
      G.total = deck.length;
      G.n = 0;
      last = { q: null, in: null, r: null, end: null };
      G.timer = setTimeout(ask, 700);
      send({ t: "new", scores: scores() });
    }

    function ask() {
      const [cat, q, right, ...wrong] = deck[G.n];
      const opts = shuffle([right, ...wrong]);
      cur = { opts, correct: opts.indexOf(right), start: Date.now(), picks: new Map() };
      G.phase = "q";
      G.n++;
      last = { q: { t: "q", n: G.n, of: G.total, cat, q, opts, dur: ANSWER_MS, scores: scores() }, in: null, r: null, end: null };
      send(last.q);
      G.timer = setTimeout(reveal, ANSWER_MS + 250); // small grace for latency
    }

    function answer(id, n, pick) {
      if (G.phase !== "q" || n !== G.n || cur.picks.has(id) || !(pick >= 0 && pick < cur.opts.length)) return;
      if (!G.players.some((p) => p.id === id)) return;
      cur.picks.set(id, { pick, ms: Math.min(ANSWER_MS, Date.now() - cur.start) });
      last.in = { t: "in", ids: [...cur.picks.keys()] };
      send(last.in);
      if (G.players.every((p) => cur.picks.has(p.id))) {
        clearTimeout(G.timer);
        G.timer = setTimeout(reveal, 400);
      }
    }

    function reveal() {
      if (G.phase !== "q") return;
      G.phase = "reveal";
      const picks = {}, gains = {};
      for (const p of G.players) {
        const a = cur.picks.get(p.id);
        if (!a) continue;
        picks[p.id] = a.pick;
        if (a.pick === cur.correct) {
          gains[p.id] = Math.round(MAX_PTS - (MAX_PTS - MIN_PTS) * (a.ms / ANSWER_MS));
          p.score += gains[p.id];
        }
      }
      last.r = { t: "r", n: G.n, correct: cur.correct, picks, gains, scores: scores() };
      send(last.r);
      G.timer = setTimeout(() => {
        if (G.n >= G.total) { G.phase = "end"; last.end = { t: "end", scores: scores() }; send(last.end); }
        else ask();
      }, REVEAL_MS);
    }

    function leave(id) {
      G.players = G.players.filter((p) => p.id !== id);
      if (G.phase === "q" && G.players.length && G.players.every((p) => cur.picks.has(p.id))) {
        clearTimeout(G.timer);
        G.timer = setTimeout(reveal, 400);
      }
    }

    // Everything a reconnecting player needs, in order, with the clock adjusted.
    function catchUp() {
      const out = [];
      if (last.q) out.push({ ...last.q, dur: G.phase === "q" ? Math.max(0, ANSWER_MS - (Date.now() - cur.start)) : 0 });
      if (last.in) out.push(last.in);
      if (last.r) out.push(last.r);
      if (last.end) out.push(last.end);
      return out;
    }
    const stop = () => clearTimeout(G.timer);
    return { G, newGame, answer, leave, stop, catchUp };
  }

  // =====================================================================
  // UI (everyone)
  // =====================================================================
  let room = null, engine = null, Q = null, myPick = -1, clockRaf = 0, clockEnds = 0, clockDur = 1;
  let lastScores = [];

  function send(m) {
    // host: to everyone, and to itself
    room.broadcast(m);
    onMsg(m);
  }

  function renderBoard(scores, { answered = [], gains = null } = {}) {
    lastScores = scores;
    const b = $("board");
    b.textContent = "";
    for (const p of [...scores].sort((a, c) => c.score - a.score)) {
      const el = document.createElement("div");
      el.className = "pl" + (p.id === room.myId ? " me" : "") + (answered.includes(p.id) ? " done" : "");
      const av = GameUtil.avatar(p);
      const nm = document.createElement("span"); nm.textContent = p.name;
      const pts = document.createElement("span"); pts.className = "pts"; pts.textContent = p.score;
      el.append(av, nm, pts);
      if (answered.includes(p.id)) { const t = document.createElement("span"); t.className = "tick"; t.textContent = "✓"; el.append(t); }
      if (gains && gains[p.id]) { const g = document.createElement("span"); g.className = "gain"; g.textContent = "+" + gains[p.id]; el.append(g); }
      b.append(el);
    }
    const mine = scores.find((p) => p.id === room.myId);
    $("myScore").textContent = mine ? mine.score + " pts" : "";
  }

  let lastSec = -1;
  function startClock(dur) {
    clockDur = dur;
    clockEnds = performance.now() + dur;
    cancelAnimationFrame(clockRaf);
    const bar = $("clockBar"), clock = $("clock");
    const tick = () => {
      const left = Math.max(0, clockEnds - performance.now());
      bar.style.width = (left / clockDur) * 100 + "%";
      clock.classList.toggle("urgent", left < 4000);
      const sec = Math.ceil(left / 1000);
      if (sec !== lastSec) { lastSec = sec; if (sec > 0 && sec <= 3 && Q && !Q.revealed && myPick < 0) GameUtil.sfx("tick"); }
      if (left > 0) clockRaf = requestAnimationFrame(tick);
    };
    tick();
  }
  function stopClock(full) {
    cancelAnimationFrame(clockRaf);
    $("clockBar").style.width = full ? "100%" : "0%";
    $("clock").classList.remove("urgent");
  }

  function pick(i) {
    if (!Q || Q.revealed || myPick >= 0 || i < 0 || i >= Q.opts.length) return;
    myPick = i;
    const btns = $("opts").children;
    for (let k = 0; k < btns.length; k++) {
      btns[k].disabled = true;
      btns[k].classList.toggle("picked", k === i);
      btns[k].classList.toggle("dim", k !== i);
    }
    $("msg").textContent = "Locked in. Waiting for the others…";
    $("msg").className = "tv-msg";
    if (room.isHost) engine.answer(room.myId, Q.n, i);
    else room.send({ t: "ans", n: Q.n, pick: i });
  }
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 4) pick(n - 1);
  });

  function onMsg(m) {
    if (!room || !m || typeof m.t !== "string") return;
    if (m.t === "new") {
      $("result").hidden = true;
      Q = null;
      $("qNum").textContent = "Get ready…";
      $("qCat").hidden = true;
      $("question").textContent = "Here comes the first question…";
      $("opts").textContent = "";
      $("msg").textContent = "";
      stopClock(true);
      renderBoard(m.scores);
    } else if (m.t === "q") {
      Q = { n: m.n, opts: m.opts, revealed: false };
      myPick = -1;
      $("result").hidden = true;
      $("qNum").textContent = `Question ${m.n} / ${m.of}`;
      $("qCat").hidden = false;
      $("qCat").textContent = m.cat;
      const qEl = $("question");
      qEl.textContent = m.q;
      qEl.classList.remove("anim-pop"); void qEl.offsetWidth; qEl.classList.add("anim-pop");
      const opts = $("opts");
      opts.textContent = "";
      m.opts.forEach((o, i) => {
        const b = document.createElement("button");
        b.className = "tv-opt";
        const l = document.createElement("b"); l.textContent = LETTERS[i];
        const t = document.createElement("span"); t.textContent = o;
        const who = document.createElement("span"); who.className = "who";
        b.append(l, t, who);
        b.addEventListener("click", () => pick(i));
        opts.append(b);
      });
      $("msg").textContent = "";
      $("msg").className = "tv-msg";
      startClock(m.dur);
      GameUtil.sfx("pop");
      renderBoard(m.scores);
    } else if (m.t === "in") {
      renderBoard(lastScores, { answered: m.ids });
    } else if (m.t === "r") {
      if (!Q || Q.n !== m.n) return;
      Q.revealed = true;
      stopClock(false);
      const btns = $("opts").children;
      for (let k = 0; k < btns.length; k++) {
        btns[k].disabled = true;
        btns[k].classList.toggle("right", k === m.correct);
        btns[k].classList.toggle("dim", k !== m.correct);
        btns[k].classList.toggle("picked", k === myPick);
        const who = btns[k].querySelector(".who");
        who.textContent = "";
        for (const p of lastScores) {
          if (m.picks[p.id] !== k) continue;
          const s = GameUtil.avatar(p);
          s.title = p.name;
          who.append(s);
        }
      }
      const gain = m.gains[room.myId];
      const msg = $("msg");
      GameUtil.sfx(gain ? "good" : "bad");
      if (gain) { msg.textContent = `Correct! +${gain}`; msg.className = "tv-msg good"; }
      else if (myPick < 0) { msg.textContent = "Too slow! The answer was " + LETTERS[m.correct] + "."; msg.className = "tv-msg bad"; }
      else { msg.textContent = "Nope. The answer was " + LETTERS[m.correct] + "."; msg.className = "tv-msg bad"; }
      renderBoard(m.scores, { gains: m.gains });
    } else if (m.t === "end") {
      stopClock(false);
      renderBoard(m.scores);
      showResults(m.scores);
    }
  }

  function showResults(scores) {
    const sorted = [...scores].sort((a, c) => c.score - a.score);
    const top = sorted[0] ? sorted[0].score : 0;
    const winners = sorted.filter((p) => p.score === top);
    const iWon = winners.some((p) => p.id === room.myId);
    GameUtil.sfx(iWon ? "win" : "lose");
    GameUtil.record("trivia", iWon ? "win" : "loss");
    $("resultTitle").textContent = iWon ? (winners.length > 1 ? "Tied for 1st" : "You win") : winners[0].name + " wins";
    const list = $("standings");
    list.textContent = "";
    sorted.forEach((p, i) => {
      const li = document.createElement("li");
      if (p.score === top) li.className = "win";
      const pos = document.createElement("span"); pos.className = "pos"; pos.textContent = i + 1;
      const nm = document.createElement("span"); nm.className = "pname"; nm.textContent = p.name + (p.id === room.myId ? " (you)" : "");
      const n = document.createElement("span"); n.className = "n"; n.textContent = p.score + " pts";
      li.append(pos, GameUtil.avatar(p), nm, n);
      list.append(li);
    });
    $("again").hidden = !room.isHost;
    $("againWait").hidden = room.isHost;
    $("result").hidden = false;
  }
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  // =====================================================================
  // Quiz pack settings (host, in the lobby)
  // =====================================================================
  const SET_KEY = "oxidpvp-trivia";
  const CATS = [...new Set(window.TRIVIA_QUESTIONS.map((q) => q[0]))];
  function loadSettings() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SET_KEY)); } catch {}
    return { cats: CATS, count: 10, custom: "", onlyCustom: false, ...(s || {}) };
  }
  function saveSettings(s) { try { localStorage.setItem(SET_KEY, JSON.stringify(s)); } catch {} }
  // "Question | right answer | wrong | wrong | wrong", one per line (1 to 3 wrong answers).
  function parseCustom(text) {
    const out = [];
    for (const line of String(text).split(/\n/)) {
      const parts = line.split("|").map((x) => x.trim().slice(0, 120)).filter(Boolean);
      if (parts.length >= 3 && parts.length <= 5 && parts[0].length >= 3) out.push(["Custom", parts[0].slice(0, 200), ...parts.slice(1)]);
    }
    return out.slice(0, 100);
  }
  function readSettings() {
    const s = loadSettings();
    const custom = parseCustom(s.custom);
    let pool = s.onlyCustom ? [] : window.TRIVIA_QUESTIONS.filter((q) => s.cats.includes(q[0]));
    pool = pool.concat(custom);
    if (!pool.length) pool = window.TRIVIA_QUESTIONS.slice();
    return { pool, count: Math.min(s.count, pool.length) };
  }
  function buildSettings(el) {
    const s = loadSettings();
    el.innerHTML = `
      <div class="set-head">Questions</div>
      <div class="seg" role="group" aria-label="How many questions"></div>
      <div class="set-head">Categories</div>
      <div class="chips"></div>
      <details class="custom-q">
        <summary>Your own questions <span class="cq-n"></span></summary>
        <textarea rows="5" spellcheck="false" placeholder="One per line:&#10;Question | right answer | wrong | wrong | wrong"></textarea>
        <label class="check"><input type="checkbox"> Only use my questions</label>
      </details>`;
    const seg = el.querySelector(".seg"), chips = el.querySelector(".chips");
    for (const n of [5, 10, 15, 20]) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = n;
      b.addEventListener("click", () => { s.count = n; save(); });
      seg.append(b);
    }
    for (const c of CATS) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = c;
      b.addEventListener("click", () => {
        s.cats = s.cats.includes(c) ? s.cats.filter((x) => x !== c) : [...s.cats, c];
        if (!s.cats.length) s.cats = [c];
        save();
      });
      chips.append(b);
    }
    const ta = el.querySelector("textarea"), only = el.querySelector(".check input");
    ta.value = s.custom; only.checked = s.onlyCustom;
    ta.addEventListener("input", () => { s.custom = ta.value; save(); });
    only.addEventListener("change", () => { s.onlyCustom = only.checked; save(); });
    function save() {
      saveSettings(s);
      [...seg.children].forEach((b) => b.classList.toggle("on", +b.textContent === s.count));
      [...chips.children].forEach((b) => b.classList.toggle("on", s.cats.includes(b.textContent)));
      const n = parseCustom(s.custom).length;
      el.querySelector(".cq-n").textContent = n ? `(${n})` : "";
      chips.classList.toggle("off", s.onlyCustom);
    }
    save();
  }

  Room.mount({
    game: "trivia",
    title: "Quiz Battle",
    subtitle: "Trivia race for 2 to 8 players. 15 seconds a question, and faster right answers score more.",
    min: 2,
    max: 8,
    lobbyExtra: buildSettings,
    onStart(r) {
      room = r;
      Q = null; myPick = -1;
      if (r.isHost) {
        engine = createEngine(r.players, send, readSettings);
        r.onData((from, m) => { if (m && m.t === "ans") engine.answer(from, m.n | 0, m.pick | 0); });
        r.onRejoin((id) => { for (const m of engine.catchUp()) r.sendTo(id, m); });
        r.onLeave((id) => { engine.leave(id); lastScores = lastScores.filter((p) => p.id !== id); });
        setTimeout(() => engine && engine.newGame(), 300);
      } else {
        r.onData((_, m) => onMsg(m));
      }
      renderBoard(r.players.map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 })));
      return () => {
        if (engine) engine.stop();
        cancelAnimationFrame(clockRaf);
        room = null; engine = null; Q = null;
        $("result").hidden = true;
        $("opts").textContent = "";
        $("board").textContent = "";
        $("question").textContent = "Waiting for the first question…";
      };
    },
  });
})();
