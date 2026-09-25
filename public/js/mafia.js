// Mafia, 5–12 players. Everyone gets a secret role. At night the Mafia pick someone to eliminate,
// the Doctor picks someone to save, and the Detective checks whether someone is Mafia. During the
// day everyone talks (use the chat) and votes someone out. The town wins by voting out every
// Mafia member; the Mafia win once they're as many as everyone else. The host deals the roles
// and only sends each player what their role lets them know.
(() => {
  const NIGHT_MS = 35000, DAWN_MS = 6000, DAY_MS = 100000, DUSK_MS = 6000;
  const ROLE = {
    mafia: { name: "Mafia", icon: "🔪", blurb: "Pick someone to eliminate each night. Blend in during the day." },
    doctor: { name: "Doctor", icon: "🩺", blurb: "Each night, pick someone to save. You can't save the same person twice in a row." },
    detective: { name: "Detective", icon: "🔎", blurb: "Each night, check one player to learn if they're Mafia." },
    town: { name: "Villager", icon: "🧑‍🌾", blurb: "Find the Mafia and vote them out during the day." },
  };
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], phase: "idle", day: 0, ends: 0, timer: 0, night: {}, votes: {}, news: null, checks: {}, lastSave: null, winner: null, gone: new Set() };
    const P = (id) => G.players.find((p) => p.id === id);
    const alive = () => G.players.filter((p) => p.alive);
    const view = (id) => {
      const me = P(id), dead = !me || !me.alive, over = G.phase === "end";
      return {
        t: "st", phase: G.phase, day: G.day, left: Math.max(0, G.ends - Date.now()), news: G.news, winner: G.winner,
        me: me ? { role: me.role, alive: me.alive } : null,
        players: G.players.map((p) => ({
          id: p.id, name: p.name, av: p.av, alive: p.alive,
          // Roles are secret, except: your own, fellow Mafia, anyone who's out, and everything when the game ends or you're dead.
          role: over || dead || p.id === id || !p.alive || (me && me.role === "mafia" && p.role === "mafia") ? p.role : null,
        })),
        votes: G.phase === "day" || G.phase === "dusk" ? G.votes : null,
        mafiaPicks: me && me.role === "mafia" && G.phase === "night" ? Object.fromEntries(Object.entries(G.night.mafia || {})) : null,
        myPick: G.phase === "night" && me ? (me.role === "mafia" ? (G.night.mafia || {})[id] : me.role === "doctor" ? G.night.save : me.role === "detective" ? G.night.check : null) : null,
        checks: me && me.role === "detective" ? G.checks : null,
        lastSave: me && me.role === "doctor" ? G.lastSave : null,
      };
    };
    const publish = () => { for (const p of room.players) if (!G.gone.has(p.id)) out.to(p.id, view(p.id)); };

    function newGame() {
      clearTimeout(G.timer);
      const ps = room.players.filter((p) => !G.gone.has(p.id));
      const n = ps.length, roles = [];
      const mafia = Math.max(1, Math.floor(n / 4));
      for (let i = 0; i < mafia; i++) roles.push("mafia");
      if (n >= 5) roles.push("doctor");
      if (n >= 6) roles.push("detective");
      while (roles.length < n) roles.push("town");
      GameUtil.shuffle(roles);
      G.players = ps.map((p, i) => ({ id: p.id, name: p.name, av: p.av, role: roles[i], alive: true }));
      G.day = 0; G.checks = {}; G.lastSave = null; G.winner = null; G.news = { kind: "start" };
      startNight();
    }
    function startNight() {
      clearTimeout(G.timer);
      G.day++;
      G.phase = "night";
      G.night = { mafia: {} };
      G.ends = Date.now() + NIGHT_MS;
      G.timer = setTimeout(dawn, NIGHT_MS);
      publish();
    }
    function nightAct(id, target) {
      const p = P(id), t = P(target);
      if (G.phase !== "night" || !p || !p.alive || !t || !t.alive) return;
      if (p.role === "mafia") { if (t.role === "mafia") return; G.night.mafia[id] = target; }
      else if (p.role === "doctor") { if (target === G.lastSave) return; G.night.save = target; }
      else if (p.role === "detective") { if (target === id) return; G.night.check = target; }
      else return;
      // Everyone with a night job has chosen: morning comes early.
      const need = alive().filter((q) => q.role !== "town");
      const doneAll = need.every((q) => (q.role === "mafia" ? G.night.mafia[q.id] != null : q.role === "doctor" ? G.night.save != null : G.night.check != null));
      if (doneAll) { clearTimeout(G.timer); G.timer = setTimeout(dawn, 1500); }
      publish();
    }
    function dawn() {
      clearTimeout(G.timer);
      const picks = Object.values(G.night.mafia).filter((x) => P(x) && P(x).alive);
      let victim = null;
      if (picks.length) {
        const count = {};
        for (const x of picks) count[x] = (count[x] || 0) + 1;
        const top = Math.max(...Object.values(count));
        const tops = Object.keys(count).filter((k) => count[k] === top).map(Number);
        victim = tops[Math.floor(Math.random() * tops.length)];
      }
      const saved = victim != null && G.night.save === victim;
      if (victim != null && !saved) P(victim).alive = false;
      if (G.night.check != null && P(G.night.check)) G.checks[G.night.check] = P(G.night.check).role === "mafia";
      G.lastSave = G.night.save ?? null;
      G.news = { kind: "dawn", victim: saved ? null : victim, saved: saved ? victim : null };
      if (checkWin()) return;
      G.phase = "dawn";
      G.ends = Date.now() + DAWN_MS;
      G.timer = setTimeout(startDay, DAWN_MS);
      publish();
    }
    function startDay() {
      G.phase = "day";
      G.votes = {};
      G.ends = Date.now() + DAY_MS;
      G.timer = setTimeout(dusk, DAY_MS);
      publish();
    }
    function vote(id, target) {
      const p = P(id);
      if (G.phase !== "day" || !p || !p.alive) return;
      if (target !== -1 && !(P(target) && P(target).alive)) return;
      G.votes[id] = target;
      if (alive().every((q) => q.id in G.votes)) { clearTimeout(G.timer); G.timer = setTimeout(dusk, 1500); }
      publish();
    }
    function dusk() {
      if (G.phase !== "day") return;
      clearTimeout(G.timer);
      const count = {};
      for (const [v, t] of Object.entries(G.votes)) if (P(+v) && P(+v).alive && t !== -1) count[t] = (count[t] || 0) + 1;
      const top = Math.max(0, ...Object.values(count));
      const tops = Object.keys(count).filter((k) => count[k] === top).map(Number);
      const skips = Object.values(G.votes).filter((t) => t === -1).length;
      let out = null;
      if (top > 0 && tops.length === 1 && top > skips) { out = tops[0]; P(out).alive = false; }
      G.news = { kind: "dusk", out, role: out != null ? P(out).role : null };
      G.phase = "dusk";
      if (checkWin()) return;
      G.ends = Date.now() + DUSK_MS;
      G.timer = setTimeout(startNight, DUSK_MS);
      publish();
    }
    function checkWin() {
      const a = alive(), m = a.filter((p) => p.role === "mafia").length;
      if (m === 0) G.winner = "town";
      else if (m >= a.length - m) G.winner = "mafia";
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
      if (G.phase !== "end" && G.players.length) { if (checkWin()) return; }
      publish();
    }
    return { G, newGame, nightAct, vote, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null;
  const nm = (id) => { const p = V && V.players.find((x) => x.id === id); return p ? (p.id === room.myId ? "You" : p.name) : "?"; };
  const act = (m) => {
    if (room.isHost) { if (m.t === "night") engine.nightAct(room.myId, m.target); else engine.vote(room.myId, m.target); }
    else room.send(m);
  };

  function render() {
    const v = V, me = v.me, role = me && ROLE[me.role];
    document.body.dataset.phase = v.phase;
    $("dayLabel").textContent = v.phase === "end" ? "Game over" : `${v.phase === "night" ? "Night" : "Day"} ${v.day}`;
    $("roleCard").className = "mf-role " + (me ? me.role : "");
    $("roleIcon").textContent = role ? role.icon : "👀";
    $("roleName").textContent = role ? `You're ${role.name === "Mafia" ? "in the Mafia" : "the " + role.name}` + (me.alive ? "" : " (out)") : "Watching";
    $("roleBlurb").textContent = role ? role.blurb : "";
    const allies = v.players.filter((p) => p.role === "mafia" && p.id !== room.myId && me && me.role === "mafia");
    $("allies").textContent = allies.length ? `Your partners: ${allies.map((p) => p.name).join(", ")}` : "";
    // news
    const n = v.news;
    $("news").textContent = !n ? "" :
      n.kind === "start" ? "Night falls on the town…" :
      n.kind === "dawn" ? (n.victim != null ? (n.victim === room.myId ? "☀️ You were eliminated in the night." : `☀️ ${nm(n.victim)} was eliminated in the night.`) : n.saved != null ? "☀️ The Doctor saved someone last night! Nobody was lost." : "☀️ A quiet night. Nobody was lost.") :
      n.kind === "dusk" ? (n.out == null ? "🗳️ No one was voted out."
        : n.out === room.myId ? `🗳️ The town voted you out. You were ${n.role === "mafia" ? "in the Mafia!" : "a " + ROLE[n.role].name + "."}`
        : `🗳️ The town voted out ${nm(n.out)}. They were ${n.role === "mafia" ? "in the Mafia!" : "a " + ROLE[n.role].name + "."}`) : "";
    // player list with actions
    const list = $("people");
    list.textContent = "";
    const canNight = v.phase === "night" && me && me.alive && me.role !== "town";
    const canVote = v.phase === "day" && me && me.alive;
    const tally = {};
    if (v.votes) for (const t of Object.values(v.votes)) tally[t] = (tally[t] || 0) + 1;
    for (const p of v.players) {
      let enabled = false;
      if (canNight && p.alive) {
        if (me.role === "mafia") enabled = p.role !== "mafia";
        else if (me.role === "doctor") enabled = p.id !== v.lastSave;
        else if (me.role === "detective") enabled = p.id !== room.myId;
      }
      if (canVote && p.alive && p.id !== room.myId) enabled = true;
      const picked = (canNight && v.myPick === p.id) || (canVote && v.votes && v.votes[room.myId] === p.id);
      const el = h(enabled ? "button" : "div", "mf-p" + (p.alive ? "" : " dead") + (picked ? " picked" : "") + (p.role === "mafia" && me && me.role === "mafia" ? " ally" : ""));
      if (enabled) { el.type = "button"; el.addEventListener("click", () => { GameUtil.sfx("click"); act({ t: canNight ? "night" : "vote", target: p.id }); }); }
      el.append(GameUtil.avatar(p), h("span", "mf-name", p.id === room.myId ? `${p.name} (you)` : p.name));
      if (p.role) el.append(h("span", "mf-tag " + p.role, ROLE[p.role].icon + " " + ROLE[p.role].name));
      if (v.checks && p.id in v.checks) el.append(h("span", "mf-tag " + (v.checks[p.id] ? "mafia" : "town"), v.checks[p.id] ? "🔎 Mafia!" : "🔎 innocent"));
      if (v.mafiaPicks) { const k = Object.values(v.mafiaPicks).filter((x) => x === p.id).length; if (k) el.append(h("span", "mf-count", `🔪×${k}`)); }
      if (tally[p.id]) el.append(h("span", "mf-count", `${tally[p.id]} vote${tally[p.id] === 1 ? "" : "s"}`));
      list.append(el);
    }
    $("skip").hidden = !canVote;
    $("skip").classList.toggle("picked", !!(v.votes && v.votes[room.myId] === -1));
    $("skip").textContent = `Skip vote${tally[-1] ? ` (${tally[-1]})` : ""}`;
    $("status").textContent =
      v.phase === "night" ? (canNight ? { mafia: "Pick someone to eliminate.", doctor: "Pick someone to save.", detective: "Pick someone to check." }[me.role] : me && !me.alive ? "You're out. Watch quietly!" : "You're asleep… 💤") :
      v.phase === "day" ? (canVote ? "Talk it over in the chat, then vote someone out." : "The town is voting…") : "";
  }
  function onState(v) {
    const prev = V;
    V = v;
    if (v.phase !== "end") render();
    if (stopClock) stopClock();
    stopClock = countdown(performance.now() + v.left, (left) => { $("timer").textContent = v.phase === "night" || v.phase === "day" ? fmt(left) : ""; });
    if (prev && prev.phase !== v.phase) {
      if (v.phase === "night") GameUtil.sfx("pop");
      if (v.phase === "dawn") GameUtil.sfx(v.news && v.news.victim != null ? "boom" : "good");
      if (v.phase === "day") GameUtil.sfx("turn");
      if (v.phase === "dusk") GameUtil.sfx(v.news && v.news.out != null ? "bad" : "pop");
    }
    if (!prev && v.me) GameUtil.toast(`${ROLE[v.me.role].icon} You're ${ROLE[v.me.role].name === "Mafia" ? "in the Mafia" : "the " + ROLE[v.me.role].name}!`, 3500);
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      render();
      const myTeam = v.me && (v.me.role === "mafia" ? "mafia" : "town");
      const won = myTeam === v.winner;
      GameUtil.sfx(won ? "win" : "lose");
      if (v.me) GameUtil.record("mafia", won ? "win" : "loss");
      results({
        title: v.winner === "mafia" ? "🔪 The Mafia win!" : "🏘️ The town wins!",
        rows: v.players.map((p) => ({ p, value: ROLE[p.role].icon + " " + ROLE[p.role].name + (p.alive ? "" : " · out"), win: (p.role === "mafia") === (v.winner === "mafia") })),
        isHost: room.isHost, meId: room.myId,
      });
    } else if (v.phase !== "end") hideResults();
  }

  $("skip").addEventListener("click", () => act({ t: "vote", target: -1 }));
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "mafia",
    title: "Mafia",
    subtitle: "Secret roles, night kills and day votes. Find the Mafia before they take over the town. 5 to 12 players.",
    min: 5,
    max: 12,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? onState(m) : r.sendTo(id, m)) };
        engine = createEngine(r, out);
        r.onData((from, m) => {
          if (!m) return;
          if (m.t === "night") engine.nightAct(from, m.target | 0);
          else if (m.t === "vote") engine.vote(from, m.target | 0);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view(id)));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => { if (engine) engine.stop(); if (stopClock) stopClock(); room = null; engine = null; V = null; hideResults(); delete document.body.dataset.phase; };
    },
  });
})();
