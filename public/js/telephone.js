// Telephone for 3–8 players: the drawing game version of the whisper game. Everyone writes a
// prompt, then the prompts get passed around: the next player draws it, the next describes the
// drawing, the next draws that, and so on. At the end the host steps through every chain so
// everyone can see how "a cat eating spaghetti" turned into "a sad octopus in a hot tub".
// Drawings are sent as compact stroke lists (not images) so they fit in a single message.
(() => {
  const W = 480, H = 360;
  const WRITE_MS = 50000, DRAW_MS = 90000, DESC_MS = 45000, GRACE_MS = 3000;
  const COLORS = ["#111111", "#ffffff", "#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#ec4899", "#ec4899", "#8b5a2b"];
  const SIZES = [3, 7, 14, 26];
  const MAX_POINTS = 5000; // keeps a drawing well under the 64 KB message limit
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);
  const cleanText = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);
  function cleanStrokes(a) {
    if (!Array.isArray(a)) return [];
    const out = [];
    let pts = 0;
    for (const s of a.slice(0, 600)) {
      if (!Array.isArray(s) || s.length < 4) continue;
      const c = s[0] | 0, w = s[1] | 0;
      const p = s.slice(2, 2 + (MAX_POINTS - pts) * 2).map((v, i) => Math.max(0, Math.min(i % 2 ? H : W, v | 0)));
      if (p.length < 2 || c < 0 || c >= COLORS.length || w < 0 || w >= SIZES.length) continue;
      out.push([c, w, ...p]);
      pts += p.length / 2;
      if (pts >= MAX_POINTS) break;
    }
    return out;
  }

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], order: [], chains: [], step: 0, steps: 0, phase: "idle", ends: 0, timer: 0, done: new Set(), show: { c: 0, i: 0 }, gone: new Set() };
    const kindOf = (step) => (step === 0 ? "write" : step % 2 ? "draw" : "desc");
    const msOf = (k) => (k === "write" ? WRITE_MS : k === "draw" ? DRAW_MS : DESC_MS);
    // At step k, chain c is handled by player order[(c + k) % n].
    const chainFor = (id, step = G.step) => { const n = G.order.length, i = G.order.indexOf(id); return ((i - step) % n + n) % n; };
    const active = () => G.order.filter((id) => !G.gone.has(id));

    function view(id) {
      const v = {
        t: "st", phase: G.phase, step: G.step, steps: G.steps, kind: kindOf(G.step), players: G.players,
        done: [...G.done], left: Math.max(0, G.ends - Date.now()), show: G.show, chains: G.chains.length,
      };
      if (G.phase === "play" && G.order.includes(id) && !G.gone.has(id)) {
        const c = chainFor(id);
        v.task = { c, prev: G.step ? G.chains[c].items[G.step - 1] : null };
        v.mineDone = G.done.has(id);
      }
      if (G.phase === "show") v.chainLen = G.chains[G.show.c] ? G.chains[G.show.c].items.length : 0;
      return v;
    }
    const publish = () => { for (const p of room.players) if (!G.gone.has(p.id)) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer);
      G.players = room.players.filter((p) => !G.gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av }));
      G.order = GameUtil.shuffle(G.players.map((p) => p.id));
      G.chains = G.order.map((id) => ({ owner: id, items: [] }));
      G.steps = G.order.length;
      G.step = -1;
      G.phase = "play";
      nextStep();
    }
    function nextStep() {
      clearTimeout(G.timer);
      G.step++;
      G.done = new Set();
      if (G.step >= G.steps) return startShow();
      G.ends = Date.now() + msOf(kindOf(G.step));
      G.timer = setTimeout(timeUp, msOf(kindOf(G.step)) + GRACE_MS);
      // Players who left still "hold" a chain position; fill their turn right away.
      for (const id of G.order) if (G.gone.has(id)) submit(id, null, true);
      publish();
    }
    function submit(id, data, silent) {
      if (G.phase !== "play" || !G.order.includes(id) || G.done.has(id)) return;
      const k = kindOf(G.step), c = chainFor(id);
      let item;
      if (k === "draw") item = { k: "draw", by: id, s: cleanStrokes(data) };
      else {
        const text = cleanText(data);
        item = { k: "text", by: id, text: text || (k === "write" ? "(blank)" : "(no idea)") };
      }
      G.chains[c].items[G.step] = item;
      G.done.add(id);
      if (G.order.every((x) => G.done.has(x))) return nextStep();
      if (!silent) publish();
    }
    function timeUp() { for (const id of G.order) if (!G.done.has(id)) submit(id, null, true); }

    function startShow() {
      G.phase = "show";
      G.show = { c: 0, i: 0 };
      publish();
      sendItem();
    }
    function sendItem() {
      const ch = G.chains[G.show.c];
      if (!ch) return;
      out.all({ t: "rv", c: G.show.c, i: G.show.i, owner: ch.owner, item: ch.items[G.show.i] });
    }
    function next(id) {
      if (G.phase !== "show" || id !== room.myId) return;
      const ch = G.chains[G.show.c];
      if (G.show.i < ch.items.length - 1) { G.show.i++; publish(); sendItem(); return; }
      if (G.show.c < G.chains.length - 1) { G.show = { c: G.show.c + 1, i: 0 }; publish(); sendItem(); return; }
      G.phase = "end";
      publish();
    }
    function leave(id) {
      G.gone.add(id);
      G.players = G.players.filter((p) => p.id !== id);
      if (G.players.length < 2 && G.phase === "play") { clearTimeout(G.timer); return startShow(); }
      if (G.phase === "play") submit(id, null, false);
    }
    function catchUp(id) {
      out.to(id, view(id));
      if (G.phase === "show") {
        const ch = G.chains[G.show.c];
        for (let i = 0; i <= G.show.i; i++) out.to(id, { t: "rv", c: G.show.c, i, owner: ch.owner, item: ch.items[i] });
      }
    }
    return { G, newGame, submit, next, leave, catchUp, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // Drawing pad
  // =====================================================================
  const pad = $("pad"), pctx = pad.getContext("2d");
  let strokes = [], cur = null, color = 0, size = 1, canDraw = false;
  function paint(ctx, list, scale = 1) {
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const s of list) {
      ctx.strokeStyle = COLORS[s[0]]; ctx.lineWidth = SIZES[s[1]];
      ctx.beginPath();
      ctx.moveTo(s[2], s[3]);
      if (s.length === 4) ctx.lineTo(s[2] + 0.1, s[3]);
      for (let i = 4; i < s.length; i += 2) ctx.lineTo(s[i], s[i + 1]);
      ctx.stroke();
    }
    ctx.restore();
  }
  const scaleOf = (cv) => cv.width / W;
  function redrawPad() { paint(pctx, cur ? [...strokes, cur] : strokes, scaleOf(pad)); }
  function sizePad(cv) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
  }
  sizePad(pad);
  const totalPts = () => strokes.reduce((a, s) => a + (s.length - 2) / 2, 0);
  const toPad = (e) => { const r = pad.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * H)]; };
  pad.addEventListener("pointerdown", (e) => {
    if (!canDraw || totalPts() >= MAX_POINTS) return;
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    cur = [color, size, ...toPad(e)];
    redrawPad();
  });
  pad.addEventListener("pointermove", (e) => {
    if (!cur) return;
    const [x, y] = toPad(e), lx = cur[cur.length - 2], ly = cur[cur.length - 1];
    if (Math.hypot(x - lx, y - ly) < 2.5) return;
    cur.push(x, y);
    redrawPad();
  });
  const endStroke = () => { if (cur) { strokes.push(cur); cur = null; redrawPad(); } };
  pad.addEventListener("pointerup", endStroke);
  pad.addEventListener("pointercancel", endStroke);
  COLORS.forEach((c, i) => {
    const b = h("button", "tp-color");
    b.type = "button"; b.style.background = c; b.setAttribute("aria-label", "Color " + (i + 1));
    b.addEventListener("click", () => { color = i; tools(); });
    $("colors").append(b);
  });
  SIZES.forEach((s, i) => {
    const b = h("button", "tp-size");
    b.type = "button"; b.append(h("i")); b.firstChild.style.width = b.firstChild.style.height = Math.max(4, s) + "px";
    b.setAttribute("aria-label", "Brush " + (i + 1));
    b.addEventListener("click", () => { size = i; tools(); });
    $("sizes").append(b);
  });
  function tools() {
    [...$("colors").children].forEach((b, i) => b.classList.toggle("on", i === color));
    [...$("sizes").children].forEach((b, i) => b.classList.toggle("on", i === size));
  }
  tools();
  $("undo").addEventListener("click", () => { strokes.pop(); redrawPad(); });
  $("clear").addEventListener("click", () => { strokes = []; redrawPad(); });

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null, submittedStep = -1, shown = [], showChain = -1;
  const pname = (id) => { const p = V && V.players.find((x) => x.id === id); return p ? p.name : "Someone"; };

  function submit() {
    if (!V || V.phase !== "play" || submittedStep === V.step) return;
    submittedStep = V.step;
    const data = V.kind === "draw" ? (cur ? [...strokes, cur] : strokes) : $("textIn").value;
    cur = null;
    GameUtil.sfx("click");
    if (room.isHost) engine.submit(room.myId, data); else room.send({ t: "sub", d: data });
    render();
  }

  function render() {
    const v = V;
    $("play").hidden = v.phase !== "play";
    $("show").hidden = v.phase === "play";
    if (v.phase === "play") {
      const waiting = submittedStep === v.step || v.mineDone;
      const kind = v.kind;
      $("stepLabel").textContent = `Step ${v.step + 1} of ${v.steps}`;
      $("task").textContent = waiting ? "Done! Waiting for everyone else…"
        : kind === "write" ? "Write something for someone to draw"
        : kind === "draw" ? "Draw this:" : "What is this drawing?";
      const prev = v.task && v.task.prev;
      $("prompt").hidden = !(kind === "draw" && prev && !waiting);
      $("prompt").textContent = prev && prev.k === "text" ? prev.text : "";
      $("seeWrap").hidden = !(kind === "desc" && prev && !waiting);
      if (kind === "desc" && prev && prev.k === "draw") { sizePad($("see")); paint($("see").getContext("2d"), prev.s, scaleOf($("see"))); }
      canDraw = kind === "draw" && !waiting;
      $("padWrap").hidden = !canDraw;
      $("textForm").hidden = !(kind !== "draw" && !waiting);
      $("textIn").placeholder = kind === "write" ? "e.g. a cat eating spaghetti" : "Describe the drawing…";
      $("doneBtn").hidden = !canDraw;
      const left = v.players.filter((p) => !v.done.includes(p.id));
      $("status").textContent = `${v.done.length} of ${v.players.length} done` + (left.length && left.length <= 3 ? ` · waiting for ${left.map((p) => p.name).join(", ")}` : "");
    } else {
      const isHost = room.isHost;
      $("nextBtn").hidden = !isHost || v.phase !== "show";
      $("showLabel").textContent = v.phase === "end" ? "That's every chain!" : `Chain ${v.show.c + 1} of ${v.chains}`;
      $("status").textContent = v.phase === "end" ? (isHost ? "" : "Waiting for the host…") : isHost ? "Click Next to reveal the next step" : "The host is revealing the chains…";
      $("againRow").hidden = !(v.phase === "end" && isHost);
    }
  }

  function renderShow() {
    const box = $("chain");
    box.textContent = "";
    for (const r of shown) {
      if (!r.item) continue;
      const it = h("div", "tp-item " + (r.item.k === "draw" ? "draw" : "text"));
      const who = h("div", "tp-who");
      const p = V.players.find((x) => x.id === r.item.by) || { name: pname(r.item.by), id: r.item.by };
      who.append(GameUtil.avatar(p, "xs"), h("span", "", `${p.name} ${r.i === 0 ? "wrote" : r.item.k === "draw" ? "drew" : "guessed"}`));
      it.append(who);
      if (r.item.k === "draw") {
        const cv = document.createElement("canvas");
        sizePad(cv);
        paint(cv.getContext("2d"), r.item.s, scaleOf(cv));
        it.append(cv);
      } else it.append(h("p", "", r.item.text));
      box.append(it);
    }
    box.lastElementChild && box.lastElementChild.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function onState(v) {
    const prev = V;
    V = v;
    if (v.phase === "play" && (!prev || prev.step !== v.step || prev.phase !== "play")) {
      strokes = []; cur = null; $("textIn").value = ""; redrawPad();
      if (!v.mineDone) submittedStep = -1;
      if (prev) GameUtil.sfx("turn");
      if (v.kind !== "draw") setTimeout(() => $("textIn").focus(), 50);
    }
    if (v.phase === "play" && v.mineDone) submittedStep = v.step;
    if (v.phase !== "play" && prev && prev.phase === "play") GameUtil.sfx("start");
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => {
      $("timer").textContent = v.phase === "play" ? fmt(left) : "";
      // Out of time: send whatever we have so a half-finished drawing still counts.
      if (v.phase === "play" && left <= 0 && submittedStep !== v.step) submit();
    });
    render();
    hideResults();
  }
  function onReveal(m) {
    if (m.c !== showChain) { showChain = m.c; shown = []; }
    shown[m.i] = m;
    GameUtil.sfx("pop");
    renderShow();
  }

  $("textForm").addEventListener("submit", (e) => { e.preventDefault(); if ($("textIn").value.trim()) submit(); });
  $("doneBtn").addEventListener("click", () => submit());
  $("nextBtn").addEventListener("click", () => { if (engine) engine.next(room.myId); });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });
  $("again2").addEventListener("click", () => { if (engine) { shown = []; showChain = -1; engine.newGame(); } });

  Room.mount({
    game: "phone",
    title: "Telephone",
    subtitle: "Write a prompt, draw what you're given, describe what you see. Then watch it all fall apart. 3 to 8 players.",
    min: 3,
    max: 8,
    onStart(r) {
      room = r; V = null; shown = []; showChain = -1; submittedStep = -1;
      if (r.isHost) {
        const out = {
          to: (id, m) => (id === r.myId ? (m.t === "rv" ? onReveal(m) : onState(m)) : r.sendTo(id, m)),
          all: (m) => { r.broadcast(m); onReveal(m); },
        };
        engine = createEngine(r, out);
        r.onData((from, m) => { if (m && m.t === "sub") engine.submit(from, m.d); });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => engine.catchUp(id));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => {
        if (!m) return;
        if (m.t === "st") onState(m);
        else if (m.t === "rv") onReveal(m);
      });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
