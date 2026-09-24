// 1v1 Pong. Host = left paddle and runs the ball; guest = right paddle.
// Each side moves its own paddle locally (zero input lag) and streams it; the host streams ball + score.
(() => {
  const W = 1280, H = 720;
  const PW = 14, PH = 120, PX = 48, BR = 10;
  const START_SPEED = 560, SPEEDUP = 1.06, MAX_SPEED = 1500, MAX_ANGLE = (55 * Math.PI) / 180;
  const KEY_SPEED = 820, PADDLE_MAX = 2600, WIN = 7, SERVE_DELAY = 1.1;
  const COLORS = ["#ff5a36", "#4da3ff"];
  const paddleX = (i) => (i === 0 ? PX : W - PX - PW);

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  GameUtil.fitCanvas(canvas, W, H);
  const $ = (id) => document.getElementById(id);
  const resultEl = $("result"), rematchBtn = $("rematch");
  $("sw0").style.background = COLORS[0];
  $("sw1").style.background = COLORS[1];

  // ---------- Input ----------
  const keys = {};
  let target = H / 2, useKeys = false;
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    keys[e.code] = true;
    if (["KeyW", "KeyS", "ArrowUp", "ArrowDown"].includes(e.code)) { useKeys = true; e.preventDefault(); }
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
  const pointer = (e) => {
    const r = canvas.getBoundingClientRect();
    target = ((e.clientY - r.top) / r.height) * H;
    useKeys = false;
  };
  canvas.addEventListener("pointermove", pointer);
  canvas.addEventListener("pointerdown", (e) => { pointer(e); canvas.setPointerCapture(e.pointerId); });

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---------- State ----------
  let link = null, running = false, stopLoop = null;
  let myIdx = 0, oppIdx = 1;
  let myY = H / 2, oppY = H / 2, oppDispY = H / 2;
  let S = null;                 // host state
  let snap = null, snapAt = 0;  // guest
  let outEvents = [];
  let particles = [], trail = [], flash = [0, 0], shake = 0;

  const newState = () => ({
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
    sc: [0, 0], serveT: SERVE_DELAY + 0.6, serveDir: Math.random() < 0.5 ? -1 : 1, win: -1,
  });

  function burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.45 * (0.5 + Math.random() * 0.5), max: 0.45, color });
    }
  }
  function applyEvent(e) {
    if (e.k === "p") { burst(e.x, e.y, COLORS[e.i], 14, 320); flash[e.i] = 1; }
    else if (e.k === "w") burst(e.x, e.y, "#9aa0aa", 5, 160);
    else if (e.k === "g") { burst(e.x, e.y, COLORS[e.i], 40, 520); shake = 12; trail = []; }
  }
  function emit(e) { outEvents.push(e); applyEvent(e); }

  // ---------- Local paddle ----------
  function stepPaddle(dt) {
    if (useKeys) {
      const dir = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
      target = clamp(myY + dir * KEY_SPEED * dt, PH / 2, H - PH / 2);
      if (!dir) target = myY;
    }
    const want = clamp(target, PH / 2, H - PH / 2);
    const maxStep = PADDLE_MAX * dt;
    myY += clamp(want - myY, -maxStep, maxStep);
  }

  // ---------- Host ----------
  function serve() {
    const a = (Math.random() * 2 - 1) * (25 * Math.PI) / 180;
    S.ball = { x: W / 2, y: H / 2, vx: Math.cos(a) * START_SPEED * S.serveDir, vy: Math.sin(a) * START_SPEED };
  }

  function hostTick(dt) {
    const py = [0, 0];
    py[myIdx] = myY; py[oppIdx] = oppY;
    const b = S.ball;

    if (S.win >= 0) return;
    if (S.serveT > 0) {
      S.serveT -= dt;
      b.x = W / 2; b.y = H / 2; b.vx = b.vy = 0;
      if (S.serveT <= 0) serve();
      return;
    }

    const steps = Math.max(1, Math.ceil(dt * 240)), h = dt / steps;
    for (let s = 0; s < steps; s++) {
      b.x += b.vx * h; b.y += b.vy * h;
      if (b.y < BR) { b.y = BR; b.vy = Math.abs(b.vy); emit({ k: "w", x: b.x | 0, y: 0 }); }
      if (b.y > H - BR) { b.y = H - BR; b.vy = -Math.abs(b.vy); emit({ k: "w", x: b.x | 0, y: H }); }

      for (const i of [0, 1]) {
        const x0 = paddleX(i), movingToward = i === 0 ? b.vx < 0 : b.vx > 0;
        if (!movingToward) continue;
        const face = i === 0 ? x0 + PW : x0;
        const hitX = i === 0 ? b.x - BR <= face && b.x > x0 - BR : b.x + BR >= face && b.x < x0 + PW + BR;
        if (hitX && Math.abs(b.y - py[i]) <= PH / 2 + BR) {
          const off = clamp((b.y - py[i]) / (PH / 2 + BR), -1, 1);
          const speed = Math.min(MAX_SPEED, Math.hypot(b.vx, b.vy) * SPEEDUP);
          const ang = off * MAX_ANGLE;
          b.vx = Math.cos(ang) * speed * (i === 0 ? 1 : -1);
          b.vy = Math.sin(ang) * speed;
          b.x = i === 0 ? face + BR : face - BR;
          emit({ k: "p", x: b.x | 0, y: b.y | 0, i });
        }
      }

      if (b.x < -BR * 3 || b.x > W + BR * 3) {
        const scorer = b.x < 0 ? 1 : 0;
        S.sc[scorer]++;
        emit({ k: "g", x: clamp(b.x, 0, W) | 0, y: b.y | 0, i: scorer });
        S.serveDir = scorer === 0 ? 1 : -1; // serve toward the player who conceded
        S.serveT = SERVE_DELAY;
        b.x = W / 2; b.y = H / 2; b.vx = b.vy = 0;
        if (S.sc[scorer] >= WIN) S.win = scorer;
        break;
      }
    }
  }

  function sendSnapshot() {
    const b = S.ball;
    link.send({
      t: "s", y: Math.round(myY * 10) / 10,
      b: [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, Math.round(b.vx), Math.round(b.vy)],
      sc: S.sc, st: Math.max(0, Math.round(S.serveT * 100) / 100), w: S.win, e: outEvents,
    });
    outEvents = [];
  }

  function resetMatch() {
    S = newState();
    outEvents = [];
    trail = [];
  }

  // ---------- Views ----------
  const scores = () => (S ? S.sc : snap ? snap.sc : [0, 0]);
  const winner = () => (S ? S.win : snap ? snap.w : -1);
  const serveTime = () => (S ? S.serveT : snap ? snap.st : 0);
  function ballPos() {
    if (S) return S.ball;
    if (!snap) return { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    const [x, y, vx, vy] = snap.b;
    const el = Math.min(0.12, (performance.now() - snapAt) / 1000);
    let bx = x + vx * el, by = y + vy * el;
    if (by < BR) by = 2 * BR - by;
    if (by > H - BR) by = 2 * (H - BR) - by;
    return { x: bx, y: by, vx, vy };
  }

  // ---------- Render ----------
  function render(dt) {
    const s = canvas._scale;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake = Math.max(0, shake - dt * 50);
    }
    ctx.fillStyle = "#0d0e11";
    ctx.fillRect(-20, -20, W + 40, H + 40);

    // side tint
    const g0 = ctx.createLinearGradient(0, 0, W / 2, 0);
    g0.addColorStop(0, COLORS[0] + "10"); g0.addColorStop(1, "transparent");
    ctx.fillStyle = g0; ctx.fillRect(0, 0, W / 2, H);
    const g1 = ctx.createLinearGradient(W, 0, W / 2, 0);
    g1.addColorStop(0, COLORS[1] + "10"); g1.addColorStop(1, "transparent");
    ctx.fillStyle = g1; ctx.fillRect(W / 2, 0, W / 2, H);

    // big background scores
    const sc = scores();
    ctx.font = "600 180px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    ctx.fillText(sc[0], W / 4, H / 2);
    ctx.fillText(sc[1], (W * 3) / 4, H / 2);

    // center line
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 18]);
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.setLineDash([]);

    // paddles
    const py = [0, 0];
    py[myIdx] = myY; py[oppIdx] = oppDispY;
    for (const i of [0, 1]) {
      const x = paddleX(i), y = py[i] - PH / 2;
      ctx.shadowColor = COLORS[i];
      ctx.shadowBlur = 20 + flash[i] * 30;
      ctx.fillStyle = COLORS[i];
      roundRect(x, y, PW, PH, 7);
      ctx.fill();
      if (flash[i] > 0) {
        ctx.fillStyle = `rgba(255,255,255,${flash[i] * 0.7})`;
        roundRect(x, y, PW, PH, 7);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      flash[i] = Math.max(0, flash[i] - dt * 5);
    }
    if (link) {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = "600 12px 'IBM Plex Sans', system-ui, sans-serif";
      ctx.fillText("YOU", paddleX(myIdx) + PW / 2, myY - PH / 2 - 16);
    }

    // ball + trail
    const b = ballPos();
    if (link && serveTime() <= 0 && winner() < 0) {
      trail.push({ x: b.x, y: b.y });
      if (trail.length > 14) trail.shift();
    }
    trail.forEach((t, i) => {
      const k = i / trail.length;
      ctx.fillStyle = `rgba(236,237,239,${k * 0.18})`;
      ctx.beginPath(); ctx.arc(t.x, t.y, BR * (0.4 + k * 0.6), 0, Math.PI * 2); ctx.fill();
    });
    ctx.shadowColor = "#fff"; ctx.shadowBlur = 16;
    ctx.fillStyle = "#f4f5f7";
    ctx.beginPath(); ctx.arc(b.x, b.y, BR, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;

    const st = serveTime();
    if (link && st > 0 && winner() < 0) {
      ctx.fillStyle = "rgba(236,237,239,0.9)";
      ctx.font = "600 20px 'IBM Plex Sans', system-ui, sans-serif";
      ctx.fillText(sc[0] + sc[1] === 0 ? "Get ready" : "Serve in " + Math.ceil(st), W / 2, H / 2 - 60);
    }
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ---------- HUD ----------
  let hudKey = "";
  function updateHud() {
    const sc = scores(), w = winner();
    const key = sc.join(":") + ":" + w;
    if (key === hudKey) return;
    hudKey = key;
    $("s0").textContent = sc[0];
    $("s1").textContent = sc[1];
    if (w >= 0) {
      const won = w === myIdx;
      $("resultTitle").textContent = won ? "Victory" : "Defeat";
      $("resultTitle").style.color = won ? COLORS[myIdx] : "#ecedef";
      $("resultScore").textContent = sc[myIdx] + " – " + sc[oppIdx];
      rematchBtn.disabled = false;
      rematchBtn.textContent = "Rematch";
      resultEl.hidden = false;
    } else resultEl.hidden = true;
  }
  rematchBtn.addEventListener("click", () => {
    if (!link) return;
    if (link.isHost) resetMatch();
    else { link.send({ t: "rm" }); rematchBtn.disabled = true; rematchBtn.textContent = "Starting…"; }
  });

  // ---------- Loop ----------
  let last = 0, sendAcc = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    stepPaddle(dt);
    sendAcc += dt;
    if (S) {
      hostTick(dt);
      if (sendAcc >= 1 / 30) { sendAcc = 0; sendSnapshot(); }
    } else if (sendAcc >= 1 / 30) {
      sendAcc = 0;
      link.send({ t: "y", y: Math.round(myY * 10) / 10 });
    }
    oppDispY += (oppY - oppDispY) * (1 - Math.exp(-dt * 25));
    for (const p of particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; }
    particles = particles.filter((p) => p.life > 0);
    render(dt);
    updateHud();
  }

  addEventListener("resize", () => { if (!running) render(0); });
  render(0);

  Lobby.mount({
    game: "pong",
    title: "Pong",
    subtitle: "Classic 1v1 paddle duel. First to 7 wins.",
    onStart(l) {
      link = l;
      myIdx = l.isHost ? 0 : 1;
      oppIdx = 1 - myIdx;
      $("name0").textContent = myIdx === 0 ? "You" : "Opponent";
      $("name1").textContent = myIdx === 1 ? "You" : "Opponent";
      S = l.isHost ? newState() : null;
      snap = null; outEvents = []; particles = []; trail = []; hudKey = "";
      myY = oppY = oppDispY = target = H / 2;

      l.onData((d) => {
        if (l.isHost) {
          if (d.t === "y") oppY = clamp(d.y, PH / 2, H - PH / 2);
          else if (d.t === "rm" && S.win >= 0) resetMatch();
        } else if (d.t === "s") {
          snap = d; snapAt = performance.now();
          oppY = d.y;
          for (const e of d.e) applyEvent(e);
        }
      });

      running = true;
      last = performance.now();
      stopLoop = GameUtil.loop(frame);
      GameUtil.toast(l.isHost ? "Connected. You're on the left." : "Connected. You're on the right.");

      return () => {
        running = false;
        stopLoop();
        link = null; S = null; snap = null;
        resultEl.hidden = true;
        $("s0").textContent = "0"; $("s1").textContent = "0";
        $("name0").textContent = "Left"; $("name1").textContent = "Right";
        render(0);
      };
    },
  });
})();
