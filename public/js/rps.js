// Rock Paper Scissors tournament for 2–8 players. A knockout bracket where every match is
// best of 3 (ties replay). All matches in a round run at once. The host keeps the bracket and
// only reveals a throw once both players have picked (or the timer runs out).
(() => {
  const THROW_MS = 8000, SHOW_MS = 1800, WINS = 2;
  const ICON = { r: "🪨", p: "📄", s: "✂️" };
  const NAME = { r: "Rock", p: "Paper", s: "Scissors" };
  const BEATS = { r: "s", p: "r", s: "p" };
  const { h, results, hideResults } = Party;
  const $ = (id) => document.getElementById(id);
  const roundName = (n) => (n === 2 ? "Final" : n === 4 ? "Semifinals" : n <= 8 ? "Quarterfinals" : `Round of ${n}`);

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { players: [], rounds: [], round: 0, phase: "idle", champion: null, tick: 0 };
    const byId = (id) => G.players.find((p) => p.id === id);
    const cur = () => G.rounds[G.round] || [];

    function mkMatch(a, b) {
      return { a, b, wins: [0, 0], winner: b == null ? a : null, pick: [null, null], last: null, ends: b == null ? 0 : Date.now() + THROW_MS, showUntil: 0 };
    }
    function newGame() {
      G.players = room.players.filter((p) => !G.gone || !G.gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av }));
      const ids = GameUtil.shuffle(G.players.map((p) => p.id));
      const first = [];
      for (let i = 0; i < ids.length; i += 2) first.push(mkMatch(ids[i], ids[i + 1] ?? null));
      G.rounds = [first]; G.round = 0; G.phase = "play"; G.champion = null;
      clearInterval(G.tick);
      G.tick = setInterval(step, 200);
      publish();
    }
    function step() {
      if (G.phase !== "play") return;
      const now = Date.now();
      let changed = false;
      for (const m of cur()) {
        if (m.winner != null) continue;
        if (m.showUntil) {
          if (now >= m.showUntil) { m.showUntil = 0; m.pick = [null, null]; m.ends = now + THROW_MS; changed = true; }
          continue;
        }
        if (now >= m.ends) {
          // Out of time: anyone who didn't pick throws something random.
          m.pick = m.pick.map((c) => c || "rps"[Math.floor(Math.random() * 3)]);
          resolve(m);
          changed = true;
        }
      }
      if (cur().every((m) => m.winner != null)) return advance();
      if (changed) publish();
    }
    function resolve(m) {
      const [x, y] = m.pick;
      const w = x === y ? -1 : BEATS[x] === y ? 0 : 1;
      m.last = { a: x, b: y, w };
      if (w >= 0) m.wins[w]++;
      if (m.wins[0] >= WINS) m.winner = m.a;
      else if (m.wins[1] >= WINS) m.winner = m.b;
      else m.showUntil = Date.now() + SHOW_MS;
    }
    function pick(id, c) {
      if (G.phase !== "play" || !"rps".includes(c) || c.length !== 1) return;
      const m = cur().find((x) => x.winner == null && !x.showUntil && (x.a === id || x.b === id));
      if (!m) return;
      const side = m.a === id ? 0 : 1;
      if (m.pick[side]) return;
      m.pick[side] = c;
      if (m.pick[0] && m.pick[1]) resolve(m);
      if (cur().every((x) => x.winner != null)) return advance();
      publish();
    }
    function advance() {
      const winners = cur().map((m) => m.winner).filter((id) => id != null && byId(id) && !byId(id).gone);
      if (winners.length <= 1) {
        G.phase = "end"; G.champion = winners[0] ?? null;
        clearInterval(G.tick);
        return publish();
      }
      publish(); // show the finished round for a moment
      G.phase = "between";
      setTimeout(() => {
        if (G.phase !== "between") return;
        const next = [];
        for (let i = 0; i < winners.length; i += 2) next.push(mkMatch(winners[i], winners[i + 1] ?? null));
        G.rounds.push(next); G.round++; G.phase = "play";
        publish();
      }, 2200);
    }
    function view() {
      return {
        t: "st", phase: G.phase, round: G.round, champion: G.champion,
        players: G.players,
        rounds: G.rounds.map((r) => r.map((m) => ({
          a: m.a, b: m.b, wins: m.wins, winner: m.winner, last: m.last,
          picked: [!!m.pick[0], !!m.pick[1]], left: m.winner == null && !m.showUntil ? Math.max(0, m.ends - Date.now()) : 0,
          showing: !!m.showUntil,
        }))),
      };
    }
    const publish = () => out.all(view());
    function leave(id) {
      (G.gone ||= new Set()).add(id);
      const p = byId(id);
      if (p) p.gone = true; // keep their name on the bracket
      for (const m of cur()) {
        if (m.winner != null) continue;
        if (m.a === id) m.winner = m.b;
        else if (m.b === id) m.winner = m.a;
      }
      if (G.phase === "play" && cur().every((m) => m.winner != null)) advance();
      else publish();
    }
    return { G, newGame, pick, leave, view, stop: () => clearInterval(G.tick) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, myPick = null, gotAt = 0, raf = 0;
  const nameOf = (id) => { const p = V && V.players.find((x) => x.id === id); return p ? p.name : "—"; };
  const personOf = (id) => (V && V.players.find((x) => x.id === id)) || { name: "—" };

  for (const c of "rps") {
    const b = h("button", "rps-btn");
    b.type = "button";
    b.dataset.c = c;
    b.append(h("span", "rps-ico", ICON[c]), h("span", "rps-lbl", NAME[c]));
    b.addEventListener("click", () => {
      if (!V || myPick) return;
      myPick = c;
      paintButtons();
      GameUtil.sfx("click");
      if (room.isHost) engine.pick(room.myId, c); else room.send({ t: "pick", c });
    });
    $("buttons").append(b);
  }
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const k = { 1: "r", 2: "p", 3: "s", r: "r", p: "p", s: "s" }[e.key.toLowerCase()];
    if (k) document.querySelector(`.rps-btn[data-c="${k}"]`).click();
  });
  function paintButtons() {
    document.querySelectorAll(".rps-btn").forEach((b) => b.classList.toggle("on", b.dataset.c === myPick));
  }

  function myMatch(v) {
    const r = v.rounds[v.round] || [];
    return r.find((m) => m.a === room.myId || m.b === room.myId);
  }

  function onState(v) {
    const prev = V;
    V = v;
    gotAt = performance.now();
    const m = myMatch(v);
    const pm = prev && myMatch(prev);
    const side = m ? (m.a === room.myId ? 0 : 1) : -1;
    const oppId = m ? (side === 0 ? m.b : m.a) : null;
    const live = v.phase === "play" && m && m.winner == null && !m.showing;
    // Each throw starts fresh; if we reloaded after picking, the host already has our pick.
    if (!live) myPick = null;
    else if (m.picked[side] && !myPick) myPick = "?";

    $("roundName").textContent = v.phase === "end" ? "Tournament over" : roundName((v.rounds[v.round] || []).length * 2);

    // my match
    const arena = $("arena");
    arena.hidden = !m || m.b == null && m.winner === room.myId && v.phase !== "play";
    $("spectate").hidden = !!m && !(m.winner != null && m.winner !== room.myId);
    if (m) {
      const me = personOf(room.myId), opp = personOf(oppId);
      $("meSide").textContent = ""; $("oppSide").textContent = "";
      $("meSide").append(GameUtil.avatar(me, "lg"), h("b", "", "You"), dots(m.wins[side]));
      $("oppSide").append(GameUtil.avatar(opp, "lg"), h("b", "", oppId == null ? "Bye" : opp.name), dots(oppId == null ? 0 : m.wins[1 - side]));
      const last = m.last;
      const reveal = $("reveal");
      reveal.textContent = "";
      if (m.b == null) reveal.append(h("div", "rps-msg", "You got a bye. Straight through to the next round!"));
      else if (last && (m.showing || m.winner != null)) {
        const mine = side === 0 ? last.a : last.b, theirs = side === 0 ? last.b : last.a;
        const res = last.w < 0 ? "Tie! Go again" : (last.w === side ? "You win the throw!" : "They win the throw");
        const row = h("div", "rps-throws");
        row.append(h("span", "big-ico", ICON[mine]), h("span", "vs", "vs"), h("span", "big-ico", ICON[theirs]));
        reveal.append(row, h("div", "rps-msg " + (last.w < 0 ? "" : last.w === side ? "good" : "bad"), m.winner != null ? (m.winner === room.myId ? "You win the match!" : `${opp.name} wins the match`) : res));
      } else if (live) reveal.append(h("div", "rps-msg", myPick ? (m.picked[1 - side] ? "Both picked…" : `${NAME[myPick] ? "You threw " + NAME[myPick] : "Picked"}. Waiting for ${opp.name}…`) : m.picked[1 - side] ? `${opp.name} has picked. Your move!` : "Pick your throw!"));
      $("buttons").hidden = !live || !!myPick;
      paintButtons();
    }

    // bracket
    const br = $("bracket");
    br.textContent = "";
    v.rounds.forEach((round, ri) => {
      const col = h("div", "br-col" + (ri === v.round ? " cur" : ""));
      col.append(h("div", "br-title", roundName(round.length * 2)));
      for (const mt of round) {
        const box = h("div", "br-match" + (mt.a === room.myId || mt.b === room.myId ? " mine" : ""));
        for (const [id, k] of [[mt.a, 0], [mt.b, 1]]) {
          const row = h("div", "br-row" + (mt.winner != null && mt.winner === id ? " won" : mt.winner != null ? " lost" : ""));
          if (id == null) { row.append(h("span", "muted", "bye")); }
          else { row.append(GameUtil.avatar(personOf(id), "xs"), h("span", "br-name", nameOf(id)), h("span", "br-w", mt.b == null ? "" : mt.wins[k])); }
          box.append(row);
        }
        col.append(box);
      }
      br.append(col);
    });

    if (prev && m && pm) {
      if (m.showing && !pm.showing && m.last) GameUtil.sfx(m.last.w < 0 ? "pop" : m.last.w === side ? "good" : "bad");
      if (m.winner != null && pm.winner == null && m.b != null) GameUtil.sfx(m.winner === room.myId ? "good" : "lose");
    }
    if (live && (!pm || pm.showing || prev.round !== v.round)) GameUtil.sfx("turn");

    cancelAnimationFrame(raf);
    const tick = () => {
      if (!V) return;
      const mm = myMatch(V);
      const left = mm && mm.left ? Math.max(0, mm.left - (performance.now() - gotAt)) : 0;
      $("timerBar").style.width = (left / THROW_MS) * 100 + "%";
      if (left > 0) raf = requestAnimationFrame(tick);
    };
    tick();

    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      const champ = personOf(v.champion);
      const won = v.champion === room.myId;
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("rps", won ? "win" : "loss");
      // Rank by how far each player got.
      const reached = {};
      v.rounds.forEach((r, ri) => r.forEach((mt) => { for (const id of [mt.a, mt.b]) if (id != null) reached[id] = ri; }));
      const rows = [...v.players].sort((a, b) => (b.id === v.champion) - (a.id === v.champion) || (reached[b.id] || 0) - (reached[a.id] || 0))
        .map((p) => ({ p, value: p.id === v.champion ? "🏆 champion" : `out in the ${roundName((v.rounds[reached[p.id] || 0] || []).length * 2).toLowerCase()}`, win: p.id === v.champion }));
      results({ title: won ? "You're the champion!" : `${champ.name} wins it all`, rows, isHost: room.isHost, meId: room.myId, again: "New tournament" });
    } else if (v.phase !== "end") hideResults();
  }
  function dots(n) {
    const d = h("span", "rps-dots");
    for (let i = 0; i < WINS; i++) d.append(h("i", i < n ? "on" : ""));
    return d;
  }

  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  Room.mount({
    game: "rps",
    title: "RPS Tournament",
    subtitle: "A knockout Rock Paper Scissors bracket. Best of 3 each match. 2 to 8 players.",
    min: 2,
    max: 8,
    onStart(r) {
      room = r; V = null; myPick = null;
      if (r.isHost) {
        const out = { all: (m) => { r.broadcast(m); onState(m); } };
        engine = createEngine(r, out);
        r.onData((from, m) => { if (m && m.t === "pick") engine.pick(from, String(m.c)); });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view()));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => { if (m && m.t === "st") onState(m); });
      return () => {
        if (engine) engine.stop();
        cancelAnimationFrame(raf);
        room = null; engine = null; V = null;
        hideResults();
      };
    },
  });
})();
