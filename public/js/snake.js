// Snake Battle for 2–4 players. Everyone steers a snake on the same board: eat to grow, and
// don't hit a wall, yourself or anyone else. Last snake alive wins the round; first to 3 rounds
// wins. The host runs the simulation at a fixed tick and streams the board; guests send turns.
(() => {
  const GW = 40, GH = 28, CELL = 24, W = GW * CELL, H = GH * CELL;
  const TICK_MS = 100, COUNTDOWN = 3, ROUND_PAUSE = 2.4, WIN = 3, FOOD = 5, START_LEN = 4;
  const COLORS = ["#ff5b3a", "#4d8dff", "#22c55e", "#facc15"];
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  const SPAWN = [[5, 14, 1], [GW - 6, 13, 3], [20, 3, 2], [19, GH - 4, 0]];
  const $ = (id) => document.getElementById(id);
  const { h, results, hideResults } = Party;

  const canvas = $("c");
  const ctx = canvas.getContext("2d");
  GameUtil.fitCanvas(canvas, W, H);

  // ---------- input ----------
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

  // =====================================================================
  // Host simulation
  // =====================================================================
  function createSim(room, out) {
    const S = {
      players: room.players.map((p, i) => ({ id: p.id, name: p.name, av: p.av, c: i, wins: 0 })),
      snakes: [], food: [], phase: "idle", timer: 0, acc: 0, n: 0, rw: null, w: null, tickN: 0,
    };
    const occupied = () => {
      const set = new Set();
      for (const s of S.snakes) if (s.alive) for (const [x, y] of s.body) set.add(y * GW + x);
      return set;
    };
    function addFood() {
      const occ = occupied();
      for (const [x, y] of S.food) occ.add(y * GW + x);
      for (let k = 0; k < 200; k++) {
        const x = 1 + Math.floor(Math.random() * (GW - 2)), y = 1 + Math.floor(Math.random() * (GH - 2));
        if (!occ.has(y * GW + x)) { S.food.push([x, y]); return; }
      }
    }
    function startRound() {
      S.snakes = S.players.filter((p) => !p.gone).map((p, k) => {
        const [x, y, d] = SPAWN[p.c];
        const body = [];
        for (let i = 0; i < START_LEN; i++) body.push([x - DX[d] * i, y - DY[d] * i]);
        return { id: p.id, c: p.c, body, dir: d, q: [], grow: 0, alive: true };
      });
      S.food = [];
      for (let i = 0; i < FOOD; i++) addFood();
      S.phase = "count"; S.timer = COUNTDOWN; S.n++; S.rw = null;
      publish(true);
    }
    function newMatch() {
      for (const p of S.players) p.wins = 0;
      S.w = null; S.n = 0;
      startRound();
    }
    function queue(id, d) {
      const s = S.snakes.find((x) => x.id === id);
      if (!s || !s.alive || !(d >= 0 && d <= 3)) return;
      const last = s.q.length ? s.q[s.q.length - 1] : s.dir;
      if (d === last || d === (last + 2) % 4 || s.q.length >= 3) return;
      s.q.push(d);
    }
    function step(dt) {
      if (S.phase === "count") { S.timer -= dt; if (S.timer <= 0) { S.phase = "play"; S.acc = 0; publish(true); } return; }
      if (S.phase === "pause") { S.timer -= dt; if (S.timer <= 0) startRound(); return; }
      if (S.phase !== "play") return;
      S.acc += dt * 1000;
      let guard = 0;
      while (S.acc >= TICK_MS && S.phase === "play" && guard++ < 4) { S.acc -= TICK_MS; tick(); }
    }
    function tick() {
      S.tickN++;
      const live = S.snakes.filter((s) => s.alive);
      for (const s of live) if (s.q.length) s.dir = s.q.shift();
      const heads = live.map((s) => [s.body[0][0] + DX[s.dir], s.body[0][1] + DY[s.dir]]);
      // Tails move out of the way this tick unless that snake is growing.
      const occ = new Map();
      for (const s of live) s.body.forEach(([x, y], i) => { if (i < s.body.length - 1 || s.grow > 0) occ.set(y * GW + x, s); });
      const dead = live.map((s, i) => {
        const [x, y] = heads[i];
        return x < 0 || y < 0 || x >= GW || y >= GH || occ.has(y * GW + x);
      });
      heads.forEach(([x, y], i) => heads.forEach(([x2, y2], j) => { if (i !== j && x === x2 && y === y2) dead[i] = true; }));
      const events = [];
      live.forEach((s, i) => {
        if (dead[i]) {
          s.alive = false;
          events.push({ k: "x", c: s.c, x: s.body[0][0], y: s.body[0][1] });
          // Leave a little food where it died.
          s.body.forEach(([x, y], k) => { if (k % 3 === 1 && x >= 0 && y >= 0 && x < GW && y < GH) S.food.push([x, y]); });
          return;
        }
        s.body.unshift(heads[i]);
        const fi = S.food.findIndex(([fx, fy]) => fx === heads[i][0] && fy === heads[i][1]);
        if (fi >= 0) { S.food.splice(fi, 1); s.grow += 2; events.push({ k: "e", c: s.c, x: heads[i][0], y: heads[i][1] }); }
        if (s.grow > 0) s.grow--; else s.body.pop();
      });
      while (S.food.length < FOOD) addFood();
      if (S.food.length > 40) S.food.length = 40;
      const alive = S.snakes.filter((s) => s.alive);
      if (alive.length <= (S.snakes.length > 1 ? 1 : 0)) {
        const winner = alive[0] ? S.players.find((p) => p.id === alive[0].id) : null;
        if (winner) winner.wins++;
        S.rw = winner ? winner.id : -1;
        const champ = S.players.find((p) => p.wins >= WIN);
        S.phase = champ ? "done" : "pause";
        S.w = champ ? champ.id : null;
        S.timer = ROUND_PAUSE;
        publish(true, events);
        return;
      }
      publish(false, events);
    }
    function snapshot(full, events = []) {
      return {
        t: "k", n: S.n, phase: S.phase, rw: S.rw, w: S.w, tick: TICK_MS, count: S.phase === "count" ? S.timer : 0,
        players: full ? S.players : undefined,
        s: S.snakes.map((s) => ({ id: s.id, c: s.c, a: s.alive ? 1 : 0, d: s.dir, b: s.body.flat(), g: s.grow > 0 ? 1 : 0 })),
        f: S.food.flat(), e: events,
      };
    }
    const publish = (full, events) => out.all(snapshot(full, events));
    function leave(id) {
      const p = S.players.find((x) => x.id === id);
      if (p) p.gone = true;
      const s = S.snakes.find((x) => x.id === id);
      if (s) s.alive = false;
      if (S.players.filter((x) => !x.gone).length < 2 && S.phase !== "done") {
        const last = S.players.find((x) => !x.gone);
        S.phase = "done"; S.w = last ? last.id : null;
        publish(true);
      }
    }
    return { S, newMatch, queue, step, leave, snapshot };
  }

  // =====================================================================
  // UI + render
  // =====================================================================
  let room = null, sim = null, V = null, players = [], stopLoop = null, gotAt = 0, particles = [], lastCount = -1;

  function turn(d) {
    if (!room) return;
    if (room.isHost) sim.queue(room.myId, d);
    else room.send({ t: "d", d });
  }

  function onMsg(m) {
    if (m.t !== "k") return;
    const prev = V;
    V = m;
    gotAt = performance.now();
    if (m.players) { players = m.players; renderScores(); }
    for (const e of m.e || []) {
      const cx = (e.x + 0.5) * CELL, cy = (e.y + 0.5) * CELL;
      if (e.k === "x") { burst(cx, cy, COLORS[e.c], 28); GameUtil.sfx("boom"); }
      else if (e.k === "e") { burst(cx, cy, COLORS[e.c], 8); if (players[e.c] && players[e.c].id === room.myId) GameUtil.sfx("pop"); }
    }
    if (prev && prev.phase !== m.phase) {
      if (m.phase === "pause" || m.phase === "done") GameUtil.sfx(m.rw === room.myId ? "good" : "bad");
    }
    if (m.phase === "done" && (!prev || prev.phase !== "done")) {
      const won = m.w === room.myId;
      setTimeout(() => {
        GameUtil.sfx(won ? "win" : "lose");
        GameUtil.record("snake", won ? "win" : "loss");
        const winner = players.find((p) => p.id === m.w);
        results({
          title: won ? "You win!" : winner ? `${winner.name} wins` : "Game over",
          rows: [...players].sort((a, b) => b.wins - a.wins).map((p) => ({ p, value: `${p.wins} round${p.wins === 1 ? "" : "s"}`, win: p.id === m.w })),
          isHost: room.isHost, meId: room.myId, again: "Rematch",
        });
      }, 1200);
    } else if (m.phase !== "done") hideResults();
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

  function burst(x, y, color, n) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 300;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.4, color, sz: 3 + Math.random() * 5 });
    }
  }

  function render(dt) {
    const s = canvas._scale;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    for (let y = 0; y < GH; y++) for (let x = (y % 2); x < GW; x += 2) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);

    if (V) {
      // food
      const t = performance.now() / 400;
      for (let i = 0; i < V.f.length; i += 2) {
        const fx = (V.f[i] + 0.5) * CELL, fy = (V.f[i + 1] + 0.5) * CELL;
        ctx.shadowColor = "#f472b6"; ctx.shadowBlur = 16;
        ctx.fillStyle = "#f472b6";
        ctx.beginPath(); ctx.arc(fx, fy, CELL * 0.28 + Math.sin(t + i) * 1.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.shadowBlur = 0;
      // snakes: drawn as smooth lines that glide between cells (like Light Cycles), so the
      // board doesn't jump a whole square every tick.
      const frac = V.phase === "play" ? Math.min(1, (performance.now() - gotAt) / V.tick) : 0;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const sn of V.s) {
        const color = COLORS[sn.c], b = sn.b, n = b.length / 2;
        if (!n) continue;
        const f = sn.a ? frac : 0;
        const pt = (k) => [(b[k * 2] + 0.5) * CELL, (b[k * 2 + 1] + 0.5) * CELL];
        const [hx0, hy0] = pt(0);
        const hx = hx0 + DX[sn.d] * CELL * f, hy = hy0 + DY[sn.d] * CELL * f;
        const pts = [[hx, hy]];
        for (let k = 0; k < n; k++) pts.push(pt(k));
        if (n >= 2 && !sn.g) {
          // tail slides toward the next segment unless the snake is growing
          const [tx, ty] = pts[pts.length - 1], [px, py] = pts[pts.length - 2];
          pts[pts.length - 1] = [tx + (px - tx) * f, ty + (py - ty) * f];
        }
        ctx.globalAlpha = sn.a ? 1 : 0.25;
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.strokeStyle = color;
        ctx.lineWidth = CELL * 0.72;
        if (sn.a) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.lineWidth = CELL * 0.22;
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.stroke();
        // head + eyes
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(hx, hy, CELL * 0.46, 0, Math.PI * 2); ctx.fill();
        const ex = DX[sn.d], ey = DY[sn.d];
        ctx.fillStyle = "#0a0a0f";
        for (const side of [-1, 1]) {
          const px = hx + ex * 4 + (ey ? side * 5 : 0), py = hy + ey * 4 + (ex ? side * 5 : 0);
          ctx.beginPath(); ctx.arc(px, py, 2.6, 0, Math.PI * 2); ctx.fill();
        }
        if (room && players[sn.c] && players[sn.c].id === room.myId && V.phase === "count") label("YOU", hx, hy - 26, color);
        ctx.globalAlpha = 1;
      }
      if (V.phase === "count") {
        const left = Math.max(0, V.count - (performance.now() - gotAt) / 1000);
        const n = Math.ceil(left);
        if (n !== lastCount) { lastCount = n; GameUtil.sfx(n ? "tick" : "start"); }
        banner(n > 0 ? String(n) : "GO", 110);
      } else if (V.phase === "pause" || V.phase === "done") {
        const p = players.find((x) => x.id === V.rw);
        banner(p ? (p.id === room.myId ? "ROUND TO YOU" : `${p.name.toUpperCase()} TAKES IT`) : "NO SURVIVORS", 56);
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
    ctx.font = "600 14px 'Geist Mono', ui-monospace, monospace";
    const w = ctx.measureText(t).width + 16;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(x - w / 2, y - 11, w, 22, 11); ctx.fill();
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

  let last = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    if (sim) sim.step(dt);
    for (const p of particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9; }
    particles = particles.filter((p) => p.life > 0);
    render(dt);
  }
  addEventListener("resize", () => { if (!room) render(0); });
  render(0);

  $("again").addEventListener("click", () => { if (sim) sim.newMatch(); });

  Room.mount({
    game: "snake",
    title: "Snake Battle",
    subtitle: "Eat, grow, and make everyone else crash. Last snake alive takes the round; first to 3 wins. 2 to 4 players.",
    min: 2,
    max: 4,
    onStart(r) {
      room = r; V = null; particles = [];
      players = r.players.map((p, i) => ({ ...p, c: i, wins: 0 }));
      renderScores();
      if (r.isHost) {
        const out = { all: (m) => { r.broadcast(m); onMsg(m); } };
        sim = createSim(r, out);
        r.onData((from, m) => { if (m && m.t === "d") sim.queue(from, m.d | 0); });
        r.onLeave((id) => sim.leave(id));
        r.onRejoin((id) => r.sendTo(id, sim.snapshot(true)));
        setTimeout(() => sim && sim.newMatch(), 300);
      } else r.onData((_, m) => m && onMsg(m));
      last = performance.now();
      stopLoop = GameUtil.loop(frame);
      return () => {
        stopLoop();
        room = null; sim = null; V = null;
        hideResults();
        render(0);
      };
    },
  });
})();
