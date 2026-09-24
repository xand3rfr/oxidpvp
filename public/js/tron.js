// Light Cycles (Tron), 1v1. The host runs the grid simulation at a fixed tick and streams
// each tick's new head positions; the guest only sends turn inputs. Both sides build their
// view from the same message stream (the host applies its own messages locally).
(() => {
  const GW = 64, GH = 40, CELL = 20, W = GW * CELL, H = GH * CELL;
  const WIN = 5, COUNTDOWN = 3, ROUND_PAUSE = 2.2;
  const TICK_START = 82, TICK_MIN = 48, TICK_ACCEL_EVERY = 22; // ms, speeds up over a round
  const COLORS = ["#ff5b3a", "#4d8dff"];
  const LINE = "#ededf3", FLOOR = "#0a0a0f";
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  const SPAWN = [[8, GH / 2, 1], [GW - 9, GH / 2 - 1, 3]];

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  GameUtil.fitCanvas(canvas, W, H);
  const $ = (id) => document.getElementById(id);
  const resultEl = $("result"), rematchBtn = $("rematch");

  // ---------- Input ----------
  const KEYDIR = { KeyW: 0, ArrowUp: 0, KeyD: 1, ArrowRight: 1, KeyS: 2, ArrowDown: 2, KeyA: 3, ArrowLeft: 3 };
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || !(e.code in KEYDIR)) return;
    e.preventDefault();
    if (!e.repeat) turn(KEYDIR[e.code]);
  });
  let swipe = null;
  canvas.addEventListener("pointerdown", (e) => { swipe = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (Math.hypot(dx, dy) < 22) return;
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
    swipe = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", () => { swipe = null; });
  canvas.addEventListener("pointercancel", () => { swipe = null; });

  // ---------- Shared view state (built from messages) ----------
  let link = null, me = 0, stopLoop = null;
  let V = null;
  const blankView = () => ({
    trails: [[], []], dir: [1, 3], alive: [true, true], sc: [0, 0],
    phase: "idle", phaseEnds: 0, tickAt: 0, tickMs: TICK_START, rw: -1, w: -1, n: 0,
  });
  let particles = [], shake = 0, crashes = [];

  function apply(m) {
    if (m.t === "r") {
      V.trails = m.s.map(([x, y]) => [[x, y]]);
      V.dir = m.s.map((s) => s[2]);
      V.alive = [true, true];
      V.sc = m.sc; V.n = m.n; V.rw = -1; V.w = -1;
      V.phase = "count"; V.phaseEnds = performance.now() + m.c * 1000;
      V.tickMs = TICK_START;
      crashes = []; particles = [];
      updateHud();
    } else if (m.t === "k") {
      V.phase = "play";
      V.tickAt = performance.now(); V.tickMs = m.ms;
      for (const i of [0, 1]) {
        if (!V.alive[i]) continue;
        V.dir[i] = m.d[i];
        if (m.x[i]) {
          const [x, y] = m.h[i];
          V.alive[i] = false;
          const cx = (x + 0.5) * CELL, cy = (y + 0.5) * CELL;
          crashes.push({ x: cx, y: cy, i });
          burst(cx, cy, COLORS[i], 26);
          shake = 10;
        } else V.trails[i].push(m.h[i]);
      }
    } else if (m.t === "e") {
      V.phase = "over"; V.rw = m.rw; V.sc = m.sc; V.w = m.w;
      updateHud();
    }
  }

  function burst(x, y, color, n) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = 120 + Math.random() * 360;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5 + Math.random() * 0.4, color: k % 3 ? color : LINE, sz: 4 + Math.random() * 6 });
    }
  }

  // ---------- Host simulation ----------
  let S = null;
  function emit(m) { link.send(m); apply(m); }

  function startRound() {
    const occ = new Uint8Array(GW * GH);
    const p = SPAWN.map(([x, y, d]) => ({ x, y, d, alive: true }));
    for (const q of p) occ[q.y * GW + q.x] = 1;
    S.occ = occ; S.p = p; S.q = [[], []]; S.acc = 0; S.ticks = 0; S.over = false;
    S.n++;
    S.phase = "count"; S.timer = COUNTDOWN;
    emit({ t: "r", n: S.n, sc: S.sc, s: SPAWN, c: COUNTDOWN });
  }
  function queueTurn(i, d) {
    if (!S || !(d >= 0 && d <= 3)) return;
    const q = S.q[i];
    const last = q.length ? q[q.length - 1] : S.p[i].d;
    if (d === last || d === (last + 2) % 4 || q.length >= 3) return;
    q.push(d);
  }
  function tickMs() { return Math.max(TICK_MIN, TICK_START - Math.floor(S.ticks / TICK_ACCEL_EVERY) * 2); }

  function hostStep(dt) {
    if (S.phase === "count") {
      S.timer -= dt;
      if (S.timer <= 0) { S.phase = "play"; S.acc = tickMs(); }
      return;
    }
    if (S.phase === "pause") {
      S.timer -= dt;
      if (S.timer <= 0) startRound();
      return;
    }
    if (S.phase !== "play") return;
    S.acc += dt * 1000;
    let guard = 0;
    while (S.acc >= tickMs() && S.phase === "play" && guard++ < 4) {
      S.acc -= tickMs();
      simTick();
    }
  }

  function simTick() {
    S.ticks++;
    const next = S.p.map((p, i) => {
      if (S.q[i].length) p.d = S.q[i].shift();
      return [p.x + DX[p.d], p.y + DY[p.d]];
    });
    const dead = next.map(([x, y]) => x < 0 || y < 0 || x >= GW || y >= GH || S.occ[y * GW + x] === 1);
    if (next[0][0] === next[1][0] && next[0][1] === next[1][1]) dead[0] = dead[1] = true;
    for (const i of [0, 1]) {
      if (dead[i]) { S.p[i].alive = false; continue; }
      S.p[i].x = next[i][0]; S.p[i].y = next[i][1];
      S.occ[S.p[i].y * GW + S.p[i].x] = 1;
    }
    const clampCell = ([x, y]) => [Math.min(GW - 1, Math.max(0, x)), Math.min(GH - 1, Math.max(0, y))];
    emit({ t: "k", h: next.map(clampCell), d: S.p.map((p) => p.d), x: dead, ms: tickMs() });
    if (dead[0] || dead[1]) {
      const rw = dead[0] && dead[1] ? 2 : dead[0] ? 1 : 0;
      if (rw < 2) S.sc[rw]++;
      const w = S.sc[0] >= WIN ? 0 : S.sc[1] >= WIN ? 1 : -1;
      S.phase = w >= 0 ? "done" : "pause";
      S.timer = ROUND_PAUSE;
      emit({ t: "e", rw, sc: S.sc.slice(), w });
    }
  }

  function newMatch() {
    S = { sc: [0, 0], n: 0 };
    startRound();
  }

  function turn(d) {
    if (!link || !V) return;
    if (link.isHost) queueTurn(0, d);
    else link.send({ t: "d", d });
  }

  // ---------- Render ----------
  function render(dt) {
    const s = canvas._scale;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake = Math.max(0, shake - dt * 40);
    }
    ctx.fillStyle = FLOOR;
    ctx.fillRect(-20, -20, W + 40, H + 40);

    // graph-paper grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.035)";
    ctx.beginPath();
    for (let x = 1; x < GW; x++) { ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, H); }
    for (let y = 1; y < GH; y++) { ctx.moveTo(0, y * CELL + 0.5); ctx.lineTo(W, y * CELL + 0.5); }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.beginPath();
    for (let x = 8; x < GW; x += 8) { ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, H); }
    for (let y = 8; y < GH; y += 8) { ctx.moveTo(0, y * CELL); ctx.lineTo(W, y * CELL); }
    ctx.stroke();

    if (V && V.phase !== "idle") {
      const now = performance.now();
      const frac = V.phase === "play" ? Math.min(1, (now - V.tickAt) / V.tickMs) : 0;
      // outline pass, then color pass, so crossings read cleanly
      for (const pass of [0, 1]) {
        for (const i of [0, 1]) {
          const tr = V.trails[i];
          if (!tr.length) continue;
          ctx.lineCap = "round"; ctx.lineJoin = "round";
          ctx.lineWidth = pass ? 7 : 12;
          ctx.strokeStyle = COLORS[i];
          ctx.globalAlpha = pass ? 1 : 0.35;
          ctx.shadowColor = COLORS[i]; ctx.shadowBlur = pass ? 0 : 18;
          ctx.beginPath();
          ctx.moveTo((tr[0][0] + 0.5) * CELL, (tr[0][1] + 0.5) * CELL);
          for (const [x, y] of tr) ctx.lineTo((x + 0.5) * CELL, (y + 0.5) * CELL);
          const [hx, hy] = tr[tr.length - 1];
          let ex = (hx + 0.5) * CELL, ey = (hy + 0.5) * CELL;
          if (V.alive[i] && frac > 0) { ex += DX[V.dir[i]] * CELL * frac; ey += DY[V.dir[i]] * CELL * frac; }
          ctx.lineTo(ex, ey);
          ctx.stroke();
          ctx.globalAlpha = 1; ctx.shadowBlur = 0;
          if (pass && V.alive[i]) {
            ctx.shadowColor = COLORS[i]; ctx.shadowBlur = 24;
            ctx.fillStyle = "#fff";
            ctx.beginPath(); ctx.roundRect(ex - 8, ey - 8, 16, 16, 4); ctx.fill();
            ctx.shadowBlur = 0;
          }
        }
      }
      for (const c of crashes) {
        ctx.strokeStyle = LINE; ctx.lineWidth = 5; ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(c.x - 14, c.y - 14); ctx.lineTo(c.x + 14, c.y + 14);
        ctx.moveTo(c.x + 14, c.y - 14); ctx.lineTo(c.x - 14, c.y + 14);
        ctx.stroke();
      }

      if (V.phase === "count" && link) {
        const [x, y] = V.trails[me][0];
        label("YOU", (x + 0.5) * CELL, (y + 0.5) * CELL - 30, COLORS[me]);
        const left = Math.max(0, V.phaseEnds - now) / 1000;
        banner(left > 0 ? String(Math.ceil(left)) : "GO", 120);
      } else if (V.phase === "over" && link) {
        const txt = V.rw === 2 ? "DOUBLE CRASH" : V.rw === me ? "ROUND TO YOU" : "YOU CRASHED";
        banner(txt, 64);
      }
    }

    for (const p of particles) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.sz / 2, p.y - p.sz / 2, p.sz, p.sz);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, W, H);
  }
  function label(t, x, y, color) {
    ctx.font = "600 15px 'Geist Mono', ui-monospace, monospace";
    const w = ctx.measureText(t).width + 18;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(x - w / 2, y - 12, w, 24, 12); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(t, x, y + 1);
  }
  function banner(t, size) {
    ctx.font = `800 ${size}px Geist, system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(139,92,246,0.9)"; ctx.shadowBlur = 40;
    ctx.fillStyle = "#fff"; ctx.fillText(t, W / 2, H / 2);
    ctx.shadowBlur = 0;
  }

  // ---------- HUD ----------
  function updateHud() {
    if (!V) return;
    $("s0").textContent = V.sc[me];
    $("s1").textContent = V.sc[1 - me];
    if (V.w >= 0) {
      setTimeout(() => {
        if (!V || V.w < 0) return;
        const won = V.w === me;
        $("resultTitle").textContent = won ? "Victory" : "Defeat";
        $("resultScore").textContent = V.sc[me] + " – " + V.sc[1 - me];
        rematchBtn.disabled = false;
        rematchBtn.textContent = "Rematch";
        resultEl.hidden = false;
      }, 1200);
    } else resultEl.hidden = true;
  }
  rematchBtn.addEventListener("click", () => {
    if (!link) return;
    if (link.isHost) newMatch();
    else { link.send({ t: "rm" }); rematchBtn.disabled = true; rematchBtn.textContent = "Starting…"; }
  });

  // ---------- Loop ----------
  let last = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    if (S) hostStep(dt);
    for (const p of particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9; }
    particles = particles.filter((p) => p.life > 0);
    render(dt);
  }

  addEventListener("resize", () => { if (!link) render(0); });
  render(0);

  Lobby.mount({
    game: "tron",
    title: "Light Cycles",
    subtitle: "You leave a wall behind you. Make them hit it first. First to 5 rounds.",
    onStart(l) {
      link = l;
      me = l.isHost ? 0 : 1;
      $("name1").textContent = l.oppName;
      V = blankView();
      $("sw0").style.background = COLORS[me];
      $("sw1").style.background = COLORS[1 - me];
      l.onData((d) => {
        if (l.isHost) {
          if (d.t === "d") queueTurn(1, d.d | 0);
          else if (d.t === "rm" && S && S.phase === "done") newMatch();
        } else apply(d);
      });
      if (l.isHost) newMatch();
      last = performance.now();
      stopLoop = GameUtil.loop(frame);
      GameUtil.toast(l.isHost ? "Connected. You're orange, on the left." : "Connected. You're blue, on the right.");
      return () => {
        stopLoop();
        link = null; S = null; V = null;
        resultEl.hidden = true;
        $("s0").textContent = "0"; $("s1").textContent = "0";
        render(0);
      };
    },
  });
})();
