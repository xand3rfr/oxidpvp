// Liar's Dice for 2–6 players. Everyone rolls hidden dice, then players take turns raising a bid
// ("there are at least 4 fives on the table") or calling the last bid a lie. Ones are wild.
// The loser of each challenge loses a die; the last player with dice wins.
// The host rolls and referees; each player only ever receives their own dice until a reveal.
(() => {
  const START_DICE = 5, TURN_MS = 30000, REVEAL_MS = 5500;
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);
  const roll = () => 1 + Math.floor(Math.random() * 6);
  const FACE = ["", "ones", "twos", "threes", "fours", "fives", "sixes"];

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = {
      players: room.players.map((p) => ({ id: p.id, name: p.name, av: p.av, dice: [], out: false })),
      turn: null, bid: null, phase: "idle", reveal: null, ends: 0, log: "", winner: null, timer: 0,
    };
    const byId = (id) => G.players.find((p) => p.id === id);
    const alive = () => G.players.filter((p) => !p.out);
    const total = () => alive().reduce((n, p) => n + p.dice.length, 0);
    const nextAlive = (id) => {
      const list = G.players;
      let i = list.findIndex((p) => p.id === id);
      for (let k = 1; k <= list.length; k++) {
        const p = list[(i + k + list.length) % list.length];
        if (!p.out) return p.id;
      }
      return null;
    };

    function view(id) {
      const me = byId(id);
      const showAll = G.phase === "reveal" || G.phase === "end";
      return {
        t: "st", phase: G.phase, turn: G.turn, bid: G.bid, log: G.log, total: total(), winner: G.winner,
        left: Math.max(0, G.ends - Date.now()),
        players: G.players.map((p) => ({ id: p.id, name: p.name, av: p.av, n: p.dice.length, out: p.out, dice: showAll ? p.dice : null })),
        mine: me ? me.dice : [],
        reveal: G.reveal,
      };
    }
    const publish = () => { for (const p of G.players) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer);
      for (const p of G.players) { p.dice = new Array(START_DICE).fill(0); p.out = false; }
      G.winner = null;
      newRound(G.players[Math.floor(Math.random() * G.players.length)].id, "New game! ");
    }
    function newRound(starter, prefix = "") {
      for (const p of alive()) p.dice = p.dice.map(roll).sort((a, b) => a - b);
      G.bid = null; G.reveal = null;
      G.phase = "bid";
      G.turn = byId(starter) && !byId(starter).out ? starter : nextAlive(starter);
      G.log = `${prefix}Everyone rolled. ${byId(G.turn).name} opens the bidding.`;
      startClock();
      publish();
    }
    function startClock() {
      clearTimeout(G.timer);
      G.ends = Date.now() + TURN_MS;
      G.timer = setTimeout(autoMove, TURN_MS);
    }
    function autoMove() {
      if (G.phase !== "bid") return;
      const id = G.turn;
      if (!G.bid) bid(id, 1, 2 + Math.floor(Math.random() * 5), true);
      else if (G.bid.q < total()) bid(id, G.bid.q + 1, G.bid.f, true);
      else call(id, true);
    }
    function validBid(q, f) {
      if (!(f >= 1 && f <= 6) || !(q >= 1 && q <= total())) return false;
      return !G.bid || q > G.bid.q || (q === G.bid.q && f > G.bid.f);
    }
    function bid(id, q, f, auto) {
      if (G.phase !== "bid" || id !== G.turn || !validBid(q, f)) return;
      const p = byId(id);
      G.bid = { q, f, by: id };
      G.log = `${p.name}${auto ? " (out of time)" : ""} bids ${q} × ${FACE[f]}`;
      G.turn = nextAlive(id);
      startClock();
      publish();
    }
    function call(id, auto) {
      if (G.phase !== "bid" || id !== G.turn || !G.bid || G.bid.by === id) return;
      clearTimeout(G.timer);
      const { q, f, by } = G.bid;
      let count = 0;
      for (const p of alive()) for (const d of p.dice) if (d === f || (d === 1 && f !== 1)) count++;
      const truthful = count >= q;
      const loser = truthful ? id : by;
      G.phase = "reveal";
      G.reveal = { q, f, by, caller: id, count, truthful, loser };
      G.log = `${byId(id).name}${auto ? " (out of time)" : ""} calls LIAR! There ${count === 1 ? "is" : "are"} ${count} ${FACE[f]}. ${byId(loser).name} loses a die.`;
      G.ends = Date.now() + REVEAL_MS;
      publish();
      G.timer = setTimeout(() => finishReveal(loser), REVEAL_MS);
    }
    function finishReveal(loserId) {
      const loser = byId(loserId);
      if (loser) {
        loser.dice.pop();
        if (!loser.dice.length) loser.out = true;
      }
      const left = alive();
      if (left.length <= 1) return endGame(left[0] ? left[0].id : null);
      const next = loser && !loser.out ? loser.id : nextAlive(loserId);
      newRound(next, loser && loser.out ? `${loser.name} is out! ` : "");
    }
    function endGame(winner) {
      clearTimeout(G.timer);
      G.phase = "end"; G.winner = winner; G.turn = null;
      G.log = winner != null && byId(winner) ? `${byId(winner).name} wins!` : "Game over";
      publish();
    }
    function leave(id) {
      const p = byId(id);
      if (!p) return;
      const wasTurn = G.turn === id;
      const next = nextAlive(id);
      G.players = G.players.filter((x) => x.id !== id);
      if (G.phase === "end") return publish();
      if (alive().length <= 1) return endGame(alive()[0] ? alive()[0].id : null);
      if (G.phase === "reveal") return publish(); // the reveal timer carries on
      if (G.bid && G.bid.by === id) G.bid = null;
      if (wasTurn) { G.turn = next; startClock(); }
      G.log = `${p.name} left the game`;
      publish();
    }
    return { G, newGame, bid, call, leave, view, stop: () => clearTimeout(G.timer), publish };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null;
  let selQ = 1, selF = 2;

  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function dieEl(v, cls = "") {
    const d = h("span", "die " + cls);
    d.dataset.v = v;
    for (let i = 0; i < 9; i++) d.append(h("i", PIPS[v] && PIPS[v].includes(i) ? "on" : ""));
    return d;
  }

  function act(m) {
    if (room.isHost) { if (m.t === "bid") engine.bid(room.myId, m.q, m.f); else engine.call(room.myId); }
    else room.send(m);
  }

  // controls
  const minQFor = (f) => (!V || !V.bid ? 1 : f > V.bid.f ? V.bid.q : V.bid.q + 1);
  function clampSel() {
    const lo = minQFor(selF);
    if (selQ < lo) selQ = lo;
    if (V && selQ > V.total) selQ = V.total;
  }
  $("qMinus").addEventListener("click", () => { selQ = Math.max(minQFor(selF), selQ - 1); paintControls(); GameUtil.sfx("click"); });
  $("qPlus").addEventListener("click", () => { if (V) selQ = Math.min(V.total, selQ + 1); paintControls(); GameUtil.sfx("click"); });
  for (let f = 1; f <= 6; f++) {
    const b = h("button", "face-btn");
    b.type = "button";
    b.append(dieEl(f, "sm"));
    b.setAttribute("aria-label", FACE[f]);
    b.addEventListener("click", () => { selF = f; clampSel(); paintControls(); GameUtil.sfx("click"); });
    $("faces").append(b);
  }
  $("bidBtn").addEventListener("click", () => { clampSel(); act({ t: "bid", q: selQ, f: selF }); });
  $("liarBtn").addEventListener("click", () => act({ t: "call" }));

  function paintControls() {
    if (!V) return;
    $("qVal").textContent = selQ;
    [...$("faces").children].forEach((b, i) => b.classList.toggle("on", i + 1 === selF));
    const valid = selQ >= minQFor(selF) && selQ <= V.total;
    $("bidBtn").disabled = !valid;
    $("bidBtn").textContent = `Bid ${selQ} × ${FACE[selF]}`;
    $("liarBtn").disabled = !V.bid;
  }

  function onState(v) {
    const prev = V;
    V = v;
    const myTurn = v.phase === "bid" && v.turn === room.myId;

    // players
    const table = $("table");
    table.textContent = "";
    for (const p of v.players) {
      const seat = h("div", "seat" + (p.id === v.turn ? " turn" : "") + (p.out ? " out" : "") + (p.id === room.myId ? " me" : ""));
      const top = h("div", "seat-top");
      top.append(GameUtil.avatar(p), h("span", "pname", p.name + (p.id === room.myId ? " (you)" : "")));
      seat.append(top);
      const cups = h("div", "cups");
      if (p.dice) {
        for (const d of p.dice) {
          const hit = v.reveal && (d === v.reveal.f || (d === 1 && v.reveal.f !== 1));
          cups.append(dieEl(d, "sm" + (hit ? " hit" : " miss")));
        }
      } else for (let i = 0; i < p.n; i++) cups.append(h("span", "cup"));
      if (p.out) cups.append(h("span", "muted", "out"));
      seat.append(cups);
      if (v.bid && v.bid.by === p.id && v.phase !== "end") {
        const b = h("div", "bid-bubble");
        b.append(h("b", "", v.bid.q + " ×"), dieEl(v.bid.f, "xs"));
        seat.append(b);
      }
      if (v.reveal && v.reveal.loser === p.id) seat.append(h("div", "lose-tag", "−1 die"));
      table.append(seat);
    }

    // center
    const cur = $("current");
    cur.textContent = "";
    if (v.bid) {
      cur.append(h("span", "muted", "Current bid"));
      const row = h("div", "bid-big");
      row.append(h("b", "", v.bid.q + " ×"), dieEl(v.bid.f));
      cur.append(row);
    } else cur.append(h("span", "muted", v.phase === "end" ? "" : "No bids yet"));
    $("log").textContent = v.log;
    $("totalDice").textContent = `${v.total} dice on the table · ones are wild`;

    // my dice
    const mine = $("mine");
    mine.textContent = "";
    for (const d of v.mine) mine.append(dieEl(d, prev && prev.phase !== "bid" && v.phase === "bid" ? "roll" : ""));

    // controls
    $("controls").hidden = !myTurn;
    $("waiting").hidden = myTurn || v.phase !== "bid";
    const turnP = v.players.find((p) => p.id === v.turn);
    $("waiting").textContent = turnP ? `${turnP.name} is thinking…` : "";
    if (myTurn && (!prev || prev.turn !== v.turn || JSON.stringify(prev.bid) !== JSON.stringify(v.bid))) {
      selF = v.bid ? v.bid.f : 2;
      selQ = minQFor(selF);
      clampSel();
      GameUtil.sfx("turn");
    }
    paintControls();

    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase === "bid" ? fmt(left) : ""; });

    if (prev) {
      if (v.phase === "reveal" && prev.phase !== "reveal") GameUtil.sfx(v.reveal.loser === room.myId ? "bad" : "boom");
      else if (v.bid && (!prev.bid || prev.bid.q !== v.bid.q || prev.bid.f !== v.bid.f) && v.bid.by !== room.myId) GameUtil.sfx("pop");
      else if (v.phase === "bid" && prev.phase !== "bid") GameUtil.sfx("click");
    }
    if (v.phase === "end") {
      if (!prev || prev.phase !== "end") {
        const won = v.winner === room.myId;
        GameUtil.sfx(won ? "win" : "lose");
        GameUtil.record("dice", won ? "win" : "loss");
        const winner = v.players.find((p) => p.id === v.winner);
        results({
          title: won ? "You win!" : winner ? `${winner.name} wins` : "Game over",
          rows: [...v.players].sort((a, b) => (b.id === v.winner) - (a.id === v.winner) || b.n - a.n).map((p) => ({ p, value: p.id === v.winner ? "winner" : "out", win: p.id === v.winner })),
          isHost: room.isHost, meId: room.myId,
        });
      }
    } else hideResults();
  }

  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "dice",
    title: "Liar's Dice",
    subtitle: "Hide your dice, bid on what's under everyone's cups, and call out the liars. Ones are wild. 2 to 6 players.",
    min: 2,
    max: 6,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? onState(m) : r.sendTo(id, m)) };
        engine = createEngine(r, out);
        r.onData((from, m) => {
          if (!m) return;
          if (m.t === "bid") engine.bid(from, m.q | 0, m.f | 0);
          else if (m.t === "call") engine.call(from);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => out.to(id, engine.view(id)));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => {
        if (engine) engine.stop();
        if (stopClock) stopClock();
        room = null; engine = null; V = null;
        hideResults();
      };
    },
  });
})();
