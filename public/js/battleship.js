// Battleship, 1v1. Each player arranges a fleet, then the host referees every shot.
// Each player gets a personal view: their own shots, the shots taken at them, and only the
// enemy ships they've sunk (the full enemy fleet is revealed when the game ends).
(() => {
  const N = 10;
  const FLEET = [5, 4, 3, 3, 2];
  const NAMES = ["Carrier", "Battleship", "Cruiser", "Submarine", "Destroyer"];
  const $ = (id) => document.getElementById(id);

  // ---------- Fleet geometry ----------
  const cellsOf = (s) => Array.from({ length: s.len }, (_, k) => [s.x + (s.v ? 0 : k), s.y + (s.v ? k : 0)]);
  const inBounds = (s) => s.x >= 0 && s.y >= 0 && (s.v ? s.y + s.len : s.x + s.len) <= N && (s.v ? s.x < N : s.y < N);
  function fits(fleet, s, skip = -1) {
    if (!inBounds(s)) return false;
    const taken = new Set();
    fleet.forEach((o, i) => { if (i !== skip) for (const [x, y] of cellsOf(o)) taken.add(y * N + x); });
    return cellsOf(s).every(([x, y]) => !taken.has(y * N + x));
  }
  function randomFleet() {
    const fleet = [];
    for (const len of FLEET) {
      let s;
      do s = { len, v: Math.random() < 0.5, x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) };
      while (!fits(fleet, s));
      fleet.push(s);
    }
    return fleet;
  }
  function validFleet(f) {
    if (!Array.isArray(f) || f.length !== FLEET.length) return null;
    const clean = [];
    for (let i = 0; i < FLEET.length; i++) {
      const s = f[i];
      if (!s || s.len !== FLEET[i]) return null;
      const c = { len: FLEET[i], v: !!s.v, x: s.x | 0, y: s.y | 0 };
      if (!fits(clean, c)) return null;
      clean.push(c);
    }
    return clean;
  }

  // ---------- Referee (host) ----------
  function createGame() {
    const S = { phase: "place", fleets: [null, null], shots: [[], []], turn: 0, winner: -1, sc: [0, 0], n: 1, last: null, starter: 0 };
    const occupied = (i, x, y) => S.fleets[i].findIndex((s) => cellsOf(s).some(([a, b]) => a === x && b === y));
    const shotAt = (i, x, y) => S.shots[i].find((s) => s.x === x && s.y === y);
    const isSunk = (target, si) => cellsOf(S.fleets[target][si]).every(([x, y]) => { const s = shotAt(1 - target, x, y); return s && s.hit; });

    function place(i, fleet) {
      if (S.phase !== "place" || S.fleets[i]) return false;
      const f = validFleet(fleet);
      if (!f) return false;
      S.fleets[i] = f;
      if (S.fleets[0] && S.fleets[1]) { S.phase = "battle"; S.turn = S.starter; }
      return true;
    }
    function fire(i, x, y) {
      if (S.phase !== "battle" || S.turn !== i) return false;
      if (!(x >= 0 && x < N && y >= 0 && y < N) || shotAt(i, x, y)) return false;
      const si = occupied(1 - i, x, y);
      S.shots[i].push({ x, y, hit: si >= 0 });
      S.last = { x, y, by: i };
      if (si >= 0 && S.fleets[1 - i].every((_, k) => isSunk(1 - i, k))) {
        S.phase = "over"; S.winner = i; S.sc[i]++;
      } else S.turn = 1 - i;
      return true;
    }
    function rematch() {
      if (S.phase !== "over") return;
      S.starter = 1 - S.winner; // loser shoots first
      Object.assign(S, { phase: "place", fleets: [null, null], shots: [[], []], winner: -1, last: null, n: S.n + 1 });
    }
    function view(i) {
      const o = 1 - i;
      const sunk = S.fleets[o] ? S.fleets[o].map((s, k) => (isSunk(o, k) ? { ...s, k } : null)).filter(Boolean) : [];
      const mySunk = S.fleets[i] ? S.fleets[i].map((_, k) => isSunk(i, k)) : [];
      return {
        t: "v", n: S.n, phase: S.phase, ready: [!!S.fleets[i], !!S.fleets[o]],
        myTurn: S.phase === "battle" && S.turn === i,
        myShots: S.shots[i], theirShots: S.shots[o], sunk, mySunk,
        reveal: S.phase === "over" ? S.fleets[o] : null,
        won: S.phase === "over" ? S.winner === i : null,
        sc: [S.sc[i], S.sc[o]],
        last: S.last ? { x: S.last.x, y: S.last.y, mine: S.last.by === i } : null,
      };
    }
    return { S, place, fire, rematch, view };
  }

  // ---------- Grids ----------
  function makeGrid(el) {
    el.textContent = "";
    const corner = document.createElement("div");
    corner.className = "corner";
    el.append(corner);
    for (let x = 0; x < N; x++) {
      const h = document.createElement("div");
      h.className = "hd top"; h.textContent = "ABCDEFGHIJ"[x];
      el.append(h);
    }
    const cells = [];
    for (let y = 0; y < N; y++) {
      const h = document.createElement("div");
      h.className = "hd"; h.textContent = y + 1;
      el.append(h);
      for (let x = 0; x < N; x++) {
        const c = document.createElement("div");
        c.className = "sq";
        c.dataset.x = x; c.dataset.y = y;
        el.append(c);
        cells.push(c);
      }
    }
    return cells;
  }
  const homeCells = makeGrid($("home"));
  const targetCells = makeGrid($("target"));
  const paint = (cells, fn) => cells.forEach((c, i) => {
    const x = i % N, y = (i / N) | 0;
    c.className = "sq" + (x === 0 ? " c0" : x === N - 1 ? " c9" : "") + (y === 0 ? " r0" : y === N - 1 ? " r9" : "") + fn(x, y);
  });

  // ---------- State ----------
  let link = null, game = null, V = null, fleet = randomFleet(), drag = null, sentFleet = false, prevV = null;

  function render() {
    const placing = !V || V.phase === "place";
    const lockedIn = placing && V && V.ready[0];

    // home board
    const occ = new Map();
    fleet.forEach((s, k) => { for (const [x, y] of cellsOf(s)) occ.set(y * N + x, k); });
    const incoming = new Map();
    if (V && !placing) for (const s of V.theirShots) incoming.set(s.y * N + s.x, s);
    let ghost = null;
    if (drag && drag.cand) ghost = { ok: fits(fleet, drag.cand, drag.si), set: new Set(cellsOf(drag.cand).map(([x, y]) => y * N + x)) };
    paint(homeCells, (x, y) => {
      const i = y * N + x, k = occ.get(i), sh = incoming.get(i);
      let c = "";
      if (ghost && ghost.set.has(i)) c += ghost.ok ? " ghost-ok" : " ghost-bad";
      else if (k != null) c += " ship" + (drag && drag.si === k ? " sel" : "") + (V && V.mySunk[k] ? " sunk" : "");
      if (sh) c += sh.hit ? " hit" : " miss";
      if (V && V.last && !V.last.mine && V.last.x === x && V.last.y === y) c += " last";
      return c;
    });

    // target board
    if (V && !placing) {
      const mine = new Map(V.myShots.map((s) => [s.y * N + s.x, s]));
      const sunkSet = new Set(), revealSet = new Set();
      for (const s of V.sunk) for (const [x, y] of cellsOf(s)) sunkSet.add(y * N + x);
      if (V.reveal) for (const s of V.reveal) for (const [x, y] of cellsOf(s)) revealSet.add(y * N + x);
      paint(targetCells, (x, y) => {
        const i = y * N + x, sh = mine.get(i);
        let c = "";
        if (sunkSet.has(i)) c += " sunk";
        else if (revealSet.has(i)) c += " ship";
        if (sh) c += sh.hit ? " hit" : " miss";
        if (V.last && V.last.mine && V.last.x === x && V.last.y === y) c += " last";
        return c;
      });
      $("target").classList.toggle("live", V.myTurn);
      const sunkK = new Set(V.sunk.map((s) => s.k));
      renderFleetLeft($("enemyFleet"), sunkK);
      renderFleetLeft($("myFleet"), new Set(V.mySunk.map((b, k) => (b ? k : -1))));
      $("enemyLeft").textContent = `${FLEET.length - sunkK.size} ships left`;
    }

    $("targetSide").hidden = placing;
    $("myFleet").hidden = placing;
    $("home").classList.toggle("small", !placing);
    $("tools").hidden = !placing && !(V && V.phase === "over");
    $("shuffle").hidden = $("ready").hidden = !placing || lockedIn || !link;
    $("rematch2").hidden = !(V && V.phase === "over");
    $("tip").hidden = !placing || lockedIn;

    const banner = $("banner"), text = $("bannerText");
    let msg, mineTurn = false;
    if (!V) msg = "Place your fleet";
    else if (V.phase === "place") msg = V.ready[0] ? "Waiting for their fleet…" : V.ready[1] ? "They're ready. Your turn to place" : "Place your fleet";
    else if (V.phase === "battle") { mineTurn = V.myTurn; msg = V.myTurn ? "Fire!" : "They're aiming…"; }
    else msg = V.won ? "Fleet destroyed. You win" : "Your fleet is gone";
    text.textContent = msg;
    banner.classList.toggle("mine", mineTurn || (V && V.phase === "place" && !V.ready[0]));

    if (V) { $("s0").textContent = V.sc[0]; $("s1").textContent = V.sc[1]; }
  }
  function renderFleetLeft(el, gone) {
    el.textContent = "";
    FLEET.forEach((len, k) => {
      const i = document.createElement("i");
      i.style.width = len * 10 + "px";
      i.title = NAMES[k];
      if (gone.has(k)) i.className = "gone";
      el.append(i);
    });
  }

  // ---------- Placement input ----------
  const cellFromPoint = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const c = el && el.closest("#home .sq");
    return c ? [+c.dataset.x, +c.dataset.y] : null;
  };
  const canEdit = () => link && (!V || (V.phase === "place" && !V.ready[0]));

  $("home").addEventListener("pointerdown", (e) => {
    if (!canEdit()) return;
    const p = cellFromPoint(e);
    if (!p) return;
    const si = fleet.findIndex((s) => cellsOf(s).some(([x, y]) => x === p[0] && y === p[1]));
    if (si < 0) return;
    e.preventDefault();
    $("home").setPointerCapture(e.pointerId);
    drag = { si, ox: p[0] - fleet[si].x, oy: p[1] - fleet[si].y, start: p, moved: false, cand: null };
    render();
  });
  $("home").addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = cellFromPoint(e);
    if (!p) return;
    if (p[0] !== drag.start[0] || p[1] !== drag.start[1]) drag.moved = true;
    if (!drag.moved) return;
    const s = fleet[drag.si];
    drag.cand = { ...s, x: p[0] - drag.ox, y: p[1] - drag.oy };
    render();
  });
  const endDrag = (cancel) => {
    if (!drag) return;
    const { si, moved, cand } = drag;
    drag = null;
    if (!cancel) {
      if (moved && cand && fits(fleet, cand, si)) fleet[si] = cand;
      else if (!moved) rotate(si);
    }
    render();
  };
  $("home").addEventListener("pointerup", () => endDrag(false));
  $("home").addEventListener("pointercancel", () => endDrag(true));

  function rotate(si) {
    const s = fleet[si];
    const r = { ...s, v: !s.v };
    // keep it on the board if rotating would push it off the edge
    if (r.v) r.y = Math.min(r.y, N - r.len); else r.x = Math.min(r.x, N - r.len);
    if (fits(fleet, r, si)) fleet[si] = r;
    else GameUtil.toast("No room to rotate there");
  }

  $("shuffle").addEventListener("click", () => { if (canEdit()) { fleet = randomFleet(); render(); } });
  $("ready").addEventListener("click", () => {
    if (!canEdit()) return;
    if (link.isHost) { if (game.place(0, fleet)) publish(); }
    else if (!sentFleet) { sentFleet = true; link.send({ t: "fleet", ships: fleet }); $("ready").disabled = true; }
  });

  // ---------- Firing ----------
  $("target").addEventListener("click", (e) => {
    const c = e.target.closest(".sq");
    if (!c || !V || !V.myTurn || !link) return;
    const x = +c.dataset.x, y = +c.dataset.y;
    if (V.myShots.some((s) => s.x === x && s.y === y)) return;
    if (link.isHost) { if (game.fire(0, x, y)) publish(); }
    else { link.send({ t: "fire", x, y }); V.myTurn = false; render(); }
  });

  // ---------- Sync ----------
  function publish() {
    link.send(game.view(1));
    show(game.view(0));
  }
  function show(v) {
    prevV = V;
    V = v;
    sentFleet = v.ready[0];
    $("ready").disabled = false;
    if (prevV && prevV.n === v.n) {
      // announce sinkings
      if (v.sunk.length > prevV.sunk.length) GameUtil.toast("You sunk their " + NAMES[v.sunk[v.sunk.length - 1].k] + "!");
      const lost = v.mySunk.findIndex((b, k) => b && !prevV.mySunk[k]);
      if (lost >= 0) GameUtil.toast("They sunk your " + NAMES[lost]);
      if (v.phase === "battle" && prevV.phase === "place") GameUtil.toast(v.myTurn ? "Both fleets ready. You fire first." : "Both fleets ready. They fire first.");
    }
    render();
    if (v.phase === "over" && (!prevV || prevV.phase !== "over")) {
      setTimeout(() => {
        if (!V || V.phase !== "over") return;
        $("resultTitle").textContent = V.won ? "Victory" : "Sunk";
        $("resultScore").textContent = V.sc[0] + " – " + V.sc[1];
        $("rematch").disabled = false; $("rematch").textContent = "Rematch";
        $("result").hidden = false;
      }, 900);
    } else if (v.phase !== "over") $("result").hidden = true;
  }

  function askRematch() {
    if (!link || !V || V.phase !== "over") return;
    if (link.isHost) { game.rematch(); publish(); }
    else {
      link.send({ t: "rm" });
      for (const b of [$("rematch"), $("rematch2")]) { b.disabled = true; b.textContent = "Waiting for host…"; }
    }
  }
  $("rematch").addEventListener("click", askRematch);
  $("rematch2").addEventListener("click", askRematch);
  $("peek").addEventListener("click", () => { $("result").hidden = true; });

  render();

  Lobby.mount({
    game: "battleship",
    title: "Battleship",
    subtitle: "Hide your fleet, then take turns calling shots. Sink all five ships to win.",
    onStart(l) {
      link = l;
      V = null; prevV = null; sentFleet = false; drag = null;
      for (const b of [$("rematch"), $("rematch2")]) { b.disabled = false; b.textContent = "Rematch"; }
      if (l.isHost) {
        game = createGame();
        l.onData((d) => {
          if (d.t === "fleet") { if (game.place(1, d.ships)) publish(); else l.send({ ...game.view(1), bad: true }); }
          else if (d.t === "fire") { if (game.fire(1, d.x | 0, d.y | 0)) publish(); else l.send(game.view(1)); }
          else if (d.t === "rm") { game.rematch(); publish(); }
        });
        publish();
      } else {
        l.onData((d) => {
          if (d.t !== "v") return;
          if (d.bad) GameUtil.toast("That fleet layout wasn't valid. Try shuffling.");
          if (d.phase === "place" && V && V.phase === "over") {
            for (const b of [$("rematch"), $("rematch2")]) { b.disabled = false; b.textContent = "Rematch"; }
          }
          show(d);
        });
      }
      render();
      GameUtil.toast("Connected. Arrange your ships and hit Ready.");
      return () => {
        link = null; game = null; V = null; prevV = null; drag = null;
        $("result").hidden = true;
        $("s0").textContent = "0"; $("s1").textContent = "0";
        render();
      };
    },
  });
})();
