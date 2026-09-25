// Minesweeper Race, 1v1. Both players get the exact same board (built from a shared seed) and
// race to clear it. You can see how far your opponent has got. Clear your board first to win
// the round; hit a mine and the round goes to them. First to 3 rounds. The host referees.
(() => {
  const COLS = 16, ROWS = 14, MINES = 34, WIN = 3;
  const COLORS = ["#ff5b3a", "#4d8dff"];
  const NUM_COLORS = ["", "#60a5fa", "#4ade80", "#f87171", "#c084fc", "#fb923c", "#2dd4bf", "#f472b6", "#e5e7eb"];
  const $ = (id) => document.getElementById(id);
  const { h } = Party;

  function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const nbrs = (i) => { const r = Math.floor(i / COLS), c = i % COLS, out = []; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS) out.push(rr * COLS + cc); } return out; };
  function makeBoard(seed, start) {
    const R = rng(seed), mine = new Array(COLS * ROWS).fill(false), safe = new Set([start, ...nbrs(start)]);
    let placed = 0;
    while (placed < MINES) { const i = Math.floor(R() * mine.length); if (!mine[i] && !safe.has(i)) { mine[i] = true; placed++; } }
    const num = mine.map((m, i) => (m ? -1 : nbrs(i).filter((k) => mine[k]).length));
    return { mine, num };
  }
  const SAFE = COLS * ROWS - MINES;

  // ---------- local board ----------
  let boomAt = -1, B = null, open = null, flag = null, opened = 0, over = true, flagMode = false, round = 0, startAt = 0, n = 0;
  function reveal(i) {
    if (over || open[i] || flag[i]) return;
    if (B.mine[i]) { open[i] = true; over = true; boomAt = i; boom(i); return; }
    const stack = [i];
    while (stack.length) {
      const k = stack.pop();
      if (open[k] || flag[k]) continue;
      open[k] = true; opened++;
      if (B.num[k] === 0) for (const x of nbrs(k)) if (!open[x] && !B.mine[x]) stack.push(x);
    }
    GameUtil.sfx("click");
    progress();
    if (opened >= SAFE) { over = true; cleared(); }
  }
  function chord(i) {
    // Click an opened number whose flags are all placed to open the rest around it.
    if (!open[i] || B.num[i] <= 0) return;
    const ns = nbrs(i);
    if (ns.filter((k) => flag[k]).length !== B.num[i]) return;
    for (const k of ns) if (!open[k] && !flag[k]) reveal(k);
  }
  function toggleFlag(i) { if (over || open[i]) return; flag[i] = !flag[i]; GameUtil.sfx("pop"); render(); }

  function render() {
    const g = $("grid");
    if (g.childElementCount !== COLS * ROWS) {
      g.textContent = "";
      g.style.gridTemplateColumns = `repeat(${COLS}, 1fr)`;
      for (let i = 0; i < COLS * ROWS; i++) { const b = h("button", "ms-c"); b.type = "button"; b.dataset.i = i; g.append(b); }
    }
    [...g.children].forEach((b, i) => {
      const o = open && open[i];
      b.className = "ms-c" + (o ? " o" : "") + (o && B.mine[i] ? (i === boomAt ? " boom" : " mine") : "") + (flag && flag[i] ? " f" : "") + ((i % 2) ^ (Math.floor(i / COLS) % 2) ? " alt" : "");
      b.textContent = o ? (B.mine[i] ? "💣" : B.num[i] || "") : flag && flag[i] ? "🚩" : "";
      b.style.color = o && B.num[i] > 0 ? NUM_COLORS[B.num[i]] : "";
    });
    $("flagBtn").classList.toggle("on", flagMode);
    $("flagBtn").textContent = flagMode ? "🚩 Flag mode ON" : "🚩 Flag mode";
    $("minesLeft").textContent = flag ? `💣 ${MINES - flag.filter(Boolean).length}` : "";
  }
  const grid = $("grid");
  let pressT = 0, longFired = false;
  grid.addEventListener("contextmenu", (e) => { e.preventDefault(); const c = e.target.closest(".ms-c"); if (c && link && !link.spectator) toggleFlag(+c.dataset.i); });
  grid.addEventListener("pointerdown", (e) => {
    const c = e.target.closest(".ms-c");
    if (!c || e.button !== 0 || !link || link.spectator) return;
    longFired = false;
    clearTimeout(pressT);
    pressT = setTimeout(() => { longFired = true; toggleFlag(+c.dataset.i); if (navigator.vibrate) navigator.vibrate(20); }, 380); // long-press flags on touch
  });
  grid.addEventListener("pointerup", () => clearTimeout(pressT));
  grid.addEventListener("pointerleave", () => clearTimeout(pressT));
  grid.addEventListener("click", (e) => {
    const c = e.target.closest(".ms-c");
    if (!c || longFired || !link || link.spectator || over) return;
    const i = +c.dataset.i;
    if (open[i]) chord(i); else if (flagMode) toggleFlag(i); else reveal(i);
    render();
  });
  $("flagBtn").addEventListener("click", () => { flagMode = !flagMode; render(); });

  // ---------- networking ----------
  let link = null, me = 0, S = null, lastProg = 0;
  const pct = () => Math.round((opened / SAFE) * 100);
  function progress() {
    const now = performance.now();
    if (now - lastProg < 150 && opened < SAFE) return;
    lastProg = now;
    const m = { t: "p", side: me, v: pct(), n };
    if (link.isHost) { link.send(m); showProg(m); } else link.send(m);
    showProg(m);
  }
  function showProg(m) {
    const bar = $(m.side === me ? "barMe" : "barThem");
    if (link.spectator) { $(m.side === 0 ? "barMe" : "barThem").style.width = m.v + "%"; return; }
    bar.style.width = m.v + "%";
  }
  function boom() { GameUtil.sfx("boom"); render(); if (link.isHost) hostEnd(1 - me, "boom", 0); else link.send({ t: "boom", n }); }
  function cleared() { GameUtil.sfx("good"); render(); const ms = Math.round(performance.now() - startAt); if (link.isHost) hostEnd(me, "clear", ms); else link.send({ t: "clear", n, ms }); }

  // host
  function hostRound() {
    S.n++; S.round++;
    const m = { t: "r", seed: Math.floor(Math.random() * 2 ** 31), start: Math.floor(ROWS / 2) * COLS + Math.floor(COLS / 2), n: S.n, round: S.round, sc: S.sc };
    S.live = true;
    S.lastR = m;
    link.send(m);
    startLocal(m);
  }
  function hostEnd(winner, why, ms) {
    if (!S || !S.live) return;
    S.live = false;
    S.sc[winner]++;
    const end = S.sc[winner] >= WIN;
    const m = { t: "res", w: winner, why, ms, sc: S.sc.slice(), end, n: S.n };
    link.send(m);
    onResult(m);
    if (!end) setTimeout(() => S && hostRound(), 3500);
  }
  function startLocal(m) {
    n = m.n; round = m.round;
    B = makeBoard(m.seed, m.start);
    boomAt = -1;
    open = new Array(COLS * ROWS).fill(false); flag = new Array(COLS * ROWS).fill(false);
    opened = 0; over = !!link.spectator; flagMode = false;
    $("barMe").style.width = "0%"; $("barThem").style.width = "0%";
    $("banner").textContent = link.spectator ? `Round ${round}: watching the race` : `Round ${round}: clear the board!`;
    $("result").hidden = true;
    render();
    if (!link.spectator) reveal(m.start); // same opening square for both players
    render();
    startAt = performance.now();
    updateScore(m.sc);
    GameUtil.sfx("start");
  }
  function updateScore(sc) { $("s0").textContent = sc[me]; $("s1").textContent = sc[1 - me]; }
  function onResult(m) {
    over = true;
    updateScore(m.sc);
    // Show where the mines were.
    if (B && !link.spectator) { B.mine.forEach((x, i) => { if (x && !flag[i]) open[i] = true; }); render(); }
    const iWon = m.w === me;
    const nm = link.spectator ? link.names[m.w] : iWon ? "You" : link.oppName;
    $("banner").textContent = m.why === "boom" ? `${link.spectator ? link.names[1 - m.w] : m.w === me ? link.oppName : "You"} hit a mine! ${nm} take${nm === "You" ? "" : "s"} the round` : `${nm} cleared the board${m.ms ? ` in ${(m.ms / 1000).toFixed(1)}s` : ""}!`;
    if (!link.spectator) GameUtil.sfx(iWon ? "good" : "bad");
    if (m.end) {
      setTimeout(() => {
        if (!link) return;
        if (!link.spectator) { GameUtil.sfx(iWon ? "win" : "lose"); GameUtil.record("mines", iWon ? "win" : "loss"); }
        $("resultTitle").textContent = link.spectator ? `${link.names[m.w]} wins` : iWon ? "You win!" : "You lose";
        $("resultScore").textContent = `${m.sc[me]} – ${m.sc[1 - me]}`;
        $("rematch").hidden = !!link.spectator; $("rematch").disabled = false; $("rematch").textContent = "Rematch";
        $("result").hidden = false;
      }, 1500);
    }
  }
  $("rematch").addEventListener("click", () => {
    if (!link) return;
    if (link.isHost) { S = { sc: [0, 0], n: S ? S.n : 0, round: 0, live: false }; hostRound(); }
    else { link.send({ t: "rm" }); $("rematch").disabled = true; $("rematch").textContent = "Waiting for host…"; }
  });
  $("peek").addEventListener("click", () => { $("result").hidden = true; });

  Lobby.mount({
    game: "mines",
    title: "Minesweeper Race",
    subtitle: "Same board, two players, one winner. Clear it first without hitting a mine. First to 3 rounds.",
    onStart(l) {
      link = l;
      me = l.isHost ? 0 : 1;
      $("name0").textContent = l.spectator ? l.myName : "You";
      $("name1").textContent = l.oppName;
      $("sw0").style.background = COLORS[me]; $("sw1").style.background = COLORS[1 - me];
      $("barMe").style.background = COLORS[me]; $("barThem").style.background = COLORS[1 - me];
      $("labelThem").textContent = l.spectator ? l.names[1] : l.oppName;
      $("labelMe").textContent = l.spectator ? l.names[0] : "You";
      if (l.isHost) {
        S = { sc: [0, 0], n: 0, round: 0, live: false };
        l.onData((d) => {
          if (!S) return;
          if (d.t === "p" && d.n === S.n) { link.send({ ...d, side: 1 }); showProg({ ...d, side: 1 }); }
          else if (d.t === "boom" && d.n === S.n) hostEnd(0, "boom", 0);
          else if (d.t === "clear" && d.n === S.n) hostEnd(1, "clear", d.ms | 0);
          else if (d.t === "rm" && !S.live) { S = { sc: [0, 0], n: S.n, round: 0, live: false }; hostRound(); }
        });
        // Late spectators (and a guest who reloaded) catch up on the current round.
        l.onRejoin(() => { if (S && S.lastR) link.send({ t: "sync", r: { ...S.lastR, sc: S.sc.slice() }, live: S.live }); });
        setTimeout(() => S && hostRound(), 600);
      } else l.onData((d) => {
        if (d.t === "r") startLocal(d);
        else if (d.t === "sync" && (link.spectator || d.r.n !== n)) { startLocal(d.r); if (!d.live) over = true; }
        else if (d.t === "p" && d.n === n) showProg(d);
        else if (d.t === "res" && d.n === n) onResult(d);
      });
      return () => { link = null; S = null; B = null; $("result").hidden = true; };
    },
  });
})();
