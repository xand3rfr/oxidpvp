// 1v1 top-down arena shooter.
// Each peer moves its own player locally (instant controls) and streams its position.
// The host owns bullets, damage, kills, respawns and score, and broadcasts snapshots.
(() => {
  const W = 1280, H = 720;
  const R = 17, SPEED = 280, DASH_SPEED = 900, DASH_TIME = 0.13, DASH_CD = 1.3;
  const FIRE_CD = 0.19, B_SPEED = 900, B_LIFE = 1.2, B_R = 4, DMG = 25, RESPAWN = 1.6, WIN = 5;
  const SNAP_RATE = 1 / 30;
  const COLORS = ["#ff5a36", "#4da3ff"];
  const START = [[110, H / 2], [W - 110, H / 2]];
  const SPAWNS = [[90, 90], [90, H - 90], [W - 90, 90], [W - 90, H - 90], [110, H / 2], [W - 110, H / 2]];

  // Point-symmetric layout so neither side has an advantage.
  const half = [
    { x: 250, y: 110, w: 36, h: 170 },
    { x: 250, y: H - 280, w: 36, h: 170 },
    { x: 450, y: 200, w: 70, h: 36 },
    { x: 450, y: H - 236, w: 70, h: 36 },
    { x: W / 2 - 18, y: 70, w: 36, h: 120 },
  ];
  const WALLS = [
    ...half,
    ...half.map((w) => ({ x: W - w.x - w.w, y: H - w.y - w.h, w: w.w, h: w.h })),
    { x: W / 2 - 100, y: H / 2 - 18, w: 200, h: 36 },
  ];

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  GameUtil.fitCanvas(canvas, W, H);

  const $ = (id) => document.getElementById(id);
  const resultEl = $("result"), rematchBtn = $("rematch");

  // ---------- Input ----------
  const keys = {};
  const mouse = { x: W / 2, y: H / 2, down: false };
  let dashQueued = false;
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    keys[e.code] = true;
    if (e.code === "Space" || e.code === "ShiftLeft" || e.code === "ShiftRight") { dashQueued = true; e.preventDefault(); }
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  addEventListener("blur", () => { for (const k in keys) keys[k] = false; mouse.down = false; });
  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - r.left) / r.width) * W;
    mouse.y = ((e.clientY - r.top) / r.height) * H;
  };
  addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.target === canvas) toWorld(e); });
  canvas.addEventListener("pointerdown", (e) => { if (e.button === 0) { toWorld(e); mouse.down = true; } });
  addEventListener("pointerup", () => { mouse.down = false; });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // Touch: left stick moves, right stick aims and fires while held, button dashes.
  const tstick = { mx: 0, my: 0, ax: 0, ay: 0, aim: false };
  GameUtil.touchControls({
    sticks: [
      { side: "left", label: "Move", onMove: (x, y) => { tstick.mx = x; tstick.my = y; } },
      { side: "right", label: "Aim + fire", onMove: (x, y, on) => { tstick.ax = x; tstick.ay = y; tstick.aim = on && Math.hypot(x, y) > 0.25; } },
    ],
    buttons: [{ side: "right", label: "Dash", onDown: () => { dashQueued = true; } }],
  });

  // ---------- Helpers ----------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const angLerp = (a, b, t) => a + (((((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * t;

  function collide(p) {
    p.x = clamp(p.x, R, W - R);
    p.y = clamp(p.y, R, H - R);
    for (const w of WALLS) {
      const cx = clamp(p.x, w.x, w.x + w.w), cy = clamp(p.y, w.y, w.y + w.h);
      const dx = p.x - cx, dy = p.y - cy, d2 = dx * dx + dy * dy;
      if (d2 >= R * R) continue;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * R;
        p.y = cy + (dy / d) * R;
      } else {
        const l = p.x - w.x, r = w.x + w.w - p.x, t = p.y - w.y, b = w.y + w.h - p.y, m = Math.min(l, r, t, b);
        if (m === l) p.x = w.x - R; else if (m === r) p.x = w.x + w.w + R; else if (m === t) p.y = w.y - R; else p.y = w.y + w.h + R;
      }
    }
  }
  const inWall = (x, y) =>
    x < 0 || y < 0 || x > W || y > H ||
    WALLS.some((w) => x > w.x - B_R && x < w.x + w.w + B_R && y > w.y - B_R && y < w.y + w.h + B_R);

  // ---------- Session state ----------
  let link = null, stopLoop = null, running = false;
  let myIdx = 0, oppIdx = 1;
  let me = null;                 // locally simulated body
  let S = null;                  // host: authoritative state
  let snap = null, snapAt = 0;   // guest: latest snapshot
  let guestIn = null, pendingFire = [], outEvents = [], snapAcc = 0;
  let localBullets = [], particles = [], shake = 0;
  let lastSeq = -1, oppSeq = -1, lastPosSend = 0;
  const oppDisp = { x: 0, y: 0, a: 0 };

  const mkP = (i) => ({ x: START[i][0], y: START[i][1], a: i ? Math.PI : 0, hp: 100, alive: true, rt: 0, seq: 0, dash: false });
  const newState = () => ({ p: [mkP(0), mkP(1)], b: [], sc: [0, 0], win: -1 });
  const resetMe = (x, y) => { me = { x, y, a: myIdx ? Math.PI : 0, dashT: 0, dashCd: 0, ddx: 0, ddy: 0, fireCd: 0 }; };

  // Unified read access for host & guest
  function playerView(i) {
    if (S) { const p = S.p[i]; return { x: p.x, y: p.y, a: p.a, hp: p.hp, alive: p.alive, seq: p.seq, dash: p.dash }; }
    if (snap) { const p = snap.p[i]; return { x: p[0], y: p[1], a: p[2], hp: p[3], alive: !!p[4], seq: p[5], dash: !!p[6] }; }
    return { x: START[i][0], y: START[i][1], a: i ? Math.PI : 0, hp: 100, alive: true, seq: -1, dash: false };
  }
  const scores = () => (S ? S.sc : snap ? snap.sc : [0, 0]);
  const winner = () => (S ? S.win : snap ? snap.w : -1);

  // ---------- Particles ----------
  function burst(x, y, color, n, speed, life = 0.5, size = 3) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life * (0.5 + Math.random() * 0.5), max: life, color, size: size * (0.6 + Math.random() * 0.8) });
    }
  }
  function applyEvent(e) {
    if (e.k === "h") {
      burst(e.x, e.y, COLORS[e.v], 10, 240);
      GameUtil.sfx("click");
      if (e.v === myIdx) shake = Math.max(shake, 6);
    } else if (e.k === "k") {
      burst(e.x, e.y, COLORS[e.v], 40, 420, 0.8, 4);
      burst(e.x, e.y, "#ffffff", 12, 200, 0.4, 2);
      GameUtil.sfx("boom");
      particles.push({ ring: true, x: e.x, y: e.y, life: 0.5, max: 0.5, color: COLORS[e.v] });
      if (e.v === myIdx) shake = 16; else shake = Math.max(shake, 5);
    } else if (e.k === "w") {
      if (!link.isHost && e.o === myIdx) return; // guest already simulated its own impacts
      burst(e.x, e.y, "#9aa0aa", 5, 140, 0.3, 2);
    }
  }

  // ---------- Local player ----------
  function fire(x, y, a) {
    burst(x, y, COLORS[myIdx], 3, 120, 0.15, 2);
    if (link.isHost) return spawnBullet(myIdx, x, y, a);
    link.send({ t: "f", x, y, a });
    localBullets.push({ x, y, vx: Math.cos(a) * B_SPEED, vy: Math.sin(a) * B_SPEED, life: B_LIFE });
  }

  function stepLocal(dt) {
    if (link && link.spectator) { // follow the guest's player from snapshots instead of our own input
      const v = playerView(myIdx), k = 1 - Math.exp(-dt * 20);
      if (Math.hypot(v.x - me.x, v.y - me.y) > 120) { me.x = v.x; me.y = v.y; }
      me.x += (v.x - me.x) * k; me.y += (v.y - me.y) * k; me.a = v.a; me.dashT = v.dash ? 0.05 : 0;
      return;
    }
    me.dashCd = Math.max(0, me.dashCd - dt);
    me.fireCd = Math.max(0, me.fireCd - dt);
    const view = playerView(myIdx);
    if (!view.alive || winner() >= 0) { dashQueued = false; me.dashT = 0; return; }

    let mx = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    let my = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
    if (!mx && !my && Math.hypot(tstick.mx, tstick.my) > 0.2) { mx = tstick.mx; my = tstick.my; }
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    if (tstick.aim) { mouse.x = me.x + tstick.ax * 140; mouse.y = me.y + tstick.ay * 140; }
    me.a = Math.atan2(mouse.y - me.y, mouse.x - me.x);

    if (dashQueued && me.dashCd <= 0) {
      me.ddx = len ? mx / len : Math.cos(me.a);
      me.ddy = len ? my / len : Math.sin(me.a);
      me.dashT = DASH_TIME;
      me.dashCd = DASH_CD;
      burst(me.x, me.y, COLORS[myIdx], 12, 180, 0.35);
    }
    dashQueued = false;

    if (me.dashT > 0) {
      me.dashT -= dt;
      me.x += me.ddx * DASH_SPEED * dt;
      me.y += me.ddy * DASH_SPEED * dt;
      if (Math.random() < 0.8) particles.push({ x: me.x, y: me.y, vx: 0, vy: 0, life: 0.25, max: 0.25, color: COLORS[myIdx], size: R * 0.8, ghost: true });
    } else {
      me.x += mx * SPEED * dt;
      me.y += my * SPEED * dt;
    }
    collide(me);

    if ((mouse.down || tstick.aim) && me.fireCd <= 0) {
      me.fireCd = FIRE_CD;
      fire(me.x + Math.cos(me.a) * (R + 8), me.y + Math.sin(me.a) * (R + 8), me.a);
    }
  }

  // ---------- Host simulation ----------
  function spawnBullet(o, x, y, a) {
    S.b.push({ x, y, vx: Math.cos(a) * B_SPEED, vy: Math.sin(a) * B_SPEED, life: B_LIFE, o });
  }
  function emit(e) { outEvents.push(e); applyEvent(e); }

  function hostTick(dt) {
    const mine = S.p[myIdx], opp = S.p[oppIdx];
    if (mine.alive) { mine.x = me.x; mine.y = me.y; mine.a = me.a; mine.dash = me.dashT > 0; }
    if (opp.alive && guestIn && guestIn.seq === opp.seq) {
      opp.x = clamp(guestIn.x, R, W - R); opp.y = clamp(guestIn.y, R, H - R); opp.a = guestIn.a; opp.dash = !!guestIn.d;
    }
    for (const f of pendingFire) if (opp.alive && S.win < 0) spawnBullet(oppIdx, f.x, f.y, f.a);
    pendingFire.length = 0;

    const steps = Math.max(1, Math.ceil(dt * 120)), h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (const b of S.b) {
        if (b.dead) continue;
        b.x += b.vx * h; b.y += b.vy * h; b.life -= h;
        if (b.life <= 0) { b.dead = true; continue; }
        if (inWall(b.x, b.y)) { b.dead = true; emit({ k: "w", x: Math.round(b.x), y: Math.round(b.y), o: b.o }); continue; }
        const t = S.p[1 - b.o];
        if (t.alive && Math.hypot(t.x - b.x, t.y - b.y) < R + B_R) {
          b.dead = true;
          t.hp -= DMG;
          if (t.hp <= 0) {
            t.hp = 0; t.alive = false; t.rt = RESPAWN;
            S.sc[b.o]++;
            emit({ k: "k", x: Math.round(t.x), y: Math.round(t.y), v: 1 - b.o });
            if (S.sc[b.o] >= WIN) { S.win = b.o; S.b.length = 0; }
          } else {
            emit({ k: "h", x: Math.round(b.x), y: Math.round(b.y), v: 1 - b.o });
          }
        }
      }
    }
    S.b = S.b.filter((b) => !b.dead);

    S.p.forEach((p, i) => {
      if (p.alive || S.win >= 0) return;
      p.rt -= dt;
      if (p.rt > 0) return;
      const other = S.p[1 - i];
      let best = SPAWNS[0], bestD = -1;
      for (const sp of SPAWNS) {
        const d = Math.hypot(sp[0] - other.x, sp[1] - other.y);
        if (d > bestD) { bestD = d; best = sp; }
      }
      Object.assign(p, { x: best[0], y: best[1], hp: 100, alive: true, seq: p.seq + 1 });
      if (i === myIdx) resetMe(p.x, p.y);
    });

    snapAcc += dt;
    if (snapAcc >= SNAP_RATE) {
      snapAcc = 0;
      link.send({
        t: "s",
        p: S.p.map((p) => [Math.round(p.x), Math.round(p.y), Math.round(p.a * 100) / 100, p.hp, p.alive ? 1 : 0, p.seq, p.dash ? 1 : 0]),
        b: S.b.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.o]),
        sc: S.sc, w: S.win, e: outEvents,
      });
      outEvents = [];
    }
  }

  function resetMatch() {
    const seqs = S.p.map((p) => p.seq + 1);
    S = newState();
    S.p.forEach((p, i) => (p.seq = seqs[i]));
    S.b = [];
    resetMe(START[myIdx][0], START[myIdx][1]);
    outEvents = [];
    snapAcc = SNAP_RATE; // push a snapshot right away
  }

  // ---------- Guest ----------
  function onSnapshot(d) {
    snap = d; snapAt = performance.now();
    for (const e of d.e) applyEvent(e);
    const mine = d.p[myIdx];
    if (mine[5] !== lastSeq) { lastSeq = mine[5]; resetMe(mine[0], mine[1]); localBullets = []; }
  }

  function stepLocalBullets(dt) {
    const opp = playerView(oppIdx);
    for (const b of localBullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (b.life <= 0) b.dead = true;
      else if (inWall(b.x, b.y)) { b.dead = true; burst(b.x, b.y, "#9aa0aa", 5, 140, 0.3, 2); }
      else if (opp.alive && Math.hypot(oppDisp.x - b.x, oppDisp.y - b.y) < R + B_R) b.dead = true;
    }
    localBullets = localBullets.filter((b) => !b.dead);
  }

  // ---------- Rendering ----------
  function drawArena() {
    ctx.fillStyle = "#0d0e11";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,0.028)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 40; x < W; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 40; y < H; y += 40) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    // spawn pads
    START.forEach((s, i) => {
      ctx.strokeStyle = COLORS[i] + "30";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s[0], s[1], 34, 0, Math.PI * 2); ctx.stroke();
    });
    for (const w of WALLS) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(w.x + 4, w.y + 6, w.w, w.h);
      ctx.fillStyle = "#1b1e25";
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = "#2c3039";
      ctx.lineWidth = 2;
      ctx.strokeRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fillRect(w.x + 2, w.y + 2, w.w - 4, 3);
    }
  }

  function drawBullet(x, y, vx, vy, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(x - vx * 0.022, y - vy * 0.022);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
  }

  function drawPlayer(x, y, a, i, hp, isMe) {
    const c = COLORS[i];
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath(); ctx.ellipse(x + 3, y + 7, R, R * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    // barrel
    ctx.save();
    ctx.translate(x, y); ctx.rotate(a);
    ctx.fillStyle = "#d9dbe0";
    ctx.fillRect(R - 6, -4, 16, 8);
    ctx.restore();
    // body
    ctx.fillStyle = c;
    ctx.shadowColor = c; ctx.shadowBlur = 18;
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath(); ctx.arc(x, y, R * 0.55, 0, Math.PI * 2); ctx.fill();
    if (isMe) {
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, R + 7, 0, Math.PI * 2); ctx.stroke();
      if (me.dashCd > 0) {
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, R + 7, -Math.PI / 2, -Math.PI / 2 + (1 - me.dashCd / DASH_CD) * Math.PI * 2);
        ctx.stroke();
      }
    }
    if (hp < 100) {
      const bw = 40;
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.fillRect(x - bw / 2, y - R - 16, bw, 4);
      ctx.fillStyle = hp > 25 ? "#ecedef" : "#ff4d5e";
      ctx.fillRect(x - bw / 2, y - R - 16, (bw * hp) / 100, 4);
    }
  }

  function render(dt) {
    const s = canvas._scale;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake = Math.max(0, shake - dt * 60);
    }
    drawArena();
    if (!link) return;

    // bullets
    if (S) {
      for (const b of S.b) drawBullet(b.x, b.y, b.vx, b.vy, COLORS[b.o]);
    } else {
      if (snap) {
        const el = Math.min(0.1, (performance.now() - snapAt) / 1000);
        for (const b of snap.b) {
          if (b[4] === myIdx && !link.spectator) continue;
          const x = b[0] + b[2] * el, y = b[1] + b[3] * el;
          if (!inWall(x, y)) drawBullet(x, y, b[2], b[3], COLORS[b[4]]);
        }
      }
      for (const b of localBullets) drawBullet(b.x, b.y, b.vx, b.vy, COLORS[myIdx]);
    }

    // particles (ghosts below players)
    for (const p of particles) {
      const t = p.life / p.max;
      if (p.ring) {
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = t;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, (1 - t) * 90 + 10, 0, Math.PI * 2); ctx.stroke();
      } else if (p.ghost) {
        ctx.globalAlpha = t * 0.25;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    const opp = playerView(oppIdx), mine = playerView(myIdx);
    if (opp.alive) drawPlayer(oppDisp.x, oppDisp.y, oppDisp.a, oppIdx, opp.hp, false);
    if (mine.alive) drawPlayer(me.x, me.y, me.a, myIdx, mine.hp, true);

    for (const p of particles) {
      if (p.ring || p.ghost) continue;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // crosshair
    if (mine.alive && winner() < 0) {
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, 8, 0, Math.PI * 2);
      ctx.moveTo(mouse.x - 13, mouse.y); ctx.lineTo(mouse.x - 4, mouse.y);
      ctx.moveTo(mouse.x + 4, mouse.y); ctx.lineTo(mouse.x + 13, mouse.y);
      ctx.moveTo(mouse.x, mouse.y - 13); ctx.lineTo(mouse.x, mouse.y - 4);
      ctx.moveTo(mouse.x, mouse.y + 4); ctx.lineTo(mouse.x, mouse.y + 13);
      ctx.stroke();
    }

    if (!mine.alive && winner() < 0) {
      ctx.fillStyle = "rgba(236,237,239,0.85)";
      ctx.font = "600 22px Geist, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Eliminated. Respawning…", W / 2, 60);
    }
  }

  // ---------- HUD ----------
  let hudKey = "";
  function updateHud() {
    const sc = scores(), w = winner();
    const key = sc[myIdx] + ":" + sc[oppIdx] + ":" + w;
    if (key === hudKey) return;
    hudKey = key;
    $("s0").textContent = sc[myIdx];
    $("s1").textContent = sc[oppIdx];
    if (w >= 0) {
      const won = w === myIdx, spec = link && link.spectator;
      if (link && !spec) { GameUtil.sfx(won ? "win" : "lose"); GameUtil.record("arena", won ? "win" : "loss"); }
      $("resultTitle").textContent = spec ? `${(w === 0 ? link.names[0] : link.names[1])} wins` : won ? "Victory" : "Defeat";
      rematchBtn.hidden = !!spec;
      $("resultTitle").style.color = won ? COLORS[myIdx] : "#ecedef";
      $("resultScore").textContent = sc[myIdx] + " – " + sc[oppIdx];
      rematchBtn.disabled = false;
      rematchBtn.textContent = "Rematch";
      resultEl.hidden = false;
    } else {
      resultEl.hidden = true;
    }
  }
  rematchBtn.addEventListener("click", () => {
    if (!link) return;
    if (link.isHost) resetMatch();
    else { link.send({ t: "rm" }); rematchBtn.disabled = true; rematchBtn.textContent = "Starting…"; }
  });

  // ---------- Loop ----------
  let last = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;

    stepLocal(dt);
    if (S) hostTick(dt);
    else {
      stepLocalBullets(dt);
      if (now - lastPosSend >= 33) {
        lastPosSend = now;
        link.send({ t: "p", x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10, a: Math.round(me.a * 100) / 100, d: me.dashT > 0 ? 1 : 0, seq: lastSeq });
      }
    }

    const opp = playerView(oppIdx);
    if (opp.seq !== oppSeq) { oppSeq = opp.seq; oppDisp.x = opp.x; oppDisp.y = opp.y; }
    const k = 1 - Math.exp(-dt * 20);
    oppDisp.x += (opp.x - oppDisp.x) * k;
    oppDisp.y += (opp.y - oppDisp.y) * k;
    oppDisp.a = angLerp(oppDisp.a, opp.a, k);

    for (const p of particles) {
      p.life -= dt;
      if (p.vx !== undefined) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9; }
    }
    particles = particles.filter((p) => p.life > 0);

    render(dt);
    updateHud();
  }

  function idleRender() { render(0); }
  addEventListener("resize", () => { if (!running) idleRender(); });
  idleRender();

  // ---------- Lobby hookup ----------
  Lobby.mount({
    game: "arena",
    title: "Arena",
    subtitle: "Top-down 1v1 shooter. First to 5 eliminations wins.",
    onStart(l) {
      document.getElementById("name0").textContent = l.spectator ? l.myName : "You";
      document.getElementById("name1").textContent = l.oppName;
      link = l;
      myIdx = l.isHost ? 0 : 1;
      oppIdx = 1 - myIdx;
      $("sw0").style.background = COLORS[myIdx];
      $("sw1").style.background = COLORS[oppIdx];
      S = l.isHost ? newState() : null;
      snap = null; guestIn = null; pendingFire = []; outEvents = []; localBullets = []; particles = [];
      lastSeq = l.isHost ? 0 : -1; oppSeq = -1; hudKey = "";
      resetMe(START[myIdx][0], START[myIdx][1]);
      Object.assign(oppDisp, { x: START[oppIdx][0], y: START[oppIdx][1], a: oppIdx ? Math.PI : 0 });

      l.onData((d) => {
        if (l.isHost) {
          if (d.t === "p") guestIn = d;
          else if (d.t === "f") pendingFire.push(d);
          else if (d.t === "rm" && S.win >= 0) resetMatch();
        } else if (d.t === "s") onSnapshot(d);
      });

      running = true;
      last = performance.now();
      stopLoop = GameUtil.loop(frame);
      if (!l.spectator) GameUtil.toast("Connected. Fight!");

      return () => {
        running = false;
        stopLoop();
        link = null; S = null; snap = null;
        resultEl.hidden = true;
        $("s0").textContent = "0"; $("s1").textContent = "0";
        idleRender();
      };
    },
  });
})();
