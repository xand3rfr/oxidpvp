// Spyfall for 3–8 players. Everyone but the spy learns a secret location and a role there.
// Players question each other (in chat or out loud) to find the spy without giving the place away.
// Anyone can accuse once per round (everyone else must agree); the spy can guess the location
// at any time. When the timer runs out, everyone votes. The host deals the cards and counts votes;
// each player only receives their own card.
(() => {
  const VOTE_MS = 30000, GUESS_MS = 30000;
  const LOCS = window.SPY_LOCATIONS;
  const { h, fmt, results, hideResults, countdown } = Party;
  const $ = (id) => document.getElementById(id);

  // =====================================================================
  // Host engine
  // =====================================================================
  function createEngine(room, settings, out) {
    const G = {
      players: room.players.map((p) => ({ id: p.id, name: p.name, av: p.av, score: 0 })),
      phase: "idle", spy: null, loc: -1, roles: {}, ends: 0, paused: 0, first: null,
      accuse: null, used: [], finalVotes: {}, result: null, round: 0, timer: 0,
    };
    const byId = (id) => G.players.find((p) => p.id === id);

    function view(id) {
      const isSpy = id === G.spy;
      const over = G.phase === "end";
      return {
        t: "st", phase: G.phase, round: G.round, first: G.first,
        players: G.players.map(({ id, name, av, score }) => ({ id, name, av, score })),
        card: isSpy ? { spy: true } : G.loc >= 0 ? { loc: LOCS[G.loc][0], role: G.roles[id] } : null,
        left: G.phase === "vote" ? G.paused : Math.max(0, G.ends - Date.now()),
        voteLeft: G.accuse ? Math.max(0, G.accuse.ends - Date.now()) : 0,
        accuse: G.accuse && { by: G.accuse.by, target: G.accuse.target, votes: G.accuse.votes },
        used: G.used, finalVotes: G.phase === "final" ? Object.keys(G.finalVotes).map(Number) : null,
        amSpy: isSpy, result: over ? G.result : null,
        spy: over ? G.spy : null, loc: over ? LOCS[G.loc][0] : null,
      };
    }
    const publish = () => { for (const p of G.players) out.to(p.id, view(p.id)); };

    function newRound() {
      clearTimeout(G.timer);
      if (G.players.length < 3) { G.phase = "end"; G.result = { winner: "none", text: "Not enough players left." }; return publish(); }
      G.round++;
      G.loc = Math.floor(Math.random() * LOCS.length);
      const roles = GameUtil.shuffle(LOCS[G.loc][1].slice());
      G.spy = G.players[Math.floor(Math.random() * G.players.length)].id;
      G.roles = {};
      G.players.forEach((p, i) => { if (p.id !== G.spy) G.roles[p.id] = roles[i % roles.length]; });
      G.first = G.players[Math.floor(Math.random() * G.players.length)].id;
      G.accuse = null; G.used = []; G.finalVotes = {}; G.result = null;
      G.phase = "play";
      G.ends = Date.now() + settings.minutes * 60000;
      G.timer = setTimeout(startFinal, settings.minutes * 60000);
      publish();
    }
    function accuse(by, target) {
      if (G.phase !== "play" || by === target || G.used.includes(by) || !byId(target) || !byId(by)) return;
      clearTimeout(G.timer);
      G.used.push(by);
      G.paused = Math.max(0, G.ends - Date.now());
      G.phase = "vote";
      G.accuse = { by, target, votes: { [by]: true }, ends: Date.now() + VOTE_MS };
      G.timer = setTimeout(() => settleVote(true), VOTE_MS);
      checkVote();
    }
    function vote(id, yes) {
      if (G.phase !== "vote" || id === G.accuse.target || !byId(id) || id in G.accuse.votes) return;
      G.accuse.votes[id] = !!yes;
      checkVote();
    }
    function checkVote() {
      const voters = G.players.filter((p) => p.id !== G.accuse.target);
      if (Object.values(G.accuse.votes).some((v) => v === false)) return settleVote(false);
      if (voters.every((p) => G.accuse.votes[p.id] === true)) return settleVote(false);
      publish();
    }
    // Unanimous yes = the accused is revealed. Anything else and the game carries on.
    function settleVote(timedOut) {
      clearTimeout(G.timer);
      const voters = G.players.filter((p) => p.id !== G.accuse.target);
      const unanimous = !timedOut && voters.every((p) => G.accuse.votes[p.id] === true);
      if (unanimous) {
        const t = byId(G.accuse.target);
        return G.accuse.target === G.spy
          ? finish("town", `${t.name} was the spy! Caught by a unanimous vote.`)
          : finish("spy", `${t.name} was innocent. The spy got away.`);
      }
      G.accuse = null;
      G.phase = "play";
      G.ends = Date.now() + G.paused;
      G.timer = setTimeout(startFinal, G.paused);
      publish();
    }
    function startFinal() {
      clearTimeout(G.timer);
      G.phase = "final"; G.finalVotes = {};
      G.ends = Date.now() + VOTE_MS;
      G.timer = setTimeout(countFinal, VOTE_MS);
      publish();
    }
    function finalVote(id, target) {
      if (G.phase !== "final" || !byId(id) || !byId(target) || id === target) return;
      G.finalVotes[id] = target;
      if (G.players.every((p) => p.id in G.finalVotes)) countFinal();
      else publish();
    }
    function countFinal() {
      if (G.phase !== "final") return;
      clearTimeout(G.timer);
      const tally = {};
      for (const t of Object.values(G.finalVotes)) tally[t] = (tally[t] || 0) + 1;
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const top = sorted[0];
      const tie = sorted[1] && sorted[1][1] === top[1];
      if (!top || tie) return finish("spy", "The vote was split. The spy slipped away.");
      const target = +top[0];
      if (target !== G.spy) return finish("spy", `Everyone voted for ${byId(target).name}, who was innocent.`);
      // Caught: the spy gets one last chance to name the location.
      G.phase = "spyguess";
      G.ends = Date.now() + GUESS_MS;
      G.timer = setTimeout(() => finish("town", "The spy was caught and couldn't name the location."), GUESS_MS);
      publish();
    }
    function guess(id, i) {
      if (id !== G.spy || !(G.phase === "play" || G.phase === "spyguess") || !(i >= 0 && i < LOCS.length)) return;
      const spy = byId(id);
      if (i === G.loc) finish("spy", `${spy.name} was the spy and guessed the location!`, true);
      else finish("town", `${spy.name} was the spy and guessed ${LOCS[i][0]}. Wrong!`);
    }
    function finish(winner, text, guessed) {
      clearTimeout(G.timer);
      G.phase = "end";
      G.result = { winner, text };
      if (winner === "spy") { const s = byId(G.spy); if (s) s.score += guessed ? 4 : 2; }
      else if (winner === "town") for (const p of G.players) if (p.id !== G.spy) p.score += 1;
      G.accuse = null;
      publish();
    }
    function leave(id) {
      if (!byId(id)) return;
      G.players = G.players.filter((p) => p.id !== id);
      if (G.phase === "end") return publish();
      if (id === G.spy) return finish("town", "The spy left the game.");
      if (G.players.length < 3) return finish("none", "Not enough players left.");
      if (G.phase === "vote") { if (G.accuse.target === id) settleVote(true); else checkVote(); }
      else if (G.phase === "final" && G.players.every((p) => p.id in G.finalVotes)) countFinal();
      else publish();
    }
    return { G, newRound, accuse, vote, finalVote, guess, leave, view, stop: () => clearTimeout(G.timer) };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, stopClock = null, crossed = new Set(), cardShown = false;
  let guessMode = false, armed = -1;
  const send = (m) => {
    if (!room) return;
    if (!room.isHost) return room.send(m);
    const id = room.myId;
    if (m.t === "accuse") engine.accuse(id, m.target);
    else if (m.t === "vote") engine.vote(id, m.yes);
    else if (m.t === "final") engine.finalVote(id, m.target);
    else if (m.t === "guess") engine.guess(id, m.i);
  };

  $("card").addEventListener("click", () => { cardShown = !cardShown; paintCard(); GameUtil.sfx("click"); });
  function paintCard() {
    const c = $("card");
    c.classList.toggle("shown", cardShown);
    c.classList.toggle("spy", !!(V && V.amSpy));
    const face = $("cardFace");
    face.textContent = "";
    if (!V || !V.card) return;
    if (V.card.spy) {
      face.append(h("div", "sp-big", "🕵️ You're the spy"), h("div", "sp-small", "Blend in and work out the location."));
    } else {
      face.append(h("div", "sp-small", "Location"), h("div", "sp-big", V.card.loc), h("div", "sp-small", "Your role: " + V.card.role));
    }
  }

  function onState(v) {
    const prev = V;
    V = v;
    const nameOf = (id) => { const p = v.players.find((x) => x.id === id); return p ? p.name : "?"; };
    if (!prev || prev.round !== v.round) { cardShown = true; crossed = new Set(); GameUtil.sfx(v.amSpy ? "boom" : "pop"); }
    paintCard();
    const first = v.players.find((p) => p.id === v.first);
    $("hint").textContent = v.phase === "play"
      ? (first ? `${first.id === room.myId ? "You ask" : first.name + " asks"} the first question. Take turns asking each other about the location, in chat or out loud.` : "")
      : v.phase === "final" ? "Time's up! Vote for who you think the spy is."
      : v.phase === "spyguess" ? (v.amSpy ? "You were caught! Name the location to steal the win." : "The spy was caught. They get one guess at the location…")
      : v.phase === "vote" ? `${nameOf(v.accuse.by)} accuses ${nameOf(v.accuse.target)}!` : "";

    // players
    const list = $("players");
    list.textContent = "";
    for (const p of v.players) {
      const li = h("li", p.id === room.myId ? "me" : "");
      li.append(GameUtil.avatar(p), h("span", "pname", p.name + (p.id === room.myId ? " (you)" : "")), h("span", "pts", p.score));
      if (v.phase === "play" && p.id !== room.myId) {
        const b = h("button", "btn ghost sm", "Accuse");
        b.type = "button";
        b.disabled = v.used.includes(room.myId);
        b.addEventListener("click", () => send({ t: "accuse", target: p.id }));
        li.append(b);
      }
      if (v.phase === "final" && p.id !== room.myId) {
        const b = h("button", "btn sm", "Vote");
        b.type = "button";
        b.disabled = v.finalVotes.includes(room.myId);
        b.addEventListener("click", () => { send({ t: "final", target: p.id }); GameUtil.sfx("click"); });
        li.append(b);
      }
      if (v.phase === "final" && v.finalVotes.includes(p.id)) li.append(h("span", "tag ok", "voted"));
      list.append(li);
    }
    $("accuseNote").textContent = v.phase === "play" ? (v.used.includes(room.myId) ? "You've used your accusation this round." : "You can accuse one player per round. Everyone else has to agree.") : "";

    // accusation vote
    const vb = $("voteBox");
    vb.hidden = v.phase !== "vote";
    if (v.phase === "vote") {
      const a = v.accuse;
      $("voteQ").textContent = `Is ${a.target === room.myId ? "you" : nameOf(a.target)} the spy?`;
      const iAmTarget = a.target === room.myId, voted = room.myId in a.votes;
      $("voteBtns").hidden = iAmTarget || voted;
      $("voteWait").textContent = iAmTarget ? "You've been accused! Everyone else is voting…" : voted ? "Vote cast. Waiting for the others…" : "It only goes through if everyone agrees.";
      $("voteTally").textContent = `${Object.values(a.votes).filter(Boolean).length} of ${v.players.length - 1} say yes`;
    }

    // locations
    const grid = $("locs");
    grid.textContent = "";
    const spyGuess = v.amSpy && (v.phase === "play" || v.phase === "spyguess");
    if (!spyGuess) guessMode = false;
    const picking = spyGuess && (guessMode || v.phase === "spyguess");
    grid.classList.toggle("guessing", picking);
    if (!picking) armed = -1;
    LOCS.forEach(([name], i) => {
      const b = h("button", "loc" + (crossed.has(i) ? " crossed" : "") + (armed === i ? " armed" : "") + (v.phase === "end" && v.loc === name ? " answer" : ""), name);
      b.type = "button";
      b.addEventListener("click", () => {
        if (picking) {
          if (armed === i) { send({ t: "guess", i }); armed = -1; return; }
          armed = i; onState(V); GameUtil.sfx("click");
          return;
        }
        crossed.has(i) ? crossed.delete(i) : crossed.add(i);
        b.classList.toggle("crossed");
      });
      grid.append(b);
    });
    $("guessBtn").hidden = !(v.amSpy && v.phase === "play");
    $("guessBtn").textContent = guessMode ? "Cancel guess" : "Guess the location";
    $("locHint").textContent = picking
      ? (armed >= 0 ? `Tap "${LOCS[armed][0]}" again to lock in your guess.` : "Tap the location you think it is.")
      : v.amSpy ? "Tap to cross places off. Think you know it? Hit \"Guess the location\"." : "Tap to cross places off (only you can see this).";

    if (stopClock) stopClock();
    const ends = performance.now() + (v.phase === "vote" ? v.voteLeft : v.left);
    let lastS = -1;
    stopClock = countdown(ends, (left) => {
      $("timer").textContent = v.phase === "end" ? "" : fmt(left);
      const s = Math.ceil(left / 1000);
      if (s !== lastS && s <= 5 && s > 0 && v.phase !== "end") { lastS = s; GameUtil.sfx("tick"); }
    });

    if (prev && prev.phase !== v.phase && (v.phase === "vote" || v.phase === "final")) GameUtil.sfx("turn");
    if (v.phase === "end") {
      if (!prev || prev.phase !== "end") {
        const iWon = v.result.winner === "none" ? null : (v.result.winner === "spy") === (v.spy === room.myId);
        if (iWon !== null) { GameUtil.sfx(iWon ? "win" : "lose"); GameUtil.record("spy", iWon ? "win" : "loss"); }
        const spy = v.players.find((p) => p.id === v.spy);
        $("resultNote").textContent = `${v.result.text} The location was ${v.loc}${spy ? `, and the spy was ${spy.name}` : ""}.`;
        results({
          title: v.result.winner === "spy" ? "The spy wins" : v.result.winner === "town" ? "Spy caught!" : "Round over",
          rows: [...v.players].sort((a, b) => b.score - a.score).map((p) => ({ p, value: p.score + " pts" + (p.id === v.spy ? " · spy" : ""), win: (v.result.winner === "spy") === (p.id === v.spy) })),
          isHost: room.isHost, meId: room.myId, again: "Next round",
        });
      }
    } else hideResults();
  }

  $("yes").addEventListener("click", () => send({ t: "vote", yes: true }));
  $("no").addEventListener("click", () => send({ t: "vote", yes: false }));
  $("guessBtn").addEventListener("click", () => { guessMode = !guessMode; armed = -1; if (V) onState(V); });
  $("again").addEventListener("click", () => { if (engine) engine.newRound(); });

  const SET_KEY = "oxidpvp-spy";
  const loadSet = () => { let s = null; try { s = JSON.parse(localStorage.getItem(SET_KEY)); } catch {} return { minutes: 6, ...(s || {}) }; };
  function buildSettings(el) {
    const s = loadSet();
    el.innerHTML = `<div class="set-head">Minutes per round</div><div class="seg"></div>`;
    const seg = el.querySelector(".seg");
    for (const v of [4, 6, 8]) {
      const b = h("button", "", v);
      b.type = "button";
      b.addEventListener("click", () => { s.minutes = v; try { localStorage.setItem(SET_KEY, JSON.stringify(s)); } catch {} paint(); });
      seg.append(b);
    }
    const paint = () => [...seg.children].forEach((b) => b.classList.toggle("on", +b.textContent === s.minutes));
    paint();
  }

  Room.mount({
    game: "spy",
    title: "Spyfall",
    subtitle: "Everyone knows the location except the spy. Ask sneaky questions to find them. 3 to 8 players.",
    min: 3,
    max: 8,
    lobbyExtra: buildSettings,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        const out = { to: (id, m) => (id === r.myId ? onState(m) : r.sendTo(id, m)) };
        engine = createEngine(r, loadSet(), out);
        r.onData((from, m) => {
          if (!m) return;
          if (m.t === "accuse") engine.accuse(from, m.target | 0);
          else if (m.t === "vote") engine.vote(from, m.yes);
          else if (m.t === "final") engine.finalVote(from, m.target | 0);
          else if (m.t === "guess") engine.guess(from, m.i | 0);
        });
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => out.to(id, engine.view(id)));
        setTimeout(() => engine && engine.newRound(), 300);
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
