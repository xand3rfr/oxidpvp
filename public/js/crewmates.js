// Crewmates, 4–10 players. Walk around the ship doing tasks. One or two players are secretly
// impostors who can take out crewmates when nobody's looking. Find a body? Report it (or hit the
// emergency button) to call a meeting, talk in chat and vote someone off the ship.
// Crew win by finishing every task or ejecting all impostors; impostors win when they equal the crew.
// Movement is local (smooth) and streamed; the host owns roles, kills, tasks, meetings and votes.
(() => {
  const W = 1700, H = 1080, R = 18, SPEED = 230, VIEW_W = 960, VIEW_H = 600;
  const KILL_RANGE = 80, REPORT_RANGE = 110, USE_RANGE = 60, KILL_CD = 25, TASK_TIME = 2.6, MEET_MS = 70000, EJECT_MS = 6000, TASKS_EACH = 4;
  const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#ec4899", "#f97316", "#a855f7", "#14b8a6", "#e5e7eb", "#78716c"];
  // Floor = union of rectangles (rooms and hallways). Everything else is wall.
  const ROOMS = [
    { n: "Cafeteria", x: 620, y: 60, w: 460, h: 300 },
    { n: "Weapons", x: 1260, y: 80, w: 300, h: 220 },
    { n: "Navigation", x: 1380, y: 440, w: 260, h: 240 },
    { n: "Shields", x: 1180, y: 800, w: 300, h: 220 },
    { n: "Storage", x: 700, y: 700, w: 320, h: 300 },
    { n: "Electrical", x: 360, y: 560, w: 260, h: 220 },
    { n: "Reactor", x: 60, y: 380, w: 240, h: 300 },
    { n: "MedBay", x: 200, y: 80, w: 280, h: 220 },
    { n: "Admin", x: 1040, y: 480, w: 240, h: 180 },
  ];
  const HALLS = [
    { x: 480, y: 170, w: 140, h: 70 }, { x: 1080, y: 160, w: 180, h: 70 }, { x: 1420, y: 300, w: 70, h: 140 },
    { x: 1400, y: 680, w: 70, h: 120 }, { x: 1020, y: 860, w: 160, h: 70 }, { x: 820, y: 360, w: 70, h: 340 },
    { x: 620, y: 620, w: 80, h: 70 }, { x: 300, y: 500, w: 60, h: 80 }, { x: 170, y: 300, w: 70, h: 80 },
    { x: 890, y: 540, w: 150, h: 70 }, { x: 1280, y: 540, w: 100, h: 70 },
  ];
  const FLOOR = [...ROOMS, ...HALLS];
  const TASKS = [
    { id: 0, n: "Empty trash", x: 700, y: 320 }, { id: 1, n: "Calibrate guns", x: 1500, y: 130 }, { id: 2, n: "Chart course", x: 1580, y: 560 },
    { id: 3, n: "Prime shields", x: 1330, y: 980 }, { id: 4, n: "Fuel engines", x: 760, y: 950 }, { id: 5, n: "Fix wiring", x: 420, y: 740 },
    { id: 6, n: "Start reactor", x: 110, y: 530 }, { id: 7, n: "Scan sample", x: 260, y: 250 }, { id: 8, n: "Swipe card", x: 1160, y: 620 },
    { id: 9, n: "Clean vent", x: 1000, y: 110 }, { id: 10, n: "Download data", x: 560, y: 600 }, { id: 11, n: "Stabilize steering", x: 1600, y: 660 },
  ];
  const BUTTON = { x: 850, y: 210 };
  const SPAWN = (i, n) => { const a = (i / n) * Math.PI * 2; return { x: 850 + Math.cos(a) * 110, y: 210 + Math.sin(a) * 80 }; };
  const $ = (id) => document.getElementById(id);
  const { h, fmt, results, hideResults, countdown } = Party;
  // A circle of radius m at (x,y) fits if its center and four edge points are all on some floor
  // rectangle (not necessarily the same one), so doorways between rooms and halls just work.
  const onFloor = (x, y) => FLOOR.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  const inside = (x, y, m = R - 4) => [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m]].every(([dx, dy]) => onFloor(x + dx, y + dy));
  const canvas = $("c"), ctx = canvas.getContext("2d");
  GameUtil.fitCanvas(canvas, VIEW_W, VIEW_H);

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], phase: "idle", pos: new Map(), bodies: [], meet: null, winner: null, timer: 0, killAt: new Map(), gone: new Set() };
    const P = (id) => G.players.find((p) => p.id === id);
    const crewAlive = () => G.players.filter((p) => p.alive && p.role === "crew");
    const impAlive = () => G.players.filter((p) => p.alive && p.role === "imp");
    const taskTotals = () => { let done = 0, all = 0; for (const p of G.players) if (p.role === "crew" && !G.gone.has(p.id)) { all += p.tasks.length; done += p.tasks.filter((t) => t.done).length; } return { done, all }; };
    const view = (id) => {
      const me = P(id), over = G.phase === "end";
      return {
        t: "st", phase: G.phase, winner: G.winner,
        me: me ? { role: me.role, alive: me.alive, tasks: me.tasks, cd: me.role === "imp" ? Math.max(0, ((G.killAt.get(id) || 0) - Date.now()) / 1000) : 0, emerg: me.emerg, c: me.c } : null,
        players: G.players.map((p) => ({ id: p.id, name: p.name, av: p.av, c: p.c, alive: p.alive, role: over || (me && me.role === "imp" && p.role === "imp") || p.id === id ? p.role : null })),
        bodies: G.bodies, bar: taskTotals(), meet: G.meet ? { ...G.meet, votes: G.meet.phase === "vote" ? Object.fromEntries(Object.keys(G.meet.votes).map((k) => [k, true])) : G.meet.votes, left: Math.max(0, G.meet.ends - Date.now()) } : null,
      };
    };
    const publish = () => { for (const p of room.players) if (!G.gone.has(p.id)) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer);
      const ps = room.players.filter((p) => !G.gone.has(p.id));
      const nImp = ps.length >= 7 ? 2 : 1;
      const imps = new Set(GameUtil.shuffle(ps.map((p) => p.id)).slice(0, nImp));
      G.players = ps.map((p, i) => ({
        id: p.id, name: p.name, av: p.av, c: i % COLORS.length, alive: true, emerg: 1,
        role: imps.has(p.id) ? "imp" : "crew",
        tasks: GameUtil.shuffle(TASKS.map((t) => t.id)).slice(0, TASKS_EACH).map((t) => ({ id: t, done: false })),
      }));
      G.bodies = []; G.meet = null; G.winner = null; G.pos = new Map();
      G.players.forEach((p, i) => G.pos.set(p.id, SPAWN(i, G.players.length)));
      for (const p of G.players) if (p.role === "imp") G.killAt.set(p.id, Date.now() + 12000);
      G.phase = "play";
      out.all({ t: "tp", pos: [...G.pos.entries()] });
      publish();
    }
    function move(id, x, y) {
      const p = P(id);
      if (!p || G.phase !== "play") return;
      G.pos.set(id, { x: +x || 0, y: +y || 0 });
    }
    const dist = (a, b) => { const A = G.pos.get(a), B = typeof b === "number" ? G.pos.get(b) : b; return A && B ? Math.hypot(A.x - B.x, A.y - B.y) : Infinity; };
    function kill(id) {
      const p = P(id);
      if (G.phase !== "play" || !p || !p.alive || p.role !== "imp" || Date.now() < (G.killAt.get(id) || 0)) return;
      let best = null, bd = KILL_RANGE + 15;
      for (const q of G.players) if (q.alive && q.role === "crew") { const d = dist(id, q.id); if (d < bd) { bd = d; best = q; } }
      if (!best) return;
      best.alive = false;
      const at = G.pos.get(best.id);
      G.bodies.push({ id: best.id, c: best.c, x: Math.round(at.x), y: Math.round(at.y) });
      G.killAt.set(id, Date.now() + KILL_CD * 1000);
      out.all({ t: "fx", k: "kill", x: at.x, y: at.y });
      if (!checkWin()) publish();
    }
    function task(id, taskId) {
      const p = P(id);
      if (G.phase !== "play" || !p || p.role !== "crew") return;
      const t = p.tasks.find((x) => x.id === taskId);
      const spot = TASKS.find((x) => x.id === taskId);
      if (!t || t.done || !spot || dist(id, spot) > USE_RANGE + 40) return;
      t.done = true;
      if (!checkWin()) publish();
    }
    function meeting(id, kind) {
      const p = P(id);
      if (G.phase !== "play" || !p || !p.alive) return;
      let body = null;
      if (kind === "report") {
        body = G.bodies.find((b) => dist(id, b) < REPORT_RANGE + 30);
        if (!body) return;
      } else {
        if (p.emerg <= 0 || dist(id, BUTTON) > 110) return;
        p.emerg--;
      }
      G.phase = "meet";
      G.meet = { by: id, body: body ? body.id : null, phase: "vote", votes: {}, ends: Date.now() + MEET_MS, result: null };
      G.bodies = [];
      clearTimeout(G.timer);
      G.timer = setTimeout(tally, MEET_MS);
      out.all({ t: "fx", k: "meet" });
      publish();
    }
    function vote(id, target) {
      const p = P(id);
      if (G.phase !== "meet" || G.meet.phase !== "vote" || !p || !p.alive || id in G.meet.votes) return;
      if (target !== -1 && !(P(target) && P(target).alive)) return;
      G.meet.votes[id] = target;
      if (G.players.filter((q) => q.alive).every((q) => q.id in G.meet.votes)) { clearTimeout(G.timer); G.timer = setTimeout(tally, 800); }
      publish();
    }
    function tally() {
      if (G.phase !== "meet" || G.meet.phase !== "vote") return;
      const count = {};
      for (const t of Object.values(G.meet.votes)) count[t] = (count[t] || 0) + 1;
      const top = Math.max(0, ...Object.values(count));
      const tops = Object.keys(count).filter((k) => count[k] === top).map(Number);
      let out = null;
      if (top > 0 && tops.length === 1 && tops[0] !== -1) { out = tops[0]; P(out).alive = false; }
      G.meet.phase = "eject";
      G.meet.result = { out, imp: out != null ? P(out).role === "imp" : null, left: impAlive().length };
      G.meet.ends = Date.now() + EJECT_MS;
      publish();
      clearTimeout(G.timer);
      G.timer = setTimeout(() => {
        if (checkWin()) return;
        G.phase = "play"; G.meet = null;
        const alive = G.players.filter((p) => p.alive);
        G.players.forEach((p, i) => G.pos.set(p.id, SPAWN(i, G.players.length)));
        for (const p of alive) if (p.role === "imp") G.killAt.set(p.id, Date.now() + KILL_CD * 1000);
        outAll({ t: "tp", pos: [...G.pos.entries()] });
        publish();
      }, EJECT_MS);
    }
    const outAll = (m) => out.all(m);
    function checkWin() {
      const { done, all } = taskTotals();
      if (impAlive().length === 0) G.winner = "crew";
      else if (all > 0 && done >= all) G.winner = "crew";
      else if (impAlive().length >= crewAlive().length) G.winner = "imp";
      if (!G.winner) return false;
      clearTimeout(G.timer);
      G.phase = "end";
      publish();
      return true;
    }
    function leave(id) {
      G.gone.add(id);
      const p = P(id);
      if (p) p.alive = false;
      if (G.phase !== "end" && G.players.length && !checkWin()) publish();
    }
    function positions() { return [...G.pos.entries()].filter(([id]) => P(id)).map(([id, p]) => [id, Math.round(p.x), Math.round(p.y)]); }
    return { G, newGame, move, kill, task, meeting, vote, leave, view, positions, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // Client
  // =====================================================================
  let room = null, engine = null, V = null, stopLoop = null, stopClock = null;
  let me = { x: 850, y: 210, face: 1, walk: 0 }, others = new Map(), taskHold = null, sendAcc = 0, posAcc = 0, fx = [];
  const keys = {};
  let stick = { x: 0, y: 0 };
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    keys[e.code] = true;
    if (e.code === "KeyE") useBtn();
    if (e.code === "KeyQ") act({ t: "kill" });
    if (e.code === "KeyR") act({ t: "report" });
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; if (e.code === "KeyE") taskHold = null; });
  addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
  GameUtil.touchControls({ sticks: [{ side: "left", label: "Move", onMove: (x, y) => { stick = { x, y }; } }] });

  const act = (m) => {
    if (!room) return;
    if (room.isHost) hostHandle(room.myId, m); else room.send(m);
  };
  function hostHandle(from, m) {
    if (!engine || !m) return;
    if (m.t === "mv") engine.move(from, m.x, m.y);
    else if (m.t === "kill") engine.kill(from);
    else if (m.t === "task") engine.task(from, m.id | 0);
    else if (m.t === "report") engine.meeting(from, "report");
    else if (m.t === "emerg") engine.meeting(from, "emergency");
    else if (m.t === "vote") engine.vote(from, m.target | 0);
  }
  const myP = () => V && V.players.find((p) => p.id === room.myId);
  const nearTask = () => {
    if (!V || !V.me || V.me.role !== "crew") return null;
    for (const t of V.me.tasks) { if (t.done) continue; const s = TASKS[t.id]; if (Math.hypot(s.x - me.x, s.y - me.y) < USE_RANGE) return s; }
    return null;
  };
  function useBtn() {
    if (!V || V.phase !== "play") return;
    if (Math.hypot(BUTTON.x - me.x, BUTTON.y - me.y) < 90 && V.me && V.me.alive && V.me.emerg > 0) { act({ t: "emerg" }); return; }
    const t = nearTask();
    if (t && !taskHold) taskHold = { id: t.id, t: 0 };
  }
  $("useBtn").addEventListener("pointerdown", (e) => { e.preventDefault(); useBtn(); });
  $("useBtn").addEventListener("pointerup", () => { taskHold = null; });
  $("useBtn").addEventListener("pointerleave", () => { taskHold = null; });
  $("killBtn").addEventListener("click", () => act({ t: "kill" }));
  $("reportBtn").addEventListener("click", () => act({ t: "report" }));
  $("skipBtn").addEventListener("click", () => act({ t: "vote", target: -1 }));

  function step(dt) {
    if (!V || V.phase !== "play") return;
    let x = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    let y = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
    if (!x && !y && Math.hypot(stick.x, stick.y) > 0.15) { x = stick.x; y = stick.y; }
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    const ghost = V.me && !V.me.alive;
    if (taskHold) { x = 0; y = 0; }
    const nx = me.x + x * SPEED * dt, ny = me.y + y * SPEED * dt;
    if (ghost || inside(nx, me.y)) me.x = Math.max(0, Math.min(W, nx));
    if (ghost || inside(me.x, ny)) me.y = Math.max(0, Math.min(H, ny));
    if (x) me.face = Math.sign(x);
    me.walk = l > 0.1 ? me.walk + dt * 10 : 0;
    if (taskHold) {
      const s = TASKS[taskHold.id];
      if (Math.hypot(s.x - me.x, s.y - me.y) > USE_RANGE) taskHold = null;
      else { taskHold.t += dt; if (taskHold.t >= TASK_TIME) { act({ t: "task", id: taskHold.id }); GameUtil.sfx("good"); taskHold = null; } }
    }
    sendAcc += dt;
    if (sendAcc > 1 / 15) { sendAcc = 0; act({ t: "mv", x: Math.round(me.x), y: Math.round(me.y) }); }
  }

  function onState(v) {
    const prev = V;
    V = v;
    const meP = myP();
    if (!prev && v.me) GameUtil.toast(v.me.role === "imp" ? "🔪 You're an IMPOSTOR. Don't get caught." : "🧑‍🚀 You're a crewmate. Do your tasks!", 3500);
    if (prev && prev.me && v.me && prev.me.alive && !v.me.alive && v.phase === "play") { GameUtil.sfx("boom"); GameUtil.toast("You were eliminated! Keep doing tasks as a ghost."); }
    renderHud();
    if (stopClock) stopClock();
    if (v.meet) stopClock = countdown(performance.now() + v.meet.left, (left) => { $("meetTimer").textContent = v.meet && v.meet.phase === "vote" ? fmt(left) : ""; });
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const won = v.me && v.me.role === v.winner;
      GameUtil.sfx(won ? "win" : "lose");
      if (v.me) GameUtil.record("crew", won ? "win" : "loss");
      results({
        title: v.winner === "imp" ? "🔪 Impostors win!" : "🧑‍🚀 Crewmates win!",
        rows: v.players.map((p) => ({ p, value: (p.role === "imp" ? "Impostor" : "Crewmate") + (p.alive ? "" : " · out"), win: p.role === v.winner })),
        isHost: room.isHost, meId: room.myId,
      });
    } else if (v.phase !== "end") hideResults();
    void meP;
  }
  function renderHud() {
    const v = V;
    if (!v) return;
    $("bar").style.width = v.bar.all ? (v.bar.done / v.bar.all) * 100 + "%" : "0%";
    const list = $("tasks");
    list.textContent = "";
    if (v.me && v.me.role === "crew") for (const t of v.me.tasks) list.append(h("li", t.done ? "done" : "", `${TASKS[t.id].n} (${roomOf(TASKS[t.id])})`));
    else if (v.me && v.me.role === "imp") { list.append(h("li", "imp", "Take out crewmates. Don't get caught.")); const mates = v.players.filter((p) => p.role === "imp" && p.id !== room.myId); if (mates.length) list.append(h("li", "imp", "Partner: " + mates.map((p) => p.name).join(", "))); }
    $("roleTag").textContent = v.me ? (v.me.role === "imp" ? "IMPOSTOR" : "CREWMATE") + (v.me.alive ? "" : " · GHOST") : "";
    $("roleTag").className = "cm-role " + (v.me ? v.me.role : "");
    // meeting overlay
    const m = v.meet;
    $("meeting").hidden = !m;
    if (m) {
      const by = v.players.find((p) => p.id === m.by);
      $("meetTitle").textContent = m.phase === "eject" ? (m.result.out == null ? "Nobody was ejected." : `${nameOf(m.result.out)} was ${m.result.imp ? "" : "not "}an impostor.`) : m.body != null ? `${by ? by.name : "Someone"} found ${nameOf(m.body)}'s body!` : `${by ? by.name : "Someone"} called an emergency meeting!`;
      $("meetSub").textContent = m.phase === "eject" ? `${m.result.left} impostor${m.result.left === 1 ? "" : "s"} remain${m.result.left === 1 ? "s" : ""}.` : "Discuss in the chat, then vote.";
      const vl = $("voteList");
      vl.textContent = "";
      const iVoted = m.votes && room.myId in m.votes;
      const canVote = m.phase === "vote" && v.me && v.me.alive && !iVoted;
      for (const p of v.players) {
        const el = h(canVote && p.alive ? "button" : "div", "cm-vote" + (p.alive ? "" : " dead") + (m.votes && m.votes[p.id] ? " voted" : ""));
        if (el.tagName === "BUTTON") { el.type = "button"; el.addEventListener("click", () => { GameUtil.sfx("click"); act({ t: "vote", target: p.id }); }); }
        const dot = h("i", "cm-dot"); dot.style.background = COLORS[p.c];
        el.append(dot, h("span", "", p.name + (p.id === room.myId ? " (you)" : "")));
        if (p.role === "imp") el.append(h("small", "", "impostor"));
        if (m.phase === "eject" && m.votes) { const n = Object.values(m.votes).filter((t) => t === p.id).length; if (n) el.append(h("b", "", `${n} vote${n === 1 ? "" : "s"}`)); }
        else if (m.votes && m.votes[p.id]) el.append(h("b", "", "voted"));
        vl.append(el);
      }
      $("skipBtn").hidden = !canVote;
    }
  }
  const nameOf = (id) => { const p = V && V.players.find((x) => x.id === id); return p ? (p.id === room.myId ? "You" : p.name) : "?"; };
  const roomOf = (pt) => { const r = ROOMS.find((q) => pt.x >= q.x && pt.x <= q.x + q.w && pt.y >= q.y && pt.y <= q.y + q.h); return r ? r.n : "hallway"; };

  // ---------- drawing ----------
  function drawCrew(x, y, c, face, walk, ghost, name) {
    ctx.save();
    ctx.translate(x, y);
    if (ghost) ctx.globalAlpha = 0.45;
    const bob = Math.sin(walk) * 2;
    ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(0, R + 2, R * 0.9, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.scale(face, 1);
    ctx.fillStyle = COLORS[c];
    ctx.beginPath(); ctx.roundRect(-R, -R - 4 + bob, R * 2, R * 2 + 6, [R, R, 8, 8]); ctx.fill();
    ctx.fillRect(-R - 7, -4 + bob, 8, 16); // backpack
    ctx.fillStyle = "#9ad8ff"; ctx.beginPath(); ctx.roundRect(-2, -R + 2 + bob, R + 4, 12, 6); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.6)"; ctx.fillRect(4, -R + 4 + bob, 8, 3);
    ctx.restore();
    ctx.globalAlpha = ghost ? 0.5 : 1;
    ctx.font = "600 12px Geist, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#fff";
    ctx.fillText(name, x, y - R - 12);
    ctx.globalAlpha = 1;
  }
  function render(dt) {
    const sc = canvas._scale;
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    ctx.fillStyle = "#05060a"; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    if (!V) return;
    const camX = Math.max(0, Math.min(W - VIEW_W, me.x - VIEW_W / 2)), camY = Math.max(0, Math.min(H - VIEW_H, me.y - VIEW_H / 2));
    ctx.save();
    ctx.translate(-camX, -camY);
    // floor
    for (const r of FLOOR) { ctx.fillStyle = ROOMS.includes(r) ? "#2a3140" : "#232936"; ctx.fillRect(r.x, r.y, r.w, r.h); }
    ctx.strokeStyle = "rgba(255,255,255,.04)";
    for (const r of ROOMS) { for (let gx = r.x; gx < r.x + r.w; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, r.y); ctx.lineTo(gx, r.y + r.h); ctx.stroke(); } }
    ctx.font = "700 15px Geist, system-ui, sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "rgba(255,255,255,.28)";
    for (const r of ROOMS) ctx.fillText(r.n.toUpperCase(), r.x + 12, r.y + 24);
    // emergency button
    ctx.fillStyle = "#7f1d1d"; ctx.beginPath(); ctx.arc(BUTTON.x, BUTTON.y, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ef4444"; ctx.beginPath(); ctx.arc(BUTTON.x, BUTTON.y - 3, 19, 0, Math.PI * 2); ctx.fill();
    // my task spots
    if (V.me && V.me.role === "crew") for (const t of V.me.tasks) if (!t.done) {
      const s = TASKS[t.id], pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
      ctx.strokeStyle = `rgba(250,204,21,${0.5 + pulse * 0.5})`; ctx.lineWidth = 3;
      ctx.strokeRect(s.x - 16, s.y - 16, 32, 32);
      ctx.fillStyle = "rgba(250,204,21,.18)"; ctx.fillRect(s.x - 16, s.y - 16, 32, 32);
    }
    // bodies
    for (const b of V.bodies) {
      ctx.fillStyle = COLORS[b.c]; ctx.beginPath(); ctx.ellipse(b.x, b.y + 8, R, R * 0.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#e5e7eb"; ctx.fillRect(b.x - 3, b.y - 14, 6, 16);
    }
    // other players
    const iAmGhost = V.me && !V.me.alive;
    const k = 1 - Math.exp(-dt * 12);
    for (const p of V.players) {
      if (p.id === room.myId) continue;
      const o = others.get(p.id);
      if (!o) continue;
      const moved = Math.hypot(o.tx - o.x, o.ty - o.y) > 1;
      if (o.tx !== o.x) o.face = Math.sign(o.tx - o.x) || o.face;
      o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k;
      o.walk = moved ? (o.walk || 0) + dt * 10 : 0;
      if (!p.alive && !iAmGhost) continue; // ghosts are invisible to the living
      drawCrew(o.x, o.y, p.c, o.face || 1, o.walk, !p.alive, p.name);
    }
    const mp = myP();
    if (mp) drawCrew(me.x, me.y, mp.c, me.face, me.walk, !mp.alive, mp.name);
    for (const f of fx) { f.life -= dt; ctx.globalAlpha = Math.max(0, f.life); ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(f.x, f.y, (1 - f.life) * 60 + 10, 0, Math.PI * 2); ctx.stroke(); }
    fx = fx.filter((f) => f.life > 0);
    ctx.globalAlpha = 1;
    ctx.restore();
    // vision: darkness outside a circle around you (ghosts and impostors see farther)
    const vision = iAmGhost ? 900 : V.me && V.me.role === "imp" ? 360 : 270;
    const g = ctx.createRadialGradient(me.x - camX, me.y - camY, vision * 0.6, me.x - camX, me.y - camY, vision);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.92)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // task progress ring
    if (taskHold) {
      ctx.strokeStyle = "#facc15"; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(me.x - camX, me.y - camY, 34, -Math.PI / 2, -Math.PI / 2 + (taskHold.t / TASK_TIME) * Math.PI * 2); ctx.stroke();
    }
    // action buttons state
    const alive = V.me && V.me.alive, play = V.phase === "play";
    const nearBody = alive && V.bodies.some((b) => Math.hypot(b.x - me.x, b.y - me.y) < REPORT_RANGE);
    const nearBtn = alive && V.me.emerg > 0 && Math.hypot(BUTTON.x - me.x, BUTTON.y - me.y) < 90;
    const canKill = alive && V.me.role === "imp" && V.me.cd <= 0 && V.players.some((p) => p.alive && p.role !== "imp" && others.has(p.id) && Math.hypot(others.get(p.id).x - me.x, others.get(p.id).y - me.y) < KILL_RANGE);
    $("useBtn").disabled = !play || !(nearTask() || nearBtn);
    $("useBtn").textContent = nearBtn ? "🚨 Emergency" : "✋ Use";
    $("reportBtn").disabled = !play || !nearBody;
    $("killBtn").hidden = !(V.me && V.me.role === "imp");
    $("killBtn").disabled = !play || !canKill;
    $("killBtn").textContent = V.me && V.me.cd > 0 ? `🔪 ${Math.ceil(V.me.cd - (performance.now() - gotAt) / 1000)}` : "🔪 Kill";
  }

  let last = 0, gotAt = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    step(dt);
    if (room && room.isHost && engine && engine.G.phase !== "idle") {
      posAcc += dt;
      if (posAcc > 1 / 15) { posAcc = 0; const m = { t: "pos", p: engine.positions() }; room.broadcast(m); onPos(m); }
    }
    render(dt);
  }
  function onPos(m) {
    for (const [id, x, y] of m.p) {
      if (id === room.myId) continue;
      const o = others.get(id);
      if (!o) others.set(id, { x, y, tx: x, ty: y, face: 1, walk: 0 });
      else { o.tx = x; o.ty = y; }
    }
  }
  function onMsg(m) {
    if (!m) return;
    if (m.t === "st") { gotAt = performance.now(); onState(m); }
    else if (m.t === "pos") onPos(m);
    else if (m.t === "tp") { const mine = m.pos.find(([id]) => id === room.myId); if (mine) { me.x = mine[1].x; me.y = mine[1].y; } for (const [id, p] of m.pos) if (id !== room.myId) others.set(id, { x: p.x, y: p.y, tx: p.x, ty: p.y, face: 1, walk: 0 }); taskHold = null; }
    else if (m.t === "fx") { if (m.k === "kill") { fx.push({ x: m.x, y: m.y, life: 1 }); } if (m.k === "meet") GameUtil.sfx("start"); }
  }

  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "crew",
    title: "Crewmates",
    subtitle: "Do tasks around the ship while a hidden impostor hunts the crew. Report bodies, call meetings, vote them out. 4 to 10 players.",
    min: 4,
    max: 10,
    onStart(r) {
      room = r; V = null; others = new Map(); fx = []; taskHold = null;
      if (r.isHost) {
        const out = {
          to: (id, m) => (id === r.myId ? onMsg(m) : r.sendTo(id, m)),
          all: (m) => { r.broadcast(m); onMsg(m); },
        };
        engine = createEngine(r, out);
        r.onData((from, m) => hostHandle(from, m));
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => { r.sendTo(id, { t: "tp", pos: [...engine.G.pos.entries()] }); r.sendTo(id, engine.view(id)); });
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => onMsg(m));
      last = performance.now();
      stopLoop = GameUtil.loop(frame);
      return () => { stopLoop(); if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
  render(0);
  window.__crew = { me: () => me, tasks: TASKS, state: () => V }; // for automated tests
})();
