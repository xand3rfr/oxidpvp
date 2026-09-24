// Most Likely To for 3–10 players. Rounds alternate between "Who is most likely to…?"
// (vote for a player) and "Would you rather…?" (pick a side). Votes stay hidden until everyone
// has voted. You score by agreeing with the room: pick the most-voted player, or the side
// most people chose.
(() => {
  const ROUNDS = 10, VOTE_MS = 20000, REVEAL_MS = 6500;
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], round: 0, phase: "idle", kind: "", prompt: null, votes: {}, reveal: null, ends: 0, timer: 0, deck: { mlt: [], wyr: [] } };
    const byId = (id) => G.players.find((p) => p.id === id);
    const deal = (k) => {
      if (!G.deck[k].length) G.deck[k] = GameUtil.shuffle((k === "mlt" ? window.MLT_PROMPTS : window.WYR_PROMPTS).map((_, i) => i));
      return G.deck[k].pop();
    };

    function view() {
      return {
        t: "st", phase: G.phase, round: G.round, rounds: ROUNDS, kind: G.kind, prompt: G.prompt,
        players: G.players, voted: Object.keys(G.votes).map(Number), reveal: G.reveal,
        left: Math.max(0, G.ends - Date.now()),
      };
    }
    const publish = () => out.all(view());

    function newGame() {
      clearTimeout(G.timer);
      G.players = room.players.filter((p) => !(G.gone && G.gone.has(p.id))).map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 }));
      G.round = 0;
      nextRound();
    }
    function nextRound() {
      clearTimeout(G.timer);
      G.round++;
      if (G.round > ROUNDS) { G.phase = "end"; return publish(); }
      G.kind = G.round % 2 ? "mlt" : "wyr";
      const i = deal(G.kind);
      G.prompt = G.kind === "mlt" ? { q: window.MLT_PROMPTS[i] } : { a: window.WYR_PROMPTS[i][0], b: window.WYR_PROMPTS[i][1] };
      G.votes = {}; G.reveal = null;
      G.phase = "vote";
      G.ends = Date.now() + VOTE_MS;
      G.timer = setTimeout(reveal, VOTE_MS);
      publish();
    }
    function vote(id, v) {
      if (G.phase !== "vote" || !byId(id) || id in G.votes) return;
      if (G.kind === "mlt" && !byId(v)) return;
      if (G.kind === "wyr" && v !== "a" && v !== "b") return;
      G.votes[id] = v;
      if (G.players.every((p) => p.id in G.votes)) reveal();
      else publish();
    }
    function reveal() {
      if (G.phase !== "vote") return;
      clearTimeout(G.timer);
      const tally = {};
      for (const v of Object.values(G.votes)) tally[v] = (tally[v] || 0) + 1;
      const top = Math.max(0, ...Object.values(tally));
      const winners = Object.keys(tally).filter((k) => tally[k] === top && top > 0);
      const gains = {};
      for (const [id, v] of Object.entries(G.votes)) {
        if (winners.includes(String(v))) { gains[id] = 100; byId(+id).score += 100; }
      }
      G.reveal = { votes: G.votes, tally, winners, gains };
      G.phase = "reveal";
      G.ends = Date.now() + REVEAL_MS;
      G.timer = setTimeout(nextRound, REVEAL_MS);
      publish();
    }
    function leave(id) {
      (G.gone ||= new Set()).add(id);
      G.players = G.players.filter((p) => p.id !== id);
      delete G.votes[id];
      if (G.players.length < 2 && G.phase !== "end") { clearTimeout(G.timer); G.phase = "end"; return publish(); }
      if (G.phase === "vote" && G.players.every((p) => p.id in G.votes)) reveal();
      else publish();
    }
    return { G, newGame, vote, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null, myVote = null;

  function send(v) {
    if (!V || V.phase !== "vote" || myVote != null) return;
    myVote = v;
    GameUtil.sfx("click");
    if (room.isHost) engine.vote(room.myId, v); else room.send({ t: "vote", v });
    render();
  }

  function render() {
    const v = V;
    const box = $("choices");
    box.textContent = "";
    const reveal = v.phase === "reveal" && v.reveal;
    const voters = (k) => (reveal ? Object.entries(v.reveal.votes).filter(([, x]) => String(x) === String(k)).map(([id]) => v.players.find((p) => p.id === +id)).filter(Boolean) : []);
    const total = reveal ? Object.keys(v.reveal.votes).length || 1 : 1;
    const option = (key, label, avatarP) => {
      const b = h("button", "ml-opt" + (String(myVote) === String(key) ? " picked" : "") + (reveal && v.reveal.winners.includes(String(key)) ? " top" : ""));
      b.type = "button";
      b.disabled = v.phase !== "vote" || myVote != null;
      if (avatarP) b.append(GameUtil.avatar(avatarP));
      b.append(h("span", "ml-label", label));
      if (reveal) {
        const n = (v.reveal.tally[key] || 0);
        const bar = h("i", "ml-bar"); bar.style.width = (n / total) * 100 + "%";
        const who = h("span", "ml-who");
        for (const p of voters(key)) who.append(GameUtil.avatar(p, "xs"));
        b.append(bar, who, h("b", "ml-n", n));
      }
      b.addEventListener("click", () => send(key));
      return b;
    };
    if (v.kind === "mlt") {
      $("prompt").textContent = v.prompt.q;
      box.className = "ml-choices grid";
      for (const p of v.players) box.append(option(p.id, p.name + (p.id === room.myId ? " (you)" : ""), p));
    } else {
      $("prompt").textContent = "Would you rather…";
      box.className = "ml-choices wyr";
      box.append(option("a", v.prompt.a), h("span", "ml-or", "or"), option("b", v.prompt.b));
    }
    $("kind").textContent = v.kind === "mlt" ? "Most likely to" : "Would you rather";
    const waiting = v.players.filter((p) => !v.voted.includes(p.id));
    $("status").textContent = v.phase === "vote"
      ? (myVote != null ? `Waiting for ${waiting.length} more vote${waiting.length === 1 ? "" : "s"}…` : "Tap your answer. Score by agreeing with the room.")
      : reveal ? (v.reveal.gains[room.myId] ? "+100! You agreed with the room." : myVote == null ? "You didn't vote." : "The room disagreed with you!") : "";
    const board = $("board");
    board.textContent = "";
    for (const p of [...v.players].sort((a, b) => b.score - a.score)) {
      const el = h("div", "pl" + (p.id === room.myId ? " me" : "") + (v.voted.includes(p.id) && v.phase === "vote" ? " done" : ""));
      el.append(GameUtil.avatar(p), h("span", "", p.name), h("span", "pts", p.score));
      if (reveal && v.reveal.gains[p.id]) el.append(h("span", "gain", "+100"));
      board.append(el);
    }
  }

  function onState(v) {
    const prev = V;
    V = v;
    if (!prev || prev.round !== v.round) myVote = null;
    if (v.phase === "vote" && myVote == null && v.voted.includes(room.myId)) myVote = "?"; // voted before a reload
    $("round").textContent = v.phase === "end" ? "Game over" : `Round ${v.round} of ${v.rounds}`;
    if (v.phase !== "end") render();
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase === "vote" ? fmt(left) : ""; });
    if (prev && prev.phase !== v.phase) {
      if (v.phase === "vote") GameUtil.sfx("pop");
      if (v.phase === "reveal") GameUtil.sfx(v.reveal.gains[room.myId] ? "good" : "bad");
    }
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const top = sorted[0] ? sorted[0].score : 0;
      const won = sorted.some((p) => p.id === room.myId && p.score === top);
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("vote", won ? "win" : "loss");
      results({ title: won ? "You read the room best!" : `${sorted[0].name} wins`, rows: sorted.map((p) => ({ p, value: p.score + " pts", win: p.score === top })), isHost: room.isHost, meId: room.myId });
    } else if (v.phase !== "end") hideResults();
  }

  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "vote",
    title: "Most Likely To",
    subtitle: "Vote on who's most likely to… and would-you-rathers. Score by agreeing with the room. 3 to 10 players.",
    min: 3,
    max: 10,
    onStart(r) {
      room = r; V = null; myVote = null;
      if (r.isHost) {
        const out = { all: (m) => { r.broadcast(m); onState(m); } };
        engine = createEngine(r, out);
        r.onData((from, m) => { if (m && m.t === "vote") engine.vote(from, m.v); });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view()));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
