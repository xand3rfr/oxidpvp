// Small helpers shared by the newer games (DOM building, results screen, countdowns).
(() => {
  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : String(s);
  };

  // Fills the standard #result overlay. rows: [{ p: {id,name,av}, value, win }]
  function results({ title, rows, isHost, meId, again = "Play again" }) {
    document.getElementById("resultTitle").textContent = title;
    const list = document.getElementById("standings");
    list.textContent = "";
    rows.forEach((r, i) => {
      const li = h("li", r.win ? "win" : "");
      li.append(h("span", "pos", i + 1), GameUtil.avatar(r.p), h("span", "pname", r.p.name + (r.p.id === meId ? " (you)" : "")), h("span", "n", r.value));
      list.append(li);
    });
    const btn = document.getElementById("again");
    btn.hidden = !isHost; btn.textContent = again;
    // Host can also let everyone vote on what to play next.
    let vote = document.getElementById("voteNext");
    if (!vote) {
      vote = h("button", "btn", "🗳️ Vote next game");
      vote.id = "voteNext"; vote.type = "button";
      vote.addEventListener("click", () => { if (GameUtil.startPoll()) hideResults(); });
      btn.after(vote);
    }
    vote.hidden = !isHost || !GameUtil.canPoll();
    document.getElementById("againWait").hidden = isHost;
    document.getElementById("result").hidden = false;
  }
  const hideResults = () => { document.getElementById("result").hidden = true; };

  // Counts down to a local deadline, calling onTick(msLeft) every frame until stop() or zero.
  function countdown(endsAt, onTick) {
    let raf = 0, stopped = false;
    const tick = () => {
      if (stopped) return;
      const left = Math.max(0, endsAt - performance.now());
      onTick(left);
      if (left > 0) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { stopped = true; cancelAnimationFrame(raf); };
  }

  window.Party = { h, fmt, results, hideResults, countdown };
})();

