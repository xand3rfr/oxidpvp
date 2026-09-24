// Hangman for 2–8 players, taking turns. Guess a letter: if it's in the puzzle you score for
// each time it appears and go again; if not, you lose your turn and the hangman grows. On your
// turn you can also try to solve the whole thing. 8 wrong guesses and nobody gets the bonus.
// The host holds the answer and only sends the revealed letters.
(() => {
  const ROUNDS = 5, TURN_MS = 25000, MAX_MISS = 8, REVEAL_MS = 4500;
  const LETTER_PTS = 10, SOLVE_PTS = 50;
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], round: 0, phase: "idle", word: "", cat: "", guessed: [], misses: 0, turn: null, ends: 0, timer: 0, last: null, solvedBy: null, deck: [] };
    const byId = (id) => G.players.find((p) => p.id === id);
    const nextId = (id) => { const i = G.players.findIndex((p) => p.id === id); return G.players[(i + 1) % G.players.length].id; };
    const masked = () => [...G.word].map((c) => (c === " " || G.guessed.includes(c) || G.phase === "reveal" || G.phase === "end" ? c : "_")).join("");

    function view() {
      return {
        t: "st", phase: G.phase, round: G.round, rounds: ROUNDS, cat: G.cat, board: masked(), guessed: G.guessed, misses: G.misses, max: MAX_MISS,
        turn: G.turn, last: G.last, solvedBy: G.solvedBy,
        players: G.players.map(({ id, name, av, score }) => ({ id, name, av, score })),
        left: Math.max(0, G.ends - Date.now()),
      };
    }
    const publish = () => out.all(view());
    function newGame() {
      clearTimeout(G.timer);
      G.players = room.players.filter((p) => !(G.gone && G.gone.has(p.id))).map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 }));
      G.round = 0;
      G.turn = G.players[Math.floor(Math.random() * G.players.length)].id;
      nextRound();
    }
    function nextRound() {
      clearTimeout(G.timer);
      G.round++;
      if (G.round > ROUNDS) { G.phase = "end"; return publish(); }
      if (!G.deck.length) G.deck = GameUtil.shuffle(window.HANGMAN_WORDS.map((_, i) => i));
      [G.cat, G.word] = window.HANGMAN_WORDS[G.deck.pop()];
      G.guessed = []; G.misses = 0; G.last = null; G.solvedBy = null;
      G.phase = "play";
      startTurn(G.turn && byId(G.turn) ? G.turn : G.players[0].id);
      publish();
    }
    function startTurn(id) {
      clearTimeout(G.timer);
      G.turn = id;
      G.ends = Date.now() + TURN_MS;
      G.timer = setTimeout(() => { G.last = { k: "timeout", id: G.turn }; startTurn(nextId(G.turn)); publish(); }, TURN_MS);
    }
    const solved = () => [...G.word].every((c) => c === " " || G.guessed.includes(c));
    function guess(id, letter) {
      letter = String(letter || "").toUpperCase();
      if (G.phase !== "play" || id !== G.turn || !ALPHA.includes(letter) || letter.length !== 1 || G.guessed.includes(letter)) return;
      G.guessed.push(letter);
      const n = [...G.word].filter((c) => c === letter).length;
      const p = byId(id);
      if (n) {
        p.score += n * LETTER_PTS;
        G.last = { k: "hit", id, letter, n };
        if (solved()) return finishRound(id);
        startTurn(id); // correct: go again
      } else {
        G.misses++;
        G.last = { k: "miss", id, letter };
        if (G.misses >= MAX_MISS) return finishRound(null);
        startTurn(nextId(id));
      }
      publish();
    }
    function solve(id, text) {
      if (G.phase !== "play" || id !== G.turn) return;
      const t = String(text || "").toUpperCase().replace(/[^A-Z ]/g, "").replace(/\s+/g, " ").trim();
      if (!t) return;
      const p = byId(id);
      if (t === G.word) {
        const hidden = [...G.word].filter((c) => c !== " " && !G.guessed.includes(c)).length;
        p.score += SOLVE_PTS + hidden * LETTER_PTS;
        return finishRound(id);
      }
      G.misses++;
      G.last = { k: "badsolve", id, text: t.slice(0, 30) };
      if (G.misses >= MAX_MISS) return finishRound(null);
      startTurn(nextId(id));
      publish();
    }
    function finishRound(winner) {
      clearTimeout(G.timer);
      G.phase = "reveal";
      G.solvedBy = winner;
      G.ends = Date.now() + REVEAL_MS;
      G.turn = winner != null ? nextId(winner) : nextId(G.turn);
      publish();
      G.timer = setTimeout(nextRound, REVEAL_MS);
    }
    function leave(id) {
      (G.gone ||= new Set()).add(id);
      const wasTurn = G.turn === id, next = G.players.length > 1 ? nextId(id) : null;
      G.players = G.players.filter((p) => p.id !== id);
      if (G.players.length < 2 && G.phase !== "end") { clearTimeout(G.timer); G.phase = "end"; return publish(); }
      if (wasTurn && G.phase === "play") startTurn(next);
      else if (wasTurn) G.turn = next;
      publish();
    }
    return { G, newGame, guess, solve, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null;
  const act = (m) => {
    if (!room.isHost) return room.send(m);
    if (m.t === "g") engine.guess(room.myId, m.l); else engine.solve(room.myId, m.text);
  };
  for (const c of ALPHA) {
    const b = h("button", "hm-key", c);
    b.type = "button";
    b.dataset.l = c;
    b.addEventListener("click", () => act({ t: "g", l: c }));
    $("keys").append(b);
  }
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.ctrlKey || e.metaKey || e.altKey) return;
    const c = e.key.toUpperCase();
    if (c.length === 1 && ALPHA.includes(c) && V && V.turn === room.myId && V.phase === "play") act({ t: "g", l: c });
  });
  $("solveForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("solveIn").value.trim();
    if (!t) return;
    act({ t: "s", text: t });
    $("solveIn").value = "";
  });

  const PARTS = ["hm-base", "hm-pole", "hm-beam", "hm-rope", "hm-head", "hm-body", "hm-arms", "hm-legs"];

  function onState(v) {
    const prev = V;
    V = v;
    const myTurn = v.phase === "play" && v.turn === room.myId;
    const nameOf = (id) => { const p = v.players.find((x) => x.id === id); return p ? (p.id === room.myId ? "You" : p.name) : "?"; };
    $("round").textContent = v.phase === "end" ? "Game over" : `Round ${v.round} of ${v.rounds}`;
    $("cat").textContent = v.cat;

    const board = $("puzzle");
    board.textContent = "";
    for (const word of v.board.split(" ")) {
      const w = h("span", "hm-word");
      for (const c of word) w.append(h("span", "hm-tile" + (c === "_" ? "" : " open"), c === "_" ? "" : c));
      board.append(w);
    }
    PARTS.forEach((id, i) => $(id).classList.toggle("on", i < v.misses));
    $("misses").textContent = `${v.misses} / ${v.max} misses`;
    document.querySelectorAll(".hm-key").forEach((b) => {
      const used = v.guessed.includes(b.dataset.l);
      b.disabled = !myTurn || used;
      b.classList.toggle("hit", used && v.board.includes(b.dataset.l));
      b.classList.toggle("miss", used && !v.board.includes(b.dataset.l));
    });
    $("solveForm").hidden = !myTurn;

    const last = v.last;
    $("status").textContent =
      v.phase === "reveal" ? (v.solvedBy != null ? `${nameOf(v.solvedBy)} solved it!` : "Out of guesses! Nobody gets the bonus.")
      : myTurn ? (last && last.k === "hit" && last.id === room.myId ? `Nice! ${last.n} × ${last.letter}. Go again.` : "Your turn. Pick a letter or solve it.")
      : v.phase === "play" ? `${nameOf(v.turn)}'s turn${last ? " · " + describe(last, nameOf) : ""}` : "";

    const list = $("board");
    list.textContent = "";
    for (const p of [...v.players].sort((a, b) => b.score - a.score)) {
      const el = h("div", "pl" + (p.id === room.myId ? " me" : "") + (p.id === v.turn && v.phase === "play" ? " done" : ""));
      el.append(GameUtil.avatar(p), h("span", "", p.name), h("span", "pts", p.score));
      list.append(el);
    }
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase === "play" ? fmt(left) : ""; });

    if (prev) {
      if (v.phase === "reveal" && prev.phase !== "reveal") GameUtil.sfx(v.solvedBy === room.myId ? "win" : v.solvedBy != null ? "pop" : "bad");
      else if (last && JSON.stringify(last) !== JSON.stringify(prev.last)) GameUtil.sfx(last.k === "hit" ? "good" : "bad");
      if (myTurn && prev.turn !== v.turn) setTimeout(() => GameUtil.sfx("turn"), 200);
    }
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const top = sorted[0] ? sorted[0].score : 0;
      const won = sorted.some((p) => p.id === room.myId && p.score === top);
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("hangman", won ? "win" : "loss");
      results({ title: won ? "You win!" : `${sorted[0].name} wins`, rows: sorted.map((p) => ({ p, value: p.score + " pts", win: p.score === top })), isHost: room.isHost, meId: room.myId });
    } else if (v.phase !== "end") hideResults();
  }
  function describe(l, nameOf) {
    if (l.k === "hit") return `${nameOf(l.id)} found ${l.n} × ${l.letter}`;
    if (l.k === "miss") return `no ${l.letter}`;
    if (l.k === "badsolve") return `"${l.text}" was wrong`;
    if (l.k === "timeout") return `${nameOf(l.id)} ran out of time`;
    return "";
  }

  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "hangman",
    title: "Hangman",
    subtitle: "Take turns guessing letters. Right letters score and let you go again. Solve it for a bonus. 2 to 8 players.",
    min: 2,
    max: 8,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        const out = { all: (m) => { r.broadcast(m); onState(m); } };
        engine = createEngine(r, out);
        r.onData((from, m) => {
          if (!m) return;
          if (m.t === "g") engine.guess(from, m.l);
          else if (m.t === "s") engine.solve(from, m.text);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view()));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
