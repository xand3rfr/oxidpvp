// Texas Hold'em for 2–8 players with play chips. Everyone starts with 1000; blinds go up every
// 8 hands. The host shuffles, deals and runs the betting (side pots included) and only sends
// each player their own hole cards until a showdown. Last player with chips wins, or whoever
// has the most after 30 hands.
(() => {
  const START = 1000, BLINDS = [10, 20], BLIND_EVERY = 8, MAX_HANDS = 30, TURN_MS = 30000, RESULT_MS = 5500, RUNOUT_MS = 1100;
  const RANKS = "23456789TJQKA", SUITS = "shdc", SUIT_CH = { s: "♠", h: "♥", d: "♦", c: "♣" };
  const HAND_NAMES = ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush"];
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);

  // ---------- Hand evaluation: best 5 of 7, returns a comparable number ----------
  const rv = (c) => RANKS.indexOf(c[0]) + 2;
  function score5(cards) {
    const r = cards.map(rv).sort((a, b) => b - a), s = cards.map((c) => c[1]);
    const flush = s.every((x) => x === s[0]);
    const uniq = [...new Set(r)];
    let straight = 0;
    if (uniq.length === 5) {
      if (r[0] - r[4] === 4) straight = r[0];
      else if (r[0] === 14 && r[1] === 5) straight = 5; // A-2-3-4-5
    }
    const counts = {};
    for (const x of r) counts[x] = (counts[x] || 0) + 1;
    const groups = Object.entries(counts).map(([k, n]) => [n, +k]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const kick = groups.map((g) => g[1]);
    let cat;
    if (straight && flush) cat = 8;
    else if (groups[0][0] === 4) cat = 7;
    else if (groups[0][0] === 3 && groups[1][0] === 2) cat = 6;
    else if (flush) cat = 5;
    else if (straight) cat = 4;
    else if (groups[0][0] === 3) cat = 3;
    else if (groups[0][0] === 2 && groups[1][0] === 2) cat = 2;
    else if (groups[0][0] === 2) cat = 1;
    else cat = 0;
    const tb = straight ? [straight] : cat === 5 || cat === 0 ? r : kick;
    let v = cat;
    for (let i = 0; i < 5; i++) v = v * 15 + (tb[i] || 0);
    return v;
  }
  function best(cards) {
    let top = -1;
    for (let a = 0; a < cards.length; a++) for (let b = a + 1; b < cards.length; b++) {
      const five = cards.filter((_, i) => i !== a && i !== b);
      const v = score5(five);
      if (v > top) top = v;
    }
    return top;
  }
  const handName = (v) => HAND_NAMES[Math.floor(v / 15 ** 5)];

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], hand: 0, dealer: -1, sb: 0, bb: 0, deck: [], board: [], street: 0, bet: 0, minRaise: 0, toAct: -1, acted: new Set(), phase: "idle", timer: 0, ends: 0, result: null, log: "" };
    const P = (i) => G.players[i];
    const seatOf = (id) => G.players.findIndex((p) => p.id === id);
    const canAct = (p) => !p.folded && !p.allIn && !p.out;
    const inHand = () => G.players.filter((p) => !p.folded && !p.out);
    const nextSeat = (i, pred) => { for (let k = 1; k <= G.players.length; k++) { const j = (i + k) % G.players.length; if (pred(P(j))) return j; } return -1; };

    function view(id) {
      const me = seatOf(id), showdown = G.phase === "result" && G.result && G.result.show;
      const p = P(me);
      const v = {
        t: "st", phase: G.phase, hand: G.hand, maxHands: MAX_HANDS, sb: G.sb, bb: G.bb, dealer: G.dealer, board: G.board, street: G.street,
        toAct: G.toAct, bet: G.bet, pot: G.players.reduce((a, q) => a + q.total, 0), result: G.result, log: G.log,
        left: Math.max(0, G.ends - Date.now()), me,
        players: G.players.map((q) => ({
          id: q.id, name: q.name, av: q.av, chips: q.chips, bet: q.bet, folded: q.folded, allIn: q.allIn, out: q.out, gone: q.gone, last: q.last,
          cards: q.id === id || (showdown && !q.folded && q.cards.length) ? q.cards : q.cards.length ? ["??", "??"] : [],
        })),
      };
      if (p && G.phase === "bet" && G.toAct === me) {
        v.opts = { call: Math.min(G.bet - p.bet, p.chips), minTo: Math.min(p.bet + p.chips, G.bet + G.minRaise), maxTo: p.bet + p.chips };
      }
      return v;
    }
    const publish = () => { for (const p of room.players) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer);
      const gone = new Set(G.players.filter((p) => p.gone).map((p) => p.id));
      G.players = room.players.filter((p) => !gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av, chips: START, bet: 0, total: 0, cards: [], folded: false, allIn: false, out: false, gone: false, last: "" }));
      G.hand = 0; G.dealer = -1;
      startHand();
    }
    function startHand() {
      clearTimeout(G.timer);
      for (const p of G.players) if (p.chips <= 0 || p.gone) p.out = true;
      const alive = G.players.filter((p) => !p.out);
      if (alive.length < 2 || G.hand >= MAX_HANDS) return endGame();
      G.hand++;
      const lvl = Math.floor((G.hand - 1) / BLIND_EVERY);
      G.sb = BLINDS[0] * 2 ** lvl; G.bb = BLINDS[1] * 2 ** lvl;
      G.deck = GameUtil.shuffle([...RANKS].flatMap((r) => [...SUITS].map((s) => r + s)));
      G.board = []; G.street = 0; G.result = null; G.log = "";
      for (const p of G.players) { p.bet = 0; p.total = 0; p.cards = []; p.folded = p.out; p.allIn = false; p.last = ""; }
      G.dealer = nextSeat(G.dealer, (p) => !p.out);
      const heads = alive.length === 2;
      const sbSeat = heads ? G.dealer : nextSeat(G.dealer, (p) => !p.out);
      const bbSeat = nextSeat(sbSeat, (p) => !p.out);
      pay(P(sbSeat), G.sb); P(sbSeat).last = "SB";
      pay(P(bbSeat), G.bb); P(bbSeat).last = "BB";
      for (const p of G.players) if (!p.out) p.cards = [G.deck.pop(), G.deck.pop()];
      G.bet = G.bb; G.minRaise = G.bb;
      G.acted = new Set();
      G.phase = "bet";
      G.toAct = nextSeat(bbSeat, canAct);
      if (streetDone()) return nextStreet();
      armTurn();
      publish();
    }
    function pay(p, n) {
      n = Math.min(n, p.chips);
      p.chips -= n; p.bet += n; p.total += n;
      if (p.chips === 0) p.allIn = true;
      return n;
    }
    function armTurn() {
      clearTimeout(G.timer);
      G.ends = Date.now() + TURN_MS;
      const seat = G.toAct;
      G.timer = setTimeout(() => {
        const p = P(seat);
        if (!p || G.toAct !== seat) return;
        act(p.id, p.bet === G.bet ? "check" : "fold");
      }, TURN_MS);
    }
    function streetDone() {
      if (inHand().length <= 1) return true;
      const active = G.players.filter(canAct);
      if (!active.length) return true;
      // Only one player can still bet: nobody to raise against, so they just need to match.
      if (active.length === 1) return active[0].bet >= G.bet;
      return active.every((p) => G.acted.has(G.players.indexOf(p)) && p.bet === G.bet);
    }
    function act(id, a, to) {
      if (G.phase !== "bet") return;
      const i = seatOf(id), p = P(i);
      if (!p || i !== G.toAct || !canAct(p)) return;
      if (a === "fold") { p.folded = true; p.last = "Fold"; }
      else if (a === "check") { if (p.bet !== G.bet) return; p.last = "Check"; }
      else if (a === "call") { const n = pay(p, G.bet - p.bet); p.last = p.allIn ? "All in" : `Call ${n}`; }
      else if (a === "allin" && p.bet + p.chips <= G.bet) { pay(p, p.chips); p.last = "All in"; }
      else if (a === "raise" || a === "allin") {
        const maxTo = p.bet + p.chips, before = G.bet;
        to = a === "allin" ? maxTo : Math.floor(+to);
        if (!(to > G.bet) || to > maxTo) return;
        if (to < G.bet + G.minRaise && to !== maxTo) return; // too small unless it's all-in
        const raise = to - G.bet;
        pay(p, to - p.bet);
        if (raise >= G.minRaise) G.minRaise = raise;
        G.bet = to;
        G.acted = new Set();
        p.last = p.allIn ? "All in" : before ? `Raise to ${to}` : `Bet ${to}`;
      } else return;
      G.acted.add(i);
      G.log = `${p.name}: ${p.last}`;
      if (inHand().length === 1) return award();
      if (streetDone()) return nextStreet();
      G.toAct = nextSeat(i, canAct);
      armTurn();
      publish();
    }
    function nextStreet() {
      clearTimeout(G.timer);
      for (const p of G.players) p.bet = 0;
      G.bet = 0; G.minRaise = G.bb; G.acted = new Set();
      if (inHand().length === 1) return award();
      G.street++;
      if (G.street === 1) G.board.push(G.deck.pop(), G.deck.pop(), G.deck.pop());
      else if (G.street <= 3) G.board.push(G.deck.pop());
      else return showdown();
      for (const p of G.players) if (!p.folded && !p.allIn) p.last = "";
      if (G.players.filter(canAct).length <= 1) {
        // Nobody left to bet against: deal the rest out with a little drama.
        G.toAct = -1;
        publish();
        G.timer = setTimeout(nextStreet, RUNOUT_MS);
        return;
      }
      G.toAct = nextSeat(G.dealer, canAct);
      armTurn();
      publish();
    }
    function award() {
      const w = inHand()[0];
      const pot = G.players.reduce((a, p) => a + p.total, 0);
      w.chips += pot;
      G.result = { show: false, wins: [{ id: w.id, amt: pot, hand: "" }], text: `${w.name} takes ${pot}` };
      finishHand();
    }
    function showdown() {
      const live = inHand();
      const scores = new Map(live.map((p) => [p.id, best([...p.cards, ...G.board])]));
      // Side pots: slice the contributions at each all-in level.
      const levels = [...new Set(G.players.map((p) => p.total).filter((t) => t > 0))].sort((a, b) => a - b);
      const won = new Map(), refunds = new Map();
      let prev = 0, carry = 0;
      for (const L of levels) {
        let slice = carry;
        for (const p of G.players) slice += Math.max(0, Math.min(p.total, L) - prev);
        prev = L;
        const elig = live.filter((p) => p.total >= L);
        if (!elig.length) { carry = slice; continue; }
        carry = 0;
        // Only one player put chips in at this level: that's their own uncalled bet coming back.
        if (elig.length === 1 && G.players.filter((p) => p.total >= L).length === 1) { elig[0].chips += slice; refunds.set(elig[0].id, (refunds.get(elig[0].id) || 0) + slice); continue; }
        const top = Math.max(...elig.map((p) => scores.get(p.id)));
        const winners = elig.filter((p) => scores.get(p.id) === top);
        const share = Math.floor(slice / winners.length);
        let rem = slice - share * winners.length;
        for (const p of winners) { const amt = share + (rem-- > 0 ? 1 : 0); p.chips += amt; won.set(p.id, (won.get(p.id) || 0) + amt); }
      }
      if (carry) { const p = live[0]; p.chips += carry; won.set(p.id, (won.get(p.id) || 0) + carry); }
      const wins = [...won.entries()].map(([id, amt]) => ({ id, amt, hand: handName(scores.get(id)) }));
      const nm = (id) => G.players.find((p) => p.id === id).name;
      const names = wins.map((w) => `${nm(w.id)} wins ${w.amt} with ${w.hand.toLowerCase()}`);
      for (const [id, amt] of refunds) names.push(`${nm(id)} gets ${amt} back`);
      G.result = { show: true, wins, hands: Object.fromEntries(live.map((p) => [p.id, handName(scores.get(p.id))])), text: names.join(" · ") };
      finishHand();
    }
    function finishHand() {
      clearTimeout(G.timer);
      G.phase = "result";
      G.toAct = -1;
      G.ends = Date.now() + RESULT_MS;
      G.timer = setTimeout(startHand, RESULT_MS);
      publish();
    }
    function endGame() {
      clearTimeout(G.timer);
      G.phase = "end";
      publish();
    }
    function leave(id) {
      const i = seatOf(id), p = P(i);
      if (!p) return;
      p.gone = true;
      if (G.phase === "bet" && !p.folded) {
        if (G.toAct === i) return act(id, "fold");
        p.folded = true; p.last = "Left";
        if (inHand().length === 1) return award();
        if (streetDone()) return nextStreet();
      }
      if (G.players.filter((q) => !q.gone && (!q.out || G.phase === "end")).length < 2 && G.phase !== "end") return endGame();
      publish();
    }
    return { G, newGame, act, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null;

  function cardEl(c, big) {
    if (c === "??") return h("span", "pk-card back" + (big ? " big" : ""));
    const el = h("span", "pk-card" + (c[1] === "h" || c[1] === "d" ? " red" : "") + (big ? " big" : ""));
    el.append(h("b", "", c[0] === "T" ? "10" : c[0]), h("i", "", SUIT_CH[c[1]]));
    return el;
  }
  function send(a, to) {
    GameUtil.sfx("click");
    if (room.isHost) engine.act(room.myId, a, to); else room.send({ t: "act", a, to });
  }

  function render() {
    const v = V;
    $("info").textContent = v.phase === "end" ? "Game over" : `Hand ${v.hand} of ${v.maxHands} · blinds ${v.sb}/${v.bb}`;
    const seats = $("seats");
    seats.textContent = "";
    v.players.forEach((p, i) => {
      const s = h("div", "pk-seat" + (i === v.toAct ? " turn" : "") + (p.folded ? " folded" : "") + (p.out ? " out" : "") + (i === v.me ? " me" : "") + (v.result && v.result.wins.some((w) => w.id === p.id) ? " won" : ""));
      const top = h("div", "pk-top");
      top.append(GameUtil.avatar(p, "xs"), h("span", "pk-name", i === v.me ? "You" : p.name));
      if (i === v.dealer) top.append(h("span", "pk-dealer", "D"));
      s.append(top);
      s.append(h("div", "pk-chips", p.out ? (p.gone ? "left" : "busted") : `${p.chips}`));
      const cards = h("div", "pk-hole");
      if (i !== v.me && !p.folded) for (const c of p.cards) cards.append(cardEl(c));
      s.append(cards);
      const status = p.bet ? `${p.last && !/^(SB|BB)$/.test(p.last) ? p.last + " · " : ""}bet ${p.bet}` : p.last;
      if (v.result && v.result.hands && v.result.hands[p.id]) s.append(h("div", "pk-last hand", v.result.hands[p.id]));
      else if (status) s.append(h("div", "pk-last", status));
      seats.append(s);
    });
    const board = $("board");
    board.textContent = "";
    for (let k = 0; k < 5; k++) board.append(v.board[k] ? cardEl(v.board[k], true) : h("span", "pk-card slot big"));
    $("pot").textContent = v.pot ? `Pot ${v.pot}` : "";
    $("log").textContent = v.result ? v.result.text : v.log;
    const me = v.players[v.me];
    const hole = $("hole");
    hole.textContent = "";
    if (me) for (const c of me.cards) hole.append(cardEl(c, true));
    $("myChips").textContent = me ? `${me.chips} chips` : "";
    const o = v.opts;
    $("actions").hidden = !o;
    if (o) {
      $("check").hidden = o.call > 0;
      $("call").hidden = o.call <= 0;
      $("call").textContent = `Call ${o.call}`;
      const canRaise = o.maxTo > v.bet && o.maxTo > (me.bet + o.call);
      $("raiseBox").hidden = !canRaise;
      const r = $("raiseAmt");
      r.min = o.minTo; r.max = o.maxTo; r.step = v.bb >= 20 ? 10 : 1;
      if (+r.value < o.minTo || +r.value > o.maxTo || !r.dataset.hand || r.dataset.hand !== `${v.hand}.${v.street}.${v.bet}`) { r.value = o.minTo; r.dataset.hand = `${v.hand}.${v.street}.${v.bet}`; }
      $("raise").textContent = `${v.bet ? "Raise to" : "Bet"} ${r.value}`;
    }
    const turnP = v.players[v.toAct];
    $("status").textContent = v.phase === "result" ? "" : o ? "Your move" : turnP ? `${turnP.name} is thinking…` : v.phase === "bet" ? "Dealing…" : "";
  }

  function onState(v) {
    const prev = V;
    V = v;
    if (v.phase !== "end") render();
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase === "bet" && v.toAct >= 0 ? fmt(left) : ""; });
    if (v.opts && !(prev && prev.opts && prev.toAct === v.toAct && prev.street === v.street && prev.bet === v.bet)) GameUtil.sfx("turn");
    if (prev && prev.board.length < v.board.length) GameUtil.sfx("pop");
    if (v.phase === "result" && (!prev || prev.phase !== "result")) GameUtil.sfx(v.result.wins.some((w) => w.id === room.myId) ? "good" : "tick");
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const sorted = [...v.players].sort((a, b) => b.chips - a.chips);
      const won = sorted[0] && sorted[0].id === room.myId;
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("poker", won ? "win" : "loss");
      results({ title: won ? "You cleaned them out!" : `${sorted[0].name} wins`, rows: sorted.map((p) => ({ p, value: p.chips + " chips", win: p === sorted[0] })), isHost: room.isHost, meId: room.myId });
    } else if (v.phase !== "end") hideResults();
  }

  $("fold").addEventListener("click", () => send("fold"));
  $("check").addEventListener("click", () => send("check"));
  $("call").addEventListener("click", () => send("call"));
  $("allin").addEventListener("click", () => send("allin"));
  $("raise").addEventListener("click", () => send("raise", +$("raiseAmt").value));
  $("raiseAmt").addEventListener("input", () => { if (V) $("raise").textContent = `${V.bet ? "Raise to" : "Bet"} ${$("raiseAmt").value}`; });
  for (const b of document.querySelectorAll("[data-pot]")) b.addEventListener("click", () => {
    if (!V || !V.opts) return;
    const f = +b.dataset.pot;
    const target = Math.round(V.bet + (V.pot + V.opts.call) * f);
    const r = $("raiseAmt");
    r.value = Math.max(V.opts.minTo, Math.min(V.opts.maxTo, target));
    $("raise").textContent = `${V.bet ? "Raise to" : "Bet"} ${r.value}`;
  });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "poker",
    title: "Poker",
    subtitle: "Texas Hold'em with play chips. Everyone starts with 1000. Last one with chips wins. 2 to 8 players.",
    min: 2,
    max: 8,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? onState(m) : r.sendTo(id, m)) };
        engine = createEngine(r, out);
        r.onData((from, m) => { if (m && m.t === "act") engine.act(from, m.a, m.to); });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view(id)));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });

  window.__pokerEval = { best, score5, handName }; // for tests
})();
