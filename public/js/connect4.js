// Connect 4, 1v1. The host owns the board; the guest only sends "drop in column c".
// Host plays piece 1 (orange), guest plays piece 2 (yellow). Loser starts the next round.
(() => {
  const COLS = 7, ROWS = 6;
  const PIECE_COLOR = { 1: "var(--p1)", 2: "var(--yellow)" };
  const $ = (id) => document.getElementById(id);
  const boardEl = $("board"), resultEl = $("result"), rematchBtn = $("rematch");
  const at = (c, r) => c * ROWS + r; // r = 0 is the bottom row

  // ---------- Rules (host) ----------
  const newState = (starter = 1, sc = [0, 0], n = 1) => ({
    b: Array(COLS * ROWS).fill(0), turn: starter, starter, win: 0, line: [], last: -1, sc, n,
  });

  function lineThrough(b, c, r) {
    const p = b[at(c, r)];
    for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const cells = [at(c, r)];
      for (const s of [1, -1]) {
        let x = c + dc * s, y = r + dr * s;
        while (x >= 0 && x < COLS && y >= 0 && y < ROWS && b[at(x, y)] === p) {
          cells.push(at(x, y));
          x += dc * s; y += dr * s;
        }
      }
      if (cells.length >= 4) return cells;
    }
    return null;
  }

  function drop(S, piece, c) {
    if (S.win || S.turn !== piece || !(c >= 0 && c < COLS)) return false;
    let r = 0;
    while (r < ROWS && S.b[at(c, r)]) r++;
    if (r >= ROWS) return false;
    S.b[at(c, r)] = piece;
    S.last = at(c, r);
    const line = lineThrough(S.b, c, r);
    if (line) {
      S.win = piece; S.line = line; S.sc[piece - 1]++;
    } else if (S.b.every(Boolean)) {
      S.win = 3;
    } else S.turn = 3 - piece;
    return true;
  }

  // ---------- Board DOM ----------
  const slots = [];
  for (let c = 0; c < COLS; c++) {
    const col = document.createElement("div");
    col.className = "col";
    col.dataset.c = c;
    for (let r = ROWS - 1; r >= 0; r--) {
      const s = document.createElement("div");
      s.className = "slot";
      col.appendChild(s);
      slots[at(c, r)] = s;
    }
    boardEl.appendChild(col);
  }

  // ---------- State ----------
  let link = null, S = null, V = null, me = 1, pending = false;

  function tryMove(c) {
    if (!link || link.spectator || !V || V.win || V.turn !== me || pending) return;
    if (V.b[at(c, ROWS - 1)]) return; // column full
    if (link.isHost) { if (drop(S, me, c)) publish(); }
    else { pending = true; link.send({ t: "drop", c }); }
  }
  boardEl.addEventListener("click", (e) => {
    const col = e.target.closest(".col");
    if (col) tryMove(+col.dataset.c);
  });
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= COLS) tryMove(n - 1);
  });

  function publish() {
    link.send({ t: "s", s: S });
    show(S);
  }

  function show(state) {
    const prev = V;
    V = JSON.parse(JSON.stringify(state));
    pending = false;
    const fresh = !prev || prev.n !== V.n;
    const cell = boardEl.querySelector(".slot").getBoundingClientRect().height;

    for (let i = 0; i < V.b.length; i++) {
      const s = slots[i], p = V.b[i];
      let d = s.querySelector(".disc");
      if (!p) { if (d) d.remove(); continue; }
      if (!d || fresh && d.dataset.p != p) {
        if (d) d.remove();
        d = document.createElement("i");
        d.className = "disc d" + p;
        d.dataset.p = p;
        if (i === V.last && (!prev || !prev.b[i] || fresh)) {
          const r = i % ROWS;
          d.style.setProperty("--fall", (ROWS - r) * cell + 20 + "px");
          d.classList.add("drop");
        }
        s.appendChild(d);
      }
      d.classList.toggle("win", V.line.includes(i));
    }

    const spec = link && link.spectator;
    const myTurn = !spec && !V.win && V.turn === me;
    const who = (piece) => (piece === me ? link.myName : link.oppName);
    if (prev && prev.n === V.n && V.last !== prev.last) GameUtil.sfx("pop");
    if (myTurn && (!prev || prev.turn !== V.turn || prev.n !== V.n)) setTimeout(() => GameUtil.sfx("turn"), 250);
    boardEl.classList.toggle("live", myTurn);
    const banner = $("banner");
    banner.classList.toggle("mine", myTurn);
    $("bannerChip").style.background = PIECE_COLOR[V.win && V.win < 3 ? V.win : V.turn];
    $("bannerText").textContent =
      V.win === 3 ? "Board full, draw" :
      spec ? (V.win ? `${who(V.win)} got four` : `${who(V.turn)}'s move`) :
      V.win ? (V.win === me ? "Four in a row!" : "They got four") :
      myTurn ? "Your move" : "Their move";

    const mine = V.sc[me - 1], theirs = V.sc[2 - me];
    $("s0").textContent = mine;
    $("s1").textContent = theirs;

    if (V.win && (!prev || !prev.win || prev.n !== V.n)) {
      if (!spec) {
        GameUtil.sfx(V.win === 3 ? "pop" : V.win === me ? "win" : "lose");
        GameUtil.record("connect", V.win === 3 ? "draw" : V.win === me ? "win" : "loss");
      }
    }
    if (V.win) {
      setTimeout(() => {
        if (!V || !V.win) return;
        $("resultTitle").textContent = V.win === 3 ? "Draw" : spec ? `${who(V.win)} wins` : V.win === me ? "You win" : "You lose";
        rematchBtn.hidden = !!spec;
        $("resultScore").textContent = `${mine} – ${theirs}`;
        rematchBtn.disabled = false;
        rematchBtn.textContent = "Next round";
        resultEl.hidden = false;
      }, 1100);
    } else resultEl.hidden = true;
  }

  function nextRound() {
    // Loser starts; after a draw, whoever didn't start last time goes first.
    const starter = S.win === 1 ? 2 : S.win === 2 ? 1 : 3 - S.starter;
    S = newState(starter, S.sc, S.n + 1);
    publish();
  }
  rematchBtn.addEventListener("click", () => {
    if (!link || !V || !V.win) return;
    if (link.isHost) nextRound();
    else { link.send({ t: "rm" }); rematchBtn.disabled = true; rematchBtn.textContent = "Waiting for host…"; }
  });

  // ---------- Computer opponent (plays piece 2) ----------
  const ORDER = [3, 2, 4, 1, 5, 0, 6];
  function windowScore(b, me) {
    let v = 0;
    const them = 3 - me;
    const lines = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) for (const [dc, dr] of lines) {
      const ec = c + dc * 3, er = r + dr * 3;
      if (ec < 0 || ec >= COLS || er < 0 || er >= ROWS) continue;
      let m = 0, t = 0;
      for (let k = 0; k < 4; k++) { const x = b[at(c + dc * k, r + dr * k)]; if (x === me) m++; else if (x === them) t++; }
      if (m && t) continue;
      if (m === 3) v += 6; else if (m === 2) v += 2;
      if (t === 3) v -= 8; else if (t === 2) v -= 2;
    }
    for (let r = 0; r < ROWS; r++) { if (b[at(3, r)] === me) v += 3; else if (b[at(3, r)] === them) v -= 3; }
    return v;
  }
  function botMove(S, level) {
    const me = 2, valid = ORDER.filter((c) => !S.b[at(c, ROWS - 1)]);
    if (!valid.length) return null;
    if (level === "easy" && Math.random() < 0.5) return valid[Math.floor(Math.random() * valid.length)];
    const depth = level === "hard" ? 7 : level === "medium" ? 4 : 2, deadline = performance.now() + 900;
    const play = (st, piece, c) => { const n = { ...st, b: st.b.slice(), sc: [0, 0], line: [] }; drop(n, piece, c); return n; };
    function nega(st, d, a, b, piece) {
      if (st.win) return st.win === 3 ? 0 : st.win === piece ? 1e6 + d : -1e6 - d;
      if (d === 0 || performance.now() > deadline) return windowScore(st.b, piece);
      let best = -Infinity;
      for (const c of ORDER) {
        if (st.b[at(c, ROWS - 1)]) continue;
        const v = -nega(play(st, piece, c), d - 1, -b, -a, 3 - piece);
        if (v > best) best = v;
        if (best > a) a = best;
        if (a >= b) break;
      }
      return best === -Infinity ? 0 : best;
    }
    let bestC = valid[0], bestV = -Infinity;
    for (const c of valid) {
      const v = -nega(play({ ...S, turn: me }, me, c), depth - 1, -Infinity, Infinity, 1) + Math.random() * 0.5;
      if (v > bestV) { bestV = v; bestC = c; }
    }
    return bestC;
  }

  Lobby.mount({
    bot: (level) => ({
      onMessage(o, reply) {
        if (o.t !== "s" || !o.s || o.s.win || o.s.turn !== 2) return;
        const c = botMove(o.s, level);
        if (c != null) setTimeout(() => reply({ t: "drop", c }), 500 + Math.random() * 400);
      },
    }),
    game: "connect",
    title: "Connect 4",
    subtitle: "Drop discs, get four in a row. Horizontal, vertical or diagonal.",
    onStart(l) {
      link = l;
      me = l.isHost ? 1 : 2;
      $("name0").textContent = l.spectator ? l.myName : "You";
      $("name1").textContent = l.oppName;
      V = null; pending = false;
      if (l.isHost) l.onRejoin(() => l.send({ t: "s", s: S }));
      $("sw0").style.background = PIECE_COLOR[me];
      $("sw1").style.background = PIECE_COLOR[3 - me];
      l.onData((d) => {
        if (l.isHost) {
          if (d.t === "drop" && drop(S, 2, d.c | 0)) publish();
          else if (d.t === "drop") l.send({ t: "s", s: S }); // rejected: resync so they can retry
          else if (d.t === "rm" && S.win) nextRound();
        } else if (d.t === "s") show(d.s);
      });
      if (l.isHost) { S = newState(Math.random() < 0.5 ? 1 : 2); publish(); }
      if (!l.spectator) GameUtil.toast(l.isHost ? "Connected. You're orange." : "Connected. You're yellow.");
      return () => {
        link = null; S = null; V = null;
        resultEl.hidden = true;
        for (const s of slots) s.textContent = "";
        $("s0").textContent = "0"; $("s1").textContent = "0";
        $("bannerText").textContent = "Waiting…";
        boardEl.classList.remove("live");
      };
    },
  });
})();
