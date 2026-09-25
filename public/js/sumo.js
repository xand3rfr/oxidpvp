// Sumo, 2–6 players. Everyone is a heavy puck on a round platform that slowly shrinks. Push the
// others off the edge; dash (Space / the Dash button) for a big shove. Last one on the platform
// wins the round; first to 3 rounds wins. The host runs the physics and streams positions.
(() => {
  const W = 900, H = 700, CX = W / 2, CY = H / 2, R = 26;
  const ARENA0 = 310, ARENA_MIN = 120, SHRINK_AFTER = 8, SHRINK_TIME = 40;
  const ACCEL = 1500, DRAG = 2.4, MAXV = 430, DASH_V = 900, DASH_CD = 1.8, WIN = 3, COUNTDOWN = 3, PAUSE = 2.6;
  const COLORS = ["#ff5b3a", "#4d8dff", "#22c55e", "#facc15", "#ec4899", "#14b8a6"];
  const $ = (id) => document.getElementById(id);
  const { h, results, hideResults } = Party;
  const canvas = $("c"), ctx = canvas.getContext("2d");
  GameUtil.fitCanvas(canvas, W, H);

  // ---------- input ----------
  const keys = {};
  let dashQ = false, stick = { x: 0, y: 0 };
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    keys[e.code] = true;
    if (e.code === "Space") { dashQ = true; e.preventDefault(); }
    if (e.code.startsWith("Arrow")) e.preventDefault();
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
  GameUtil.touchControls({
    sticks: [{ side: "left", label: "Move", onMove: (x, y) => { stick = { x, y }; } }],
    buttons: [{ side: "right", label: "Dash", onDown: () => { dashQ = true; } }],
  });
  function readInput() {
    let x = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    let y = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
    if (!x && !y && Math.hypot(stick.x, stick.y) > 0.15) { x = stick.x; y = stick.y; }
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    const d = dashQ; dashQ = false;
    return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, d };
  }

  // =====================================================================
  // Host simulation
  // =====================================================================
  function createSim(room, out) {
    const S = { players: room.players.map((p, i) => ({ id: p.id, name: p.name, av: p.av, c: i, wins: 0 })), bodies: [], phase: "idle", timer: 0, t: 0, arena: ARENA0, n: 0, rw: null, w: null, events: [] };
    const inputs = new Map();
    function startRound() {
      const live = S.players.filter((p) => !p.gone);
      S.bodies = live.map((p, k) => {
        const a = (k / live.length) * Math.PI * 2 - Math.PI / 2, rr = ARENA0 * 0.6;
        return { id: p.id, c: p.c, x: CX + Math.cos(a) * rr, y: CY + Math.sin(a) * rr, vx: 0, vy: 0, alive: true, cd: 0, dash: 0, fall: 0 };
      });
      inputs.clear();
      S.arena = ARENA0; S.t = 0; S.n++; S.rw = null;
      S.phase = "count"; S.timer = COUNTDOWN;
    }
    function newMatch() { for (const p of S.players) p.wins = 0; S.w = null; startRound(); }
    function input(id, m) { inputs.set(id, { x: Math.max(-1, Math.min(1, +m.x || 0)), y: Math.max(-1, Math.min(1, +m.y || 0)), d: !!m.d || (inputs.get(id) || {}).d }); }
    function step(dt) {
      if (S.phase === "count") { S.timer -= dt; if (S.timer <= 0) S.phase = "play"; return; }
      if (S.phase === "pause") { S.timer -= dt; if (S.timer <= 0) { if (S.w != null) S.phase = "done"; else startRound(); } return; }
      if (S.phase !== "play") return;
      S.t += dt;
      if (S.t > SHRINK_AFTER) S.arena = Math.max(ARENA_MIN, ARENA0 - ((S.t - SHRINK_AFTER) / SHRINK_TIME) * (ARENA0 - ARENA_MIN));
      for (const b of S.bodies) {
        if (!b.alive) { b.fall += dt; continue; }
        const inp = inputs.get(b.id) || { x: 0, y: 0 };
        b.vx += inp.x * ACCEL * dt; b.vy += inp.y * ACCEL * dt;
        b.cd = Math.max(0, b.cd - dt); b.dash = Math.max(0, b.dash - dt);
        if (inp.d && b.cd <= 0) {
          const l = Math.hypot(inp.x, inp.y) || Math.hypot(b.vx, b.vy) || 1;
          const dx = (inp.x || b.vx) / l, dy = (inp.y || b.vy) / l;
          b.vx = dx * DASH_V; b.vy = dy * DASH_V; b.cd = DASH_CD; b.dash = 0.25;
          S.events.push({ k: "d", c: b.c });
        }
        if (inp.d) inp.d = false;
        const sp = Math.hypot(b.vx, b.vy), cap = b.dash > 0 ? DASH_V : MAXV;
        if (sp > cap) { b.vx *= cap / sp; b.vy *= cap / sp; }
        b.vx *= Math.exp(-DRAG * dt); b.vy *= Math.exp(-DRAG * dt);
        b.x += b.vx * dt; b.y += b.vy * dt;
      }
      // collisions: equal masses, a bit bouncy
      const live = S.bodies.filter((b) => b.alive);
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        if (d >= R * 2 || d === 0) continue;
        const nx = dx / d, ny = dy / d, overlap = R * 2 - d;
        a.x -= nx * overlap / 2; a.y -= ny * overlap / 2; b.x += nx * overlap / 2; b.y += ny * overlap / 2;
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv < 0) {
          const j2 = -(1 + 0.9) * rv / 2;
          a.vx -= j2 * nx; a.vy -= j2 * ny; b.vx += j2 * nx; b.vy += j2 * ny;
          if (-rv > 250) S.events.push({ k: "h", x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) });
        }
      }
      for (const b of live) if (Math.hypot(b.x - CX, b.y - CY) > S.arena) { b.alive = false; S.events.push({ k: "f", c: b.c }); }
      const left = S.bodies.filter((b) => b.alive);
      if (left.length <= (S.bodies.length > 1 ? 1 : 0)) {
        const win = left[0] ? S.players.find((p) => p.id === left[0].id) : null;
        if (win) win.wins++;
        S.rw = win ? win.id : -1;
        const champ = S.players.find((p) => p.wins >= WIN);
        S.w = champ ? champ.id : null;
        S.phase = "pause"; S.timer = PAUSE;
      }
    }
    const snapshot = (full) => ({
      t: "s", ph: S.phase, n: S.n, a: Math.round(S.arena), cnt: S.phase === "count" ? S.timer : 0, rw: S.rw, w: S.w,
      b: S.bodies.map((b) => [b.c, Math.round(b.x), Math.round(b.y), b.alive ? 1 : 0, b.cd > 0 ? Math.round(b.cd * 10) : 0, b.id]),
      players: S.players, e: S.events.splice(0),
    });
    function leave(id) { const p = S.players.find((x) => x.id === id); if (p) p.gone = true; const b = S.bodies.find((x) => x.id === id); if (b) b.alive = false; }
    return { S, newMatch, input, step, snapshot, leave };
  }

  // =====================================================================
  // Client
  // =====================================================================
  let room = null, sim = null, V = null, players = [], stopLoop = null, disp = new Map(), particles = [], sendAcc = 0, snapAcc = 0, lastIn = "", lastCount = -1;
  function onSnap(m) {
    const prev = V;
    V = m;
    if (m.players) { players = m.players; renderScores(); }
    for (const e of m.e) {
      if (e.k === "f") { GameUtil.sfx("boom"); }
      else if (e.k === "h") { burst(e.x, e.y, "#fff", 10); GameUtil.sfx("click"); }
      else if (e.k === "d") GameUtil.sfx("pop");
    }
    if (prev && prev.ph !== m.ph) {
      if (m.ph === "pause") GameUtil.sfx(m.rw === room.myId ? "good" : "bad");
      if (m.ph === "play") GameUtil.sfx("start");
      renderScores();
    }
    if (m.ph === "done" && (!prev || prev.ph !== "done")) {
      const won = m.w === room.myId;
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("sumo", won ? "win" : "loss");
      const winner = players.find((p) => p.id === m.w);
      setTimeout(() => results({ title: won ? "Sumo champion!" : winner ? `${winner.name} wins` : "Game over", rows: [...players].sort((a, b) => b.wins - a.wins).map((p) => ({ p, value: `${p.wins} round${p.wins === 1 ? "" : "s"}`, win: p.id === m.w })), isHost: room.isHost, meId: room.myId, again: "Rematch" }), 600);
    } else if (m.ph !== "done") hideResults();
  }
  function renderScores() {
    const el = $("scores");
    el.textContent = "";
    for (const p of players) {
      const chip = h("div", "sn-chip" + (p.id === room.myId ? " me" : "") + (p.gone ? " gone" : ""));
      chip.style.setProperty("--c", COLORS[p.c]);
      chip.append(h("i", "sw"), h("span", "", p.id === room.myId ? "You" : p.name), h("b", "", p.wins));
      el.append(chip);
    }
  }
  function burst(x, y, color, n) { for (let k = 0; k < n; k++) { const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 260; particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.3, color }); } }

  function render(dt) {
    const sc = canvas._scale;
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    ctx.fillStyle = "#07070c"; ctx.fillRect(0, 0, W, H);
    if (!V) return;
    // platform
    const g = ctx.createRadialGradient(CX, CY, 20, CX, CY, V.a);
    g.addColorStop(0, "#3b2f24"); g.addColorStop(1, "#231b14");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(CX, CY, V.a, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 8; ctx.strokeStyle = V.a < ARENA0 - 2 ? "#f87171" : "#e7d6b3"; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(231,214,179,.25)";
    ctx.beginPath(); ctx.arc(CX, CY, ARENA0, 0, Math.PI * 2); ctx.setLineDash([6, 10]); ctx.stroke(); ctx.setLineDash([]);
    // bodies (interpolated)
    const k = 1 - Math.exp(-dt * 18);
    for (const [c, x, y, alive, cd, id] of V.b) {
      let d = disp.get(c);
      if (!d || d.n !== V.n) { d = { x, y, n: V.n, fall: 0 }; disp.set(c, d); }
      d.x += (x - d.x) * k; d.y += (y - d.y) * k;
      d.fall = alive ? 0 : d.fall + dt;
      const scale = alive ? 1 : Math.max(0, 1 - d.fall * 1.6);
      if (scale <= 0) continue;
      ctx.globalAlpha = alive ? 1 : scale;
      ctx.fillStyle = "rgba(0,0,0,.4)";
      ctx.beginPath(); ctx.ellipse(d.x + 3, d.y + 6, R * scale, R * 0.8 * scale, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS[c]; ctx.shadowColor = COLORS[c]; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(d.x, d.y, R * scale, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,.25)"; ctx.beginPath(); ctx.arc(d.x - 7 * scale, d.y - 8 * scale, 9 * scale, 0, Math.PI * 2); ctx.fill();
      if (id === room.myId && alive) {
        ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(d.x, d.y, R + 7, -Math.PI / 2, -Math.PI / 2 + (1 - cd / (DASH_CD * 10)) * Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (const p of particles) { ctx.globalAlpha = Math.max(0, p.life * 2); ctx.fillStyle = p.color; ctx.fillRect(p.x - 2, p.y - 2, 4, 4); }
    ctx.globalAlpha = 1;
    // banner
    const banner = (t, size) => { ctx.font = `800 ${size}px Geist, system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff"; ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = 20; ctx.fillText(t, CX, 70); ctx.shadowBlur = 0; };
    if (V.ph === "count") { const n = Math.ceil(V.cnt); if (n !== lastCount) { lastCount = n; GameUtil.sfx("tick"); } banner(n > 0 ? String(n) : "GO", 70); }
    else if (V.ph === "pause" || V.ph === "done") { const p = players.find((x) => x.id === V.rw); banner(p ? (p.id === room.myId ? "YOU WIN THE ROUND" : `${p.name.toUpperCase()} WINS THE ROUND`) : "NOBODY LEFT!", 40); }
  }

  let last = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    const inp = readInput();
    if (room) {
      if (room.isHost) {
        sim.input(room.myId, inp);
        const steps = Math.max(1, Math.round(dt / (1 / 120)));
        for (let s = 0; s < steps; s++) sim.step(dt / steps);
        snapAcc += dt;
        if (snapAcc >= 1 / 30) { snapAcc = 0; const m = sim.snapshot(false); room.broadcast(m); onSnap(m); }
      } else {
        sendAcc += dt;
        const key = `${inp.x},${inp.y}`;
        if (inp.d || (key !== lastIn && sendAcc > 1 / 30) || sendAcc > 0.25) { sendAcc = 0; lastIn = key; room.send({ t: "in", ...inp }); }
      }
    }
    for (const p of particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9; }
    particles = particles.filter((p) => p.life > 0);
    render(dt);
  }
  addEventListener("resize", () => { if (!room) render(0); });

  $("again").addEventListener("click", () => { if (sim) { sim.newMatch(); const m = sim.snapshot(true); room.broadcast(m); onSnap(m); } });

  Room.mount({
    game: "sumo",
    title: "Sumo",
    subtitle: "Shove everyone off a shrinking platform. Dash for a big hit. Last one standing takes the round. 2 to 6 players.",
    min: 2,
    max: 6,
    onStart(r) {
      room = r; V = null; disp = new Map(); particles = [];
      players = r.players.map((p, i) => ({ ...p, c: i, wins: 0 }));
      renderScores();
      if (r.isHost) {
        sim = createSim(r, null);
        r.onData((from, m) => { if (m && m.t === "in") sim.input(from, m); });
        r.onLeave((id) => sim.leave(id));
        r.onRejoin((id) => r.sendTo(id, sim.snapshot(true)));
        sim.newMatch();
        setTimeout(() => { if (sim) { const m = sim.snapshot(true); r.broadcast(m); onSnap(m); } }, 300);
      } else r.onData((_, m) => { if (m && m.t === "s") onSnap(m); });
      last = performance.now();
      stopLoop = GameUtil.loop(frame);
      return () => { stopLoop(); room = null; sim = null; V = null; hideResults(); render(0); };
    },
  });
  render(0);
})();
