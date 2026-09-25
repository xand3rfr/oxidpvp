// Kart Racing, 1–6 players. Three laps around a top-down track; cars are ghosts (no crashing
// into each other). Each player drives their own car locally, so steering feels instant, and
// reports position and lap progress; the host keeps the standings and the finish order.
// Keyboard: arrows / WASD. Touch: push the stick where you want to go and the kart drives there.
(() => {
  const W = 1400, H = 860, TRACK_W = 118, LAPS = 3, COUNTDOWN = 3;
  const COLORS = ["#ff5b3a", "#4d8dff", "#22c55e", "#facc15", "#ec4899", "#14b8a6"];
  // Centerline: a wobbly loop around the middle of the map (clockwise on screen). The wobble
  // (three big lobes plus smaller ripples) makes bends of different sizes without ever crossing.
  const RAW = Array.from({ length: 28 }, (_, i) => {
    const t = (i / 28) * Math.PI * 2, r = 1 + 0.2 * Math.sin(3 * t + 0.6) + 0.07 * Math.cos(5 * t);
    return [700 + 500 * r * Math.cos(t), 430 + 290 * r * Math.sin(t)];
  });
  function smooth(pts, n) {    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[(i - 1 + pts.length) % pts.length], p1 = pts[i], p2 = pts[(i + 1) % pts.length], p3 = pts[(i + 2) % pts.length];
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        out.push([0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]);
      }
    }
    return out;
  }
  const TRACK = smooth(RAW, 8), NSEG = TRACK.length;
  const $ = (id) => document.getElementById(id);
  const { h, results, hideResults } = Party;
  const canvas = $("c"), ctx = canvas.getContext("2d");
  GameUtil.fitCanvas(canvas, W, H);

  // nearest centerline point to (x,y), searching near a hint index
  function nearest(x, y, hint = -1) {
    let best = 0, bd = Infinity;
    const scan = hint < 0 ? [...Array(NSEG).keys()] : Array.from({ length: 41 }, (_, k) => (hint - 20 + k + NSEG) % NSEG);
    for (const i of scan) { const d = (TRACK[i][0] - x) ** 2 + (TRACK[i][1] - y) ** 2; if (d < bd) { bd = d; best = i; } }
    return { i: best, d: Math.sqrt(bd) };
  }

  // ---------- input ----------
  const keys = {};
  let stick = { x: 0, y: 0, on: false };
  addEventListener("keydown", (e) => { if (e.target.tagName === "INPUT") return; keys[e.code] = true; if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault(); });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
  GameUtil.touchControls({ sticks: [{ side: "left", label: "Drive", onMove: (x, y, on) => { stick = { x, y, on }; } }] });

  // ---------- my car ----------
  let car = null;
  function resetCar(slot) {
    const a = Math.atan2(TRACK[1][1] - TRACK[0][1], TRACK[1][0] - TRACK[0][0]);
    const back = 60 + Math.floor(slot / 2) * 55, side = (slot % 2 ? 1 : -1) * 26;
    car = { x: TRACK[0][0] - Math.cos(a) * back - Math.sin(a) * side, y: TRACK[0][1] - Math.sin(a) * back + Math.cos(a) * side, a, v: 0, seg: NSEG - 3, lap: 0, half: false, fin: 0 };
  }
  function drive(dt, go) {
    if (!car) return;
    const onTrack = nearest(car.x, car.y, car.seg).d < TRACK_W / 2 + 6;
    const maxV = onTrack ? 520 : 200, accel = 620;
    let throttle = (keys.ArrowUp || keys.KeyW ? 1 : 0) - (keys.ArrowDown || keys.KeyS ? 1 : 0);
    let steer = (keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0);
    if (!throttle && !steer && stick.on && Math.hypot(stick.x, stick.y) > 0.25) {
      // Touch: steer toward the stick direction, throttle by how far it's pushed.
      const want = Math.atan2(stick.y, stick.x);
      let diff = ((want - car.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      steer = Math.max(-1, Math.min(1, diff * 2.2));
      throttle = Math.min(1, Math.hypot(stick.x, stick.y)) * (Math.abs(diff) > 2.4 ? 0.3 : 1);
    }
    if (!go) throttle = 0;
    if (throttle > 0) car.v += accel * throttle * dt;
    else if (throttle < 0) car.v += (car.v > 0 ? -900 : -300) * -throttle * dt;
    car.v *= Math.exp(-(onTrack ? 0.8 : 3.2) * dt);
    car.v = Math.max(-160, Math.min(maxV, car.v));
    const turn = 2.8 * Math.min(1, Math.abs(car.v) / 220) * Math.sign(car.v);
    car.a += steer * turn * dt;
    car.x += Math.cos(car.a) * car.v * dt;
    car.y += Math.sin(car.a) * car.v * dt;
    car.x = Math.max(20, Math.min(W - 20, car.x)); car.y = Math.max(20, Math.min(H - 20, car.y));
    // progress: laps count when crossing the start going forward, having been past halfway
    const n = nearest(car.x, car.y, car.seg);
    const prev = car.seg;
    car.seg = n.i;
    if (Math.abs(n.i - NSEG / 2) < 20) car.half = true;
    if (prev > NSEG - 25 && n.i < 25 && car.half) { car.lap++; car.half = false; GameUtil.sfx(car.lap >= LAPS ? "win" : "good"); }
    if (prev < 25 && n.i > NSEG - 25 && car.lap > 0 && !car.half) car.lap--; // backed over the line
  }
  const progressOf = (lap, seg) => lap * NSEG + seg;

  // =====================================================================
  // Host: standings
  // =====================================================================
  let room = null, R = null, V = null, players = [], stopLoop = null, sendAcc = 0, lastCount = -1, others = new Map();
  function hostNewRace() {
    R = { phase: "count", start: Date.now() + COUNTDOWN * 1000, cars: {}, order: [], n: (R ? R.n : 0) + 1, firstFin: 0, ended: false };
    hostPublish(true);
  }
  function hostReport(id, m) {
    if (!R || R.phase === "end") return;
    const c = R.cars[id] || (R.cars[id] = { fin: 0 });
    Object.assign(c, { x: +m.x || 0, y: +m.y || 0, a: +m.a || 0, lap: Math.max(0, m.lap | 0), seg: m.seg | 0 });
    if (R.phase === "race" && c.lap >= LAPS && !c.fin) {
      c.fin = Date.now() - R.start;
      R.order.push(id);
      if (!R.firstFin) R.firstFin = Date.now();
    }
  }
  function hostTick() {
    if (!R) return;
    if (R.phase === "count" && Date.now() >= R.start) R.phase = "race";
    const racers = room.players.map((p) => p.id);
    if (R.phase === "race" && !R.ended && (racers.every((id) => R.cars[id] && R.cars[id].fin) || (R.firstFin && Date.now() - R.firstFin > 30000))) { R.phase = "end"; R.ended = true; hostPublish(true); }
  }
  function hostPublish(full) {
    const m = { t: "r", ph: R.phase, n: R.n, left: Math.max(0, R.start - Date.now()), cars: Object.entries(R.cars).map(([id, c]) => [+id, Math.round(c.x), Math.round(c.y), Math.round(c.a * 100) / 100, c.lap, c.seg, c.fin]), order: R.order };
    if (full) m.players = room.players;
    room.broadcast(m);
    onRace(m);
  }

  // =====================================================================
  // Client
  // =====================================================================
  function onRace(m) {
    gotAt = performance.now();
    const prev = V;
    V = m;
    if (m.players) players = m.players;
    if (!prev || prev.n !== m.n) { resetCar(players.findIndex((p) => p.id === room.myId)); others = new Map(); lastCount = -1; hideResults(); }
    for (const [id, x, y, a] of m.cars) {
      if (id === room.myId) continue;
      const o = others.get(id) || { x, y, a };
      o.tx = x; o.ty = y; o.ta = a;
      others.set(id, o);
    }
    if (m.ph === "end" && prev && prev.ph !== "end") {
      const place = m.order.indexOf(room.myId) + 1, solo = players.length === 1;
      GameUtil.sfx(place === 1 ? "win" : "lose");
      if (!solo) GameUtil.record("racing", place === 1 ? "win" : "loss");
      const rows = players.map((p) => { const c = m.cars.find((x) => x[0] === p.id); return { p, fin: c ? c[6] : 0, prog: c ? progressOf(c[4], c[5]) : 0 }; })
        .sort((a, b) => (a.fin && b.fin ? a.fin - b.fin : a.fin ? -1 : b.fin ? 1 : b.prog - a.prog))
        .map((r, i) => ({ p: r.p, value: r.fin ? `${(r.fin / 1000).toFixed(2)}s` : "DNF", win: i === 0 && !!r.fin }));
      setTimeout(() => results({ title: solo ? (rows[0].value !== "DNF" ? `Finished in ${rows[0].value}` : "Time's up") : place === 1 ? "You win the race!" : place ? `You finished #${place}` : "Race over", rows, isHost: room.isHost, meId: room.myId, again: "Race again" }), 900);
    }
  }
  function place() {
    if (!V) return 0;
    const me = { id: room.myId, p: car ? progressOf(car.lap, car.seg) : 0 };
    const all = [me, ...V.cars.filter((c) => c[0] !== room.myId).map((c) => ({ id: c[0], p: c[6] ? 1e9 - c[6] : progressOf(c[4], c[5]) }))];
    if (car && car.lap >= LAPS) me.p = 1e9 - ((V.cars.find((c) => c[0] === room.myId) || [])[6] || 0);
    return all.sort((a, b) => b.p - a.p).findIndex((x) => x.id === room.myId) + 1;
  }

  // ---------- rendering ----------
  let trackCache = null;
  function drawTrack() {
    if (!trackCache) {
      trackCache = document.createElement("canvas");
      trackCache.width = W; trackCache.height = H;
      const c = trackCache.getContext("2d");
      c.fillStyle = "#2f6b2a"; c.fillRect(0, 0, W, H);
      c.fillStyle = "rgba(255,255,255,.035)";
      for (let x = 0; x < W; x += 60) c.fillRect(x, 0, 30, H);
      const path = () => { c.beginPath(); TRACK.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); };
      c.lineJoin = c.lineCap = "round";
      path(); c.lineWidth = TRACK_W + 16; c.strokeStyle = "#e5e7eb"; c.stroke();
      path(); c.lineWidth = TRACK_W + 16; c.setLineDash([18, 18]); c.strokeStyle = "#dc2626"; c.stroke(); c.setLineDash([]);
      path(); c.lineWidth = TRACK_W; c.strokeStyle = "#3f3f46"; c.stroke();
      path(); c.lineWidth = 3; c.setLineDash([22, 26]); c.strokeStyle = "rgba(255,255,255,.35)"; c.stroke(); c.setLineDash([]);
      // start/finish line
      const [x0, y0] = TRACK[0], [x1, y1] = TRACK[1], a = Math.atan2(y1 - y0, x1 - x0);
      c.save(); c.translate(x0, y0); c.rotate(a);
      for (let k = -TRACK_W / 2; k < TRACK_W / 2; k += 12) for (let j = 0; j < 2; j++) { c.fillStyle = ((k / 12 + j) & 1) ? "#fff" : "#111"; c.fillRect(j * 10 - 10, k, 10, 12); }
      c.restore();
    }
    ctx.drawImage(trackCache, 0, 0);
  }
  function drawCar(x, y, a, color, me) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fillRect(-15, -8, 34, 20);
    ctx.fillStyle = "#111"; ctx.fillRect(-12, -12, 9, 5); ctx.fillRect(-12, 7, 9, 5); ctx.fillRect(8, -12, 9, 5); ctx.fillRect(8, 7, 9, 5);
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(-16, -9, 34, 18, 6); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.fillRect(4, -6, 7, 12);
    ctx.restore();
    if (me) { ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.stroke(); }
  }
  function render(dt) {
    const sc = canvas._scale;
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    drawTrack();
    if (!V) return;
    const k = 1 - Math.exp(-dt * 15);
    for (const [id, o] of others) {
      o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k;
      o.a += (((o.ta - o.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * k;
      const i = players.findIndex((p) => p.id === id);
      if (i >= 0) drawCar(o.x, o.y, o.a, COLORS[i % COLORS.length], false);
    }
    if (car) drawCar(car.x, car.y, car.a, COLORS[Math.max(0, players.findIndex((p) => p.id === room.myId)) % COLORS.length], true);
    // HUD
    ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(16, 16, 230, 70);
    ctx.fillStyle = "#fff"; ctx.font = "700 22px Geist, system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`Lap ${Math.min(LAPS, (car ? car.lap : 0) + 1)} / ${LAPS}`, 30, 26);
    ctx.font = "600 16px 'Geist Mono', monospace";
    const pl = place();
    ctx.fillText(`${pl ? ["1st", "2nd", "3rd", "4th", "5th", "6th"][pl - 1] : ""} · ${Math.round(Math.abs(car ? car.v : 0) / 5)} km/h`, 30, 56);
    const left = V.ph === "count" ? V.left - (performance.now() - gotAt) : 0;
    if (V.ph === "count") {
      const n = Math.ceil(left / 1000);
      if (n !== lastCount) { lastCount = n; GameUtil.sfx(n > 0 ? "tick" : "start"); }
      ctx.font = "800 110px Geist, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = 30; ctx.fillText(n > 0 ? String(n) : "GO!", W / 2, H / 2); ctx.shadowBlur = 0;
    }
    if (car && car.lap >= LAPS) { ctx.font = "800 56px Geist, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText("FINISHED!", W / 2, 120); }
  }

  let last = 0, gotAt = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    if (room && V) {
      const go = V.ph === "race" || (V.ph === "count" && V.left - (now - gotAt) <= 0);
      if (!(car && car.lap >= LAPS)) drive(dt, go && V.ph !== "end");
      else if (car) { car.v *= Math.exp(-3 * dt); drive(dt, false); }
      sendAcc += dt;
      if (sendAcc > 1 / 20 && car) {
        sendAcc = 0;
        const m = { t: "p", x: Math.round(car.x), y: Math.round(car.y), a: Math.round(car.a * 100) / 100, lap: car.lap, seg: car.seg };
        if (room.isHost) { hostReport(room.myId, m); hostTick(); hostPublish(false); } else room.send(m);
      }
    }
    render(dt);
  }
  addEventListener("resize", () => { if (!room) render(0); });

  $("again").addEventListener("click", () => { if (room && room.isHost) hostNewRace(); });

  Room.mount({
    game: "racing",
    title: "Kart Racing",
    subtitle: "Three laps, up to six karts. Arrow keys, WASD or the touch stick. 1 to 6 players.",
    min: 1,
    max: 6,
    onStart(r) {
      room = r; V = null; R = null; players = r.players; others = new Map();
      if (r.isHost) {
        r.onData((from, m) => { if (m && m.t === "p") hostReport(from, m); });
        r.onLeave(() => {});
        r.onRejoin(() => hostPublish(true));
        setTimeout(() => room && hostNewRace(), 300);
      } else r.onData((_, m) => { if (m && m.t === "r") onRace(m); });
      last = performance.now();
      stopLoop = GameUtil.loop(frame);
      return () => { stopLoop(); room = null; V = null; R = null; car = null; hideResults(); render(0); };
    },
  });
  render(0);
  window.__race = { car: () => car, track: TRACK }; // for automated tests
})();
