// Imposter for 3–10 players. Everyone gets the same secret word, except one imposter who only
// knows the category. Take turns giving a one-word clue (two laps), then vote on who's faking it.
// Catch the imposter and they get one chance to name the word to steal the round. The host
// deals the roles and only ever sends the word to players who aren't the imposter.
(() => {
  const CLUE_MS = 25000, VOTE_MS = 30000, GUESS_MS = 20000, REVEAL_MS = 8000, LAPS = 2;
  const WORDS = {
    Food: ["Pizza", "Sushi", "Taco", "Pancake", "Burger", "Spaghetti", "Popcorn", "Donut", "Salad", "Ice cream", "Hot dog", "Waffle"],
    Animals: ["Penguin", "Giraffe", "Shark", "Owl", "Kangaroo", "Octopus", "Elephant", "Snail", "Tiger", "Bat", "Camel", "Frog"],
    Places: ["Beach", "Airport", "Library", "Hospital", "Zoo", "Movie theater", "Gym", "Castle", "Farm", "Space station", "Museum", "Bowling alley"],
    Sports: ["Soccer", "Basketball", "Tennis", "Golf", "Boxing", "Skiing", "Swimming", "Baseball", "Volleyball", "Surfing", "Hockey", "Bowling"],
    Jobs: ["Firefighter", "Chef", "Teacher", "Pilot", "Doctor", "Astronaut", "Farmer", "Police officer", "Dentist", "Magician", "Plumber", "Lifeguard"],
    Objects: ["Umbrella", "Toothbrush", "Ladder", "Candle", "Backpack", "Mirror", "Pillow", "Scissors", "Guitar", "Clock", "Balloon", "Key"],
    "Video games": ["Minecraft", "Fortnite", "Mario Kart", "Tetris", "Pac-Man", "Roblox", "Among Us", "Pokémon", "Zelda", "Rocket League", "Sonic", "Call of Duty"],
    Weather: ["Rain", "Snow", "Thunder", "Rainbow", "Tornado", "Fog", "Hail", "Heatwave", "Hurricane", "Wind", "Sunshine", "Blizzard"],
    Holidays: ["Halloween", "Christmas", "Birthday", "Thanksgiving", "Valentine's Day", "New Year's Eve", "Easter", "Fourth of July", "Hanukkah", "April Fools'", "Graduation", "Wedding"],
    School: ["Homework", "Recess", "Cafeteria", "Principal", "Field trip", "Pop quiz", "Locker", "Gym class", "Detention", "School bus", "Science fair", "Yearbook"],
  };
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);
  const cleanClue = (s) => String(s || "").replace(/[^\p{L}\p{N}' -]/gu, "").trim().split(/\s+/)[0].slice(0, 20);

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], round: 0, rounds: 0, phase: "idle", cat: "", word: "", imp: null, order: [], turn: 0, clues: [], votes: {}, options: [], reveal: null, ends: 0, timer: 0, gone: new Set(), used: new Set() };
    const byId = (id) => G.players.find((p) => p.id === id);
    const current = () => G.order[G.turn % G.order.length];

    function view(id) {
      const imp = id === G.imp, done = G.phase === "reveal" || G.phase === "end";
      return {
        t: "st", phase: G.phase, round: G.round, rounds: G.rounds, cat: G.cat, players: G.players,
        word: imp && !done ? null : G.word, imp: done || G.phase === "guess" ? G.imp : null, iAmImp: imp,
        turn: G.phase === "clue" ? current() : null, lap: Math.min(LAPS, Math.floor(G.turn / Math.max(1, G.order.length)) + 1), laps: LAPS,
        clues: G.clues, voted: Object.keys(G.votes).map(Number), options: G.phase === "guess" && imp ? G.options : null,
        reveal: G.reveal, left: Math.max(0, G.ends - Date.now()),
      };
    }
    const publish = () => { for (const p of room.players) if (!G.gone.has(p.id)) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer);
      G.players = room.players.filter((p) => !G.gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 }));
      G.rounds = Math.min(6, Math.max(4, G.players.length));
      G.round = 0;
      nextRound();
    }
    function nextRound() {
      clearTimeout(G.timer);
      G.round++;
      if (G.round > G.rounds) { G.phase = "end"; return publish(); }
      const cats = Object.keys(WORDS);
      let cat, word;
      for (let k = 0; k < 50; k++) {
        cat = cats[Math.floor(Math.random() * cats.length)];
        word = WORDS[cat][Math.floor(Math.random() * WORDS[cat].length)];
        if (!G.used.has(word)) break;
      }
      G.used.add(word);
      G.cat = cat; G.word = word;
      G.imp = G.players[Math.floor(Math.random() * G.players.length)].id;
      G.order = GameUtil.shuffle(G.players.map((p) => p.id));
      // The imposter never goes first, that would be too hard.
      if (G.order[0] === G.imp) G.order.push(G.order.shift());
      G.turn = 0; G.clues = []; G.votes = {}; G.reveal = null; G.options = [];
      G.phase = "clue";
      armClue();
      publish();
    }
    function armClue() {
      G.ends = Date.now() + CLUE_MS;
      clearTimeout(G.timer);
      G.timer = setTimeout(() => clue(current(), "…"), CLUE_MS);
    }
    function clue(id, text) {
      if (G.phase !== "clue" || id !== current()) return;
      const c = text === "…" ? "…" : cleanClue(text);
      if (!c) return;
      G.clues.push({ id, c });
      G.turn++;
      if (G.turn >= G.order.length * LAPS) {
        G.phase = "vote";
        G.ends = Date.now() + VOTE_MS;
        clearTimeout(G.timer);
        G.timer = setTimeout(tally, VOTE_MS);
      } else armClue();
      publish();
    }
    function vote(id, who) {
      if (G.phase !== "vote" || !byId(id) || !byId(who) || id === who || id in G.votes) return;
      G.votes[id] = who;
      if (G.players.every((p) => p.id in G.votes)) tally();
      else publish();
    }
    function tally() {
      if (G.phase !== "vote") return;
      clearTimeout(G.timer);
      const n = {};
      for (const v of Object.values(G.votes)) n[v] = (n[v] || 0) + 1;
      const top = Math.max(0, ...Object.values(n));
      const tops = Object.keys(n).filter((k) => n[k] === top).map(Number);
      const caught = top > 0 && tops.length === 1 && tops[0] === G.imp;
      G.reveal = { votes: { ...G.votes }, accused: tops.length === 1 ? tops[0] : null, caught, guess: null, gains: {} };
      if (caught && byId(G.imp)) {
        const others = GameUtil.shuffle(WORDS[G.cat].filter((w) => w !== G.word)).slice(0, 7);
        G.options = GameUtil.shuffle([G.word, ...others]);
        G.phase = "guess";
        G.ends = Date.now() + GUESS_MS;
        G.timer = setTimeout(() => finish(null), GUESS_MS);
        return publish();
      }
      finish(null);
    }
    function guess(id, w) {
      if (G.phase !== "guess" || id !== G.imp || !G.options.includes(w)) return;
      finish(w);
    }
    function finish(guessWord) {
      clearTimeout(G.timer);
      const R = G.reveal, gains = R.gains;
      R.guess = guessWord;
      const add = (id, n) => { const p = byId(id); if (p && n) { p.score += n; gains[id] = (gains[id] || 0) + n; } };
      if (!R.caught) add(G.imp, 200);
      else if (guessWord === G.word) add(G.imp, 150);
      else for (const p of G.players) if (p.id !== G.imp) add(p.id, R.votes[p.id] === G.imp ? 100 : 50);
      G.phase = "reveal";
      G.ends = Date.now() + REVEAL_MS;
      G.timer = setTimeout(nextRound, REVEAL_MS);
      publish();
    }
    function leave(id) {
      G.gone.add(id);
      G.players = G.players.filter((p) => p.id !== id);
      delete G.votes[id];
      if (G.players.length < 3 && G.phase !== "end") { clearTimeout(G.timer); G.phase = "end"; return publish(); }
      if (id === G.imp && G.phase !== "reveal") return nextRound(); // imposter left: new round
      if (G.phase === "clue") {
        G.order = G.order.filter((x) => x !== id);
        if (G.turn >= G.order.length * LAPS) { G.phase = "vote"; G.ends = Date.now() + VOTE_MS; clearTimeout(G.timer); G.timer = setTimeout(tally, VOTE_MS); }
        else armClue();
      }
      if (G.phase === "vote" && G.players.every((p) => p.id in G.votes)) return tally();
      publish();
    }
    return { G, newGame, clue, vote, guess, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null, myVote = null;
  const name = (id) => { const p = V && V.players.find((x) => x.id === id); return p ? (p.id === room.myId ? "You" : p.name) : "?"; };

  function act(m) {
    if (room.isHost) {
      if (m.t === "clue") engine.clue(room.myId, m.c);
      else if (m.t === "vote") engine.vote(room.myId, m.who);
      else if (m.t === "guess") engine.guess(room.myId, m.w);
    } else room.send(m);
  }

  function render() {
    const v = V;
    // secret card
    const card = $("card");
    card.className = "im-card" + (v.iAmImp && v.phase !== "reveal" ? " imp" : "");
    $("cat").textContent = v.cat;
    $("word").textContent = v.phase === "reveal" ? v.word : v.iAmImp ? "You're the imposter!" : v.word;
    $("cardHint").textContent = v.phase === "reveal" ? "The word was" : v.iAmImp ? "Blend in. Figure out the word from everyone's clues." : "Give clues that prove you know it, without giving it away.";
    // clues
    const list = $("clues");
    list.textContent = "";
    const byPlayer = new Map(v.players.map((p) => [p.id, []]));
    for (const c of v.clues) if (byPlayer.has(c.id)) byPlayer.get(c.id).push(c.c);
    for (const p of v.players) {
      const canVote = v.phase === "vote" && p.id !== room.myId && myVote == null && !v.voted.includes(room.myId);
      const row = h(canVote ? "button" : "div", "im-row" + (v.turn === p.id ? " turn" : "") + (myVote === p.id ? " picked" : "") + (v.phase === "reveal" && p.id === v.imp ? " imp" : ""));
      if (canVote) { row.type = "button"; row.addEventListener("click", () => { myVote = p.id; GameUtil.sfx("click"); act({ t: "vote", who: p.id }); render(); }); }
      row.append(GameUtil.avatar(p), h("span", "im-name", p.id === room.myId ? "You" : p.name));
      const cl = h("span", "im-words");
      for (const w of byPlayer.get(p.id)) cl.append(h("b", "", w));
      if (v.turn === p.id) cl.append(h("i", "im-typing", "…"));
      row.append(cl);
      if (v.phase === "reveal" && v.reveal) {
        const n = Object.values(v.reveal.votes).filter((x) => x === p.id).length;
        if (n) row.append(h("span", "im-votes", `${n} vote${n === 1 ? "" : "s"}`));
      } else if (v.phase === "vote" && v.voted.includes(p.id)) row.append(h("span", "im-voted", "voted"));
      list.append(row);
    }
    // controls
    const myTurn = v.phase === "clue" && v.turn === room.myId;
    $("clueForm").hidden = !myTurn;
    $("guessBox").hidden = !(v.phase === "guess" && v.options);
    if (v.phase === "guess" && v.options) {
      const g = $("guessOpts");
      g.textContent = "";
      for (const w of v.options) {
        const b = h("button", "btn", w);
        b.type = "button";
        b.addEventListener("click", () => { GameUtil.sfx("click"); act({ t: "guess", w }); g.querySelectorAll("button").forEach((x) => (x.disabled = true)); });
        g.append(b);
      }
    }
    const R = v.reveal;
    $("status").textContent =
      v.phase === "clue" ? (myTurn ? "Your turn: one word!" : `${name(v.turn)} is giving a clue · lap ${v.lap} of ${v.laps}`)
      : v.phase === "vote" ? (myVote != null || v.voted.includes(room.myId) ? "Vote in. Waiting for everyone…" : "Who's the imposter? Tap a player to vote.")
      : v.phase === "guess" ? (v.iAmImp ? "Busted! Name the word to steal the round." : `Caught ${name(v.imp)}! They get one guess at the word…`)
      : v.phase === "reveal" && R ? (v.imp === room.myId
        ? (!R.caught ? "You got away with it! +200" : R.guess === v.word ? "Caught, but you guessed the word! +150" : "You got caught!")
        : !R.caught ? `${name(v.imp)} was the imposter and got away with it!`
        : R.guess === v.word ? `${name(v.imp)} was caught but guessed “${v.word}”!` : `Caught ${name(v.imp)}! ${R.guess ? `They guessed “${R.guess}”.` : "No guess."}`)
      : "";
    const board = $("board");
    board.textContent = "";
    for (const p of [...v.players].sort((a, b) => b.score - a.score)) {
      const el = h("div", "pl" + (p.id === room.myId ? " me" : ""));
      el.append(GameUtil.avatar(p), h("span", "", p.name), h("span", "pts", p.score));
      if (R && R.gains[p.id] && v.phase === "reveal") el.append(h("span", "gain", "+" + R.gains[p.id]));
      board.append(el);
    }
  }

  function onState(v) {
    const prev = V;
    V = v;
    if (!prev || prev.round !== v.round) myVote = null;
    $("round").textContent = v.phase === "end" ? "Game over" : `Round ${v.round} of ${v.rounds}`;
    if (v.phase !== "end") render();
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase !== "reveal" && v.phase !== "end" ? fmt(left) : ""; });
    if (v.phase === "clue" && v.turn === room.myId && (!prev || prev.turn !== room.myId || prev.phase !== "clue")) { GameUtil.sfx("turn"); setTimeout(() => $("clueIn").focus(), 50); }
    if (prev && prev.phase !== v.phase) {
      if (v.phase === "vote") GameUtil.sfx("pop");
      if (v.phase === "reveal") GameUtil.sfx(v.reveal && v.reveal.gains[room.myId] ? "good" : "bad");
    }
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const top = sorted[0] ? sorted[0].score : 0;
      const won = sorted.some((p) => p.id === room.myId && p.score === top);
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("imposter", won ? "win" : "loss");
      results({ title: won ? "Master of deception!" : sorted[0] ? `${sorted[0].name} wins` : "Game over", rows: sorted.map((p) => ({ p, value: p.score + " pts", win: p.score === top })), isHost: room.isHost, meId: room.myId });
    } else if (v.phase !== "end") hideResults();
  }

  $("clueForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const c = cleanClue($("clueIn").value);
    if (!c) return;
    $("clueIn").value = "";
    act({ t: "clue", c });
  });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "imposter",
    title: "Imposter",
    subtitle: "Everyone knows the secret word except one faker. Give one-word clues and vote out the imposter. 3 to 10 players.",
    min: 3,
    max: 10,
    onStart(r) {
      room = r; V = null; myVote = null;
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? onState(m) : r.sendTo(id, m)) };
        engine = createEngine(r, out);
        r.onData((from, m) => {
          if (!m) return;
          if (m.t === "clue") engine.clue(from, m.c);
          else if (m.t === "vote") engine.vote(from, m.who);
          else if (m.t === "guess") engine.guess(from, m.w);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view(id)));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
