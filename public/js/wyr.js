// Would You Rather, 2–12 players. Everyone picks a side in secret, then the split is revealed
// with names. Side with the majority scores. Hosts can add their own questions.
(() => {
  const ROUNDS = 10, VOTE_MS = 15000, SHOW_MS = 6000;
  const QS = [
    ["Be able to fly", "Be invisible"], ["Never do homework again", "Never have to sleep"], ["Live without music", "Live without TV"],
    ["Always be 10 minutes late", "Always be 20 minutes early"], ["Have a pet dragon", "Have a pet unicorn"], ["Only eat pizza forever", "Never eat pizza again"],
    ["Talk to animals", "Speak every language"], ["Be the funniest person", "Be the smartest person"], ["Live in the city", "Live in the country"],
    ["Have summer all year", "Have winter all year"], ["Be a famous singer", "Be a famous athlete"], ["Explore space", "Explore the deep ocean"],
    ["Have no phone for a month", "Have no friends for a week"], ["Time travel to the past", "Time travel to the future"], ["Win the lottery", "Live twice as long"],
    ["Be a wizard", "Be a superhero"], ["Have a rewind button", "Have a pause button"], ["Eat a spoon of mustard", "Eat a spoon of mayo"],
    ["Never use the internet again", "Never watch a movie again"], ["Have super speed", "Have super strength"], ["Live in a treehouse", "Live on a boat"],
    ["Be able to read minds", "Be able to see the future"], ["Fight 1 horse-sized duck", "Fight 100 duck-sized horses"], ["Only whisper", "Only shout"],
    ["Have a personal chef", "Have a personal driver"], ["Be stuck in a game", "Be stuck in a movie"], ["Always have to sing", "Always have to dance"],
    ["Give up chocolate", "Give up chips"], ["Know how you die", "Know when you die"], ["Be a kid forever", "Be an adult now"],
    ["Have a talking dog", "Have a flying cat"], ["Go to a theme park", "Go to the beach"], ["Never feel cold", "Never feel tired"],
    ["Teleport anywhere", "Pause time"], ["Have 1 real best friend", "Have 50 fun friends"], ["Live without a fridge", "Live without an oven"],
    ["Be really tall", "Be really short"], ["Have hiccups forever", "Always feel like sneezing"], ["Play every game perfectly", "Win every argument"],
    ["Have a robot helper", "Have a magic wand with 3 wishes a year"], ["Lose your phone", "Lose your wallet"], ["Only eat breakfast food", "Never eat breakfast food"],
    ["Be a YouTuber", "Be a pro gamer"], ["Swim with sharks", "Hold a tarantula"], ["Have no homework", "Have a 3-day weekend"],
    ["Be a ghost", "Be a vampire"], ["Only watch cartoons", "Only watch documentaries"], ["Eat a bug", "Lick a doorknob"],
    ["Have unlimited snacks", "Have unlimited game time"], ["Be famous for something silly", "Be unknown but rich"], ["Ride a dinosaur", "Ride a dragon"],
    ["Live on the moon", "Live under the sea"], ["Never lose a game", "Never lose your keys"], ["Have a secret room", "Have a secret pool"],
    ["Be the oldest sibling", "Be the youngest sibling"], ["Have a pause for life", "Have skip ads for life"], ["Sneeze glitter", "Cry lemonade"],
    ["Be able to breathe underwater", "Be able to see in the dark"], ["Have a giant house", "Have a tiny house that travels"], ["Know every song", "Know every movie"],
  ];
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);
  const CUSTOM_KEY = "oxidpvp-wyr-custom";
  const parseCustom = (txt) => String(txt || "").split(/\n/).map((l) => l.split(/\s+(?:\||or)\s+/i).map((x) => x.trim().slice(0, 80))).filter((p) => p.length === 2 && p[0] && p[1]);

  function createEngine(room, out, custom) {
    const G = { players: [], round: 0, phase: "idle", q: null, votes: {}, ends: 0, timer: 0, gone: new Set(), deck: [] };
    const view = () => ({
      t: "st", phase: G.phase, round: G.round, rounds: ROUNDS, left: Math.max(0, G.ends - Date.now()), q: G.q,
      voted: Object.keys(G.votes).map(Number), votes: G.phase === "show" || G.phase === "end" ? G.votes : null,
      players: G.players.map((p) => ({ id: p.id, name: p.name, av: p.av, score: p.score, gain: p.gain || 0 })),
    });
    const publish = () => { const v = view(); for (const p of room.players) if (!G.gone.has(p.id)) out.to(p.id, v); };
    function newGame() {
      clearTimeout(G.timer);
      G.players = room.players.filter((p) => !G.gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 }));
      G.round = 0;
      const pool = [...parseCustom(custom), ...GameUtil.shuffle(QS.slice())];
      G.deck = custom && parseCustom(custom).length ? [...GameUtil.shuffle(parseCustom(custom)), ...GameUtil.shuffle(QS.slice())] : pool;
      next();
    }
    function next() {
      clearTimeout(G.timer);
      G.round++;
      if (G.round > ROUNDS || !G.deck.length) { G.phase = "end"; return publish(); }
      const q = G.deck.shift();
      G.q = Math.random() < 0.5 ? q : [q[1], q[0]];
      G.votes = {}; for (const p of G.players) p.gain = 0;
      G.phase = "vote"; G.ends = Date.now() + VOTE_MS;
      G.timer = setTimeout(reveal, VOTE_MS);
      publish();
    }
    function vote(id, side) {
      if (G.phase !== "vote" || !G.players.some((p) => p.id === id) || (side !== 0 && side !== 1)) return;
      G.votes[id] = side;
      if (G.players.every((p) => G.votes[p.id] != null)) return reveal();
      publish();
    }
    function reveal() {
      if (G.phase !== "vote") return;
      clearTimeout(G.timer);
      const n = [0, 0];
      for (const v of Object.values(G.votes)) n[v]++;
      for (const p of G.players) {
        const v = G.votes[p.id];
        if (v == null) continue;
        p.gain = n[v] >= n[1 - v] ? 100 : 0;
        if (n[v] === 1 && n[1 - v] >= 2) p.gain = 25; // lone wolf still gets something
        p.score += p.gain;
      }
      G.phase = "show"; G.ends = Date.now() + SHOW_MS;
      G.timer = setTimeout(next, SHOW_MS);
      publish();
    }
    function leave(id) {
      G.gone.add(id); G.players = G.players.filter((p) => p.id !== id);
      if (G.phase === "vote" && G.players.length && G.players.every((p) => G.votes[p.id] != null)) return reveal();
      publish();
    }
    return { newGame, vote, leave, view, stop: () => clearTimeout(G.timer) };
  }

  let room = null, engine = null, V = null, stopClock = null;
  function render() {
    const v = V;
    $("round").textContent = `Round ${v.round} of ${v.rounds}`;
    const mine = v.votes ? v.votes[room.myId] : null;
    const counts = [0, 0];
    if (v.votes) for (const x of Object.values(v.votes)) counts[x]++;
    const total = counts[0] + counts[1];
    [0, 1].forEach((i) => {
      const b = $("opt" + i);
      b.querySelector("b").textContent = v.q ? v.q[i] : "";
      b.classList.toggle("picked", myPick === i);
      b.classList.toggle("shown", !!v.votes);
      b.disabled = v.phase !== "vote";
      const pct = total ? Math.round((counts[i] / total) * 100) : 0;
      b.querySelector(".wy-pct").textContent = v.votes ? pct + "%" : "";
      b.style.setProperty("--p", v.votes ? pct + "%" : "0%");
      const who = b.querySelector(".wy-who");
      who.textContent = "";
      if (v.votes) for (const p of v.players) if (v.votes[p.id] === i) who.append(GameUtil.avatar(p, "xs"));
    });
    $("status").textContent = v.phase === "vote" ? (myPick != null ? `Locked in! ${v.voted.length} of ${v.players.length} voted` : "Pick one!") : v.phase === "show" ? (mine == null ? "You didn't vote" : counts[mine] >= counts[1 - mine] ? "You're with the crowd! +100" : "You're on your own…") : "";
    const board = $("board");
    board.textContent = "";
    for (const p of [...v.players].sort((a, b) => b.score - a.score)) {
      const el = h("div", "pl" + (p.id === room.myId ? " me" : "") + (v.voted.includes(p.id) ? " done" : ""));
      el.append(GameUtil.avatar(p), h("span", "", p.name), h("span", "pts", p.score));
      if (p.gain && v.phase === "show") el.append(h("span", "gain", "+" + p.gain));
      board.append(el);
    }
  }
  let myPick = null;
  function onState(v) {
    const prev = V;
    if (!prev || prev.round !== v.round) { myPick = null; if (v.phase === "vote") GameUtil.sfx("pop"); }
    V = v;
    if (v.phase === "show" && prev && prev.phase === "vote") GameUtil.sfx("tick");
    if (v.phase !== "end") render();
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase === "vote" ? fmt(left) : ""; });
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const sorted = [...v.players].sort((a, b) => b.score - a.score), top = sorted[0] ? sorted[0].score : 0;
      const won = sorted.some((p) => p.id === room.myId && p.score === top);
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("wyr", won ? "win" : "loss");
      results({ title: won ? "You read the room!" : `${sorted[0].name} wins`, rows: sorted.map((p) => ({ p, value: p.score + " pts", win: p.score === top })), isHost: room.isHost, meId: room.myId });
    } else if (v.phase !== "end") hideResults();
  }
  for (const i of [0, 1]) $("opt" + i).addEventListener("click", () => {
    if (!V || V.phase !== "vote") return;
    myPick = i; GameUtil.sfx("click"); render();
    if (room.isHost) engine.vote(room.myId, i); else room.send({ t: "v", side: i });
  });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });
  function buildSettings(el) {
    let saved = "";
    try { saved = localStorage.getItem(CUSTOM_KEY) || ""; } catch {}
    el.innerHTML = `<details class="custom-q"><summary>Your own questions</summary><textarea rows="4" spellcheck="false" placeholder="One per line: Option A | Option B"></textarea></details>`;
    const ta = el.querySelector("textarea");
    ta.value = saved;
    ta.addEventListener("input", () => { try { localStorage.setItem(CUSTOM_KEY, ta.value); } catch {} });
    ta.addEventListener("keydown", (e) => e.stopPropagation());
  }
  Room.mount({
    game: "wyr", title: "Would You Rather",
    subtitle: "Pick a side in secret, then see who agrees. Side with the crowd to score. 2 to 12 players.",
    min: 2, max: 12, lobbyExtra: buildSettings,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        let custom = ""; try { custom = localStorage.getItem(CUSTOM_KEY) || ""; } catch {}
        const out = { to: (id, m) => (id === r.myId ? onState(m) : r.sendTo(id, m)) };
        engine = createEngine(r, out, custom);
        r.onData((from, m) => { if (m && m.t === "v") engine.vote(from, m.side); });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view()));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
