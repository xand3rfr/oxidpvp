// Tournament: a knockout bracket for any 1v1 game, 3–8 players. This tab holds the bracket;
// each match opens the real game in a new tab with its own room code (one player hosts, the
// other joins). When the match ends, the game tab tells this tab who won (same browser, via
// BroadcastChannel), and the bracket fills itself in. Players can also report by hand, and
// the host can settle any match.
(() => {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const SET_KEY = "oxidpvp-cup-game";
  const { h, results, hideResults } = Party;
  const $ = (id) => document.getElementById(id);
  const duels = () => GameUtil.games.filter((g) => g.duel);
  const loadGame = () => { let g = null; try { g = localStorage.getItem(SET_KEY); } catch {} return duels().some((x) => x.id === g) ? g : "connect"; };
  const makeCode = () => { const a = new Uint32Array(5); crypto.getRandomValues(a); return [...a].map((x) => ALPHABET[x % ALPHABET.length]).join(""); };

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, out) {
    const G = { game: loadGame(), players: [], rounds: [], champ: null, phase: "idle", gone: new Set() };
    const byId = (id) => G.players.find((p) => p.id === id);
    const view = () => ({ t: "st", game: G.game, players: G.players, rounds: G.rounds, champ: G.champ, phase: G.phase });
    const publish = () => out.all(view());

    function newGame() {
      G.game = loadGame();
      G.players = room.players.filter((p) => !G.gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, av: p.av }));
      const seeds = GameUtil.shuffle(G.players.map((p) => p.id));
      let size = 2;
      while (size < seeds.length) size *= 2;
      const first = [];
      for (let i = 0; i < size / 2; i++) first.push(match(seeds[i] ?? null, seeds[size - 1 - i] ?? null));
      G.rounds = [first];
      for (let n = size / 4; n >= 1; n /= 2) G.rounds.push(Array.from({ length: n }, () => match(null, null)));
      G.champ = null;
      G.phase = "play";
      advance();
    }
    const match = (a, b) => ({ a, b, w: null, code: null, bye: false });
    function advance() {
      // Byes, winners moving up, and fresh room codes for matches that are ready.
      for (let r = 0; r < G.rounds.length; r++) {
        G.rounds[r].forEach((m, i) => {
          if (r > 0) {
            const f1 = G.rounds[r - 1][i * 2], f2 = G.rounds[r - 1][i * 2 + 1];
            if (f1.w != null) m.a = f1.w;
            if (f2.w != null) m.b = f2.w;
            // A feeder with nobody in it (double bye) sends nobody up.
            if (f1.w == null && f1.a == null && f1.b == null) m.a = null;
            if (f2.w == null && f2.a == null && f2.b == null) m.b = null;
          }
          const feedersDone = r === 0 || (G.rounds[r - 1][i * 2].w != null || isEmpty(G.rounds[r - 1][i * 2])) && (G.rounds[r - 1][i * 2 + 1].w != null || isEmpty(G.rounds[r - 1][i * 2 + 1]));
          if (m.w == null && feedersDone && (m.a == null) !== (m.b == null)) { m.w = m.a ?? m.b; m.bye = true; }
          if (m.w == null && m.a != null && m.b != null && !m.code) m.code = makeCode();
        });
      }
      const fin = G.rounds[G.rounds.length - 1][0];
      if (fin.w != null && G.phase !== "end") { G.champ = fin.w; G.phase = "end"; }
      publish();
    }
    const isEmpty = (m) => m.a == null && m.b == null;
    function find(key) { const [r, i] = String(key).split(".").map(Number); return G.rounds[r] && G.rounds[r][i]; }
    function report(from, key, result) {
      const m = find(key);
      if (!m || m.w != null || G.phase !== "play" || (from !== m.a && from !== m.b)) return;
      if (result !== "win" && result !== "loss") return;
      const other = from === m.a ? m.b : m.a;
      m.w = result === "win" ? from : other;
      out.note(`${byId(m.w) ? byId(m.w).name : "?"} wins their match!`);
      advance();
    }
    function settle(key, w) {
      const m = find(key);
      if (!m || G.phase !== "play" || (w !== m.a && w !== m.b) || w == null) return;
      m.w = w;
      advance();
    }
    function leave(id) {
      G.gone.add(id);
      if (G.phase !== "play") return;
      // Forfeit any unfinished match they're in.
      for (const round of G.rounds) for (const m of round) {
        if (m.w == null && (m.a === id || m.b === id)) {
          const other = m.a === id ? m.b : m.a;
          if (other != null) m.w = other; else m.a = m.b = null;
        }
      }
      advance();
    }
    return { G, newGame, report, settle, leave, view };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, reported = new Set();
  const nm = (id) => { const p = V && V.players.find((x) => x.id === id); return p ? (p.id === room.myId ? "You" : p.name) : "—"; };
  const gameOf = (id) => GameUtil.gameById(id) || { title: id, page: id };
  function myMatch() {
    if (!V) return null;
    for (let r = 0; r < V.rounds.length; r++) for (let i = 0; i < V.rounds[r].length; i++) {
      const m = V.rounds[r][i];
      if (m.w == null && m.code && (m.a === room.myId || m.b === room.myId)) return { m, key: `${r}.${i}`, r };
    }
    return null;
  }
  function send(msg) {
    if (room.isHost) {
      if (msg.t === "rep") engine.report(room.myId, msg.key, msg.r);
      else if (msg.t === "set") engine.settle(msg.key, msg.w);
    } else room.send(msg);
  }

  function render() {
    const v = V, g = gameOf(v.game);
    $("gameName").textContent = g.title;
    const roundName = (r) => { const left = v.rounds.length - r; return left === 1 ? "Final" : left === 2 ? "Semifinals" : left === 3 ? "Quarterfinals" : `Round ${r + 1}`; };
    const br = $("bracket");
    br.textContent = "";
    v.rounds.forEach((round, r) => {
      const col = h("div", "cup-col");
      col.append(h("div", "cup-round", roundName(r)));
      round.forEach((m, i) => {
        const box = h("div", "cup-match" + (m.w == null && m.code ? " live" : "") + (m.a === room.myId || m.b === room.myId ? " mine" : ""));
        for (const side of ["a", "b"]) {
          const id = m[side];
          const row = h("div", "cup-p" + (m.w != null && id === m.w ? " won" : m.w != null && id != null ? " lost" : ""));
          const p = v.players.find((x) => x.id === id);
          if (p) row.append(GameUtil.avatar(p, "xs"));
          row.append(h("span", "", id == null ? (m.bye && m.w != null ? "bye" : "…") : nm(id)));
          if (room.isHost && v.phase === "play" && m.w == null && m.code && id != null) {
            const b = h("button", "cup-set", "won");
            b.type = "button"; b.title = `Mark ${nm(id)} as the winner`;
            b.addEventListener("click", () => send({ t: "set", key: `${r}.${i}`, w: id }));
            row.append(b);
          }
          box.append(row);
        }
        col.append(box);
      });
      br.append(col);
    });
    // my match panel
    const mm = myMatch();
    $("mine").hidden = !mm;
    if (mm) {
      const opp = mm.m.a === room.myId ? mm.m.b : mm.m.a;
      $("mineTitle").textContent = `Your match: you vs ${nm(opp)}`;
      $("play").href = `${g.page}.html#${mm.m.a === room.myId ? "host" : "join"}=${mm.m.code}`;
    }
    const waiting = v.players.some((p) => p.id === room.myId) && !mm && v.phase === "play";
    $("status").textContent = v.phase === "end" ? "" : mm ? "Keep this tab open. The result is filled in when your match ends." : waiting ? "Waiting for other matches to finish…" : "";
  }

  function onState(v) {
    const prev = V;
    V = v;
    if (v.phase !== "end") { render(); hideResults(); }
    const mm = myMatch();
    if (mm && (!prev || !prev.rounds.flat().some((m) => m.code === mm.m.code))) GameUtil.sfx("turn");
    if (v.phase === "end" && (!prev || prev.phase !== "end")) {
      render();
      const won = v.champ === room.myId;
      GameUtil.sfx(won ? "win" : "lose");
      GameUtil.record("cup", won ? "win" : "loss");
      // Rank by how far each player got.
      const reach = new Map(v.players.map((p) => [p.id, 0]));
      v.rounds.forEach((round, r) => round.forEach((m) => { for (const id of [m.a, m.b]) if (id != null) reach.set(id, r + (m.w === id ? 1 : 0)); }));
      const rows = [...v.players].sort((a, b) => reach.get(b.id) - reach.get(a.id)).map((p) => ({ p, value: p.id === v.champ ? "Champion 🏆" : `Round ${reach.get(p.id) + 1}`, win: p.id === v.champ }));
      setTimeout(() => results({ title: won ? "You're the champion!" : `${nm(v.champ)} wins the cup`, rows, isHost: room.isHost, meId: room.myId, again: "New tournament" }), 900);
    }
  }

  // Results from the game tab (same browser).
  try {
    new BroadcastChannel("oxidpvp").onmessage = (e) => {
      const d = e.data;
      if (!d || d.t !== "result" || !room || !V) return;
      const mm = myMatch();
      if (!mm || d.code !== mm.m.code || reported.has(mm.m.code)) return;
      if (d.result !== "win" && d.result !== "loss") return; // draws: play again
      reported.add(mm.m.code);
      send({ t: "rep", key: mm.key, r: d.result });
    };
  } catch {}

  $("iwon").addEventListener("click", () => { const mm = myMatch(); if (mm) send({ t: "rep", key: mm.key, r: "win" }); });
  $("ilost").addEventListener("click", () => { const mm = myMatch(); if (mm) send({ t: "rep", key: mm.key, r: "loss" }); });
  $("again").addEventListener("click", () => { if (engine) engine.newGame(); });

  function buildSettings(el) {
    el.innerHTML = `<div class="set-head">Game</div><div class="cup-games"></div>`;
    const box = el.querySelector(".cup-games");
    for (const g of duels()) {
      const b = h("button", "", g.title);
      b.type = "button";
      b.dataset.v = g.id;
      b.addEventListener("click", () => { try { localStorage.setItem(SET_KEY, g.id); } catch {} paint(); });
      box.append(b);
    }
    const paint = () => [...box.children].forEach((b) => b.classList.toggle("on", b.dataset.v === loadGame()));
    paint();
  }

  Room.mount({
    game: "cup",
    title: "Tournament",
    subtitle: "A knockout bracket for any 1v1 game, 3 to 8 players. The host picks the game; each match opens in a new tab.",
    min: 3,
    max: 8,
    lobbyExtra: buildSettings,
    onStart(r) {
      room = r; V = null; reported = new Set();
      if (r.isHost) {
        const out = { all: (m) => { r.broadcast(m); onState(m); }, note: (t) => { r.broadcast({ t: "note", text: t }); GameUtil.toast(t); } };
        engine = createEngine(r, out);
        r.onData((from, m) => {
          if (!m) return;
          if (m.t === "rep") engine.report(from, m.key, m.r);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => r.sendTo(id, engine.view()));
        setTimeout(() => engine && engine.newGame(), 300);
      } else r.onData((_, m) => {
        if (!m) return;
        if (m.t === "st") onState(m);
        else if (m.t === "note") GameUtil.toast(m.text);
      });
      return () => { room = null; engine = null; V = null; hideResults(); };
    },
  });
})();
