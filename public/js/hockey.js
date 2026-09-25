// Air Hockey, 1v1. Each player moves a mallet in their own half (mouse or touch); the host runs
// the puck physics and streams it. Knock the puck into the other goal. First to 7.
(() => {
  const W = 1280, H = 720, PR = 22, MR = 40, GOAL = 230, WIN = 7;
  const MAX_PUCK = 2300, MALLET_MAX = 3200, WALL_E = 0.9, HIT_E = 0.95, FRICTION = 0.35; // per second
  const COLORS = ["#ff5b3a", "#4d8dff"];
  const $ = (id) => document.getElementById(id);
  const canvas = $("c"), ctx = canvas.getContext("2d");
  GameUtil.fitCanvas(canvas, W, H);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const home = (i) => ({ x: i === 0 ? 150 : W - 150, y: H / 2 });
  const halfX = (i, x) => (i === 0 ? clamp(x, MR, W / 2 - MR) : clamp(x, W / 2 + MR, W - MR));

  // ---------- input ----------
  const keys = {};
  let target = null, useKeys = false;
  addEventListener("keydown", (e) => { if (e.target.tagName === "INPUT") return; keys[e.code] = true; if (/Key[WASD]|Arrow/.test(e.code)) { useKeys = true; e.preventDefault(); } });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  const toTable = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
  canvas.addEventListener("pointermove", (e) => { target = toTable(e); useKeys = false; });
  canvas.addEventListener("pointerdown", (e) => { target = toTable(e); useKeys = false; canvas.setPointerCapture(e.pointerId); });

  // ---------- state ----------
  let link = null, me = 0, stopLoop = null, running = false;
  const mine = { x: 0, y: 0, vx: 0, vy: 0 }, opp = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
  let S = null, snap = null, snapAt = 0, events = [], particles = [], flash = 0;
  // Replay highlights: remember the last couple of seconds of what was on screen, and keep a clip
  // of every goal. After the match you can watch them back in slow motion.
  const CLIP = 1.8, SLOW = 0.4;
  let buf = [], clips = [], clipDue = 0, clipBy = 0, clipAt = 0, replay = null;

  const newState = () => ({ p: { x: W / 2, y: H / 2, vx: 0, vy: 0 }, sc: [0, 0], w: -1, serve: 1.2, n: 0 });

  function stepMallet(dt) {
    if (link && link.spectator) {
      if (snap) { const m = snap.m[me]; mine.x += (m[0] - mine.x) * Math.min(1, dt * 20); mine.y += (m[1] - mine.y) * Math.min(1, dt * 20); }
      return;
    }
    let tx = target ? target.x : mine.x, ty = target ? target.y : mine.y;
    if (useKeys) {
      const dx = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
      const dy = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
      tx = mine.x + dx * 900 * dt; ty = mine.y + dy * 900 * dt;
    }
    tx = halfX(me, tx); ty = clamp(ty, MR, H - MR);
    const dx = tx - mine.x, dy = ty - mine.y, d = Math.hypot(dx, dy), max = MALLET_MAX * dt;
    const k = d > max ? max / d : 1;
    const nx = mine.x + dx * k, ny = mine.y + dy * k;
    mine.vx = dt ? (nx - mine.x) / dt : 0; mine.vy = dt ? (ny - mine.y) / dt : 0;
    mine.x = nx; mine.y = ny;
  }

  // ---------- host physics ----------
  function emit(e) { events.push(e); fx(e); }
  function hostTick(dt) {
    const p = S.p;
    if (S.w >= 0) return;
    if (S.serve > 0) { S.serve -= dt; return; }
    const mallets = [me === 0 ? mine : opp, me === 0 ? opp : mine];
    const steps = Math.max(1, Math.ceil(dt * 360)), h = dt / steps;
    for (let s = 0; s < steps; s++) {
      p.x += p.vx * h; p.y += p.vy * h;
      if (p.y < PR) { p.y = PR; p.vy = Math.abs(p.vy) * WALL_E; emit({ k: "w" }); }
      if (p.y > H - PR) { p.y = H - PR; p.vy = -Math.abs(p.vy) * WALL_E; emit({ k: "w" }); }
      const inMouth = Math.abs(p.y - H / 2) < GOAL / 2 - PR * 0.3;
      if (!inMouth) {
        if (p.x < PR) { p.x = PR; p.vx = Math.abs(p.vx) * WALL_E; emit({ k: "w" }); }
        if (p.x > W - PR) { p.x = W - PR; p.vx = -Math.abs(p.vx) * WALL_E; emit({ k: "w" }); }
      }
      for (let i = 0; i < 2; i++) {
        const m = mallets[i];
        const dx = p.x - m.x, dy = p.y - m.y, d = Math.hypot(dx, dy);
        if (d < PR + MR && d > 0) {
          const nx = dx / d, ny = dy / d;
          p.x = m.x + nx * (PR + MR); p.y = m.y + ny * (PR + MR);
          const rvx = p.vx - m.vx, rvy = p.vy - m.vy, dot = rvx * nx + rvy * ny;
          if (dot < 0) {
            p.vx -= (1 + HIT_E) * dot * nx; p.vy -= (1 + HIT_E) * dot * ny;
            emit({ k: "h", i, x: p.x | 0, y: p.y | 0 });
          }
        }
      }
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > MAX_PUCK) { p.vx *= MAX_PUCK / sp; p.vy *= MAX_PUCK / sp; }
      if (p.x < -PR || p.x > W + PR) {
        const scorer = p.x < 0 ? 1 : 0;
        S.sc[scorer]++;
        emit({ k: "g", i: scorer, y: p.y | 0 });
        const loser = 1 - scorer;
        Object.assign(p, { x: loser === 0 ? W / 2 - 180 : W / 2 + 180, y: H / 2, vx: 0, vy: 0 });
        S.serve = 1.2;
        if (S.sc[scorer] >= WIN) S.w = scorer;
        break;
      }
    }
    const f = Math.pow(FRICTION, dt);
    p.vx *= f; p.vy *= f;
  }
  function sendSnap() {
    const p = S.p, a = me === 0 ? mine : opp, b = me === 0 ? opp : mine;
    link.send({ t: "s", m: [[a.x | 0, a.y | 0], [b.x | 0, b.y | 0]], p: [p.x | 0, p.y | 0, p.vx | 0, p.vy | 0], sc: S.sc, w: S.w, st: S.serve > 0 ? 1 : 0, e: events });
    events = [];
  }

  function fx(e) {
    if (e.k === "h") { burst(e.x, e.y, COLORS[e.i], 10, 260); GameUtil.sfx("click"); }
    else if (e.k === "w") { /* quiet */ }
    else if (e.k === "g") { clipAt = buf.length ? buf[buf.length - 1].t + 1 : performance.now(); clipDue = performance.now() + 350; clipBy = e.i; flash = 1; burst(e.i === 0 ? W - 10 : 10, e.y, COLORS[e.i], 40, 500); GameUtil.sfx(link && !link.spectator && e.i === me ? "good" : "bad"); }
  }
  function burst(x, y, color, n, speed) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5, color });
    }
  }

  // ---------- views ----------
  const scores = () => (S ? S.sc : snap ? snap.sc : [0, 0]);
  const winner = () => (S ? S.w : snap ? snap.w : -1);
  function puck() {
    if (S) return S.p;
    if (!snap) return { x: W / 2, y: H / 2 };
    const [x, y, vx, vy] = snap.p, el = Math.min(0.1, (performance.now() - snapAt) / 1000);
    return { x: x + vx * el, y: clamp(y + vy * el, PR, H - PR) };
  }

  function render(dt, R) {
    const s = canvas._scale;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    // rink
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#0e1a2e"); g.addColorStop(1, "#0a1322");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,0.025)";
    for (let x = 20; x < W; x += 40) for (let y = 20; y < H; y += 40) ctx.fillRect(x, y, 2, 2);
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 90, 0, Math.PI * 2); ctx.stroke();
    for (const [i, x] of [[0, 0], [1, W]]) {
      ctx.strokeStyle = COLORS[i] + "55";
      ctx.beginPath(); ctx.arc(x, H / 2, GOAL / 2 + 40, i ? Math.PI / 2 : -Math.PI / 2, i ? Math.PI * 1.5 : Math.PI / 2); ctx.stroke();
      ctx.fillStyle = COLORS[i]; ctx.shadowColor = COLORS[i]; ctx.shadowBlur = 20;
      ctx.fillRect(i ? W - 8 : 0, H / 2 - GOAL / 2, 8, GOAL);
      ctx.shadowBlur = 0;
    }
    if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash * 0.12})`; ctx.fillRect(0, 0, W, H); flash = Math.max(0, flash - dt * 2); }
    // big scores
    const sc = scores();
    ctx.font = "600 160px 'Geist Mono', ui-monospace, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillText(sc[0], W / 4, H / 2); ctx.fillText(sc[1], (W * 3) / 4, H / 2);

    if (link || R) {
      const ms = R ? R.m.map(([x, y]) => ({ x, y })) : [me === 0 ? mine : opp, me === 0 ? opp : mine];
      ms.forEach((m, i) => {
        ctx.shadowColor = COLORS[i]; ctx.shadowBlur = 24;
        ctx.fillStyle = COLORS[i];
        ctx.beginPath(); ctx.arc(m.x, m.y, MR, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.beginPath(); ctx.arc(m.x, m.y, MR * 0.62, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.beginPath(); ctx.arc(m.x, m.y, MR * 0.3, 0, Math.PI * 2); ctx.fill();
      });
      const p = R ? R.p : puck();
      ctx.shadowColor = "#fff"; ctx.shadowBlur = 18;
      ctx.fillStyle = "#e5e7eb"; ctx.beginPath(); ctx.arc(p.x, p.y, PR, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, PR * 0.6, 0, Math.PI * 2); ctx.stroke();
      const serving = R ? false : S ? S.serve > 0 : snap && snap.st;
      if (serving && winner() < 0) { ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.font = "600 22px Geist, system-ui, sans-serif"; ctx.fillText("Get ready…", W / 2, 60); }
    }
    if (R) {
      ctx.fillStyle = "rgba(10,14,30,0.18)"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#fff"; ctx.font = "700 26px Geist, system-ui, sans-serif"; ctx.textAlign = "left";
      ctx.fillText(`▶ REPLAY  ·  goal ${R.idx + 1} of ${R.of}  ·  slow-mo`, 28, 40);
      ctx.fillStyle = COLORS[R.by]; ctx.textAlign = "right";
      ctx.fillText(R.name === "You" ? "You score!" : `${R.name} scores`, W - 28, 40);
      ctx.textAlign = "center";
      return;
    }
    for (const q of particles) { ctx.globalAlpha = Math.max(0, q.life * 2); ctx.fillStyle = q.color; ctx.fillRect(q.x - 2, q.y - 2, 4, 4); }
    ctx.globalAlpha = 1;
  }

  // ---------- HUD ----------
  let hudKey = "";
  function hud() {
    const sc = scores(), w = winner(), key = sc.join(":") + w;
    if (key === hudKey) return;
    hudKey = key;
    if (sc[0] + sc[1] === 0) { clips = []; replay = null; } // new match
    $("s0").textContent = sc[me]; $("s1").textContent = sc[1 - me];
    if (w >= 0) {
      const won = w === me, spec = link.spectator;
      if (!spec) { GameUtil.sfx(won ? "win" : "lose"); GameUtil.record("hockey", won ? "win" : "loss"); }
      $("resultTitle").textContent = spec ? `${link.names[w]} wins` : won ? "Victory" : "Defeat";
      $("resultScore").textContent = sc[me] + " – " + sc[1 - me];
      $("rematch").hidden = spec; $("rematch").disabled = false; $("rematch").textContent = "Rematch";
      $("replayBtn").hidden = !clips.length;
      $("replayBtn").textContent = `▶ Goal replays (${clips.length})`;
      if (!replay) $("result").hidden = false;
    } else { $("result").hidden = true; replay = null; }
  }
  $("rematch").addEventListener("click", () => {
    if (!link) return;
    clips = []; replay = null;
    if (link.isHost) { S = newState(); Object.assign(mine, home(0)); }
    else { link.send({ t: "rm" }); $("rematch").disabled = true; $("rematch").textContent = "Starting…"; }
  });

  let last = 0, acc = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    stepMallet(dt);
    if (!S) {
      // smooth the opponent's mallet toward the latest position we have for it
      const k = 1 - Math.exp(-dt * 25);
      opp.x += (opp.tx - opp.x) * k; opp.y += (opp.ty - opp.y) * k;
    }
    acc += dt;
    if (S) { hostTick(dt); if (acc >= 1 / 30) { acc = 0; sendSnap(); } }
    else if (acc >= 1 / 30 && !link.spectator) { acc = 0; link.send({ t: "m", x: mine.x | 0, y: mine.y | 0 }); }
    if (link) {
      const p = puck(), ms = [me === 0 ? mine : opp, me === 0 ? opp : mine];
      buf.push({ t: now, m: ms.map((m) => [m.x, m.y]), p: { x: p.x, y: p.y } });
      while (buf.length && buf[0].t < now - (CLIP + 0.6) * 1000) buf.shift();
      if (clipDue && now >= clipDue) {
        clipDue = 0;
        // stop the clip at the goal itself so the puck doesn't jump back to the serve spot
        const fr = buf.filter((f) => f.t >= clipAt - CLIP * 1000 && f.t < clipAt);
        if (fr.length > 5) clips.push({ frames: fr, by: clipBy });
        if (clips.length > 5) clips.shift();
        $("replayBtn").hidden = !clips.length;
        $("replayBtn").textContent = `▶ Goal replays (${clips.length})`;
      }
    }
    for (const q of particles) { q.life -= dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.92; q.vy *= 0.92; }
    particles = particles.filter((q) => q.life > 0);
    if (replay) playReplay(now, dt); else render(dt);
    hud();
  }
  function playReplay(now, dt) {
    const c = clips[replay.i], fr = c.frames;
    const at = fr[0].t + (now - replay.t0) * SLOW;
    if (at > fr[fr.length - 1].t + 250) {
      replay.i++; replay.t0 = now;
      if (replay.i >= clips.length) { replay = null; $("result").hidden = winner() < 0; render(dt); return; }
      return playReplay(now, dt);
    }
    let k = 0;
    while (k < fr.length - 1 && fr[k + 1].t <= at) k++;
    const a = fr[k], b = fr[Math.min(k + 1, fr.length - 1)], u = b.t > a.t ? clamp((at - a.t) / (b.t - a.t), 0, 1) : 0;
    const L = (x, y) => x + (y - x) * u;
    const nameOf = (i) => (link && !link.spectator ? (i === me ? "You" : link.oppName) : link ? link.names[i] : "");
    render(dt, { m: a.m.map((m, i) => [L(m[0], b.m[i][0]), L(m[1], b.m[i][1])]), p: { x: L(a.p.x, b.p.x), y: L(a.p.y, b.p.y) }, idx: replay.i, of: clips.length, by: c.by, name: nameOf(c.by) });
  }
  function startReplays() {
    if (!clips.length) return;
    $("result").hidden = true;
    replay = { i: 0, t0: performance.now() };
  }
  $("replayBtn").addEventListener("click", startReplays);
  window.__hockey = { get S() { return S; }, get clips() { return clips; }, get replay() { return replay; } }; // test hook
  canvas.addEventListener("click", () => { if (replay) { replay = null; $("result").hidden = winner() < 0; } });
  $("peek").addEventListener("click", () => { $("result").hidden = true; });
  addEventListener("resize", () => { if (!running) render(0); });
  render(0);

  Lobby.mount({
    game: "hockey",
    title: "Air Hockey",
    subtitle: "Slam the puck into their goal. Move your mallet with the mouse or your finger. First to 7.",
    onStart(l) {
      link = l;
      me = l.isHost ? 0 : 1;
      $("name0").textContent = l.spectator ? l.myName : "You";
      $("name1").textContent = l.oppName;
      $("sw0").style.background = COLORS[me]; $("sw1").style.background = COLORS[1 - me];
      Object.assign(mine, home(me), { vx: 0, vy: 0 });
      Object.assign(opp, home(1 - me), { vx: 0, vy: 0 }); opp.tx = opp.x; opp.ty = opp.y;
      target = null; S = l.isHost ? newState() : null; snap = null; events = []; particles = []; hudKey = ""; buf = []; clips = []; replay = null; clipDue = 0;
      let lastOpp = null;
      l.onData((d) => {
        if (l.isHost) {
          if (d.t === "m") {
            // derive the guest mallet's velocity from successive positions
            const now = performance.now();
            const x = halfX(1, +d.x || 0), y = clamp(+d.y || 0, MR, H - MR);
            if (lastOpp) { const dtm = Math.max(0.016, (now - lastOpp.t) / 1000); opp.vx = (x - lastOpp.x) / dtm; opp.vy = (y - lastOpp.y) / dtm; }
            lastOpp = { x, y, t: now };
            opp.x = x; opp.y = y; opp.tx = x; opp.ty = y;
          } else if (d.t === "rm" && S.w >= 0) { S = newState(); Object.assign(mine, home(0)); clips = []; replay = null; }
        } else if (d.t === "s") {
          snap = d; snapAt = performance.now();
          const o = d.m[1 - me]; opp.tx = o[0]; opp.ty = o[1];
          for (const e of d.e) fx(e);
        }
      });
      running = true; last = performance.now();
      stopLoop = GameUtil.loop(frame);
      if (!l.spectator) GameUtil.toast(l.isHost ? "You're orange, defending the left goal." : "You're blue, defending the right goal.");
      return () => { running = false; stopLoop(); link = null; S = null; snap = null; $("result").hidden = true; render(0); };
    },
  });
})();
