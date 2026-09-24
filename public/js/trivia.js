// Quiz Battle: multiple-choice trivia for 2–8 players.
// The host picks the questions, times the answers and keeps score. The correct answer is only
// sent out at reveal time, so guests can't read it from the network traffic.
(() => {
  const ROUNDS = 10, ANSWER_MS = 15000, REVEAL_MS = 4200, MAX_PTS = 1000, MIN_PTS = 500;
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
  function createEngine(players, send) {
    const bank = window.TRIVIA_QUESTIONS;
    const G = { players: players.map((p) => ({ id: p.id, name: p.name, score: 0 })), n: 0, phase: "idle", timer: null };
    let deck = [], cur = null;

    const scores = () => G.players.map((p) => ({ id: p.id, name: p.name, score: p.score }));

    function newGame() {
      clearTimeout(G.timer);
      for (const p of G.players) p.score = 0;
      deck = shuffle(bank.map((_, i) => i)).slice(0, ROUNDS);
      G.n = 0;
      G.timer = setTimeout(ask, 700);
      send({ t: "new", scores: scores() });
    }

    function ask() {
      const [cat, q, right, ...wrong] = bank[deck[G.n]];
      const opts = shuffle([right, ...wrong]);
      cur = { opts, correct: opts.indexOf(right), start: Date.now(), picks: new Map() };
      G.phase = "q";
      G.n++;
      send({ t: "q", n: G.n, of: ROUNDS, cat, q, opts, dur: ANSWER_MS, scores: scores() });
      G.timer = setTimeout(reveal, ANSWER_MS + 250); // small grace for latency
    }

    function answer(id, n, pick) {
      if (G.phase !== "q" || n !== G.n || cur.picks.has(id) || !(pick >= 0 && pick < 4)) return;
      if (!G.players.some((p) => p.id === id)) return;
      cur.picks.set(id, { pick, ms: Math.min(ANSWER_MS, Date.now() - cur.start) });
      send({ t: "in", ids: [...cur.picks.keys()] });
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
      send({ t: "r", n: G.n, correct: cur.correct, picks, gains, scores: scores() });
      G.timer = setTimeout(() => {
        if (G.n >= ROUNDS) { G.phase = "end"; send({ t: "end", scores: scores() }); }
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

    const stop = () => clearTimeout(G.timer);
    return { G, newGame, answer, leave, stop };
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
      const av = document.createElement("span");
      av.className = "avatar"; av.textContent = p.name[0].toUpperCase();
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

  function startClock(dur) {
    clockDur = dur;
    clockEnds = performance.now() + dur;
    cancelAnimationFrame(clockRaf);
    const bar = $("clockBar"), clock = $("clock");
    const tick = () => {
      const left = Math.max(0, clockEnds - performance.now());
      bar.style.width = (left / clockDur) * 100 + "%";
      clock.classList.toggle("urgent", left < 4000);
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
          const s = document.createElement("span");
          s.textContent = p.name[0].toUpperCase();
          s.title = p.name;
          who.append(s);
        }
      }
      const gain = m.gains[room.myId];
      const msg = $("msg");
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
    $("resultTitle").textContent = iWon ? (winners.length > 1 ? "Tied for 1st" : "You win") : winners[0].name + " wins";
    const list = $("standings");
    list.textContent = "";
    sorted.forEach((p, i) => {
      const li = document.createElement("li");
      if (p.score === top) li.className = "win";
      const pos = document.createElement("span"); pos.className = "pos"; pos.textContent = i + 1;
      const nm = document.createElement("span"); nm.className = "pname"; nm.textContent = p.name + (p.id === room.myId ? " (you)" : "");
      const n = document.createElement("span"); n.className = "n"; n.textContent = p.score + " pts";
      li.append(pos, nm, n);
      list.append(li);
    });
    $("again").hidden = !room.isHost;
    $("againWait").hidden = room.isHost;
    $("result").hidden = false;
  }
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "trivia",
    title: "Quiz Battle",
    subtitle: "10 questions, 15 seconds each. Right answers score more the faster you are. 2 to 8 players.",
    min: 2,
    max: 8,
    onStart(r) {
      room = r;
      Q = null; myPick = -1;
      if (r.isHost) {
        engine = createEngine(r.players, send);
        r.onData((from, m) => { if (m && m.t === "ans") engine.answer(from, m.n | 0, m.pick | 0); });
        r.onLeave((id) => { engine.leave(id); lastScores = lastScores.filter((p) => p.id !== id); });
        setTimeout(() => engine && engine.newGame(), 300);
      } else {
        r.onData((_, m) => onMsg(m));
      }
      renderBoard(r.players.map((p) => ({ id: p.id, name: p.name, score: 0 })));
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
