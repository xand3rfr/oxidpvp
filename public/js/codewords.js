// Codewords: team word game for 4–10 players (Red vs Blue). Each team has one spymaster who
// sees which of the 25 words belong to their team, and gives one-word clues plus a number.
// Their teammates guess; hitting the other team's word or a neutral ends the turn, and the
// single assassin word loses the game instantly. First team to find all its words wins.
// The host holds the key and only sends it to the two spymasters.
(() => {
  const RED = 0, BLUE = 1, NEUTRAL = 2, ASSASSIN = 3;
  const TEAM = ["Red", "Blue"];
  const { h, results, hideResults } = Party;
  const $ = (id) => document.getElementById(id);

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = {
      players: room.players.map((p, i) => ({ id: p.id, name: p.name, av: p.av, team: i % 2, role: i < 2 ? "spy" : "op" })),
      phase: "setup", words: [], key: [], revealed: [], turn: RED, step: "clue", clue: null, left: 0, log: [], winner: null, why: "",
    };
    const byId = (id) => G.players.find((p) => p.id === id);
    const remaining = (team) => G.key.filter((k, i) => k === team && !G.revealed[i]).length;

    function view(id) {
      const me = byId(id);
      const seeKey = G.phase === "end" || (me && me.role === "spy");
      return {
        t: "st", phase: G.phase, turn: G.turn, step: G.step, clue: G.clue, left: G.left, log: G.log.slice(-12), winner: G.winner, why: G.why,
        players: G.players.map(({ id, name, av, team, role }) => ({ id, name, av, team, role })),
        words: G.words, revealed: G.revealed,
        key: G.key.map((k, i) => (seeKey || G.revealed[i] ? k : null)),
        remaining: G.phase === "setup" ? [0, 0] : [remaining(RED), remaining(BLUE)],
      };
    }
    const publish = () => { for (const p of G.players) out.to(p.id, view(p.id)); };

    function setupOk() {
      return [RED, BLUE].every((t) => {
        const team = G.players.filter((p) => p.team === t);
        return team.length >= 2 && team.filter((p) => p.role === "spy").length === 1;
      });
    }
    function pickTeam(id, team, role) {
      const p = byId(id);
      if (!p || G.phase !== "setup" || (team !== RED && team !== BLUE)) return;
      p.team = team;
      if (role === "spy") for (const q of G.players) if (q.team === team && q.role === "spy") q.role = "op";
      p.role = role === "spy" ? "spy" : "op";
      publish();
    }
    function randomize() {
      if (G.phase !== "setup") return;
      const ids = GameUtil.shuffle(G.players.map((p) => p.id));
      ids.forEach((id, i) => { const p = byId(id); p.team = i % 2; p.role = i < 2 ? "spy" : "op"; });
      publish();
    }
    function start() {
      if (!setupOk()) return false;
      const first = Math.random() < 0.5 ? RED : BLUE;
      G.words = GameUtil.shuffle(window.CODEWORDS.slice()).slice(0, 25);
      const key = [...Array(first === RED ? 9 : 8).fill(RED), ...Array(first === BLUE ? 9 : 8).fill(BLUE), ...Array(7).fill(NEUTRAL), ASSASSIN];
      G.key = GameUtil.shuffle(key);
      G.revealed = new Array(25).fill(false);
      G.turn = first; G.step = "clue"; G.clue = null; G.left = 0; G.log = []; G.winner = null; G.why = "";
      G.phase = "play";
      publish();
      return true;
    }
    function clue(id, word, n) {
      const p = byId(id);
      if (G.phase !== "play" || G.step !== "clue" || !p || p.role !== "spy" || p.team !== G.turn) return;
      word = String(word || "").trim().toLowerCase().replace(/[^a-z-]/g, "").slice(0, 24);
      n = n | 0;
      if (!word || n < 0 || n > 9) return;
      if (G.words.some((w, i) => !G.revealed[i] && (w === word || w.includes(word) || word.includes(w)))) {
        out.to(id, { t: "err", text: "Your clue can't be (or contain) a word on the board." });
        return;
      }
      G.clue = { word, n, team: G.turn };
      G.left = n === 0 ? 99 : n + 1;
      G.step = "guess";
      G.log.push({ team: G.turn, text: `${word.toUpperCase()} · ${n}` });
      publish();
    }
    function guess(id, i) {
      const p = byId(id);
      if (G.phase !== "play" || G.step !== "guess" || !p || p.role !== "op" || p.team !== G.turn) return;
      if (!(i >= 0 && i < 25) || G.revealed[i]) return;
      G.revealed[i] = true;
      const k = G.key[i];
      G.log.push({ team: G.turn, text: `${p.name} picked ${G.words[i].toUpperCase()}`, k });
      if (k === ASSASSIN) return win(1 - G.turn, `${TEAM[G.turn]} hit the assassin!`);
      if (remaining(RED) === 0) return win(RED, "Red found all their words.");
      if (remaining(BLUE) === 0) return win(BLUE, "Blue found all their words.");
      if (k === G.turn) {
        G.left--;
        if (G.left <= 0) return switchTurn();
        return publish();
      }
      switchTurn();
    }
    function endTurn(id) {
      const p = byId(id);
      if (G.phase !== "play" || G.step !== "guess" || !p || p.team !== G.turn) return;
      switchTurn();
    }
    function switchTurn() {
      G.turn = 1 - G.turn; G.step = "clue"; G.clue = null; G.left = 0;
      publish();
    }
    function win(team, why) { G.phase = "end"; G.winner = team; G.why = why; publish(); }
    function toSetup() { G.phase = "setup"; G.winner = null; publish(); }
    function leave(id) {
      const p = byId(id);
      if (!p) return;
      G.players = G.players.filter((x) => x.id !== id);
      if (G.phase === "play") {
        const team = G.players.filter((x) => x.team === p.team);
        if (!team.length) return win(1 - p.team, `${TEAM[p.team]} has no players left.`);
        if (p.role === "spy") team[0].role = "spy"; // someone has to give clues
      }
      publish();
    }
    return { G, pickTeam, randomize, start, clue, guess, endTurn, toSetup, leave, view, setupOk };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null;
  const send = (m) => {
    if (!room.isHost) return room.send(m);
    const id = room.myId;
    if (m.t === "team") engine.pickTeam(id, m.team, m.role);
    else if (m.t === "clue") engine.clue(id, m.word, m.n);
    else if (m.t === "guess") engine.guess(id, m.i);
    else if (m.t === "end") engine.endTurn(id);
  };

  function renderSetup(v) {
    const me = v.players.find((p) => p.id === room.myId);
    for (const t of [RED, BLUE]) {
      const col = $(t === RED ? "redTeam" : "blueTeam");
      col.textContent = "";
      for (const p of v.players.filter((x) => x.team === t)) {
        const li = h("li", p.id === room.myId ? "me" : "");
        li.append(GameUtil.avatar(p), h("span", "pname", p.name), h("span", "role", p.role === "spy" ? "Spymaster" : "Guesser"));
        col.append(li);
      }
    }
    document.querySelectorAll("[data-team]").forEach((b) => {
      const t = +b.dataset.team, role = b.dataset.role;
      b.classList.toggle("on", me && me.team === t && me.role === role);
    });
    const ok = [RED, BLUE].every((t) => {
      const team = v.players.filter((p) => p.team === t);
      return team.length >= 2 && team.filter((p) => p.role === "spy").length === 1;
    });
    $("startBtn").hidden = !room.isHost;
    $("shuffleTeams").hidden = !room.isHost;
    $("startBtn").disabled = !ok;
    $("setupMsg").textContent = ok ? (room.isHost ? "Teams look good. Start when ready!" : "Waiting for the host to start…") : "Each team needs a spymaster and at least one guesser.";
  }

  function onState(v) {
    const prev = V;
    V = v;
    $("setup").hidden = v.phase !== "setup";
    $("game").hidden = v.phase === "setup";
    if (v.phase === "setup") { hideResults(); return renderSetup(v); }

    const me = v.players.find((p) => p.id === room.myId) || {};
    const iSpy = me.role === "spy";
    const myTurn = me.team === v.turn;
    document.body.dataset.turn = v.turn;

    $("redLeft").textContent = v.remaining[RED];
    $("blueLeft").textContent = v.remaining[BLUE];
    $("turnText").textContent = v.phase === "end" ? `${TEAM[v.winner]} wins!` : `${TEAM[v.turn]}'s turn · ${v.step === "clue" ? "spymaster is thinking" : "guessing"}`;
    $("turnText").className = "cw-turn t" + (v.phase === "end" ? v.winner : v.turn);
    $("myRole").textContent = `You're ${me.team === RED ? "Red" : "Blue"} ${iSpy ? "spymaster" : "guesser"}`;

    // board
    const board = $("board");
    board.textContent = "";
    board.classList.toggle("spyview", iSpy && v.phase !== "end");
    const canGuess = v.phase === "play" && v.step === "guess" && myTurn && !iSpy;
    board.classList.toggle("live", canGuess);
    v.words.forEach((w, i) => {
      const k = v.key[i];
      const b = h("button", "cw-card" + (v.revealed[i] ? " open" : "") + (k != null ? " k" + k : ""), w);
      b.type = "button";
      b.disabled = !canGuess || v.revealed[i];
      b.addEventListener("click", () => send({ t: "guess", i }));
      board.append(b);
    });

    // clue bar
    const clueBar = $("clue");
    clueBar.textContent = "";
    if (v.clue && v.phase === "play") {
      clueBar.append(h("span", "cw-clue-word", v.clue.word.toUpperCase()), h("span", "cw-clue-n", v.clue.n));
      clueBar.append(h("span", "muted", v.left > 50 ? "unlimited guesses" : `${v.left} guess${v.left === 1 ? "" : "es"} left`));
    }
    $("clueForm").hidden = !(v.phase === "play" && v.step === "clue" && myTurn && iSpy);
    $("endTurn").hidden = !canGuess;

    // players + log
    for (const t of [RED, BLUE]) {
      const ul = $(t === RED ? "redList" : "blueList");
      ul.textContent = "";
      for (const p of v.players.filter((x) => x.team === t)) {
        const li = h("li", p.id === room.myId ? "me" : "");
        li.append(GameUtil.avatar(p, "xs"), p.name + (p.role === "spy" ? " 🔎" : ""));
        ul.append(li);
      }
    }
    const log = $("log");
    log.textContent = "";
    for (const e of v.log) log.append(h("li", "t" + e.team + (e.k != null ? " k" + e.k : ""), e.text));
    log.scrollTop = log.scrollHeight;

    if (prev && prev.phase === "play") {
      const newlyOpen = v.revealed.findIndex((r, i) => r && !prev.revealed[i]);
      if (newlyOpen >= 0) GameUtil.sfx(v.key[newlyOpen] === ASSASSIN ? "boom" : v.key[newlyOpen] === prev.turn ? "good" : "bad");
      else if (v.step !== prev.step || v.turn !== prev.turn) GameUtil.sfx(myTurn ? "turn" : "pop");
    }
    if (v.phase === "end") {
      if (!prev || prev.phase !== "end") {
        const won = me.team === v.winner;
        GameUtil.sfx(won ? "win" : "lose");
        GameUtil.record("codewords", won ? "win" : "loss");
        $("resultNote").textContent = v.why;
        results({
          title: won ? "Your team wins!" : `${TEAM[v.winner]} wins`,
          rows: [...v.players].sort((a, b) => (b.team === v.winner) - (a.team === v.winner)).map((p) => ({ p, value: `${TEAM[p.team]} ${p.role === "spy" ? "spymaster" : "guesser"}`, win: p.team === v.winner })),
          isHost: room.isHost, meId: room.myId, again: "New teams & board",
        });
      }
    } else hideResults();
  }

  // setup controls
  document.querySelectorAll("[data-team]").forEach((b) => b.addEventListener("click", () => send({ t: "team", team: +b.dataset.team, role: b.dataset.role })));
  $("shuffleTeams").addEventListener("click", () => engine && engine.randomize());
  $("startBtn").addEventListener("click", () => engine && engine.start());
  $("clueForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const word = $("clueWord").value.trim();
    if (!/^[a-zA-Z-]{2,24}$/.test(word)) return GameUtil.toast("Clues are a single word.");
    send({ t: "clue", word, n: +$("clueNum").value });
    $("clueWord").value = "";
  });
  $("endTurn").addEventListener("click", () => send({ t: "end" }));
  $("peek").addEventListener("click", () => hideResults());
  $("again").addEventListener("click", () => engine && engine.toSetup());

  Room.mount({
    game: "codewords",
    title: "Codewords",
    subtitle: "Red vs Blue. Spymasters give one-word clues; teammates find their words and avoid the assassin. 4 to 10 players.",
    min: 4,
    max: 10,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? onMsg(m) : r.sendTo(id, m)) };
        engine = createEngine(r, out);
        r.onData((from, m) => {
          if (!m) return;
          if (m.t === "team") engine.pickTeam(from, m.team | 0, m.role);
          else if (m.t === "clue") engine.clue(from, m.word, m.n);
          else if (m.t === "guess") engine.guess(from, m.i | 0);
          else if (m.t === "end") engine.endTurn(from);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => out.to(id, engine.view(id)));
        setTimeout(() => { if (engine) for (const p of engine.G.players) out.to(p.id, engine.view(p.id)); }, 300);
      } else r.onData((_, m) => m && onMsg(m));
      return () => { room = null; engine = null; V = null; hideResults(); };
    },
  });
  function onMsg(m) {
    if (m.t === "st") onState(m);
    else if (m.t === "err") GameUtil.toast(m.text);
  }
})();
