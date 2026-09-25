// Dots & Boxes, 1v1 on a 6×6 grid of dots (25 boxes). Take turns drawing one line between two
// dots. Close the fourth side of a box to claim it and go again. Most boxes wins.
(() => {
  const N = 6;            // dots per side
  const B = N - 1;        // boxes per side
  const COLORS = ["#ff5b3a", "#4d8dff"];
  const $ = (id) => document.getElementById(id);
  const { h } = Party;

  function newState(first) {
    return { h: new Array(N * B).fill(-1), v: new Array(B * N).fill(-1), box: new Array(B * B).fill(-1), turn: first, over: null, last: null };
  }
  // h[r*B+c] = line from dot (r,c) to (r,c+1); v[r*N+c] = line from dot (r,c) to (r+1,c)
  const boxDone = (S, r, c) => S.h[r * B + c] >= 0 && S.h[(r + 1) * B + c] >= 0 && S.v[r * N + c] >= 0 && S.v[r * N + c + 1] >= 0;
  function move(S, side, m) {
    const r = m.r | 0, c = m.c | 0;
    let arr, i, around;
    if (m.k === "h" && r >= 0 && r < N && c >= 0 && c < B) { arr = S.h; i = r * B + c; around = [[r - 1, c], [r, c]]; }
    else if (m.k === "v" && r >= 0 && r < B && c >= 0 && c < N) { arr = S.v; i = r * N + c; around = [[r, c - 1], [r, c]]; }
    else return false;
    if (arr[i] >= 0) return false;
    arr[i] = side;
    S.last = { k: m.k, r, c };
    let scored = 0;
    for (const [br, bc] of around) {
      if (br < 0 || bc < 0 || br >= B || bc >= B || S.box[br * B + bc] >= 0) continue;
      if (boxDone(S, br, bc)) { S.box[br * B + bc] = side; scored++; }
    }
    if (S.box.every((x) => x >= 0)) {
      const n = [0, 1].map((s) => S.box.filter((x) => x === s).length);
      S.over = { winner: n[0] === n[1] ? -1 : n[0] > n[1] ? 0 : 1, reason: `${Math.max(...n)} boxes to ${Math.min(...n)}` };
    } else if (!scored) S.turn = 1 - side; // closing a box earns another go
    return true;
  }

  function render(S, ui) {
    const el = $("board");
    el.textContent = "";
    el.classList.toggle("live", ui.canMove);
    el.style.gridTemplateColumns = el.style.gridTemplateRows = `repeat(${B}, 14px 1fr) 14px`;
    // Grid of (2N-1)×(2N-1): dots at even/even, lines between, boxes at odd/odd.
    for (let y = 0; y < 2 * N - 1; y++) {
      for (let x = 0; x < 2 * N - 1; x++) {
        const r = y >> 1, c = x >> 1;
        if (y % 2 === 0 && x % 2 === 0) { el.append(h("i", "db-dot")); continue; }
        if (y % 2 === 1 && x % 2 === 1) {
          const o = S.box[r * B + c];
          el.append(h("span", "db-box" + (o >= 0 ? " s" + o : ""), o >= 0 ? (o === ui.me && !ui.spectator ? "You" : ui.names[o][0]) : ""));
          continue;
        }
        const k = y % 2 === 0 ? "h" : "v";
        const owner = k === "h" ? S.h[r * B + c] : S.v[r * N + c];
        const isLast = S.last && S.last.k === k && S.last.r === r && S.last.c === c;
        const b = h("button", `db-line ${k}` + (owner >= 0 ? " s" + owner : "") + (isLast ? " last" : ""));
        b.type = "button";
        b.disabled = !ui.canMove || owner >= 0;
        b.setAttribute("aria-label", `${k === "h" ? "Horizontal" : "Vertical"} line ${r + 1},${c + 1}`);
        b.addEventListener("click", () => ui.send({ k, r, c }));
        el.append(b);
      }
    }
    const n = [0, 1].map((s) => S.box.filter((x) => x === s).length);
    $("info").textContent = ui.spectator ? `${ui.names[0]} ${n[0]} · ${ui.names[1]} ${n[1]}` : `Boxes: you ${n[ui.me]} · them ${n[1 - ui.me]} · close a box to go again`;
    if (ui.prev) {
      const before = ui.prev.box.filter((x) => x >= 0).length, after = S.box.filter((x) => x >= 0).length;
      if (after > before) GameUtil.sfx("good");
    }
  }

  // ---------- Computer opponent ----------
  const cloneS = (S) => ({ ...S, h: S.h.slice(), v: S.v.slice(), box: S.box.slice(), over: S.over && { ...S.over } });
  const allMoves = (S) => {
    const out = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < B; c++) if (S.h[r * B + c] < 0) out.push({ k: "h", r, c });
    for (let r = 0; r < B; r++) for (let c = 0; c < N; c++) if (S.v[r * N + c] < 0) out.push({ k: "v", r, c });
    return out;
  };
  const sides = (S, r, c) => (S.h[r * B + c] >= 0) + (S.h[(r + 1) * B + c] >= 0) + (S.v[r * N + c] >= 0) + (S.v[r * N + c + 1] >= 0);
  const boxesOf = (m) => (m.k === "h" ? [[m.r - 1, m.c], [m.r, m.c]] : [[m.r, m.c - 1], [m.r, m.c]]).filter(([r, c]) => r >= 0 && c >= 0 && r < B && c < B);
  const completes = (S, m) => boxesOf(m).some(([r, c]) => S.box[r * B + c] < 0 && sides(S, r, c) === 3);
  const givesAway = (S, m) => boxesOf(m).some(([r, c]) => S.box[r * B + c] < 0 && sides(S, r, c) === 2);
  // How many boxes the other player could grab in a row if we play m (they take greedily).
  function cost(S, side, m) {
    const c = cloneS(S);
    move(c, side, m);
    let n = 0;
    for (let guard = 0; guard < 40 && !c.over && c.turn !== side; guard++) {
      const take = allMoves(c).find((x) => completes(c, x));
      if (!take) break;
      const before = c.box.filter((x) => x >= 0).length;
      move(c, c.turn, take);
      n += c.box.filter((x) => x >= 0).length - before;
    }
    return n;
  }
  function ai(S, side, level) {
    const moves = allMoves(S);
    if (!moves.length) return null;
    const grab = moves.filter((m) => completes(S, m));
    if (level === "easy") return grab.length && Math.random() < 0.6 ? Party.pickRandom(grab) : Party.pickRandom(moves);
    if (grab.length) return Party.pickRandom(grab);
    const safe = moves.filter((m) => !givesAway(S, m));
    if (safe.length) return Party.pickRandom(safe);
    if (level === "medium") return Party.pickRandom(moves);
    // Hard: forced to open something, so open the smallest chain.
    let best = null, bestC = Infinity;
    for (const m of moves) { const c = cost(S, side, m); if (c < bestC) { bestC = c; best = m; } }
    return best;
  }

  Party.turnDuel({
    game: "dots",
    title: "Dots & Boxes",
    subtitle: "Take turns drawing lines. Close a box to claim it and go again. Most boxes wins.",
    chip: (side) => COLORS[side],
    newState, move, render, ai,
  });
})();
