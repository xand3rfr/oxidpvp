// Emoji Guess, 2–10 players. Each round shows a movie, show, game or saying written in emojis.
// Type your guess: close spellings count, and the faster you get it the more you score. Letters
// of the answer are revealed as hints while the clock runs down. The host checks every guess.
(() => {
  const ROUNDS = 10, ROUND_MS = 30000, SHOW_MS = 4500;
  const PUZZLES = [
    ["Movie", "🦁👑", "The Lion King"], ["Movie", "❄️👸⛄", "Frozen"], ["Movie", "🕷️🧑", "Spider-Man"], ["Movie", "🦈🌊😱", "Jaws"],
    ["Movie", "👻🚫📞", "Ghostbusters"], ["Movie", "🧸🤠🚀", "Toy Story"], ["Movie", "🐠🔍", "Finding Nemo"], ["Movie", "🏠🎈👴", "Up"],
    ["Movie", "🦖🏝️", "Jurassic Park"], ["Movie", "🚢🧊💔", "Titanic"], ["Movie", "🧙‍♂️💍🌋", "The Lord of the Rings"], ["Movie", "⚡👓🧙", "Harry Potter"],
    ["Movie", "🐭👨‍🍳🇫🇷", "Ratatouille"], ["Movie", "🤖🗑️🌱", "WALL-E"], ["Movie", "🦸‍♂️🦇🌃", "Batman"], ["Movie", "👽📞🏠", "ET"],
    ["Movie", "🐼🥋", "Kung Fu Panda"], ["Movie", "🧞‍♂️🪔🐒", "Aladdin"], ["Movie", "🐟💙🧠", "Finding Dory"], ["Movie", "🚗⚡💨", "Cars"],
    ["Movie", "👸🍎💤", "Snow White"], ["Movie", "🧜‍♀️🔱", "The Little Mermaid"], ["Movie", "🦍🏙️", "King Kong"], ["Movie", "👹💚🧅", "Shrek"],
    ["Movie", "🍫🏭🎟️", "Charlie and the Chocolate Factory"], ["Movie", "🧠😀😢😡", "Inside Out"], ["Movie", "🐝🎬", "Bee Movie"], ["Movie", "🐧🎵👞", "Happy Feet"],
    ["Movie", "⭐⚔️", "Star Wars"], ["Movie", "🔨⚡👑", "Thor"], ["Movie", "🐺🌕🐷🐷🐷", "Three Little Pigs"], ["Movie", "🧛‍♂️🏨", "Hotel Transylvania"],
    ["Show", "🧽🍍🌊", "SpongeBob"], ["Show", "👦🔬🧪👴", "Rick and Morty"], ["Show", "🟡👨‍👩‍👧‍👦🍩", "The Simpsons"], ["Show", "🧇🚲👧🔦", "Stranger Things"],
    ["Show", "🐉👑⚔️", "Game of Thrones"], ["Show", "☕🛋️👫", "Friends"], ["Show", "🐶🔍👻🚐", "Scooby Doo"], ["Show", "🦑🎮💰", "Squid Game"],
    ["Game", "⛏️🧱🐷", "Minecraft"], ["Game", "🍄👨‍🔧👸", "Mario"], ["Game", "🟡👻🍒", "Pac-Man"], ["Game", "🔪🚀👨‍🚀", "Among Us"],
    ["Game", "🦔💨💍", "Sonic"], ["Game", "🚗⚽🥅", "Rocket League"], ["Game", "🪂🔫🏗️", "Fortnite"], ["Game", "😡🐦🐷", "Angry Birds"],
    ["Game", "🧱⬇️📐", "Tetris"], ["Game", "⚡🐭🎒", "Pokemon"],
    ["Saying", "🌧️🐱🐶", "Raining cats and dogs"], ["Saying", "🍰🚶‍♂️", "Piece of cake"], ["Saying", "🐘🏠", "Elephant in the room"],
    ["Saying", "⏰💸", "Time is money"], ["Saying", "🍎👨‍⚕️🚫", "An apple a day keeps the doctor away"], ["Saying", "🦵💥🎭", "Break a leg"],
    ["Saying", "🐦🐦🪨", "Two birds one stone"], ["Saying", "🌙🍯", "Honeymoon"], ["Saying", "🧊🔨", "Break the ice"], ["Saying", "🐂🏪🍽️", "Bull in a china shop"],
    ["Song", "⭐✨🎵🌙", "Twinkle Twinkle Little Star"], ["Song", "🎂🎉🎵", "Happy Birthday"], ["Song", "🐑🐑👧", "Mary Had a Little Lamb"], ["Song", "🔔🔔❄️", "Jingle Bells"],
    ["Song", "🕷️🌧️🌞", "Itsy Bitsy Spider"], ["Song", "🚣‍♂️🚣‍♂️🌊", "Row Row Row Your Boat"],
  ];
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);
  const norm = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]/g, "");
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  const close = (g, ans) => { const a = norm(ans), b = norm(g); if (!b) return false; return a === b || (a.length >= 6 && lev(a, b) <= Math.floor(a.length / 6)); };

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], round: 0, phase: "idle", q: null, ends: 0, started: 0, got: {}, timer: 0, hintT: 0, shown: [], deck: [], gone: new Set(), feed: [] };
    const byId = (id) => G.players.find((p) => p.id === id);
    const hint = () => {
      if (!G.q) return "";
      const a = G.q[2];
      return [...a].map((c, i) => (/[a-z0-9]/i.test(c) ? (G.shown.includes(i) || G.phase !== "guess" ? c : "_") : c)).join("");
    };
    const view = (id) => ({
      t: "st", phase: G.phase, round: G.round, rounds: ROUNDS, left: Math.max(0, G.ends - Date.now()),
      cat: G.q && G.q[0], clue: G.q && G.q[1], hint: hint(), answer: G.phase !== "guess" || G.got[id] ? G.q && G.q[2] : null,
      players: G.players.map((p) => ({ id: p.id, name: p.name, av: p.av, score: p.score, got: !!G.got[p.id], gain: G.got[p.id] || 0 })), feed: G.feed,
    });
    const publish = () => { for (const p of room.players) if (!G.gone.has(p.id)) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer); clearInterval(G.hintT);
      G.players = room.players.filter((p) => !G.gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 }));
      G.round = 0;
      nextRound();
    }
    function nextRound() {
      clearTimeout(G.timer); clearInterval(G.hintT);
      G.round++;
      if (G.round > ROUNDS) { G.phase = "end"; return publish(); }
      if (!G.deck.length) G.deck = GameUtil.shuffle(PUZZLES.map((_, i) => i));
      G.q = PUZZLES[G.deck.pop()];
      G.got = {}; G.shown = []; G.feed = [];
      G.phase = "guess";
      G.started = Date.now();
      G.ends = G.started + ROUND_MS;
      G.timer = setTimeout(reveal, ROUND_MS);
      // Reveal a letter every few seconds after the first 10.
      const letters = [...G.q[2]].map((c, i) => (/[a-z0-9]/i.test(c) ? i : -1)).filter((i) => i >= 0);
      const maxShow = Math.floor(letters.length * 0.45);
      G.hintT = setInterval(() => {
        if (Date.now() - G.started < 10000 || G.shown.length >= maxShow) return;
        const pool = letters.filter((i) => !G.shown.includes(i));
        G.shown.push(pool[Math.floor(Math.random() * pool.length)]);
        publish();
      }, 3500);
      publish();
    }
    function guess(id, text) {
      const p = byId(id);
      if (G.phase !== "guess" || !p || G.got[id]) return;
      text = String(text || "").slice(0, 60);
      if (close(text, G.q[2])) {
        const frac = Math.max(0, (G.ends - Date.now()) / ROUND_MS);
        const order = Object.keys(G.got).length;
        const gain = Math.round(50 + 100 * frac) + (order === 0 ? 25 : 0);
        G.got[id] = gain; p.score += gain;
        G.feed.unshift({ id, ok: true });
        if (G.players.every((x) => G.got[x.id])) return reveal();
      } else {
        G.feed.unshift({ id, text: text.slice(0, 30) });
      }
      G.feed.length = Math.min(G.feed.length, 8);
      publish();
    }
    function reveal() {
      if (G.phase !== "guess") return;
      clearTimeout(G.timer); clearInterval(G.hintT);
      G.phase = "show";
      G.ends = Date.now() + SHOW_MS;
      G.timer = setTimeout(nextRound, SHOW_MS);
      publish();
    }
    function leave(id) {
      G.gone.add(id);
      G.players = G.players.filter((p) => p.id !== id);
      if (G.players.length < 1) { clearTimeout(G.timer); clearInterval(G.hintT); return; }
      if (G.phase === "guess" && G.players.every((x) => G.got[x.id])) return reveal();
      publish();
    }
    return { G, newGame, guess, leave, view, stop: () => { clearTimeout(G.timer); clearInterval(G.hintT); } };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null;
  const nm = (id) => { const p = V && V.players.find((x) => x.id === id); return p ? (p.id === room.myId ? "You" : p.name) : "?"; };

  function render() {
    const v = V, me = v.players.find((p) => p.id === room.myId);
    $("round").textContent = v.phase === "end" ? "Game over" : `Round ${v.round} of ${v.rounds}`;
    $("cat").textContent = v.cat || "";
    $("clue").textContent = v.clue || "";
    $("hint").textContent = v.answer || v.hint;
    $("hint").classList.toggle("solved", !!v.answer);
    $("form").hidden = !(v.phase === "guess" && me && !me.got);
    const feed = $("feed");
    feed.textContent = "";
    for (const f of v.feed) feed.append(h("li", f.ok ? "ok" : "", f.ok ? `${nm(f.id)} got it!` : `${nm(f.id)}: ${f.text}`));
    $("status").textContent = v.phase === "guess" ? (me && me.got ? `Nice! +${me.gain}. Waiting for the others…` : `Guess the ${String(v.cat).toLowerCase()}!`) : v.phase === "show" ? `It was “${v.answer}”` : "";
    const board = $("board");
    board.textContent = "";
    for (const p of [...v.players].sort((a, b) => b.score - a.score)) {
      const el = h("div", "pl" + (p.id === room.myId ? " me" : "") + (p.got ? " done" : ""));
      el.append(GameUtil.avatar(p), h("span", "", p.name), h("span", "pts", p.score));
      if (p.gain) el.append(h("span", "gain", "+" + p.gain));
      board.append(el);
    }
  }
  function onState(v) {
    const prev = V;
    V = v;
    if (v.phase !== "end") render();
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase === "guess" ? fmt(left) : ""; });
    const me = v.players.find((p) => p.id === room.myId), pme = prev && prev.players.find((p) => p.id === room.myId);
    if (me && me.got && pme && !pme.got) GameUtil.sfx("good");
    if (prev && prev.round !== v.round && v.phase === "guess") { GameUtil.sfx("pop"); $("guess").value = ""; setTimeout(() => $("guess").focus(), 50); }
    if (prev && prev.feed.length < v.feed.length && v.feed[0] && !v.feed[0].ok && v.feed[0].id === room.myId) { GameUtil.sfx("bad"); $("form").classList.remove("shake"); void $("form").offsetWidth; $("form").classList.add("shake"); }
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const sorted = [...v.players].sort((a, b) => b.score - a.score);
      const top = sorted[0] ? sorted[0].score : 0;
      const won = sorted.some((p) => p.id === room.myId && p.score === top);
      GameUtil.sfx(won ? "win" : "lose");
      if (v.players.length > 1) GameUtil.record("emoji", won ? "win" : "loss");
      results({ title: won ? "Emoji master!" : `${sorted[0].name} wins`, rows: sorted.map((p) => ({ p, value: p.score + " pts", win: p.score === top })), isHost: room.isHost, meId: room.myId });
    } else if (v.phase !== "end") hideResults();
  }

  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("guess").value.trim();
    if (!t) return;
    $("guess").value = "";
    if (room.isHost) engine.guess(room.myId, t); else room.send({ t: "g", text: t });
  });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "emoji",
    title: "Emoji Guess",
    subtitle: "Movies, shows, games and sayings written in emojis. Guess fast for more points. 1 to 10 players.",
    min: 1,
    max: 10,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? onState(m) : r.sendTo(id, m)) };
        engine = createEngine(r, out);
        r.onData((from, m) => { if (m && m.t === "g") engine.guess(from, m.text); });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view(id)));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
