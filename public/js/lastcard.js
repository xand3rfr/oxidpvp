// Last Card: UNO-style card game for 2–6 players.
// The host runs the rules engine and sends each player a personal view (only their own hand).
// Guests just send intents: play / draw / pass / call / catch.
(() => {
  const COLORS = ["r", "y", "g", "b"];
  const COLOR_NAME = { r: "Red", y: "Yellow", g: "Green", b: "Blue" };
  const COLOR_HEX = { r: "#e5484d", y: "#f0b429", g: "#30a46c", b: "#3e8bff" };
  const HAND_SIZE = 7, TURN_MS = 30000, DREW_GRACE_MS = 10000;
  const $ = (id) => document.getElementById(id);

  // =====================================================================
  // Rules engine (host only)
  // =====================================================================
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function buildDeck() {
    let id = 0;
    const d = [];
    for (const c of COLORS) {
      d.push({ id: id++, c, v: "0" });
      for (let k = 0; k < 2; k++) {
        for (let n = 1; n <= 9; n++) d.push({ id: id++, c, v: String(n) });
        for (const v of ["skip", "rev", "d2"]) d.push({ id: id++, c, v });
      }
    }
    for (let k = 0; k < 4; k++) {
      d.push({ id: id++, c: "w", v: "wild" });
      d.push({ id: id++, c: "w", v: "d4" });
    }
    return shuffle(d);
  }
  const label = (card) =>
    (card.c !== "w" ? COLOR_NAME[card.c] + " " : "") +
    ({ skip: "Skip", rev: "Reverse", d2: "+2", wild: "Wild", d4: "Wild +4" }[card.v] || card.v);

  function createEngine(roomPlayers, hostId, emit) {
    const G = {
      players: roomPlayers.map((p) => ({ id: p.id, name: p.name, av: p.av, hand: [], called: false })),
      deck: [], discard: [], color: "r", turn: 0, dir: 1,
      drew: false, drawnId: null, vulnerable: null, winner: null,
      log: "", fx: null, turnEnds: 0, seq: 0, round: 0,
    };
    const n = () => G.players.length;
    const idx = (k) => (((G.turn + G.dir * k) % n()) + n()) % n();
    const top = () => G.discard[G.discard.length - 1];
    const canPlay = (card) => card.c === "w" || card.c === G.color || card.v === top().v;

    function drawCards(p, count) {
      const got = [];
      for (let i = 0; i < count; i++) {
        if (!G.deck.length) {
          const t = G.discard.pop();
          G.deck = shuffle(G.discard);
          G.discard = [t];
          if (!G.deck.length) break;
        }
        const c = G.deck.pop();
        p.hand.push(c);
        got.push(c);
      }
      if (p.hand.length > 1) p.called = false;
      return got;
    }

    function advance(k) {
      G.turn = idx(k);
      G.drew = false;
      G.drawnId = null;
      G.turnEnds = Date.now() + TURN_MS;
    }

    function newRound() {
      G.deck = buildDeck();
      G.discard = [];
      for (const p of G.players) { p.hand = []; p.called = false; }
      for (let i = 0; i < HAND_SIZE; i++) for (const p of G.players) p.hand.push(G.deck.pop());
      // Start on a number card
      let first = G.deck.pop();
      while (!/^\d$/.test(first.v)) { G.deck.unshift(first); first = G.deck.pop(); }
      G.discard.push(first);
      G.color = first.c;
      G.dir = 1;
      G.turn = Math.floor(Math.random() * n());
      G.drew = false; G.drawnId = null; G.vulnerable = null; G.winner = null;
      G.turnEnds = Date.now() + TURN_MS;
      G.round++;
      G.log = `Round ${G.round}: ${G.players[G.turn].name} goes first`;
      G.fx = { k: "round" };
    }

    function act(pid, m) {
      const pi = G.players.findIndex((p) => p.id === pid);
      if (pi < 0 || !m || typeof m.t !== "string") return;
      const p = G.players[pi];

      if (m.t === "again") {
        if (pid === hostId && G.winner != null && n() >= 2) { newRound(); emit(); }
        return;
      }
      if (G.winner != null) return;

      if (m.t === "call") {
        if (p.hand.length <= 2 && !p.called) {
          p.called = true;
          if (G.vulnerable === pid) G.vulnerable = null;
          G.log = `${p.name} calls LAST CARD!`;
          G.fx = { k: "call", pid };
          emit();
        }
        return;
      }
      if (m.t === "catch") {
        const v = G.players.find((x) => x.id === G.vulnerable);
        if (v && v.id !== pid) {
          drawCards(v, 2);
          G.vulnerable = null;
          G.log = `${p.name} caught ${v.name}! +2 cards`;
          G.fx = { k: "catch", pid: v.id, by: pid };
          emit();
        }
        return;
      }

      if (pi !== G.turn) return;
      // A forgotten "last card" can only be caught until the next player acts.
      if (G.vulnerable != null && G.vulnerable !== pid) G.vulnerable = null;

      if (m.t === "play") {
        const ci = p.hand.findIndex((c) => c.id === m.id);
        if (ci < 0) return;
        const card = p.hand[ci];
        if (G.drew && card.id !== G.drawnId) return;
        if (!canPlay(card)) return;
        if (card.c === "w" && !COLORS.includes(m.color)) return;

        p.hand.splice(ci, 1);
        G.discard.push(card);
        G.color = card.c === "w" ? m.color : card.c;
        G.fx = { k: "play", pid, card };
        let text = `${p.name} played ${label(card)}`;
        if (card.c === "w") text += ` and picked ${COLOR_NAME[G.color]}`;

        if (!p.hand.length) {
          G.winner = pid;
          G.log = `${p.name} wins the round!`;
          emit();
          return;
        }
        if (p.hand.length === 1 && !p.called) G.vulnerable = pid;

        let step = 1;
        if (card.v === "skip") {
          text += `. ${G.players[idx(1)].name} is skipped`;
          step = 2;
        } else if (card.v === "rev") {
          if (n() === 2) step = 2; else G.dir *= -1;
        } else if (card.v === "d2" || card.v === "d4") {
          const victim = G.players[idx(1)], k = card.v === "d2" ? 2 : 4;
          drawCards(victim, k);
          text += `. ${victim.name} draws ${k}`;
          step = 2;
        }
        G.log = text;
        advance(step);
        emit();
        return;
      }

      if (m.t === "draw") {
        if (G.drew) return;
        const [c] = drawCards(p, 1);
        G.log = `${p.name} drew a card`;
        G.fx = { k: "draw", pid };
        if (c && canPlay(c)) {
          G.drew = true;
          G.drawnId = c.id;
          G.turnEnds = Math.max(G.turnEnds, Date.now() + DREW_GRACE_MS);
        } else advance(1);
        emit();
        return;
      }

      if (m.t === "pass" && G.drew) {
        G.log = `${p.name} kept the card and passed`;
        advance(1);
        emit();
      }
    }

    function tick() {
      if (G.winner != null || !n() || Date.now() < G.turnEnds) return;
      const p = G.players[G.turn];
      if (!G.drew) drawCards(p, 1);
      G.log = `${p.name} ran out of time and drew a card`;
      if (G.vulnerable != null && G.vulnerable !== p.id) G.vulnerable = null;
      advance(1);
      emit();
    }

    function leave(pid) {
      const i = G.players.findIndex((p) => p.id === pid);
      if (i < 0) return;
      const [p] = G.players.splice(i, 1);
      G.deck.push(...p.hand);
      shuffle(G.deck);
      if (G.vulnerable === pid) G.vulnerable = null;
      if (!n()) return;
      if (i < G.turn) G.turn--;
      else if (i === G.turn) {
        G.turn = G.dir === 1 ? i % n() : (i - 1 + n()) % n();
        G.drew = false; G.drawnId = null;
        G.turnEnds = Date.now() + TURN_MS;
      }
      G.turn %= n();
      G.log = `${p.name} left the game`;
      if (n() === 1 && G.winner == null) {
        G.winner = G.players[0].id;
        G.log = `Everyone else left. ${G.players[0].name} wins!`;
      }
      emit();
    }

    function view(pid) {
      const p = G.players.find((x) => x.id === pid);
      const cur = G.players[G.turn];
      return {
        t: "st", seq: G.seq, me: pid,
        hand: p ? p.hand : [],
        players: G.players.map((x) => ({ id: x.id, name: x.name, av: x.av, n: x.hand.length, called: x.called })),
        top: top(), under: G.discard.slice(-4, -1),
        color: G.color, turn: cur ? cur.id : null, dir: G.dir, deck: G.deck.length,
        drew: !!(cur && cur.id === pid && G.drew), drawnId: cur && cur.id === pid ? G.drawnId : null,
        vulnerable: G.vulnerable, winner: G.winner, log: G.log, fx: G.fx,
        left: Math.max(0, G.turnEnds - Date.now()), round: G.round,
      };
    }

    return { G, newRound, act, tick, leave, view };
  }

  // =====================================================================
  // UI (everyone, including the host)
  // =====================================================================
  const ICONS = {
    skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="8.5"/><path d="M6.2 17.8 17.8 6.2"/></svg>',
    rev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h14l-4-4M20 15.5H6l4 4"/></svg>',
  };
  const glyph = (v) => ICONS[v] || { d2: "+2", d4: "+4", wild: "W" }[v] || v;

  function cardEl(card) {
    const el = document.createElement("div");
    el.className = "card c-" + card.c;
    el.dataset.id = card.id;
    if (card.c === "w") {
      el.innerHTML = `<span class="corner tl">${glyph(card.v)}</span><span class="mid"><span class="wheel">${card.v === "d4" ? "<b>+4</b>" : ""}</span></span><span class="corner br">${glyph(card.v)}</span>`;
    } else {
      el.innerHTML = `<span class="oval"></span><span class="corner tl">${glyph(card.v)}</span><span class="mid">${glyph(card.v)}</span><span class="corner br">${glyph(card.v)}</span>`;
    }
    return el;
  }
  const rot = (id) => ((id * 37) % 23) - 11;
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const SORT_C = { r: 0, y: 1, g: 2, b: 3, w: 4 };
  const SORT_V = (v) => (/^\d$/.test(v) ? +v : { skip: 10, rev: 11, d2: 12, wild: 13, d4: 14 }[v]);

  let room = null, engine = null, V = null, timerTick = 0, hostTimer = 0;
  let turnEndsLocal = 0, lastTopId = null, prevHand = new Set(), lastSeq = -1, pendingWild = null;

  const handEl = $("hand"), deckEl = $("deck");
  const nameOf = (id) => (V && V.players.find((p) => p.id === id) || { name: "?" }).name;

  function send(m) {
    if (!room) return;
    if (room.isHost) engine.act(room.myId, m);
    else room.send(m);
  }

  function canPlayClient(card) {
    if (!V || !V.top) return false;
    if (V.drew) return card.id === V.drawnId;
    return card.c === "w" || card.c === V.color || card.v === V.top.v;
  }

  function onView(v) {
    if (v.seq <= lastSeq) return;
    lastSeq = v.seq;
    const prev = V;
    V = v;
    if (prev) {
      if (v.top && prev.top && v.top.id !== prev.top.id) GameUtil.sfx("pop");
      else if (v.fx && v.fx.k === "draw") GameUtil.sfx("click");
      if (v.fx && v.fx.k === "call") GameUtil.sfx("good");
      if (v.fx && v.fx.k === "catch") GameUtil.sfx(v.fx.pid === v.me ? "bad" : "good");
      if (v.turn === v.me && prev.turn !== v.me && v.winner == null) setTimeout(() => GameUtil.sfx("turn"), 200);
      if (v.winner != null && prev.winner == null) {
        GameUtil.sfx(v.winner === v.me ? "win" : "lose");
        GameUtil.record("lastcard", v.winner === v.me ? "win" : "loss");
      }
    }
    turnEndsLocal = performance.now() + v.left;
    if (v.fx && v.fx.k === "call" && v.fx.pid !== v.me) GameUtil.toast(`${nameOf(v.fx.pid)}: LAST CARD!`);
    if (v.fx && v.fx.k === "catch") GameUtil.toast(v.fx.pid === v.me ? `${nameOf(v.fx.by)} caught you! +2 cards` : `${nameOf(v.fx.by)} caught ${nameOf(v.fx.pid)}!`);
    if (v.fx && v.fx.k === "round") { lastTopId = null; prevHand = new Set(); }
    render();
  }

  function render() {
    if (!V) return;
    const me = V.me, myTurn = V.turn === me && V.winner == null;

    // opponents, in turn order starting after me
    const mi = V.players.findIndex((p) => p.id === me);
    const others = mi < 0 ? V.players : [...V.players.slice(mi + 1), ...V.players.slice(0, mi)];
    const opps = $("opps");
    opps.textContent = "";
    for (const p of others) {
      const box = h("div", "opp" + (p.id === V.turn && V.winner == null ? " turn" : ""));
      const meta = h("div", "meta");
      meta.append(h("span", "oname", p.name), h("span", "ocount", p.n + (p.n === 1 ? " card" : " cards")));
      const fan = h("div", "fan");
      for (let i = 0; i < Math.min(p.n, 8); i++) fan.append(h("i", "mini"));
      box.append(GameUtil.avatar(p), meta, fan);
      if (p.n === 1 && p.called) box.append(h("span", "badge", "LAST"));
      else if (p.id === V.vulnerable) box.append(h("span", "badge danger", "1 LEFT"));
      opps.append(box);
    }

    // direction
    $("dirEl").textContent = V.dir === 1 ? "↻ clockwise" : "↺ counter-clockwise";

    // discard pile
    const discard = $("discard");
    discard.textContent = "";
    V.under.forEach((c) => {
      const el = cardEl(c);
      el.style.transform = `rotate(${rot(c.id)}deg)`;
      discard.append(el);
    });
    if (V.top) {
      const el = cardEl(V.top);
      el.classList.add("top");
      el.style.transform = `rotate(${rot(V.top.id)}deg)`;
      el.style.setProperty("--r0", rot(V.top.id) + 20 + "deg");
      if (lastTopId !== null && lastTopId !== V.top.id) el.classList.add("pop");
      lastTopId = V.top.id;
      discard.append(el);
    }
    document.documentElement.style.setProperty("--cur", COLOR_HEX[V.color]);

    // deck
    $("deckN").textContent = V.deck;
    deckEl.classList.toggle("can", myTurn && !V.drew);

    // status
    const status = $("status");
    status.textContent = "";
    if (V.winner != null) status.append(V.winner === me ? "You win the round!" : `${nameOf(V.winner)} wins the round`);
    else if (myTurn) status.append(V.drew ? "Play the card you drew, or keep it" : "Your turn");
    else status.append(`${nameOf(V.turn)}'s turn`);
    if (V.top && V.top.c === "w" && V.winner == null) {
      const chip = h("span", "chip", COLOR_NAME[V.color]);
      chip.style.background = COLOR_HEX[V.color];
      status.append(chip);
    }
    $("log").textContent = V.log;

    // hand
    const mine = [...V.hand].sort((a, b) => SORT_C[a.c] - SORT_C[b.c] || SORT_V(a.v) - SORT_V(b.v));
    handEl.textContent = "";
    handEl.classList.toggle("my-turn", myTurn);
    const seen = new Set();
    for (const c of mine) {
      const el = cardEl(c);
      if (myTurn && canPlayClient(c)) el.classList.add("playable");
      if (prevHand.size && !prevHand.has(c.id)) el.classList.add("new");
      seen.add(c.id);
      handEl.append(el);
    }
    prevHand = seen;
    layoutHand();

    // actions
    const meP = V.players.find((p) => p.id === me);
    $("callBtn").hidden = !(meP && !meP.called && V.winner == null &&
      ((myTurn && V.hand.length === 2) || V.vulnerable === me));
    const catchBtn = $("catchBtn");
    catchBtn.hidden = !(V.vulnerable != null && V.vulnerable !== me && V.winner == null);
    if (!catchBtn.hidden) catchBtn.textContent = `Catch ${nameOf(V.vulnerable)}!`;
    $("passBtn").hidden = !(myTurn && V.drew);

    // results
    const result = $("result");
    if (V.winner != null) {
      $("resultTitle").textContent = V.winner === me ? "You win!" : `${nameOf(V.winner)} wins`;
      const list = $("standings");
      list.textContent = "";
      [...V.players].sort((a, b) => a.n - b.n).forEach((p) => {
        const li = h("li", p.id === V.winner ? "win" : "");
        li.append(GameUtil.avatar(p), h("span", "pname", p.name + (p.id === me ? " (you)" : "")),
          h("span", "n", p.n === 0 ? "out" : p.n + " left"));
        list.append(li);
      });
      $("again").hidden = !room.isHost;
      $("again").disabled = V.players.length < 2;
      $("againWait").hidden = room.isHost;
      if (result.hidden) setTimeout(() => { if (V && V.winner != null) result.hidden = false; }, 900);
    } else result.hidden = true;
  }

  function layoutHand() {
    const cards = handEl.children.length;
    if (!cards) return;
    const w = handEl.firstElementChild.getBoundingClientRect().width;
    const cs = getComputedStyle(handEl);
    const avail = handEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
    const overlap = cards > 1 ? Math.min(6, (avail - w * cards) / (cards - 1)) : 0;
    handEl.style.setProperty("--overlap", Math.max(-w * 0.72, overlap) + "px");
  }
  addEventListener("resize", layoutHand);

  // --- interactions ---
  handEl.addEventListener("click", (e) => {
    const el = e.target.closest(".card.playable");
    if (!el || !V) return;
    const card = V.hand.find((c) => c.id === +el.dataset.id);
    if (!card) return;
    if (card.c === "w") { pendingWild = card.id; $("picker").hidden = false; }
    else send({ t: "play", id: card.id });
  });
  $("picker").addEventListener("click", (e) => {
    const b = e.target.closest("[data-c]");
    if (!b || pendingWild == null) return;
    send({ t: "play", id: pendingWild, color: b.dataset.c });
    pendingWild = null;
    $("picker").hidden = true;
  });
  $("pickCancel").addEventListener("click", () => { pendingWild = null; $("picker").hidden = true; });
  deckEl.addEventListener("click", () => { if (deckEl.classList.contains("can")) send({ t: "draw" }); });
  $("passBtn").addEventListener("click", () => send({ t: "pass" }));
  $("callBtn").addEventListener("click", () => send({ t: "call" }));
  $("catchBtn").addEventListener("click", () => send({ t: "catch" }));
  $("again").addEventListener("click", () => send({ t: "again" }));

  function tickTimer() {
    const bar = $("timerBar");
    if (V && V.winner == null) {
      const left = Math.max(0, turnEndsLocal - performance.now());
      bar.style.width = (left / TURN_MS) * 100 + "%";
      bar.parentElement.classList.toggle("urgent", left < 8000);
    } else bar.style.width = "0%";
    timerTick = requestAnimationFrame(tickTimer);
  }

  // =====================================================================
  // Lobby hookup
  // =====================================================================
  Room.mount({
    game: "lastcard",
    title: "Last Card",
    subtitle: "Match color or number, 2 to 6 players. Empty your hand first, and don't forget to call your last card.",
    min: 2,
    max: 6,
    onStart(r) {
      room = r;
      V = null; lastSeq = -1; lastTopId = null; prevHand = new Set(); pendingWild = null;
      $("result").hidden = true;
      $("picker").hidden = true;

      if (r.isHost) {
        engine = createEngine(r.players, r.myId, () => {
          engine.G.seq++;
          for (const p of engine.G.players) {
            if (p.id === r.myId) onView(engine.view(p.id));
            else r.sendTo(p.id, engine.view(p.id));
          }
          engine.G.fx = null;
        });
        r.onData((from, m) => engine.act(from, m));
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => { engine.G.seq++; r.sendTo(id, engine.view(id)); });
        engine.newRound();
        engine.G.seq++;
        // first deal: small delay so guests have their handlers attached
        setTimeout(() => {
          for (const p of engine.G.players) {
            if (p.id === r.myId) onView(engine.view(p.id));
            else r.sendTo(p.id, engine.view(p.id));
          }
          engine.G.fx = null;
        }, 300);
        hostTimer = setInterval(() => engine.tick(), 250);
      } else {
        r.onData((_, m) => { if (m && m.t === "st") onView(m); });
      }
      tickTimer();

      return () => {
        clearInterval(hostTimer);
        cancelAnimationFrame(timerTick);
        room = null; engine = null; V = null;
        $("result").hidden = true;
        $("picker").hidden = true;
      };
    },
  });
})();
