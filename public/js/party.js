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
})();
