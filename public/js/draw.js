// Draw & Guess: one player draws a secret word, everyone else races to guess it.
// The host runs the turns, checks guesses and keeps score; the drawer's strokes are relayed
// through the host to everyone else. Only the drawer (and players who already guessed it) ever
// receive the word before the reveal.
(() => {
  const W = 800, H = 600;
  const CHOOSE_MS = 15000, REVEAL_MS = 5000;
  const COLORS = ["#111111", "#ffffff", "#9ca3af", "#ef4444", "#f97316", "#facc15", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#8b5a2b"];
  const SIZES = [3, 7, 14, 28];
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, settings, out) {
    const G = {
      players: room.players.map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0, guessed: false, gain: 0 })),
      order: [], turn: -1, round: 1, rounds: settings.rounds, drawTime: settings.time * 1000,
      phase: "idle", drawer: null, word: "", choices: [], ends: 0, revealed: [], strokes: [], feed: [], timer: 0, hintTimers: [],
    };
    const used = new Set();
    const byId = (id) => G.players.find((p) => p.id === id);

    function hint() {
      if (!G.word) return "";
      return [...G.word].map((c, i) => (c === " " ? " " : G.revealed.includes(i) ? c : "_")).join("");
    }
    function view(id) {
      const p = byId(id);
      const knows = id === G.drawer || (p && p.guessed) || G.phase === "reveal" || G.phase === "end";
      return {
        t: "st", phase: G.phase, round: G.round, rounds: G.rounds, drawer: G.drawer, teams: !!settings.teams,
        players: G.players.map(({ id, name, av, score, guessed, gain }) => ({ id, name, av, score, guessed, gain })),
        word: knows ? G.word : null, hint: hint(), len: G.word.length,
        choices: id === G.drawer && G.phase === "choose" ? G.choices : null,
        left: Math.max(0, G.ends - Date.now()), total: G.phase === "choose" ? CHOOSE_MS : G.phase === "draw" ? G.drawTime : REVEAL_MS,
      };
    }
    const publish = () => { for (const p of G.players) out.to(p.id, view(p.id)); };
    function feed(item) {
      G.feed.push(item);
      if (G.feed.length > 40) G.feed.shift();
      out.all({ t: "fd", item });
    }
    const clearTimers = () => { clearTimeout(G.timer); G.hintTimers.forEach(clearTimeout); G.hintTimers = []; };

    function newGame() {
      clearTimers();
      for (const p of G.players) { p.score = 0; p.guessed = false; p.gain = 0; }
      G.order = GameUtil.shuffle(G.players.map((p) => p.id));
      G.turn = -1; G.round = 1; G.feed = [];
      nextTurn();
    }
    function nextTurn() {
      clearTimers();
      G.turn++;
      if (G.turn >= G.order.length) { G.turn = 0; G.round++; }
      if (G.round > G.rounds) return endGame();
      G.drawer = G.order[G.turn];
      if (!byId(G.drawer)) return nextTurn(); // they left
      for (const p of G.players) { p.guessed = false; p.gain = 0; }
      // Host's own word list (from the lobby settings) mixes in, or replaces the built-in words.
      const custom = String(settings.words || "").split(/[\n,]/).map((w) => w.trim().toLowerCase().replace(/[^a-z ]/g, "").slice(0, 30)).filter((w) => w.length >= 2);
      const base = settings.onlyWords && custom.length >= 3 ? custom : [...window.DRAW_WORDS, ...custom];
      const pool = base.filter((w) => !used.has(w));
      G.choices = GameUtil.shuffle(pool.length >= 3 ? pool : base.slice()).slice(0, 3);
      G.word = ""; G.revealed = []; G.strokes = [];
      G.phase = "choose";
      G.ends = Date.now() + CHOOSE_MS;
      out.all({ t: "clear" });
      feed({ k: "sys", text: `${byId(G.drawer).name} is choosing a word` });
      publish();
      G.timer = setTimeout(() => pick(G.drawer, Math.floor(Math.random() * 3)), CHOOSE_MS);
    }
    function pick(id, i) {
      if (G.phase !== "choose" || id !== G.drawer || !(i >= 0 && i < 3)) return;
      clearTimers();
      G.word = G.choices[i];
      used.add(G.word);
      G.phase = "draw";
      G.ends = Date.now() + G.drawTime;
      // Reveal a letter at 50% and 75% of the time (not for tiny words).
      const letters = [...G.word].map((c, k) => k).filter((k) => G.word[k] !== " ");
      if (letters.length > 3) {
        for (const frac of [0.5, 0.75]) {
          G.hintTimers.push(setTimeout(() => {
            const left = letters.filter((k) => !G.revealed.includes(k));
            if (left.length > 2) { G.revealed.push(left[Math.floor(Math.random() * left.length)]); publish(); }
          }, G.drawTime * frac));
        }
      }
      publish();
      G.timer = setTimeout(() => endTurn("time"), G.drawTime);
    }
    function guess(id, text) {
      const p = byId(id);
      const g = norm(text).slice(0, 40);
      if (!p || !g || G.phase !== "draw" || id === G.drawer || p.guessed) return;
      if (g === G.word) {
        const left = Math.max(0, G.ends - Date.now());
        p.guessed = true;
        p.gain = Math.max(100, Math.round(500 * left / G.drawTime));
        p.score += p.gain;
        const d = byId(G.drawer);
        if (d) { d.score += 100; d.gain += 100; }
        feed({ k: "right", name: p.name, av: p.av });
        publish();
        const guessers = G.players.filter((x) => x.id !== G.drawer);
        if (guessers.length && guessers.every((x) => x.guessed)) endTurn("all");
        return;
      }
      if (g.length > 3 && lev(g, G.word) === 1) out.to(id, { t: "fd", item: { k: "close", text: g } });
      feed({ k: "guess", name: p.name, av: p.av, text: g });
    }
    function endTurn() {
      if (G.phase !== "draw" && G.phase !== "choose") return;
      clearTimers();
      G.phase = "reveal";
      G.ends = Date.now() + REVEAL_MS;
      feed({ k: "sys", text: `The word was "${G.word || "?"}"` });
      publish();
      G.timer = setTimeout(nextTurn, REVEAL_MS);
    }
    function endGame() {
      clearTimers();
      G.phase = "end"; G.drawer = null;
      publish();
    }
    // Drawer strokes: validate the sender, keep a copy for late joiners, relay to the rest.
    function stroke(id, m) {
      if (id !== G.drawer || G.phase !== "draw") return;
      if (m.t === "sk") {
        const s = { id: m.id | 0, c: COLORS.includes(m.c) ? m.c : "#111111", w: SIZES.includes(m.w) ? m.w : 7, p: cleanPts(m.p) };
        G.strokes.push(s);
        if (G.strokes.length > 3000) G.strokes.shift();
        out.except(id, { t: "sk", s });
      } else if (m.t === "sp") {
        const s = G.strokes.find((x) => x.id === (m.id | 0));
        if (!s || s.p.length > 4000) return;
        const p = cleanPts(m.p);
        s.p.push(...p);
        out.except(id, { t: "sp", id: s.id, p });
      } else if (m.t === "undo") {
        G.strokes.pop();
        out.except(id, { t: "all", strokes: G.strokes });
      } else if (m.t === "clear") {
        G.strokes = [];
        out.except(id, { t: "clear" });
      }
    }
    const cleanPts = (p) => (Array.isArray(p) ? p.slice(0, 400).map((v) => Math.max(-50, Math.min(850, v | 0))) : []);

    function leave(id) {
      G.players = G.players.filter((p) => p.id !== id);
      if (G.players.length < 2 && G.phase !== "end") return endGame();
      if (id === G.drawer && (G.phase === "draw" || G.phase === "choose")) {
        feed({ k: "sys", text: "The drawer left" });
        endTurn();
      } else publish();
    }
    function catchUp(id) {
      out.to(id, view(id));
      out.to(id, { t: "all", strokes: G.strokes });
      out.to(id, { t: "feedAll", items: G.feed });
    }
    return { G, newGame, pick, guess, stroke, leave, catchUp, stop: clearTimers };
  }

  // =====================================================================
  // UI (everyone)
  // =====================================================================
  const canvas = $("board"), ctx = canvas.getContext("2d");
  let room = null, engine = null, V = null, strokes = [], stopClock = null;
  let color = COLORS[0], size = SIZES[1], drawing = null, strokeSeq = 0, pending = [], flushTimer = 0;

  function clearCanvas() {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
  }
  function drawSeg(s, from) {
    const p = s.p;
    ctx.strokeStyle = s.c; ctx.fillStyle = s.c;
    ctx.lineWidth = s.w; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (p.length === 2) { ctx.beginPath(); ctx.arc(p[0], p[1], s.w / 2, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.beginPath();
    const start = Math.max(0, from - 2);
    ctx.moveTo(p[start], p[start + 1]);
    for (let i = start + 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.stroke();
  }
  function redraw() { clearCanvas(); for (const s of strokes) drawSeg(s, 0); }
  clearCanvas();

  // ---------- drawing input (drawer only) ----------
  const amDrawer = () => V && room && V.drawer === room.myId && V.phase === "draw";
  const toBoard = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * H)];
  };
  function send(m) {
    if (room.isHost) engine.stroke(room.myId, m);
    else room.send(m);
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (!amDrawer()) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = toBoard(e);
    drawing = { id: ++strokeSeq, c: color, w: size, p: [x, y] };
    strokes.push(drawing);
    drawSeg(drawing, 0);
    send({ t: "sk", id: drawing.id, c: drawing.c, w: drawing.w, p: [x, y] });
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const [x, y] = toBoard(e);
    const p = drawing.p;
    if (Math.abs(p[p.length - 2] - x) + Math.abs(p[p.length - 1] - y) < 3) return;
    p.push(x, y);
    drawSeg(drawing, p.length - 2);
    pending.push(x, y);
    if (!flushTimer) flushTimer = setTimeout(flush, 40);
  });
  const endStroke = () => { if (drawing) { flush(); drawing = null; } };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  function flush() {
    clearTimeout(flushTimer); flushTimer = 0;
    if (drawing && pending.length) send({ t: "sp", id: drawing.id, p: pending });
    pending = [];
  }

  // tools
  for (const c of COLORS) {
    const b = h("button", "dg-color");
    b.type = "button"; b.style.background = c; b.setAttribute("aria-label", "Color " + c);
    b.addEventListener("click", () => { color = c; paintTools(); });
    $("colors").append(b);
  }
  for (const s of SIZES) {
    const b = h("button", "dg-size");
    b.type = "button"; b.setAttribute("aria-label", "Brush size " + s);
    const dot = h("i"); dot.style.width = dot.style.height = Math.max(4, s * 0.8) + "px";
    b.append(dot);
    b.addEventListener("click", () => { size = s; paintTools(); });
    $("sizes").append(b);
  }
  function paintTools() {
    [...$("colors").children].forEach((b, i) => b.classList.toggle("on", COLORS[i] === color));
    [...$("sizes").children].forEach((b, i) => b.classList.toggle("on", SIZES[i] === size));
  }
  paintTools();
  $("undo").addEventListener("click", () => { if (!amDrawer()) return; strokes.pop(); redraw(); send({ t: "undo" }); });
  $("clear").addEventListener("click", () => { if (!amDrawer()) return; strokes = []; redraw(); send({ t: "clear" }); });

  // ---------- guessing ----------
  $("guessForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("guess");
    const text = input.value.trim();
    if (!text || !V || V.phase !== "draw") return;
    input.value = "";
    if (room.isHost) engine.guess(room.myId, text);
    else room.send({ t: "g", text });
  });

  function addFeed(item) {
    const el = h("div", "dg-msg " + item.k);
    if (item.k === "right") { el.append(GameUtil.avatar(item, "xs"), h("b", "", item.name), " guessed the word!"); }
    else if (item.k === "guess") { el.append(GameUtil.avatar(item, "xs"), h("b", "", item.name), " " + item.text); }
    else if (item.k === "close") { el.textContent = `"${item.text}" is close!`; }
    else el.textContent = item.text;
    const f = $("feed");
    f.append(el);
    while (f.children.length > 60) f.firstChild.remove();
    f.scrollTop = f.scrollHeight;
    if (item.k === "right") GameUtil.sfx(item.name === meName() ? "good" : "pop");
    if (item.k === "close") GameUtil.sfx("click");
  }
  const meName = () => { const p = V && V.players.find((x) => x.id === room.myId); return p ? p.name : ""; };

  // ---------- state ----------
  function onState(v) {
    const prev = V;
    V = v;
    const meP = v.players.find((p) => p.id === room.myId);
    const drawerP = v.players.find((p) => p.id === v.drawer);
    const iDraw = v.drawer === room.myId;

    $("round").textContent = v.phase === "end" ? "Game over" : `Round ${Math.min(v.round, v.rounds)} of ${v.rounds}`;
    const word = $("word");
    word.textContent = "";
    if (v.phase === "draw" || v.phase === "reveal") {
      if (v.word) word.append(h("span", "dg-secret", v.word));
      else for (const c of v.hint) word.append(h("span", c === " " ? "gap" : "ch", c === "_" ? "" : c));
      if (!v.word && v.phase === "draw") word.append(h("small", "", String(v.len)));
    } else if (v.phase === "choose") word.textContent = iDraw ? "Pick a word" : `${drawerP ? drawerP.name : "Someone"} is picking…`;

    // players
    const list = $("players");
    list.textContent = "";
    for (const p of [...v.players].sort((a, b) => b.score - a.score)) {
      const li = h("li", (p.id === v.drawer ? "drawing " : "") + (p.guessed ? "guessed " : "") + (p.id === room.myId ? "me" : ""));
      li.append(GameUtil.avatar(p), h("span", "pname", p.name), h("span", "pts", p.score));
      if (p.id === v.drawer && v.phase !== "end") li.append(h("span", "tag", "✏️"));
      else if (p.gain && (v.phase === "reveal" || p.guessed)) li.append(h("span", "gain", "+" + p.gain));
      list.append(li);
    }

    // cover over the canvas
    const cover = $("cover");
    cover.textContent = "";
    cover.hidden = !(v.phase === "choose" || v.phase === "reveal");
    if (v.phase === "choose") {
      if (iDraw) {
        cover.append(h("div", "dg-cover-title", "Choose a word to draw"));
        const row = h("div", "dg-choices");
        v.choices.forEach((w, i) => {
          const b = h("button", "btn", w);
          b.type = "button";
          b.addEventListener("click", () => { if (room.isHost) engine.pick(room.myId, i); else room.send({ t: "pick", i }); });
          row.append(b);
        });
        cover.append(row);
      } else {
        if (drawerP) cover.append(GameUtil.avatar(drawerP, "lg"));
        cover.append(h("div", "dg-cover-title", `${drawerP ? drawerP.name : "Someone"} is choosing a word…`));
      }
    } else if (v.phase === "reveal") {
      cover.append(h("div", "dg-cover-sub", "The word was"), h("div", "dg-cover-word", v.word || "?"));
    }

    $("tools").hidden = !(iDraw && v.phase === "draw");
    canvas.classList.toggle("can-draw", iDraw && v.phase === "draw");
    const input = $("guess");
    const canGuess = v.phase === "draw" && !iDraw && meP && !meP.guessed;
    input.disabled = !canGuess;
    input.placeholder = iDraw ? "You're drawing!" : meP && meP.guessed ? "You got it! Waiting for others…" : v.phase === "draw" ? "Type your guess…" : "Wait for the next drawing…";
    $("guessForm").querySelector("button").disabled = !canGuess;

    if (stopClock) stopClock();
    const ends = performance.now() + v.left;
    let lastS = -1;
    stopClock = countdown(ends, (left) => {
      $("time").textContent = v.phase === "end" ? "" : fmt(left);
      const s = Math.ceil(left / 1000);
      if (v.phase === "draw" && s !== lastS && s <= 5 && s > 0) { lastS = s; GameUtil.sfx("tick"); }
    });

    if (prev && prev.phase !== v.phase) {
      if (v.phase === "choose" && iDraw) GameUtil.sfx("turn");
      if (v.phase === "draw" && !iDraw) { input.focus(); }
      if (v.phase === "reveal") GameUtil.sfx("pop");
    }
    if (v.phase === "end") {
      if (!prev || prev.phase !== "end") {
        const sorted = [...v.players].sort((a, b) => b.score - a.score);
        const top = sorted[0] ? sorted[0].score : 0;
        const T = v.teams ? Party.teams(v.players, (p) => p.score) : null;
        const won = T ? T.winner >= 0 && T.team.get(room.myId) === T.winner : sorted.some((p) => p.id === room.myId && p.score === top);
        GameUtil.sfx(won ? "win" : "lose");
        GameUtil.record("draw", won ? "win" : "loss");
        results({
          title: T ? (T.winner < 0 ? `Tie! ${T.totals[0]} – ${T.totals[1]}` : `${Party.TEAMS[T.winner].name} team wins! ${T.totals[0]} – ${T.totals[1]}`) : won ? "You win!" : `${sorted[0].name} wins`,
          rows: sorted.map((p) => ({ p, value: (T ? Party.TEAMS[T.team.get(p.id)].name + " · " : "") + p.score + " pts", win: T ? T.team.get(p.id) === T.winner : p.score === top })),
          isHost: room.isHost, meId: room.myId,
        });
      }
    } else hideResults();
  }

  function onMsg(m) {
    if (m.t === "st") onState(m);
    else if (m.t === "fd") addFeed(m.item);
    else if (m.t === "feedAll") { $("feed").textContent = ""; m.items.forEach(addFeed); }
    else if (m.t === "clear") { strokes = []; redraw(); }
    else if (m.t === "all") { strokes = m.strokes || []; redraw(); }
    else if (m.t === "sk") { strokes.push(m.s); drawSeg(m.s, 0); }
    else if (m.t === "sp") {
      const s = strokes.find((x) => x.id === m.id);
      if (!s) return;
      const from = s.p.length;
      s.p.push(...m.p);
      drawSeg(s, from);
    }
  }

  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  // ---------- lobby settings ----------
  const SET_KEY = "oxidpvp-draw";
  const loadSet = () => { let s = null; try { s = JSON.parse(localStorage.getItem(SET_KEY)); } catch {} return { rounds: 2, time: 80, words: "", onlyWords: false, teams: false, ...(s || {}) }; };
  function buildSettings(el) {
    const s = loadSet();
    el.innerHTML = `<div class="set-head">Rounds</div><div class="seg" data-k="rounds"></div><div class="set-head">Seconds to draw</div><div class="seg" data-k="time"></div>
      <details class="custom-q"><summary>Your own words</summary><textarea rows="4" spellcheck="false" placeholder="Separate with commas or new lines: pizza, my dog, the principal…"></textarea>
      <label class="check"><input type="checkbox" class="only-w"> Only use my words (needs at least 3)</label></details>
      <label class="check"><input type="checkbox" class="teams-w"> Teams: Red vs Blue (players alternate by join order)</label>`;
    const ta = el.querySelector("textarea"), only = el.querySelector(".only-w"), tm = el.querySelector(".teams-w");
    ta.value = s.words; only.checked = s.onlyWords; tm.checked = s.teams;
    const saveX = () => { try { localStorage.setItem(SET_KEY, JSON.stringify(s)); } catch {} };
    ta.addEventListener("input", () => { s.words = ta.value; saveX(); });
    ta.addEventListener("keydown", (e) => e.stopPropagation());
    only.addEventListener("change", () => { s.onlyWords = only.checked; saveX(); });
    tm.addEventListener("change", () => { s.teams = tm.checked; saveX(); });
    const opts = { rounds: [1, 2, 3], time: [60, 80, 100] };
    for (const seg of el.querySelectorAll(".seg")) {
      const k = seg.dataset.k;
      for (const v of opts[k]) {
        const b = h("button", "", v);
        b.type = "button";
        b.addEventListener("click", () => { s[k] = v; try { localStorage.setItem(SET_KEY, JSON.stringify(s)); } catch {} paint(); });
        seg.append(b);
      }
    }
    const paint = () => el.querySelectorAll(".seg").forEach((seg) => [...seg.children].forEach((b) => b.classList.toggle("on", +b.textContent === s[seg.dataset.k])));
    paint();
  }

  Room.mount({
    game: "draw",
    title: "Draw & Guess",
    subtitle: "Take turns drawing a secret word while everyone else races to guess it. 2 to 8 players.",
    min: 2,
    max: 8,
    lobbyExtra: buildSettings,
    onStart(r) {
      room = r;
      V = null; strokes = []; redraw();
      $("feed").textContent = "";
      if (r.isHost) {
        const out = {
          to: (id, m) => (id === r.myId ? onMsg(m) : r.sendTo(id, m)),
          all: (m) => { r.broadcast(m); onMsg(m); },
          except: (id, m) => { for (const p of engine.G.players) if (p.id !== id) out.to(p.id, m); },
        };
        engine = createEngine(r, loadSet(), out);
        r.onData((from, m) => {
          if (!m || typeof m.t !== "string") return;
          if (m.t === "pick") engine.pick(from, m.i | 0);
          else if (m.t === "g") engine.guess(from, m.text);
          else engine.stroke(from, m);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => engine.catchUp(id));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => m && onMsg(m));
      return () => {
        if (engine) engine.stop();
        if (stopClock) stopClock();
        room = null; engine = null; V = null;
        hideResults();
      };
    },
  });
})();
