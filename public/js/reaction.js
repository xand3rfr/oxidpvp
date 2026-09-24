// Reaction Duel, 1v1. Wait for the screen to turn green, then click (or tap, or hit Space)
// as fast as you can. Go early and you lose the round, and watch out for fake-out flashes.
// Each player's reaction time is measured on their own device, from the moment green shows
// on *their* screen, so a laggy connection doesn't cost you the round. First to 5 wins.
(() => {
  const WIN = 5, RESOLVE_MS = 2500, NEXT_MS = 2600;
  const $ = (id) => document.getElementById(id);
  const pad = $("pad"), big = $("big"), small = $("small");
  const COLORS = ["#ff5b3a", "#4d8dff"];

  let link = null, me = 0, S = null;          // S: host-side round state
  let R = null;                                // local round: { n, goAt, sent, timers }
  let score = [0, 0], over = false, roundNo = 0;

  // ---------- local round display ----------
  function clearTimers() { if (R) for (const t of R.timers) clearTimeout(t); }
  function setPad(cls, a, b) { pad.className = "rx-pad " + cls; big.textContent = a; small.textContent = b || ""; }
  function startLocal(m) {
    clearTimers();
    R = { n: m.n, goAt: 0, sent: false, timers: [] };
    roundNo = m.round;
    setPad("wait", "Wait for green…", `Round ${m.round}`);
    for (const f of m.fakes) {
      R.timers.push(setTimeout(() => { if (R && R.n === m.n && !R.goAt && !R.sent) { setPad("fake", "Not yet!", "Don't click"); GameUtil.sfx("tick"); } }, f));
      R.timers.push(setTimeout(() => { if (R && R.n === m.n && !R.goAt && !R.sent) setPad("wait", "Wait for green…", `Round ${m.round}`); }, f + 380));
    }
    R.timers.push(setTimeout(() => {
      if (!R || R.n !== m.n || R.sent) return;
      R.goAt = performance.now();
      setPad("go", "CLICK!", "");
      GameUtil.sfx("start");
    }, m.delay));
  }
  function press() {
    if (!link || link.spectator || !R || R.sent || over) return;
    R.sent = true;
    const ms = R.goAt ? Math.round(performance.now() - R.goAt) : -1;
    setPad(ms < 0 ? "early" : "done", ms < 0 ? "Too soon!" : `${ms} ms`, ms < 0 ? "False start" : "Waiting for your opponent…");
    GameUtil.sfx(ms < 0 ? "bad" : "click");
    if (link.isHost) hostTime(0, ms, R.n); else link.send({ t: "t", ms, n: R.n });
  }
  pad.addEventListener("pointerdown", (e) => { e.preventDefault(); press(); });
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); if (!e.repeat) press(); }
  });

  function showResult(m) {
    clearTimers();
    score = m.sc;
    updateScore();
    const t = m.times;
    const fmtT = (x) => (x == null ? "no click" : x < 0 ? "false start" : `${x} ms`);
    const mine = t[me], theirs = t[1 - me];
    const name = (i) => (link.spectator ? link.names[i] : i === me ? "You" : link.oppName);
    const head = m.w < 0 ? "No point" : link.spectator ? `${link.names[m.w]} takes it` : m.w === me ? "You win the round!" : `${link.oppName} wins the round`;
    setPad(m.w < 0 ? "wait" : link.spectator || m.w !== me ? "lose" : "win", head, link.spectator ? `${name(0)}: ${fmtT(t[0])} · ${name(1)}: ${fmtT(t[1])}` : `You: ${fmtT(mine)} · Them: ${fmtT(theirs)}`);
    if (!link.spectator) GameUtil.sfx(m.w === me ? "good" : m.w < 0 ? "pop" : "bad");
    // Personal best, saved on this device.
    if (!link.spectator && mine > 0) {
      let best = 0;
      try { best = +localStorage.getItem("oxidpvp-reaction-best") || 0; } catch {}
      if (!best || mine < best) { try { localStorage.setItem("oxidpvp-reaction-best", mine); } catch {} best = mine; }
      $("best").textContent = `Your best: ${best} ms`;
    }
    if (m.end) {
      over = true;
      const won = m.end - 1 === me;
      setTimeout(() => {
        if (!link) return;
        if (!link.spectator) { GameUtil.sfx(won ? "win" : "lose"); GameUtil.record("reaction", won ? "win" : "loss"); }
        $("resultTitle").textContent = link.spectator ? `${link.names[m.end - 1]} wins` : won ? "Lightning fast!" : "Too slow!";
        $("resultScore").textContent = `${score[me]} – ${score[1 - me]}`;
        $("rematch").hidden = !!link.spectator; $("rematch").disabled = false; $("rematch").textContent = "Rematch";
        $("result").hidden = false;
      }, 1400);
    }
  }
  function updateScore() { $("s0").textContent = score[me]; $("s1").textContent = score[1 - me]; }

  // ---------- host referee ----------
  function hostRound() {
    clearTimeout(S.timer);
    S.n++; S.round++;
    S.times = [undefined, undefined];
    const delay = 1600 + Math.floor(Math.random() * 3400);
    const fakes = [];
    const nf = Math.random() < 0.55 ? 1 + (Math.random() < 0.4 ? 1 : 0) : 0;
    for (let k = 0; k < nf; k++) fakes.push(500 + Math.floor(Math.random() * Math.max(200, delay - 1100)));
    const m = { t: "r", n: S.n, round: S.round, delay, fakes };
    link.send(m);
    startLocal(m);
    S.timer = setTimeout(resolve, delay + RESOLVE_MS);
  }
  function hostTime(side, ms, n) {
    if (!S || n !== S.n || S.times[side] !== undefined) return;
    S.times[side] = ms;
    // A false start ends the round right away; otherwise wait for both.
    if (ms < 0 || S.times.every((x) => x !== undefined)) resolve();
  }
  function resolve() {
    if (!S || S.resolvedN === S.n) return;
    S.resolvedN = S.n;
    clearTimeout(S.timer);
    const t = S.times.map((x) => (x === undefined ? null : x));
    const ok = t.map((x) => x != null && x >= 0);
    let w = -1;
    if (t[0] != null && t[0] < 0 && !(t[1] != null && t[1] < 0)) w = 1;
    else if (t[1] != null && t[1] < 0 && !(t[0] != null && t[0] < 0)) w = 0;
    else if (ok[0] && ok[1]) w = t[0] === t[1] ? -1 : t[0] < t[1] ? 0 : 1;
    else if (ok[0]) w = 0;
    else if (ok[1]) w = 1;
    if (w >= 0) S.sc[w]++;
    const end = S.sc[0] >= WIN ? 1 : S.sc[1] >= WIN ? 2 : 0;
    const m = { t: "res", n: S.n, times: t, w, sc: S.sc.slice(), end };
    link.send(m);
    showResult(m);
    if (!end) S.timer = setTimeout(hostRound, NEXT_MS);
  }
  function hostNewMatch() {
    if (S) clearTimeout(S.timer);
    S = { sc: [0, 0], n: S ? S.n : 0, round: 0, times: [], timer: 0, resolvedN: -1 };
    over = false; score = [0, 0]; updateScore();
    link.send({ t: "new" });
    $("result").hidden = true;
    S.timer = setTimeout(hostRound, 1200);
    setPad("wait", "Get ready…", "Click when it turns green");
  }

  $("rematch").addEventListener("click", () => {
    if (!link) return;
    if (link.isHost) hostNewMatch();
    else { link.send({ t: "rm" }); $("rematch").disabled = true; $("rematch").textContent = "Waiting for host…"; }
  });
  $("peek").addEventListener("click", () => { $("result").hidden = true; });

  Lobby.mount({
    game: "reaction",
    title: "Reaction Duel",
    subtitle: "Wait for green, then click faster than your friend. Go early and you lose the round. First to 5.",
    onStart(l) {
      link = l;
      me = l.isHost ? 0 : 1;
      $("name0").textContent = l.spectator ? l.myName : "You";
      $("name1").textContent = l.oppName;
      $("sw0").style.background = COLORS[me]; $("sw1").style.background = COLORS[1 - me];
      score = [0, 0]; over = false; R = null; updateScore();
      try { const b = +localStorage.getItem("oxidpvp-reaction-best"); $("best").textContent = b ? `Your best: ${b} ms` : ""; } catch {}
      setPad("wait", "Get ready…", "Click when it turns green");
      if (l.isHost) {
        S = null;
        l.onData((d) => {
          if (d.t === "t") hostTime(1, d.ms | 0, d.n);
          else if (d.t === "rm" && over) hostNewMatch();
        });
        l.onRejoin(() => link.send({ t: "res", n: S.n, times: [null, null], w: -1, sc: S.sc.slice(), end: 0 }));
        hostNewMatch();
      } else l.onData((d) => {
        if (d.t === "r") startLocal(d);
        else if (d.t === "res") showResult(d);
        else if (d.t === "new") { over = false; score = [0, 0]; updateScore(); $("result").hidden = true; setPad("wait", "Get ready…", "Click when it turns green"); }
      });
      return () => { clearTimers(); if (S) clearTimeout(S.timer); S = null; R = null; link = null; $("result").hidden = true; };
    },
  });
})();
