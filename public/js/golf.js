// Mini Golf, 1v1 over 6 holes. Take turns: drag back from anywhere to aim (like a slingshot)
// and let go to putt. Balls bounce off walls; get it in the cup in as few strokes as you can.
// Max 8 strokes a hole. Lowest total wins. The host runs the ball physics and streams it.
(() => {
  const W = 1000, H = 600, BR = 9, CUP = 15, MAX_SPEED = 1250, MAX_STROKES = 8, E = 0.72;
  const COLORS = ["#ff5b3a", "#4d8dff"];
  const $ = (id) => document.getElementById(id);
  const canvas = $("c"), ctx = canvas.getContext("2d");
  const refit = GameUtil.fitCanvas(canvas, W, H);
  let cardH = 0;

  const rect = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  const sq = (cx, cy, s) => rect(cx - s, cy - s, cx + s, cy + s);
  const HOLES = [
    { par: 2, area: rect(60, 180, 940, 420), blocks: [], tee: [140, 300], cup: [860, 300] },
    { par: 3, area: [[60, 60], [560, 60], [560, 420], [940, 420], [940, 560], [420, 560], [420, 200], [60, 200]], blocks: [], tee: [130, 130], cup: [870, 490] },
    { par: 2, area: rect(60, 100, 940, 500), blocks: [rect(440, 200, 560, 400)], tee: [120, 300], cup: [880, 300] },
    { par: 3, area: rect(60, 60, 940, 540), blocks: [rect(330, 60, 350, 400), rect(650, 200, 670, 540)], tee: [150, 470], cup: [850, 130] },
    { par: 3, area: rect(60, 100, 940, 500), blocks: [sq(300, 220, 22), sq(300, 380, 22), sq(500, 300, 22), sq(700, 220, 22), sq(700, 380, 22)], tee: [110, 300], cup: [890, 300] },
    { par: 3, area: rect(60, 60, 940, 540), blocks: [rect(60, 290, 760, 310)], tee: [130, 175], cup: [130, 425] },
  ];
  const segs = (hole) => {
    const out = [];
    for (const poly of [hole.area, ...hole.blocks]) poly.forEach((p, i) => out.push([p, poly[(i + 1) % poly.length]]));
    return out;
  };

  // =====================================================================
  // Host simulation
  // =====================================================================
  let link = null, me = 0, stopLoop = null, S = null, V = null, walls = [], balls = null, particles = [];
  function newState(first) {
    return { hole: 0, turn: first, first, moving: false, phase: "play", over: null, cards: [[], []], ...ballsFor(0), n: (S ? S.n : 0) + 1 };
  }
  function ballsFor(i) {
    const [x, y] = HOLES[i].tee;
    return { b: [0, 1].map((k) => ({ x: x + (k ? 0 : 0), y: y + (k ? 14 : -14), vx: 0, vy: 0, done: false, strokes: 0 })) };
  }
  const publishState = () => { const m = { t: "st", S: JSON.parse(JSON.stringify(S)) }; link.send(m); onState(m.S); };

  function shoot(side, a, p) {
    if (!S || S.phase !== "play" || S.moving || S.turn !== side) return;
    const ball = S.b[side];
    if (ball.done) return;
    p = Math.max(0, Math.min(1, +p || 0));
    if (p < 0.03 || !isFinite(+a)) return;
    ball.vx = Math.cos(a) * p * MAX_SPEED; ball.vy = Math.sin(a) * p * MAX_SPEED;
    ball.strokes++;
    S.moving = true;
    publishState();
  }
  let sendAcc = 0;
  function simulate(dt) {
    if (!S || !S.moving) return;
    const ball = S.b[S.turn], hole = HOLES[S.hole];
    const steps = Math.max(1, Math.ceil(dt * 300)), h = dt / steps;
    for (let s = 0; s < steps; s++) {
      ball.x += ball.vx * h; ball.y += ball.vy * h;
      for (const [[x1, y1], [x2, y2]] of walls) {
        const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, ((ball.x - x1) * dx + (ball.y - y1) * dy) / len2));
        const px = x1 + t * dx, py = y1 + t * dy, ox = ball.x - px, oy = ball.y - py, d = Math.hypot(ox, oy);
        if (d < BR && d > 0) {
          const nx = ox / d, ny = oy / d;
          ball.x = px + nx * BR; ball.y = py + ny * BR;
          const dot = ball.vx * nx + ball.vy * ny;
          if (dot < 0) { ball.vx -= (1 + E) * dot * nx; ball.vy -= (1 + E) * dot * ny; }
        }
      }
      const sp = Math.hypot(ball.vx, ball.vy);
      const cd = Math.hypot(ball.x - hole.cup[0], ball.y - hole.cup[1]);
      if (cd < CUP - 2 && sp < 700) { ball.x = hole.cup[0]; ball.y = hole.cup[1]; ball.vx = ball.vy = 0; ball.done = true; break; }
      if (cd < CUP * 2.2 && sp < 700) { ball.vx += (hole.cup[0] - ball.x) * 3 * h; ball.vy += (hole.cup[1] - ball.y) * 3 * h; } // gentle pull near the cup
    }
    // rolling friction
    const sp = Math.hypot(ball.vx, ball.vy);
    const ns = Math.max(0, sp * Math.exp(-0.9 * dt) - 70 * dt);
    if (sp > 0) { ball.vx *= ns / sp; ball.vy *= ns / sp; }
    sendAcc += dt;
    if (sendAcc > 1 / 30) { sendAcc = 0; link.send({ t: "b", b: S.b.map((q) => [Math.round(q.x), Math.round(q.y)]) }); }
    if (ball.done || ns < 6) {
      ball.vx = ball.vy = 0;
      S.moving = false;
      if (!ball.done && ball.strokes >= MAX_STROKES) ball.done = true; // give up at the stroke limit
      afterShot();
    }
  }
  function afterShot() {
    const other = 1 - S.turn;
    if (S.b.every((q) => q.done)) {
      S.cards[0].push(S.b[0].strokes); S.cards[1].push(S.b[1].strokes);
      S.phase = "holeEnd";
      publishState();
      setTimeout(nextHole, 2600);
      return;
    }
    if (!S.b[other].done) S.turn = other;
    publishState();
  }
  function nextHole() {
    if (!S || S.phase !== "holeEnd") return;
    if (S.hole + 1 >= HOLES.length) {
      const tot = S.cards.map((c) => c.reduce((a, b) => a + b, 0));
      S.phase = "end";
      S.over = { winner: tot[0] === tot[1] ? -1 : tot[0] < tot[1] ? 0 : 1, tot };
      return publishState();
    }
    S.hole++;
    Object.assign(S, ballsFor(S.hole));
    // Whoever did better on the last hole tees off first.
    const last = S.cards.map((c) => c[c.length - 1]);
    S.turn = last[0] === last[1] ? 1 - S.turn : last[0] < last[1] ? 0 : 1;
    S.phase = "play";
    publishState();
  }

  // =====================================================================
  // UI
  // =====================================================================
  let aim = null;
  const toTable = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
  const myTurn = () => V && link && !link.spectator && V.phase === "play" && !V.moving && V.turn === me && !V.b[me].done;
  canvas.addEventListener("pointerdown", (e) => { if (!myTurn()) return; canvas.setPointerCapture(e.pointerId); aim = { start: toTable(e), cur: toTable(e) }; });
  canvas.addEventListener("pointermove", (e) => { if (aim) aim.cur = toTable(e); });
  canvas.addEventListener("pointerup", () => {
    if (!aim) return;
    const { a, p } = aimVec();
    aim = null;
    if (p < 0.03) return;
    GameUtil.sfx("click");
    if (link.isHost) shoot(0, a, p); else link.send({ t: "shot", a, p });
  });
  function aimVec() {
    // Pull back like a slingshot: the ball goes the opposite way you drag.
    const dx = aim.start.x - aim.cur.x, dy = aim.start.y - aim.cur.y;
    return { a: Math.atan2(dy, dx), p: Math.min(1, Math.hypot(dx, dy) / 220) };
  }

  function onState(s) {
    const prev = V;
    V = s;
    walls = segs(HOLES[s.hole]);
    balls = s.b.map((q) => ({ x: q.x, y: q.y, tx: q.x, ty: q.y }));
    if (prev && prev.n === s.n) {
      if (s.b.some((q, i) => q.done && !prev.b[i].done && Math.hypot(q.x - HOLES[s.hole].cup[0], q.y - HOLES[s.hole].cup[1]) < 1)) GameUtil.sfx("good");
      const mine = s.b[me];
      if (!link.spectator && mine.done && !prev.b[me].done && mine.strokes === 1 && Math.hypot(mine.x - HOLES[s.hole].cup[0], mine.y - HOLES[s.hole].cup[1]) < 1) { GameUtil.toast("⛳ Hole in one!"); GameUtil.achieve("ace"); }
      if (!s.moving && prev.moving === false && s.turn === me && prev.turn !== me && s.phase === "play") GameUtil.sfx("turn");
      if (s.moving && !prev.moving) GameUtil.sfx("pop");
    }
    hud();
    if (s.phase === "end" && (!prev || prev.phase !== "end" || prev.n !== s.n)) {
      const r = s.over.winner, spec = link.spectator;
      if (!spec) { GameUtil.sfx(r < 0 ? "pop" : r === me ? "win" : "lose"); GameUtil.record("golf", r < 0 ? "draw" : r === me ? "win" : "loss"); }
      setTimeout(() => {
        $("resultTitle").textContent = r < 0 ? "Tied!" : spec ? `${link.names[r]} wins` : r === me ? "You win" : "You lose";
        $("resultScore").textContent = `${s.over.tot[me]} – ${s.over.tot[1 - me]} strokes`;
        $("rematch").hidden = spec; $("rematch").disabled = false; $("rematch").textContent = "Rematch";
        $("result").hidden = false;
      }, 800);
    } else if (s.phase !== "end") $("result").hidden = true;
  }
  function hud() {
    const s = V, hole = HOLES[s.hole];
    const tot = (i) => s.cards[i].reduce((a, b) => a + b, 0) + (s.phase === "play" ? s.b[i].strokes : 0);
    $("s0").textContent = tot(me); $("s1").textContent = tot(1 - me);
    const who = s.phase !== "play" ? "" : link.spectator ? `${link.names[s.turn]}'s shot` : s.turn === me ? (s.moving ? "Rolling…" : "Your shot · drag back and let go") : "Their shot";
    $("hud").textContent = `Hole ${s.hole + 1} of ${HOLES.length} · par ${hole.par}` + (who ? ` · ${who}` : "") + (s.phase === "holeEnd" ? " · hole done!" : "");
    const card = $("card");
    card.textContent = "";
    const row = (label, cells, cls = "") => { const tr = document.createElement("tr"); tr.className = cls; const th = document.createElement("th"); th.textContent = label; tr.append(th); for (const c of cells) { const td = document.createElement("td"); td.textContent = c; tr.append(td); } card.append(tr); };
    row("Hole", [...HOLES.map((_, i) => i + 1), "Tot"], "head");
    row("Par", [...HOLES.map((h) => h.par), HOLES.reduce((a, h) => a + h.par, 0)], "par");
    for (const i of [me, 1 - me]) row(link.spectator ? link.names[i] : i === me ? "You" : link.names[i], [...HOLES.map((_, k) => (s.cards[i][k] ?? (k === s.hole && s.phase === "play" ? (s.b[i].strokes || "·") : ""))), tot(i)], "p" + i);
    // The scorecard takes room from the stage, so refit the canvas when its height changes.
    if (card.offsetHeight !== cardH) { cardH = card.offsetHeight; refit(); }
  }

  function render(dt) {
    const sc = canvas._scale;
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    ctx.fillStyle = "#07120c"; ctx.fillRect(0, 0, W, H);
    if (!V) return;
    const hole = HOLES[V.hole];
    const path = (poly) => { ctx.beginPath(); poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
    // green
    path(hole.area);
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#1f7a3f"); g.addColorStop(1, "#15602f");
    ctx.fillStyle = g; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    for (let x = 0; x < W; x += 40) ctx.fillRect(x, 0, 20, H);
    ctx.restore();
    ctx.lineWidth = 10; ctx.strokeStyle = "#8b5a2b"; ctx.lineJoin = "round"; path(hole.area); ctx.stroke();
    for (const b of hole.blocks) { path(b); ctx.fillStyle = "#8b5a2b"; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = "#5c3a1a"; ctx.stroke(); }
    // tee + cup
    ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(hole.tee[0] - 22, hole.tee[1] - 30, 44, 60);
    ctx.fillStyle = "#050806"; ctx.beginPath(); ctx.arc(hole.cup[0], hole.cup[1], CUP, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(hole.cup[0], hole.cup[1]); ctx.lineTo(hole.cup[0], hole.cup[1] - 60); ctx.stroke();
    ctx.fillStyle = "#facc15"; ctx.beginPath(); ctx.moveTo(hole.cup[0], hole.cup[1] - 60); ctx.lineTo(hole.cup[0] + 28, hole.cup[1] - 50); ctx.lineTo(hole.cup[0], hole.cup[1] - 40); ctx.fill();
    // balls
    if (balls) balls.forEach((q, i) => {
      const k = 1 - Math.exp(-dt * 25);
      q.x += (q.tx - q.x) * k; q.y += (q.ty - q.y) * k;
      if (V.b[i].done && Math.hypot(q.x - hole.cup[0], q.y - hole.cup[1]) < 2) return;
      ctx.globalAlpha = V.turn === i || V.phase !== "play" ? 1 : 0.55;
      ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.beginPath(); ctx.arc(q.x + 2, q.y + 3, BR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(q.x, q.y, BR, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = COLORS[i]; ctx.lineWidth = 4; ctx.stroke();
      ctx.globalAlpha = 1;
    });
    // aim
    if (aim && balls) {
      const { a, p } = aimVec(), q = balls[me];
      ctx.setLineDash([6, 8]); ctx.lineWidth = 3; ctx.strokeStyle = `rgba(255,255,255,${0.4 + p * 0.5})`;
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + Math.cos(a) * (40 + p * 220), q.y + Math.sin(a) * (40 + p * 220)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(20, H - 34, 200, 14);
      ctx.fillStyle = p > 0.8 ? "#f43f5e" : p > 0.5 ? "#facc15" : "#22c55e"; ctx.fillRect(20, H - 34, 200 * p, 14);
    }
    for (const q of particles) { ctx.globalAlpha = Math.max(0, q.life * 2); ctx.fillStyle = q.color; ctx.fillRect(q.x - 2, q.y - 2, 4, 4); }
    ctx.globalAlpha = 1;
  }

  let last = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    if (link && link.isHost) {
      simulate(dt);
      if (S && balls) S.b.forEach((q, i) => { balls[i].tx = q.x; balls[i].ty = q.y; });
    }
    render(dt);
  }

  $("rematch").addEventListener("click", () => {
    if (!link) return;
    if (link.isHost) { S = newState(1 - S.first); publishState(); }
    else { link.send({ t: "rm" }); $("rematch").disabled = true; $("rematch").textContent = "Waiting for host…"; }
  });
  $("peek").addEventListener("click", () => { $("result").hidden = true; });

  Lobby.mount({
    game: "golf",
    title: "Mini Golf",
    subtitle: "Six holes of putt-putt. Drag back and let go to shoot. Fewest strokes wins.",
    onStart(l) {
      link = l;
      me = l.isHost ? 0 : 1;
      $("name0").textContent = l.spectator ? l.myName : "You";
      $("name1").textContent = l.oppName;
      $("sw0").style.background = COLORS[me]; $("sw1").style.background = COLORS[1 - me];
      V = null; S = null; balls = null;
      if (l.isHost) {
        l.onData((d) => {
          if (d.t === "shot") shoot(1, +d.a, +d.p);
          else if (d.t === "rm" && S && S.phase === "end") { S = newState(1 - S.first); publishState(); }
        });
        l.onRejoin(() => link.send({ t: "st", S }));
        S = newState(0);
        publishState();
      } else l.onData((d) => {
        if (d.t === "st") onState(d.S);
        else if (d.t === "b" && balls) d.b.forEach(([x, y], i) => { balls[i].tx = x; balls[i].ty = y; });
      });
      last = performance.now();
      stopLoop = GameUtil.loop(frame);
      return () => { stopLoop(); link = null; S = null; V = null; $("result").hidden = true; };
    },
  });
})();
