// Categories, 2–8 players. Each round has a random letter and six categories ("A fruit",
// "Something in a kitchen"…). You have 90 seconds to write one answer per category starting with
// that letter. Then everyone reviews: tap an answer you think doesn't count to vote it out.
// Answers that match someone else's score nothing; unique, accepted answers score a point.
(() => {
  const WRITE_MS = 90000, REVIEW_MS = 30000, SHOW_MS = 7000, ROUNDS = 3, PER = 6;
  const LETTERS = "ABCDEFGHILMNOPRSTW";
  const CATS = [
    "A fruit", "A vegetable", "An animal", "A country", "A city", "A boy's name", "A girl's name", "A food", "A drink", "A sport",
    "A color", "A movie", "A TV show", "A band or singer", "A video game", "A brand", "Something in a kitchen", "Something in a school",
    "Something at the beach", "A job", "A body part", "Something you wear", "A car brand", "A famous person", "A cartoon character",
    "An insect", "A bird", "A sea creature", "A dessert", "A breakfast food", "A pizza topping", "A board game", "A musical instrument",
    "Something cold", "Something hot", "Something loud", "Something sticky", "Something round", "Something that flies", "A superhero",
    "A school subject", "A holiday", "A hobby", "A tool", "Something in a bathroom", "A piece of furniture", "A store or restaurant",
    "A type of weather", "A reason to be late", "A word that describes you", "A thing you shout", "Something green", "Something with wheels",
    "An app or website", "A place in a house", "A candy", "A snack", "A dog breed", "Something in space", "Something scary",
  ];
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);
  const norm = (s) => String(s || "").toLowerCase().replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]/g, "");

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], round: 0, phase: "idle", letter: "", cats: [], ends: 0, answers: {}, votes: {}, reveal: null, timer: 0, gone: new Set(), usedL: [] };
    const byId = (id) => G.players.find((p) => p.id === id);
    const view = (id) => ({
      t: "st", phase: G.phase, round: G.round, rounds: ROUNDS, letter: G.letter, cats: G.cats, left: Math.max(0, G.ends - Date.now()),
      players: G.players.map((p) => ({ id: p.id, name: p.name, av: p.av, score: p.score, in: !!G.answers[p.id] })),
      mine: G.answers[id] || null,
      all: G.phase === "review" || G.phase === "show" ? G.answers : null,
      votes: G.phase === "review" ? { mine: G.votes[id] || [] } : null,
      reveal: G.reveal,
    });
    const publish = () => { for (const p of room.players) if (!G.gone.has(p.id)) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer);
      G.players = room.players.filter((p) => !G.gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 }));
      G.round = 0; G.usedL = [];
      nextRound();
    }
    function nextRound() {
      clearTimeout(G.timer);
      G.round++;
      if (G.round > ROUNDS) { G.phase = "end"; return publish(); }
      const pool = [...LETTERS].filter((l) => !G.usedL.includes(l));
      G.letter = pool[Math.floor(Math.random() * pool.length)];
      G.usedL.push(G.letter);
      G.cats = GameUtil.shuffle(CATS.slice()).slice(0, PER);
      G.answers = {}; G.votes = {}; G.reveal = null;
      G.phase = "write";
      G.ends = Date.now() + WRITE_MS;
      G.timer = setTimeout(startReview, WRITE_MS + 1500); // a little grace for the last answers to arrive
      publish();
    }
    function submit(id, list) {
      if (G.phase !== "write" || !byId(id) || !Array.isArray(list)) return;
      G.answers[id] = list.slice(0, PER).map((a) => String(a || "").replace(/\s+/g, " ").trim().slice(0, 40));
      publish();
    }
    function done(id) {
      if (G.phase !== "write") return;
      (G.finished ||= new Set()).add(id);
      if (G.players.every((p) => G.finished.has(p.id))) startReview(); else publish();
    }
    function startReview() {
      if (G.phase !== "write") return;
      clearTimeout(G.timer);
      G.finished = new Set();
      for (const p of G.players) if (!G.answers[p.id]) G.answers[p.id] = Array(PER).fill("");
      G.phase = G.players.length > 1 ? "review" : "show";
      if (G.phase === "show") return score();
      G.ends = Date.now() + REVIEW_MS;
      G.timer = setTimeout(score, REVIEW_MS);
      publish();
    }
    // votes[voter] = ["pid:cat", …] answers they reject
    function vote(id, key) {
      if (G.phase !== "review" || !byId(id) || typeof key !== "string") return;
      const [pid] = key.split(":").map(Number);
      if (pid === id) return;
      const list = G.votes[id] || (G.votes[id] = []);
      const i = list.indexOf(key);
      if (i >= 0) list.splice(i, 1); else list.push(key);
      publish();
    }
    function score() {
      clearTimeout(G.timer);
      const n = G.players.length, gains = {}, status = {};
      for (let c = 0; c < PER; c++) {
        const counts = {};
        for (const p of G.players) { const k = norm(G.answers[p.id][c]); if (k) counts[k] = (counts[k] || 0) + 1; }
        for (const p of G.players) {
          const a = G.answers[p.id][c], k = norm(a), key = `${p.id}:${c}`;
          const rejects = Object.entries(G.votes).filter(([v, l]) => +v !== p.id && l.includes(key)).length;
          let st;
          if (!k) st = "empty";
          else if (k[0] !== G.letter.toLowerCase()) st = "letter";
          else if (n > 1 && rejects * 2 >= n - 1 && rejects > 0) st = "voted";
          else if (counts[k] > 1) st = "dup";
          else { st = "ok"; gains[p.id] = (gains[p.id] || 0) + 1; }
          status[key] = st;
        }
      }
      for (const p of G.players) p.score += gains[p.id] || 0;
      G.reveal = { gains, status };
      G.phase = "show";
      G.ends = Date.now() + SHOW_MS;
      G.timer = setTimeout(nextRound, SHOW_MS);
      publish();
    }
    function leave(id) {
      G.gone.add(id);
      G.players = G.players.filter((p) => p.id !== id);
      delete G.answers[id]; delete G.votes[id];
      if (G.players.length < 1 && G.phase !== "end") { clearTimeout(G.timer); G.phase = "end"; return; }
      if (G.phase === "write" && G.finished && G.players.every((p) => G.finished.has(p.id))) return startReview();
      publish();
    }
    return { G, newGame, submit, done, vote, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null, draft = [], sentDone = false, pushT = 0;
  const act = (m) => {
    if (room.isHost) { if (m.t === "ans") engine.submit(room.myId, m.list); else if (m.t === "done") engine.done(room.myId); else if (m.t === "vote") engine.vote(room.myId, m.key); }
    else room.send(m);
  };
  const pushDraft = () => { clearTimeout(pushT); pushT = setTimeout(() => act({ t: "ans", list: draft }), 400); };

  function render() {
    const v = V;
    $("round").textContent = v.phase === "end" ? "Game over" : `Round ${v.round} of ${v.rounds}`;
    $("letter").textContent = v.letter;
    const form = $("form");
    form.hidden = v.phase !== "write";
    if (v.phase === "write") {
      if (form.childElementCount !== v.cats.length || form.dataset.round !== String(v.round)) {
        form.textContent = "";
        form.dataset.round = v.round;
        v.cats.forEach((c, i) => {
          const row = h("label", "ct-row");
          const inp = h("input", "p-input");
          inp.maxLength = 40; inp.placeholder = `${v.letter}…`; inp.value = draft[i] || ""; inp.autocomplete = "off";
          inp.addEventListener("input", () => { draft[i] = inp.value; pushDraft(); });
          inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const nx = form.querySelectorAll("input")[i + 1]; if (nx) nx.focus(); } });
          row.append(h("span", "ct-cat", c), inp);
          form.append(row);
        });
      }
    }
    $("doneBtn").hidden = v.phase !== "write" || sentDone;
    const rv = $("review");
    rv.hidden = !(v.phase === "review" || v.phase === "show");
    if (!rv.hidden && v.all) {
      rv.textContent = "";
      v.cats.forEach((c, ci) => {
        const block = h("div", "ct-block");
        block.append(h("div", "ct-cat", c));
        const list = h("div", "ct-answers");
        for (const p of v.players) {
          const a = (v.all[p.id] || [])[ci] || "";
          const key = `${p.id}:${ci}`;
          const st = v.reveal ? v.reveal.status[key] : null;
          const mineVote = v.votes && v.votes.mine.includes(key);
          const el = h(v.phase === "review" && p.id !== room.myId && a ? "button" : "div", "ct-ans" + (st ? " " + st : "") + (mineVote ? " rejected" : ""));
          if (el.tagName === "BUTTON") { el.type = "button"; el.title = mineVote ? "Undo your vote" : "Vote this answer out"; el.addEventListener("click", () => { GameUtil.sfx("click"); act({ t: "vote", key }); }); }
          el.append(GameUtil.avatar(p, "xs"), h("span", "", a || "—"));
          if (st && st !== "ok") el.append(h("small", "", { dup: "same as someone", letter: "wrong letter", voted: "voted out", empty: "" }[st]));
          if (st === "ok") el.append(h("small", "", "+1"));
          list.append(el);
        }
        block.append(list);
        rv.append(block);
      });
    }
    $("status").textContent = v.phase === "write" ? (sentDone ? "Waiting for the others…" : `Answers must start with ${v.letter}.`) : v.phase === "review" ? "Tap any answer that shouldn't count. Most votes and it's out." : v.phase === "show" && v.reveal ? `+${v.reveal.gains[room.myId] || 0} for you` : "";
    const board = $("board");
    board.textContent = "";
    for (const p of [...v.players].sort((a, b) => b.score - a.score)) {
      const el = h("div", "pl" + (p.id === room.myId ? " me" : ""));
      el.append(GameUtil.avatar(p), h("span", "", p.name), h("span", "pts", p.score));
      if (v.phase === "show" && v.reveal && v.reveal.gains[p.id]) el.append(h("span", "gain", "+" + v.reveal.gains[p.id]));
      board.append(el);
    }
  }
  function onState(v) {
    const prev = V;
    V = v;
    if (!prev || prev.round !== v.round) { draft = v.mine ? v.mine.slice() : []; sentDone = false; }
    if (v.phase !== "end") render();
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => {
      $("timer").textContent = v.phase === "write" || v.phase === "review" ? fmt(left) : "";
      if (v.phase === "write" && left <= 0 && !sentDone) { act({ t: "ans", list: draft }); sentDone = true; }
    });
    if (prev && prev.phase !== v.phase) {
      if (v.phase === "write") { GameUtil.sfx("start"); setTimeout(() => $("form").querySelector("input")?.focus(), 60); }
      if (v.phase === "review") GameUtil.sfx("pop");
      if (v.phase === "show") GameUtil.sfx(v.reveal && v.reveal.gains[room.myId] ? "good" : "bad");
    }
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const top = sorted[0] ? sorted[0].score : 0;
      const won = sorted.some((p) => p.id === room.myId && p.score === top);
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("categories", won ? "win" : "loss");
      results({ title: won ? "Most original!" : `${sorted[0].name} wins`, rows: sorted.map((p) => ({ p, value: p.score + " pts", win: p.score === top })), isHost: room.isHost, meId: room.myId });
    } else if (v.phase !== "end") hideResults();
  }

  $("doneBtn").addEventListener("click", () => { act({ t: "ans", list: draft }); act({ t: "done" }); sentDone = true; render(); });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "categories",
    title: "Categories",
    subtitle: "One letter, six categories, 90 seconds. Unique answers score; vote out the bad ones. 2 to 8 players.",
    min: 2,
    max: 8,
    onStart(r) {
      room = r; V = null; draft = []; sentDone = false;
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? onState(m) : r.sendTo(id, m)) };
        engine = createEngine(r, out);
        r.onData((from, m) => {
          if (!m) return;
          if (m.t === "ans") engine.submit(from, m.list);
          else if (m.t === "done") engine.done(from);
          else if (m.t === "vote") engine.vote(from, m.key);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view(id)));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
