// Wavelength for 3–10 players. Each round one player is the psychic: they see a spectrum
// (like Cold ↔ Hot) and a secret target somewhere on it, and give a one-line clue. Everyone else
// slides their guess to where they think the target is. The closer you are, the more you score,
// and the psychic scores the average of everyone's points. Everyone is the psychic once.
(() => {
  const CLUE_MS = 45000, GUESS_MS = 30000, REVEAL_MS = 7000;
  const SPECTRA = [
    ["Cold", "Hot"], ["Useless", "Useful"], ["Boring", "Exciting"], ["Cheap", "Expensive"], ["Easy", "Hard"],
    ["Quiet", "Loud"], ["Tiny", "Huge"], ["Bad movie", "Good movie"], ["Underrated", "Overrated"], ["Healthy", "Unhealthy"],
    ["Scary", "Not scary"], ["Smells bad", "Smells good"], ["Old-fashioned", "Futuristic"], ["Worst pizza topping", "Best pizza topping"],
    ["Villain", "Hero"], ["Relaxing", "Stressful"], ["Rare", "Common"], ["Normal pet", "Weird pet"], ["Soft", "Hard"],
    ["Sad song", "Happy song"], ["Unknown", "Famous"], ["Bad superpower", "Good superpower"], ["Slow", "Fast"],
    ["Mild", "Spicy"], ["Dangerous", "Safe"], ["Weak", "Strong"], ["Casual", "Formal"], ["Ugly", "Beautiful"],
    ["Bad school subject", "Good school subject"], ["Fantasy", "Sci-fi"], ["Wet", "Dry"], ["Round", "Pointy"],
    ["Easy to spell", "Hard to spell"], ["Snack", "Meal"], ["Mainstream", "Niche"], ["Worst chore", "Best chore"],
    ["Bad gift", "Good gift"], ["Nerdy", "Cool"], ["Tastes bad", "Tastes good"], ["Harmless", "Evil"],
    ["Bad video game", "Great video game"], ["Short-lived", "Lasts forever"], ["Kid thing", "Adult thing"],
  ];
  const points = (d) => (d <= 5 ? 100 : d <= 12 ? 60 : d <= 20 ? 30 : 0);
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], order: [], round: 0, rounds: 0, phase: "idle", psychic: null, spectrum: null, target: 0, clue: "", guesses: {}, reveal: null, ends: 0, timer: 0, deck: [], gone: new Set() };
    const byId = (id) => G.players.find((p) => p.id === id);

    function view(id) {
      return {
        t: "st", phase: G.phase, round: G.round, rounds: G.rounds, psychic: G.psychic, spectrum: G.spectrum, clue: G.clue,
        players: G.players, guessed: Object.keys(G.guesses).map(Number), reveal: G.reveal,
        target: id === G.psychic || G.phase === "reveal" ? G.target : null,
        left: Math.max(0, G.ends - Date.now()),
      };
    }
    // The target is secret, so everyone gets their own copy of the state.
    const publish = () => { for (const p of room.players) if (!G.gone.has(p.id)) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer);
      G.players = room.players.filter((p) => !G.gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 }));
      G.order = GameUtil.shuffle(G.players.map((p) => p.id));
      G.rounds = G.order.length;
      G.round = 0;
      nextRound();
    }
    function nextRound() {
      clearTimeout(G.timer);
      G.round++;
      while (G.round <= G.rounds && !byId(G.order[G.round - 1])) G.round++;
      if (G.round > G.rounds) { G.phase = "end"; return publish(); }
      if (!G.deck.length) G.deck = GameUtil.shuffle(SPECTRA.map((_, i) => i));
      G.spectrum = SPECTRA[G.deck.pop()];
      G.target = 4 + Math.floor(Math.random() * 93);
      G.psychic = G.order[G.round - 1];
      G.clue = ""; G.guesses = {}; G.reveal = null;
      G.phase = "clue";
      G.ends = Date.now() + CLUE_MS;
      G.timer = setTimeout(() => clue(G.psychic, "(no clue!)"), CLUE_MS);
      publish();
    }
    function clue(id, text) {
      if (G.phase !== "clue" || id !== G.psychic) return;
      text = String(text || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!text) return;
      clearTimeout(G.timer);
      G.clue = text;
      G.phase = "guess";
      G.ends = Date.now() + GUESS_MS;
      G.timer = setTimeout(reveal, GUESS_MS);
      publish();
    }
    function guess(id, v) {
      if (G.phase !== "guess" || id === G.psychic || !byId(id) || id in G.guesses) return;
      v = Math.round(+v);
      if (!(v >= 0 && v <= 100)) return;
      G.guesses[id] = v;
      if (G.players.every((p) => p.id === G.psychic || p.id in G.guesses)) reveal();
      else publish();
    }
    function reveal() {
      if (G.phase !== "guess") return;
      clearTimeout(G.timer);
      const gains = {};
      const vals = Object.entries(G.guesses);
      for (const [id, v] of vals) { gains[id] = points(Math.abs(v - G.target)); byId(+id).score += gains[id]; }
      const ps = byId(G.psychic);
      const avg = vals.length ? Math.round(vals.reduce((a, [id]) => a + gains[id], 0) / vals.length) : 0;
      if (ps) { gains[G.psychic] = avg; ps.score += avg; }
      G.reveal = { guesses: G.guesses, gains };
      G.phase = "reveal";
      G.ends = Date.now() + REVEAL_MS;
      G.timer = setTimeout(nextRound, REVEAL_MS);
      publish();
    }
    function leave(id) {
      G.gone.add(id);
      G.players = G.players.filter((p) => p.id !== id);
      delete G.guesses[id];
      if (G.players.length < 2 && G.phase !== "end") { clearTimeout(G.timer); G.phase = "end"; return publish(); }
      if (id === G.psychic && G.phase !== "reveal") return nextRound();
      if (G.phase === "guess" && G.players.every((p) => p.id === G.psychic || p.id in G.guesses)) reveal();
      else publish();
    }
    return { G, newGame, clue, guess, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null, locked = false;
  const slider = $("dial");

  function sendMsg(m) {
    if (room.isHost) { if (m.t === "clue") engine.clue(room.myId, m.text); else engine.guess(room.myId, m.v); }
    else room.send(m);
  }

  function render() {
    const v = V, iAmPsychic = v.psychic === room.myId, psy = v.players.find((p) => p.id === v.psychic);
    $("left").textContent = v.spectrum[0];
    $("right").textContent = v.spectrum[1];
    const track = $("track");
    track.querySelectorAll(".wl-target, .wl-mark").forEach((e) => e.remove());
    if (v.target != null) {
      const t = h("div", "wl-target");
      t.style.setProperty("--x", v.target + "%");
      t.append(h("i", "z3"), h("i", "z2"), h("i", "z1"));
      track.append(t);
    }
    if (v.phase === "reveal" && v.reveal) {
      for (const [id, g] of Object.entries(v.reveal.guesses)) {
        const p = v.players.find((x) => x.id === +id);
        if (!p) continue;
        const m = h("div", "wl-mark" + (+id === room.myId ? " me" : ""));
        m.style.left = g + "%";
        m.append(GameUtil.avatar(p, "xs"));
        track.append(m);
      }
    }
    const canGuess = v.phase === "guess" && !iAmPsychic && !locked && !v.guessed.includes(room.myId);
    slider.disabled = !canGuess;
    $("thumb").hidden = !(v.phase === "guess" && !iAmPsychic);
    $("thumb").style.left = slider.value + "%";
    $("lock").hidden = !canGuess;
    $("clueForm").hidden = !(v.phase === "clue" && iAmPsychic);
    $("clue").textContent = v.phase === "clue" ? (iAmPsychic ? "You're the psychic! Give a clue for where the target is." : `${psy ? psy.name : "The psychic"} is thinking of a clue…`) : `“${v.clue}”`;
    $("clue").classList.toggle("wait", v.phase === "clue");
    const waiting = v.players.filter((p) => p.id !== v.psychic && !v.guessed.includes(p.id)).length;
    $("status").textContent =
      v.phase === "clue" ? (iAmPsychic ? "Only you can see the target. Pick something that lands near it." : "Get ready to guess.")
      : v.phase === "guess" ? (iAmPsychic ? `Waiting for ${waiting} guess${waiting === 1 ? "" : "es"}…` : locked || v.guessed.includes(room.myId) ? `Locked in. Waiting for ${waiting} more…` : "Slide to where you think the target is, then lock it in.")
      : v.phase === "reveal" && v.reveal ? (v.reveal.gains[room.myId] != null ? `+${v.reveal.gains[room.myId]} for you` : "") : "";
    const board = $("board");
    board.textContent = "";
    for (const p of [...v.players].sort((a, b) => b.score - a.score)) {
      const el = h("div", "pl" + (p.id === room.myId ? " me" : "") + (v.guessed.includes(p.id) && v.phase === "guess" ? " done" : ""));
      el.append(GameUtil.avatar(p), h("span", "", p.name + (p.id === v.psychic ? " 🔮" : "")), h("span", "pts", p.score));
      if (v.phase === "reveal" && v.reveal && v.reveal.gains[p.id]) el.append(h("span", "gain", "+" + v.reveal.gains[p.id]));
      board.append(el);
    }
  }

  function onState(v) {
    const prev = V;
    V = v;
    if (!prev || prev.round !== v.round) { locked = false; slider.value = 50; }
    $("round").textContent = v.phase === "end" ? "Game over" : `Round ${v.round} of ${v.rounds}`;
    if (v.phase !== "end") render();
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase === "clue" || v.phase === "guess" ? fmt(left) : ""; });
    if (prev && prev.phase !== v.phase) {
      if (v.phase === "guess" || (v.phase === "clue" && v.psychic === room.myId)) GameUtil.sfx("turn");
      if (v.phase === "reveal") GameUtil.sfx(v.reveal.gains[room.myId] ? "good" : "bad");
    }
    if (v.phase === "clue" && v.psychic === room.myId && (!prev || prev.phase !== "clue")) setTimeout(() => $("clueIn").focus(), 50);
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const top = sorted[0] ? sorted[0].score : 0;
      const won = sorted.some((p) => p.id === room.myId && p.score === top);
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("wave", won ? "win" : "loss");
      results({ title: won ? "You're on the same wavelength!" : sorted[0] ? `${sorted[0].name} wins` : "Game over", rows: sorted.map((p) => ({ p, value: p.score + " pts", win: p.score === top })), isHost: room.isHost, meId: room.myId });
    } else if (v.phase !== "end") hideResults();
  }

  slider.addEventListener("input", () => { $("thumb").style.left = slider.value + "%"; });
  $("lock").addEventListener("click", () => {
    if (!V || V.phase !== "guess" || locked) return;
    locked = true;
    GameUtil.sfx("click");
    sendMsg({ t: "guess", v: +slider.value });
    render();
  });
  $("clueForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("clueIn").value.trim();
    if (!text) return;
    $("clueIn").value = "";
    sendMsg({ t: "clue", text });
  });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "wave",
    title: "Wavelength",
    subtitle: "One psychic, one secret spot on a scale, one clue. Guess where the target is. 3 to 10 players.",
    min: 3,
    max: 10,
    onStart(r) {
      room = r; V = null; locked = false;
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? onState(m) : r.sendTo(id, m)) };
        engine = createEngine(r, out);
        r.onData((from, m) => {
          if (!m) return;
          if (m.t === "clue") engine.clue(from, m.text);
          else if (m.t === "guess") engine.guess(from, m.v);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view(id)));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
