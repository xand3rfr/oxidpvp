// Type Race for 2–8 players. Everyone types the same passage; progress bars race across the
// screen and the first to finish wins. The host picks the passage, runs the clock and ranks
// finishers; each player tracks their own typing and reports progress.
(() => {
  const COUNT_MS = 3500, LIMIT_MS = 120000, AFTER_FIRST_MS = 30000;
  const PASSAGES = [
    "The quick brown fox jumps over the lazy dog while the sleepy cat watches from a sunny window.",
    "Every great adventure starts with a single step, a packed bag, and a friend who says yes.",
    "Rain tapped on the roof all night, and by morning the whole street smelled like wet grass.",
    "She pressed start, grabbed the controller, and promised herself this would be the last level.",
    "A good pizza needs three things: a crispy crust, plenty of cheese, and someone to share it with.",
    "The robot blinked twice, tilted its head, and asked why humans always argue about pineapple.",
    "Our team lost the first game, won the second, and argued about the third until midnight.",
    "Far below the ocean waves, glowing fish drift through the dark like tiny floating lanterns.",
    "He tried to sneak a cookie from the jar, but the lid made a loud clink and everyone turned around.",
    "The storm knocked out the power, so we played cards by candlelight and told ghost stories.",
    "Learning to skateboard takes patience, a helmet, and the courage to fall down a hundred times.",
    "At the top of the mountain, the air was thin and cold, but the view made every step worth it.",
    "The library was so quiet that you could hear the pages turning three tables away.",
    "My phone buzzed with forty new messages, and every single one of them was about the group project.",
    "Volcanoes can sleep for thousands of years before waking up with a deep and angry rumble.",
    "Bring snacks, charge your controller, and do not let your little brother pick the teams.",
    "The dragon counted its gold every morning, even though it already knew exactly how much it had.",
    "Summer afternoons were made for long bike rides, cold lemonade, and doing absolutely nothing.",
    "Somewhere in the city, a street musician played a song so good that people forgot to walk.",
    "The spaceship hummed softly as it drifted past the rings of a planet no one had named yet.",
    "Practice makes progress, not perfection, so keep typing even when your fingers feel slow.",
    "Our cat knocked a glass off the table, stared at us, and then knocked off another one.",
    "The final question was worth double points, and the whole room went completely silent.",
    "Pack a map, a flashlight, and extra batteries, because the cave goes deeper than you think.",
    "Two penguins waddled across the ice, slipped at the same time, and slid all the way to the sea.",
    "The best way to win a race is to stay calm, keep your eyes on the words, and never look back.",
  ];
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], phase: "idle", text: "", startAt: 0, endAt: 0, firstDone: 0, timer: 0, pushTimer: 0 };
    const byId = (id) => G.players.find((p) => p.id === id);
    const wpm = (p) => {
      const ms = p.done ? p.ms : Math.max(1, Date.now() - G.startAt);
      return G.phase === "count" || ms <= 0 ? 0 : Math.round((p.i / 5) / (ms / 60000));
    };
    function view() {
      const now = Date.now();
      return {
        t: "st", phase: G.phase, text: G.text,
        left: G.phase === "count" ? G.startAt - now : Math.max(0, G.endAt - now),
        players: G.players.map((p) => ({
          id: p.id, name: p.name, av: p.av, i: p.i, done: p.done, place: p.place, e: p.e,
          wpm: wpm(p), acc: p.i ? Math.round((p.i / (p.i + p.e)) * 100) : 100,
        })),
      };
    }
    const publish = () => out.all(view());
    // Progress arrives constantly; batch the broadcasts.
    const soon = () => { if (!G.pushTimer) G.pushTimer = setTimeout(() => { G.pushTimer = 0; publish(); }, 150); };

    function newRace() {
      clearTimeout(G.timer);
      G.players = room.players.filter((p) => !G.left || !G.left.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av, i: 0, e: 0, done: false, ms: 0, place: 0 }));
      G.text = PASSAGES[Math.floor(Math.random() * PASSAGES.length)];
      G.phase = "count";
      G.startAt = Date.now() + COUNT_MS;
      G.firstDone = 0;
      publish();
      G.timer = setTimeout(() => {
        G.phase = "race";
        G.endAt = Date.now() + LIMIT_MS;
        G.timer = setTimeout(endRace, LIMIT_MS);
        publish();
      }, COUNT_MS);
    }
    function progress(id, i, e) {
      const p = byId(id);
      if (!p || G.phase !== "race" || p.done) return;
      p.i = Math.max(0, Math.min(G.text.length, i | 0));
      p.e = Math.max(0, e | 0);
      if (p.i >= G.text.length) {
        const ms = Date.now() - G.startAt;
        if (ms < G.text.length * 15) { p.i = 0; return; } // faster than humanly possible
        p.done = true; p.ms = ms;
        p.place = G.players.filter((x) => x.done).length;
        if (!G.firstDone) {
          G.firstDone = Date.now();
          const cap = Math.min(G.endAt, Date.now() + AFTER_FIRST_MS);
          if (cap < G.endAt) { G.endAt = cap; clearTimeout(G.timer); G.timer = setTimeout(endRace, cap - Date.now()); }
        }
        if (G.players.every((x) => x.done)) return endRace();
        return publish();
      }
      soon();
    }
    function endRace() {
      clearTimeout(G.timer);
      G.phase = "end";
      publish();
    }
    function leave(id) {
      (G.left ||= new Set()).add(id);
      G.players = G.players.filter((p) => p.id !== id);
      if (G.phase === "race" && G.players.length && G.players.every((x) => x.done)) endRace();
      else publish();
    }
    return { G, newRace, progress, leave, view, stop: () => { clearTimeout(G.timer); clearTimeout(G.pushTimer); } };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null;
  let pos = 0, errs = 0, lastSent = 0, sendTimer = 0, text = "", wrongFlash = 0;
  const input = $("typeIn");

  function paintText() {
    const el = $("passage");
    el.textContent = "";
    el.append(h("span", "done", text.slice(0, pos)));
    if (pos < text.length) {
      el.append(h("span", "cur" + (wrongFlash ? " wrong" : ""), text[pos]));
      el.append(h("span", "", text.slice(pos + 1)));
    }
  }
  function report(force) {
    const now = performance.now();
    if (!force && now - lastSent < 120) { clearTimeout(sendTimer); sendTimer = setTimeout(() => report(true), 130); return; }
    lastSent = now;
    if (room.isHost) engine.progress(room.myId, pos, errs);
    else room.send({ t: "p", i: pos, e: errs });
  }
  function typeChars(s) {
    if (!V || V.phase !== "race" || pos >= text.length) return;
    for (const ch of s) {
      if (pos >= text.length) break;
      if (ch === text[pos]) { pos++; wrongFlash = 0; }
      else { errs++; wrongFlash = 1; GameUtil.sfx("click"); break; }
    }
    paintText();
    report(pos >= text.length);
  }
  input.addEventListener("input", () => { const v = input.value; input.value = ""; typeChars(v); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  $("passage").addEventListener("click", () => input.focus());

  function onState(v) {
    const prev = V;
    V = v;
    if (!prev || prev.text !== v.text || (prev.phase === "end" && v.phase === "count")) {
      text = v.text; pos = 0; errs = 0; wrongFlash = 0;
      // Rejoining mid-race (after a reload) picks up where the host last saw us.
      const mine = !prev && v.phase === "race" && v.players.find((p) => p.id === room.myId);
      if (mine) { pos = mine.i; errs = mine.e; }
    }
    paintText();

    // lanes
    const lanes = $("lanes");
    lanes.textContent = "";
    for (const p of v.players) {
      const pct = Math.min(100, (p.i / Math.max(1, v.text.length)) * 100);
      const lane = h("div", "tr-lane" + (p.id === room.myId ? " me" : "") + (p.done ? " done" : ""));
      const who = h("div", "tr-who");
      who.append(GameUtil.avatar(p, "xs"), h("span", "", p.name));
      const track = h("div", "tr-track");
      const car = h("div", "tr-car");
      car.style.left = `calc(${pct}% - ${pct / 100 * 28}px)`;
      car.append(GameUtil.avatar(p));
      const fill = h("div", "tr-fill");
      fill.style.width = pct + "%";
      track.append(fill, car);
      const stat = h("div", "tr-stat", p.place ? `#${p.place} · ${p.wpm} wpm` : `${p.wpm} wpm`);
      lane.append(who, track, stat);
      lanes.append(lane);
    }

    const me = v.players.find((p) => p.id === room.myId);
    $("typeBox").classList.toggle("locked", v.phase !== "race" || (me && me.done));
    input.disabled = v.phase !== "race" || (me && me.done);
    if (v.phase === "race" && prev && prev.phase !== "race") { input.focus(); GameUtil.sfx("start"); }
    $("myStats").textContent = me ? `${me.wpm} wpm · ${me.acc}% accuracy` : "";

    if (stopClock) stopClock();
    let lastS = -1;
    stopClock = countdown(performance.now() + v.left, (left) => {
      if (v.phase === "count") {
        const s = Math.ceil(left / 1000);
        $("banner").textContent = s > 0 ? `Starting in ${s}…` : "Go!";
        if (s !== lastS && s > 0) { lastS = s; GameUtil.sfx("tick"); }
      } else if (v.phase === "race") $("banner").textContent = me && me.done ? `Finished #${me.place}! Waiting for the others…` : `${fmt(left)}${left < 60000 ? "s" : ""} left`;
      else $("banner").textContent = "";
    });

    if (prev && me && me.done && !prev.players.find((p) => p.id === room.myId && p.done)) GameUtil.sfx(me.place === 1 ? "win" : "good");
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const ranked = [...v.players].sort((a, b) => (a.place || 99) - (b.place || 99) || b.i - a.i);
      const won = ranked[0] && ranked[0].id === room.myId && ranked[0].done;
      if (!(me && me.place === 1)) GameUtil.sfx(won ? "win" : "lose");
      const solo = v.players.length === 1;
      if (!solo) GameUtil.record("typing", won ? "win" : "loss");
      results({
        title: solo ? (me && me.done ? `${me.wpm} wpm!` : "Time's up") : won ? "You win!" : ranked[0] && ranked[0].done ? `${ranked[0].name} wins` : "Time's up",
        rows: ranked.map((p) => ({ p, value: p.done ? `${p.wpm} wpm · ${p.acc}%` : `${Math.round((p.i / v.text.length) * 100)}% done`, win: p.place === 1 })),
        isHost: room.isHost, meId: room.myId, again: "Race again",
      });
    } else if (v.phase !== "end") hideResults();
  }

  $("again").addEventListener("click", () => { if (engine) engine.newRace(); });

  Room.mount({
    game: "typing",
    title: "Type Race",
    subtitle: "Everyone types the same passage. Fastest fingers win. 2 to 8 players, or start alone to practice.",
    min: 1,
    max: 8,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        const out = { all: (m) => { r.broadcast(m); onState(m); } };
        engine = createEngine(r, out);
        r.onData((from, m) => { if (m && m.t === "p") engine.progress(from, m.i, m.e); });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view()));
        setTimeout(() => engine && engine.newRace(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => {
        if (engine) engine.stop();
        if (stopClock) stopClock();
        room = null; engine = null; V = null;
        hideResults();
      };
    },
  });
})();
