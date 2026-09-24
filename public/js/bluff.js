// Bluff for 3–8 players. Each round shows a strange-but-true fact with a blank. Everyone writes a
// convincing fake answer, then all the answers (fakes + the truth) are shown and everyone tries
// to pick the real one. Points for finding the truth, and for every player your fake fools.
// Only the host knows the real answer until the reveal.
(() => {
  const ROUNDS = 6, WRITE_MS = 45000, PICK_MS = 30000, REVEAL_MS = 8000;
  const TRUTH_PTS = 500, FOOL_PTS = 250;
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], round: 0, phase: "idle", q: null, fakes: {}, options: [], picks: {}, reveal: null, ends: 0, timer: 0, deck: [] };
    const byId = (id) => G.players.find((p) => p.id === id);

    function view(id) {
      return {
        t: "st", phase: G.phase, round: G.round, rounds: ROUNDS, q: G.q && G.q.q,
        players: G.players.map(({ id, name, av, score }) => ({ id, name, av, score })),
        wrote: Object.keys(G.fakes).map(Number), picked: Object.keys(G.picks).map(Number),
        // Everyone gets the option list, minus their own fake so they can't pick it.
        options: G.phase === "pick" ? G.options.filter((o) => !o.by.includes(id)).map((o) => ({ k: o.k, text: o.text })) : null,
        myFake: G.fakes[id] || null,
        reveal: G.reveal,
        left: Math.max(0, G.ends - Date.now()),
      };
    }
    const publish = () => { for (const p of G.players) out.to(p.id, view(p.id)); };

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
      if (!G.deck.length) G.deck = GameUtil.shuffle(window.BLUFF_QUESTIONS.map((_, i) => i));
      G.q = window.BLUFF_QUESTIONS[G.deck.pop()];
      G.fakes = {}; G.picks = {}; G.options = []; G.reveal = null;
      G.phase = "write";
      G.ends = Date.now() + WRITE_MS;
      G.timer = setTimeout(startPick, WRITE_MS);
      publish();
    }
    const isTruth = (text) => { const n = norm(text); return n === norm(G.q.a) || (G.q.accept || []).some((x) => norm(x) === n); };
    function write(id, text) {
      if (G.phase !== "write" || !byId(id)) return;
      text = String(text || "").replace(/\s+/g, " ").trim().slice(0, 40);
      if (!text) return;
      if (isTruth(text)) return out.to(id, { t: "err", text: "That's the real answer! Write a fake one instead." });
      G.fakes[id] = text;
      if (G.players.every((p) => p.id in G.fakes)) startPick();
      else publish();
    }
    function startPick() {
      clearTimeout(G.timer);
      // Merge identical fakes so two people who wrote the same thing share the credit.
      const byText = new Map();
      for (const [id, text] of Object.entries(G.fakes)) {
        const k = norm(text);
        if (!byText.has(k)) byText.set(k, { text, by: [] });
        byText.get(k).by.push(+id);
      }
      G.options = GameUtil.shuffle([{ text: G.q.a, by: [], truth: true }, ...byText.values()]).map((o, i) => ({ ...o, k: i }));
      G.phase = "pick";
      G.ends = Date.now() + PICK_MS;
      G.timer = setTimeout(doReveal, PICK_MS);
      publish();
    }
    function pick(id, k) {
      if (G.phase !== "pick" || !byId(id) || id in G.picks) return;
      const o = G.options.find((x) => x.k === k);
      if (!o || o.by.includes(id)) return;
      G.picks[id] = k;
      if (G.players.every((p) => p.id in G.picks)) doReveal();
      else publish();
    }
    function doReveal() {
      if (G.phase !== "pick") return;
      clearTimeout(G.timer);
      const gains = {};
      const add = (id, n) => { const p = byId(id); if (p) { p.score += n; gains[id] = (gains[id] || 0) + n; } };
      for (const [id, k] of Object.entries(G.picks)) {
        const o = G.options.find((x) => x.k === k);
        if (o.truth) add(+id, TRUTH_PTS);
        else for (const author of o.by) add(author, FOOL_PTS);
      }
      G.reveal = {
        answer: G.q.a, gains,
        options: G.options.map((o) => ({ text: o.text, truth: !!o.truth, by: o.by, pickedBy: Object.entries(G.picks).filter(([, k]) => k === o.k).map(([id]) => +id) })),
      };
      G.phase = "reveal";
      G.ends = Date.now() + REVEAL_MS;
      G.timer = setTimeout(nextRound, REVEAL_MS);
      publish();
    }
    function leave(id) {
      (G.gone ||= new Set()).add(id);
      G.players = G.players.filter((p) => p.id !== id);
      if (G.players.length < 2 && G.phase !== "end") { clearTimeout(G.timer); G.phase = "end"; return publish(); }
      if (G.phase === "write" && G.players.every((p) => p.id in G.fakes)) startPick();
      else if (G.phase === "pick" && G.players.every((p) => p.id in G.picks)) doReveal();
      else publish();
    }
    return { G, newGame, write, pick, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null;
  const act = (m) => {
    if (!room.isHost) return room.send(m);
    if (m.t === "write") engine.write(room.myId, m.text);
    else if (m.t === "pick") engine.pick(room.myId, m.k);
  };

  $("writeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("fake").value.trim();
    if (!text) return;
    act({ t: "write", text });
    GameUtil.sfx("click");
  });

  function onState(v) {
    const prev = V;
    V = v;
    const nameOf = (id) => { const p = v.players.find((x) => x.id === id); return p ? p.name : "?"; };
    const personOf = (id) => v.players.find((x) => x.id === id) || { name: "?" };
    $("round").textContent = v.phase === "end" ? "Game over" : `Round ${v.round} of ${v.rounds}`;
    $("question").textContent = v.q ? v.q.replace("___", "_____") : "";
    $("phaseTag").textContent = { write: "Write a fake answer", pick: "Find the truth", reveal: "The truth is…" }[v.phase] || "";

    const iWrote = v.wrote.includes(room.myId), iPicked = v.picked.includes(room.myId);
    $("writeForm").hidden = v.phase !== "write";
    $("fake").disabled = iWrote;
    $("writeForm").querySelector("button").disabled = iWrote;
    if (v.phase === "write" && (!prev || prev.round !== v.round)) { $("fake").value = ""; setTimeout(() => $("fake").focus(), 50); }
    if (iWrote && v.myFake) $("fake").value = v.myFake;

    const opts = $("options");
    opts.textContent = "";
    if (v.phase === "pick") {
      for (const o of v.options) {
        const b = h("button", "bl-opt", o.text);
        b.type = "button";
        b.disabled = iPicked;
        b.addEventListener("click", () => { act({ t: "pick", k: o.k }); GameUtil.sfx("click"); });
        opts.append(b);
      }
    } else if (v.phase === "reveal") {
      for (const o of v.reveal.options) {
        const el = h("div", "bl-opt revealed" + (o.truth ? " truth" : ""));
        el.append(h("span", "bl-text", o.text));
        el.append(h("span", "bl-by", o.truth ? "✓ the truth" : `lie by ${o.by.map(nameOf).join(" & ")}`));
        const who = h("span", "bl-who");
        for (const id of o.pickedBy) who.append(GameUtil.avatar(personOf(id), "xs"));
        el.append(who);
        opts.append(el);
      }
    }

    const waitingOn = v.players.filter((p) => !(v.phase === "write" ? v.wrote : v.picked).includes(p.id)).length;
    $("status").textContent =
      v.phase === "write" ? (iWrote ? `Nice lie. Waiting for ${waitingOn} more…` : "Make up an answer that sounds real enough to fool everyone.")
      : v.phase === "pick" ? (iPicked ? `Waiting for ${waitingOn} more…` : "One of these is true. Which one?")
      : v.phase === "reveal" ? (v.reveal.gains[room.myId] ? `+${v.reveal.gains[room.myId]} points this round!` : "No points this round.") : "";

    const board = $("board");
    board.textContent = "";
    for (const p of [...v.players].sort((a, b) => b.score - a.score)) {
      const done = (v.phase === "write" && v.wrote.includes(p.id)) || (v.phase === "pick" && v.picked.includes(p.id));
      const el = h("div", "pl" + (p.id === room.myId ? " me" : "") + (done ? " done" : ""));
      el.append(GameUtil.avatar(p), h("span", "", p.name), h("span", "pts", p.score));
      if (v.phase === "reveal" && v.reveal.gains[p.id]) el.append(h("span", "gain", "+" + v.reveal.gains[p.id]));
      board.append(el);
    }

    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase === "write" || v.phase === "pick" ? fmt(left) : ""; });
    if (prev && prev.phase !== v.phase) GameUtil.sfx(v.phase === "reveal" ? (v.reveal.gains[room.myId] ? "good" : "bad") : "pop");
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const top = sorted[0] ? sorted[0].score : 0;
      const won = sorted.some((p) => p.id === room.myId && p.score === top);
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("bluff", won ? "win" : "loss");
      results({ title: won ? "Master liar!" : `${sorted[0].name} wins`, rows: sorted.map((p) => ({ p, value: p.score + " pts", win: p.score === top })), isHost: room.isHost, meId: room.myId });
    } else if (v.phase !== "end") hideResults();
  }
  function onMsg(m) {
    if (m.t === "st") onState(m);
    else if (m.t === "err") { GameUtil.toast(m.text); GameUtil.sfx("bad"); }
  }

  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "bluff",
    title: "Bluff",
    subtitle: "Write fake answers to weird-but-true facts, then find the real one. Fool your friends for points. 3 to 8 players.",
    min: 3,
    max: 8,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? onMsg(m) : r.sendTo(id, m)) };
        engine = createEngine(r, out);
        r.onData((from, m) => {
          if (!m) return;
          if (m.t === "write") engine.write(from, m.text);
          else if (m.t === "pick") engine.pick(from, m.k | 0);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => out.to(id, engine.view(id)));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => m && onMsg(m));
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
