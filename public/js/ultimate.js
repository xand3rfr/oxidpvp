// Ultimate Tic-Tac-Toe, 1v1. Nine small boards inside one big board. The square you play in
// sends your opponent to the matching small board; win small boards to claim them, and get
// three small boards in a row to win. If you're sent to a finished board, you can play anywhere.
(() => {
  const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  const MARK = ["✕", "◯"];
  const COLORS = ["#ff5b3a", "#4d8dff"];
  const $ = (id) => document.getElementById(id);
  const { h } = Party;

  const lineWin = (get) => { for (const [a, b, c] of LINES) { const v = get(a); if (v && v === get(b) && v === get(c)) return { v, line: [a, b, c] }; } return null; };

  function newState(first) {
    return { cells: new Array(81).fill(0), boards: new Array(9).fill(0), next: -1, turn: first, over: null, last: -1, line: null };
  }
  function move(S, side, m) {
    const b = m.b | 0, c = m.c | 0;
    if (b < 0 || b > 8 || c < 0 || c > 8) return false;
    if (S.boards[b] || S.cells[b * 9 + c]) return false;
    if (S.next >= 0 && S.next !== b) return false;
    S.cells[b * 9 + c] = side + 1;
    S.last = b * 9 + c;
    const small = lineWin((k) => S.cells[b * 9 + k]);
    if (small) S.boards[b] = small.v;
    else if ([...Array(9).keys()].every((k) => S.cells[b * 9 + k])) S.boards[b] = 3; // full: nobody's
    S.next = S.boards[c] ? -1 : c;
    const big = lineWin((k) => (S.boards[k] === 3 ? 0 : S.boards[k]));
    if (big) { S.over = { winner: big.v - 1, reason: "three in a row" }; S.line = big.line; }
    else if (S.boards.every(Boolean)) {
      // No line: whoever won more small boards takes it.
      const n = [1, 2].map((v) => S.boards.filter((x) => x === v).length);
      S.over = n[0] === n[1] ? { winner: -1, reason: "board full" } : { winner: n[0] > n[1] ? 0 : 1, reason: "more small boards" };
    }
    S.turn = 1 - side;
    return true;
  }

  function render(S, ui) {
    const el = $("board");
    el.textContent = "";
    for (let b = 0; b < 9; b++) {
      const active = ui.canMove && !S.boards[b] && (S.next < 0 || S.next === b);
      const sb = h("div", "ut-small" + (active ? " active" : "") + (S.boards[b] ? " done w" + S.boards[b] : "") + (S.line && S.line.includes(b) ? " big-line" : ""));
      for (let c = 0; c < 9; c++) {
        const v = S.cells[b * 9 + c];
        const cell = h("button", "ut-cell" + (v ? " m" + v : "") + (S.last === b * 9 + c ? " last" : ""), v ? MARK[v - 1] : "");
        cell.type = "button";
        cell.disabled = !active || !!v;
        cell.addEventListener("click", () => ui.send({ b, c }));
        sb.append(cell);
      }
      if (S.boards[b] === 1 || S.boards[b] === 2) sb.append(h("span", "ut-big", MARK[S.boards[b] - 1]));
      el.append(sb);
    }
    const mine = S.boards.filter((x) => x === ui.me + 1).length, theirs = S.boards.filter((x) => x === 2 - ui.me).length;
    $("info").textContent = `You're ${MARK[ui.me]} · small boards: ${mine} vs ${theirs}` + (ui.canMove ? (S.next < 0 ? " · play in any open board" : " · play in the glowing board") : "");
    if (ui.spectator) $("info").textContent = `${ui.names[0]} ✕ vs ${ui.names[1]} ◯`;
  }

  Party.turnDuel({
    game: "uttt",
    title: "Ultimate Tic-Tac-Toe",
    subtitle: "Tic-tac-toe inside tic-tac-toe. Where you play decides where they play next.",
    chip: (side) => COLORS[side],
    newState, move, render,
  });
})();