// Turn-based 1v1 helper used by Checkers, Ultimate Tic-Tac-Toe and Dots & Boxes.
// The host keeps the real state S and referees moves; the guest (and spectators) just render.
//   cfg.newState(first) -> S with S.turn (0 = host, 1 = guest) and S.over (null | { winner: 0|1|-1, reason })
//   cfg.move(S, side, m) -> true if the move was legal and applied
//   cfg.render(S, ui)    ui = { me, canMove, send(m), names, spectator, fresh, prev }
(() => {
  const $ = (id) => document.getElementById(id);
  function turnDuel(cfg) {
    let link = null, S = null, V = null, sc = [0, 0], n = 0, first = 0;
    const clone = (x) => JSON.parse(JSON.stringify(x));

    function publish() { const m = { t: "st", S, sc, n }; link.send(m); show(clone(m)); }
    function newGame() {
      n++;
      S = cfg.newState(first);
      first = 1 - first; // alternate who starts
      publish();
    }
    function hostMove(side, m) {
      if (!S || S.over || S.turn !== side) return false;
      if (!cfg.move(S, side, m)) return false;
      if (S.over && S.over.winner >= 0) sc[S.over.winner]++;
      publish();
      return true;
    }
    function send(m) {
      if (!link || link.spectator) return;
      if (link.isHost) hostMove(0, m);
      else link.send({ t: "mv", m });
    }

    function show(msg) {
      const prev = V;
      V = msg;
      const me = link.isHost ? 0 : 1;
      const names = link.names;
      const nm = (side) => (link.spectator ? names[side] : side === me ? "You" : names[side]);
      const s = msg.S;
      const canMove = !link.spectator && !s.over && s.turn === me;
      $("s0").textContent = msg.sc[me];
      $("s1").textContent = msg.sc[1 - me];
      $("banner").classList.toggle("mine", canMove);
      $("bannerText").textContent = s.over
        ? (s.over.winner < 0 ? "Draw" : link.spectator ? `${names[s.over.winner]} wins` : s.over.winner === me ? "You win!" : "They win")
        : link.spectator ? `${names[s.turn]}'s move` : canMove ? (cfg.yourTurnText ? cfg.yourTurnText(s) : "Your move") : "Their move";
      if (cfg.chip) $("bannerChip").style.background = cfg.chip(s.over ? Math.max(0, s.over.winner) : s.turn);
      const fresh = !prev || prev.n !== msg.n;
      cfg.render(s, { me, canMove, send, names, spectator: link.spectator, fresh, prev: prev && !fresh ? prev.S : null, nm });
      if (!fresh && prev && JSON.stringify(prev.S) !== JSON.stringify(s)) {
        if (canMove && prev.S.turn !== s.turn) setTimeout(() => GameUtil.sfx("turn"), 200);
        else if (!s.over) GameUtil.sfx("pop");
      }
      if (s.over && (fresh || !prev.S.over)) {
        const r = s.over.winner;
        if (!link.spectator) { GameUtil.sfx(r < 0 ? "pop" : r === me ? "win" : "lose"); GameUtil.record(cfg.game, r < 0 ? "draw" : r === me ? "win" : "loss"); }
        setTimeout(() => {
          if (!V || !V.S.over) return;
          $("resultTitle").textContent = r < 0 ? "Draw" : link.spectator ? `${names[r]} wins` : r === me ? "You win" : "You lose";
          $("resultScore").textContent = (s.over.reason ? s.over.reason + " · " : "") + `${msg.sc[me]} – ${msg.sc[1 - me]}`;
          $("rematch").hidden = link.spectator;
          $("rematch").disabled = false; $("rematch").textContent = "Rematch";
          $("result").hidden = false;
        }, 900);
      } else if (!s.over) $("result").hidden = true;
    }

    $("rematch").addEventListener("click", () => {
      if (!link) return;
      if (link.isHost) newGame();
      else { link.send({ t: "rm" }); $("rematch").disabled = true; $("rematch").textContent = "Waiting for host…"; }
    });
    $("peek").addEventListener("click", () => { $("result").hidden = true; });

    Lobby.mount({
      game: cfg.game, title: cfg.title, subtitle: cfg.subtitle,
      // With cfg.ai the lobby offers practice against the computer: the bot answers each state
      // where it's the guest's turn with a move, after a short "thinking" pause.
      bot: cfg.ai ? (level) => ({
        onMessage(o, reply) {
          if (o.t !== "st" || !o.S || o.S.over || o.S.turn !== 1) return;
          const S0 = clone(o.S), t0 = performance.now();
          const m = cfg.ai(S0, 1, level);
          if (m == null) return;
          setTimeout(() => reply({ t: "mv", m }), Math.max(0, 450 + Math.random() * 400 - (performance.now() - t0)));
        },
      }) : null,
      onStart(l) {
        link = l; V = null; sc = [0, 0]; n = 0; first = 0;
        $("name0").textContent = l.spectator ? l.myName : "You";
        $("name1").textContent = l.oppName;
        if (cfg.chip) { $("sw0").style.background = cfg.chip(l.isHost ? 0 : 1); $("sw1").style.background = cfg.chip(l.isHost ? 1 : 0); }
        if (l.isHost) {
          l.onData((d) => {
            if (d.t === "mv" && !hostMove(1, d.m)) l.send({ t: "st", S, sc, n }); // rejected: resync
            else if (d.t === "rm" && S && S.over) newGame();
          });
          l.onRejoin(() => l.send({ t: "st", S, sc, n }));
          newGame();
        } else l.onData((d) => { if (d.t === "st") show(d); });
        return () => { link = null; S = null; V = null; $("result").hidden = true; };
      },
    });
  }
  window.Party.turnDuel = turnDuel;

  // Game-tree search for the computer opponents. g = { moves(S, side), play(S, side, m) -> S2,
  // score(S, side) }. Returns the best move for `side` looking `depth` plies ahead (alpha-beta).
  // A side can move twice in a row (checkers jumps, dots boxes): the turn is read from S.turn.
  function search(S, side, depth, g, deadline = performance.now() + 900) {
    let best = null, bestV = -Infinity;
    const moves = g.moves(S, side);
    if (!moves.length) return null;
    const order = moves.map((m) => ({ m, S2: g.play(S, side, m) }));
    order.sort((a, b) => g.score(b.S2, side) - g.score(a.S2, side));
    function ab(S, d, a, b) {
      if (S.over) return S.over.winner === side ? 1e6 + d : S.over.winner < 0 ? 0 : -1e6 - d;
      if (d <= 0 || performance.now() > deadline) return g.score(S, side);
      const who = S.turn, mv = g.moves(S, who);
      if (!mv.length) return g.score(S, side);
      if (who === side) {
        let v = -Infinity;
        for (const m of mv) { v = Math.max(v, ab(g.play(S, who, m), d - 1, a, b)); a = Math.max(a, v); if (a >= b) break; }
        return v;
      }
      let v = Infinity;
      for (const m of mv) { v = Math.min(v, ab(g.play(S, who, m), d - 1, a, b)); b = Math.min(b, v); if (a >= b) break; }
      return v;
    }
    for (const { m, S2 } of order) {
      const v = ab(S2, depth - 1, bestV, Infinity) + Math.random() * 0.01;
      if (v > bestV) { bestV = v; best = m; }
    }
    return best;
  }
  window.Party.search = search;

  // Team mode for party games: players alternate Red, Blue, Red… in join order, so every client
  // works out the same teams from the same player list. Returns totals and the winning team.
  const TEAMS = [{ name: "Red", color: "#ef4444" }, { name: "Blue", color: "#3b82f6" }];
  window.Party.TEAMS = TEAMS;
  window.Party.teams = (players, scoreOf) => {
    const team = new Map(players.map((p, i) => [p.id, i % 2]));
    const totals = [0, 0];
    for (const p of players) totals[team.get(p.id)] += scoreOf(p);
    return { team, totals, winner: totals[0] === totals[1] ? -1 : totals[0] > totals[1] ? 0 : 1 };
  };
  window.Party.pickRandom = (a) => a[Math.floor(Math.random() * a.length)];
})();
