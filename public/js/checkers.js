// Checkers (English draughts), 1v1. Men move diagonally forward and capture by jumping; captures
// are mandatory and multi-jumps must be finished; reaching the far row crowns a king that moves
// both ways. Lose all your pieces (or have no legal move) and you lose. The host referees.
(() => {
  const EMPTY = 0;
  // side 0 (host, red) starts at the bottom and moves up; side 1 (guest, dark) moves down.
  const MAN = [1, 3], KING = [2, 4];
  const sideOf = (p) => (p === 1 || p === 2 ? 0 : p === 3 || p === 4 ? 1 : -1);
  const isKing = (p) => p === 2 || p === 4;
  const DRAW_PLIES = 80; // no capture or promotion for this long = draw
  const COLORS = ["#ef4444", "#e5e7eb"];
  const $ = (id) => document.getElementById(id);
  const { h } = Party;

  function newState(first) {
    const b = new Array(64).fill(EMPTY);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 0) continue;
      if (r < 3) b[r * 8 + c] = MAN[1];
      if (r > 4) b[r * 8 + c] = MAN[0];
    }
    return { b, turn: first, over: null, chain: -1, quiet: 0, last: null };
  }

  function dirs(p) {
    if (isKing(p)) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    return sideOf(p) === 0 ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
  }
  const inside = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  function captures(S, i) {
    const p = S.b[i], side = sideOf(p), r = i >> 3, c = i & 7, out = [];
    for (const [dr, dc] of dirs(p)) {
      const mr = r + dr, mc = c + dc, tr = r + 2 * dr, tc = c + 2 * dc;
      if (!inside(tr, tc)) continue;
      const mid = S.b[mr * 8 + mc];
      if (mid !== EMPTY && sideOf(mid) === 1 - side && S.b[tr * 8 + tc] === EMPTY) out.push({ from: i, to: tr * 8 + tc, cap: mr * 8 + mc });
    }
    return out;
  }
  function steps(S, i) {
    const p = S.b[i], r = i >> 3, c = i & 7, out = [];
    for (const [dr, dc] of dirs(p)) {
      const tr = r + dr, tc = c + dc;
      if (inside(tr, tc) && S.b[tr * 8 + tc] === EMPTY) out.push({ from: i, to: tr * 8 + tc });
    }
    return out;
  }
  function legal(S, side) {
    if (S.chain >= 0) return captures(S, S.chain);
    const mine = S.b.map((p, i) => (sideOf(p) === side ? i : -1)).filter((i) => i >= 0);
    const caps = mine.flatMap((i) => captures(S, i));
    return caps.length ? caps : mine.flatMap((i) => steps(S, i));
  }
  function move(S, side, m) {
    const mv = legal(S, side).find((x) => x.from === m.from && x.to === m.to);
    if (!mv) return false;
    const p = S.b[mv.from];
    S.b[mv.to] = p; S.b[mv.from] = EMPTY;
    S.last = { from: mv.from, to: mv.to };
    let crowned = false;
    const row = mv.to >> 3;
    if (!isKing(p) && ((side === 0 && row === 0) || (side === 1 && row === 7))) { S.b[mv.to] = KING[side]; crowned = true; }
    if (mv.cap != null) {
      S.b[mv.cap] = EMPTY;
      S.quiet = 0;
      // Keep jumping with the same piece if possible (crowning ends the turn).
      if (!crowned && captures(S, mv.to).length) { S.chain = mv.to; return true; }
    } else S.quiet = crowned ? 0 : S.quiet + 1;
    S.chain = -1;
    S.turn = 1 - side;
    if (!S.b.some((q) => sideOf(q) === S.turn) || !legal(S, S.turn).length) S.over = { winner: side, reason: "no moves left" };
    else if (S.quiet >= DRAW_PLIES) S.over = { winner: -1, reason: "40 moves without a capture" };
    return true;
  }

  // ---------- UI ----------
  let sel = -1, lastUi = null, curS = null;
  function render(S, ui) {
    lastUi = ui; curS = S;
    if (ui.fresh || !ui.canMove) sel = -1;
    if (S.chain >= 0 && ui.canMove) sel = S.chain;
    const board = $("board");
    board.textContent = "";
    board.classList.toggle("live", ui.canMove);
    const flip = ui.me === 1;
    const moves = ui.canMove ? legal(S, ui.me) : [];
    const movable = new Set(moves.map((m) => m.from));
    const targets = new Set(moves.filter((m) => m.from === sel).map((m) => m.to));
    for (let k = 0; k < 64; k++) {
      const i = flip ? 63 - k : k;
      const dark = ((i >> 3) + (i & 7)) % 2 === 1;
      const cell = h("button", "ck-sq " + (dark ? "dark" : "light"));
      cell.type = "button";
      cell.dataset.i = i;
      if (S.last && (S.last.from === i || S.last.to === i)) cell.classList.add("last");
      if (targets.has(i)) cell.classList.add("target");
      const p = S.b[i];
      if (p) {
        const pc = h("span", "ck-pc s" + sideOf(p) + (isKing(p) ? " king" : "") + (sel === i ? " sel" : "") + (movable.has(i) ? " can" : ""));
        if (isKing(p)) pc.textContent = "♛";
        cell.append(pc);
      }
      board.append(cell);
    }
    const counts = [0, 1].map((s) => S.b.filter((p) => sideOf(p) === s).length);
    $("info").textContent = `${counts[ui.me]} pieces vs ${counts[1 - ui.me]}` + (moves.length && moves[0].cap != null ? " · you must capture!" : "");
    if (ui.prev && JSON.stringify(ui.prev.b.filter(Boolean).length) !== JSON.stringify(S.b.filter(Boolean).length)) GameUtil.sfx("good");
  }
  $("board").addEventListener("click", (e) => {
    const cell = e.target.closest(".ck-sq");
    if (!cell || !lastUi || !lastUi.canMove) return;
    const i = +cell.dataset.i;
    if (cell.classList.contains("target")) { lastUi.send({ from: sel, to: i }); return; }
    if (cell.querySelector(".ck-pc.can")) { sel = i; GameUtil.sfx("click"); render(curS, { ...lastUi, fresh: false, prev: null }); }
  });

  Party.turnDuel({
    game: "checkers",
    title: "Checkers",
    subtitle: "Jump your opponent's pieces, get kings, and clear the board. Captures are mandatory.",
    chip: (side) => COLORS[side],
    newState,
    move,
    render,
    yourTurnText: (S) => (S.chain >= 0 ? "Keep jumping!" : "Your move"),
  });
})();
