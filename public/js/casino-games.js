// More casino games, plugged into casino.js with Casino.register(). Every bet still goes through
// the table host (who checks balances and pays out), exactly like the original games.
// Play coins only. Nothing here can be bought with, or turned into, real money.
(() => {
  const C = window.Casino;
  if (!C) return;
  const { h, $, fmtC } = C;
  const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  const main = document.querySelector(".cs-main");
  const pane = (id, cls, html) => {
    const el = document.createElement("div");
    el.className = "cs-pane " + cls;
    el.dataset.pane = id;
    el.hidden = true;
    el.innerHTML = html;
    main.append(el);
    return el;
  };
  // Host side: take a bet from a player, or null if they can't cover it.
  const bet = (E, id, amt, min = 1) => {
    const p = E.P(id);
    if (!p) return null;
    amt = Math.floor(+amt);
    if (!(amt >= min) || amt > E.maxBet(p) || !E.take(p, amt)) return null;
    return { p, amt };
  };
  const coinsOk = (amt) => { if (C.wallet().coins < amt) { GameUtil.toast("Not enough coins for that bet"); return false; } return true; };
  const msg = (el, text, good) => { el.textContent = text; el.className = "cs-msg" + (good ? " good" : ""); };

  // =====================================================================
  // Dice: pick a number, roll over or under it. Lower chance, bigger payout.
  // =====================================================================
  pane("dice", "cs-dark", `
    <div class="dc-roll" id="dcRoll">50.00</div>
    <div class="dc-track" id="dcTrack"><input type="range" id="dcTarget" min="2" max="98" step="1" value="50" aria-label="Target number"><i class="dc-pin" id="dcPin"></i></div>
    <div class="dc-stats">
      <div><small>Payout</small><b id="dcMult"></b></div>
      <div><small>Roll</small><button class="btn sm" id="dcDir" type="button"></button></div>
      <div><small>Win chance</small><b id="dcChance"></b></div>
    </div>
    <button class="btn primary lg" id="dcBtn" type="button">Roll</button>
    <p class="cs-msg" id="dcMsg">Slide to pick your number, then roll.</p>
    <div class="dc-hist" id="dcHist"></div>`);
  let dcOver = false;
  const dcTarget = () => +$("dcTarget").value;
  const dcChance = () => (dcOver ? 100 - dcTarget() : dcTarget());
  const dcMult = (ch) => Math.floor((99 / ch) * 10000) / 10000;
  function dcPaint() {
    const t = dcTarget(), ch = dcChance();
    $("dcDir").textContent = (dcOver ? "Over " : "Under ") + t;
    $("dcMult").textContent = dcMult(ch).toFixed(4) + "×";
    $("dcChance").textContent = ch + "%";
    $("dcTrack").style.setProperty("--t", t + "%");
    $("dcTrack").classList.toggle("over", dcOver);
    $("dcBtn").textContent = `Roll · ${fmtC(C.chip())}`;
  }
  $("dcTarget").addEventListener("input", dcPaint);
  $("dcDir").addEventListener("click", () => { dcOver = !dcOver; dcPaint(); GameUtil.sfx("click"); });
  $("dcBtn").addEventListener("click", () => { if (coinsOk(C.chip())) { $("dcBtn").disabled = true; C.act({ t: "dice", amt: C.chip(), target: dcTarget(), over: dcOver }); } });
  C.register({
    engine: (E) => ({
      handle(from, m) {
        if (m.t !== "dice") return false;
        const target = Math.max(2, Math.min(98, Math.round(+m.target || 50))), over = !!m.over;
        const b = bet(E, from, m.amt);
        if (!b) return true;
        const roll = Math.floor(rnd() * 10000) / 100, chance = over ? 100 - target : target;
        const win = over ? roll > target : roll < target, mult = dcMult(chance), pay = win ? Math.floor(b.amt * mult) : 0;
        E.give(b.p, pay);
        if (win && mult >= 10) E.note(`${b.p.name} rolled ${roll.toFixed(2)} for ${mult.toFixed(2)}× on Dice!`);
        E.to(from, { t: "dice", roll, win, pay, amt: b.amt });
        E.publish();
        return true;
      },
    }),
    onPrivate(m) {
      if (m.t !== "dice") return false;
      const el = $("dcRoll");
      let k = 0;
      const iv = setInterval(() => { el.textContent = (rnd() * 100).toFixed(2); if (++k > 8) { clearInterval(iv); done(); } }, 45);
      function done() {
        el.textContent = m.roll.toFixed(2);
        el.className = "dc-roll " + (m.win ? "win" : "lose");
        $("dcPin").style.left = m.roll + "%"; $("dcPin").classList.add("on");
        msg($("dcMsg"), m.win ? `Rolled ${m.roll.toFixed(2)} · won ${fmtC(m.pay)}!` : `Rolled ${m.roll.toFixed(2)} · no luck`, m.win);
        const chip = h("span", m.win ? "win" : "", m.roll.toFixed(2));
        $("dcHist").prepend(chip);
        while ($("dcHist").children.length > 12) $("dcHist").lastChild.remove();
        GameUtil.sfx(m.win ? "good" : "bad");
        $("dcBtn").disabled = false;
      }
      return true;
    },
    render(V, tab) { if (tab === "dice") dcPaint(); },
  });
  dcPaint();

  // =====================================================================
  // Keno: pick up to 10 of 40 numbers; 10 are drawn. Pays about 95% on average.
  // =====================================================================
  const KENO = {
    1: [0, 3.8], 2: [0, 1.7, 5], 3: [0, 1, 2.1, 18], 4: [0, 0.6, 1.8, 5.6, 45], 5: [0, 0.2, 1.5, 3.3, 13, 132],
    6: [0, 0, 1.1, 2.5, 6.9, 46, 286], 7: [0, 0, 0.7, 2.2, 4.4, 17, 110, 551], 8: [0, 0, 0.5, 1.6, 3.2, 8.5, 43, 213, 1066],
    9: [0, 0, 0.4, 1.1, 2.7, 6.4, 21, 85, 425, 2124], 10: [0, 0, 0.3, 1, 2, 4.1, 10, 41, 203, 1015, 5075],
  };
  pane("keno", "cs-dark", `
    <div class="kn-grid" id="knGrid"></div>
    <div class="kn-pays" id="knPays"></div>
    <div class="cs-row"><button class="btn" id="knAuto" type="button">🎲 Quick pick</button><button class="btn ghost" id="knClear" type="button">Clear</button><button class="btn primary lg" id="knBtn" type="button">Play</button></div>
    <p class="cs-msg" id="knMsg">Pick 1 to 10 numbers, then play.</p>`);
  let knPicks = [], knLast = null, knBusy = false;
  function knPaint() {
    const g = $("knGrid");
    if (!g.childElementCount) for (let i = 1; i <= 40; i++) { const b = h("button", "kn-n", i); b.type = "button"; b.dataset.n = i; g.append(b); }
    for (const b of g.children) {
      const n = +b.dataset.n, pick = knPicks.includes(n), drawn = knLast && knLast.draw.includes(n);
      b.className = "kn-n" + (pick ? " pick" : "") + (drawn ? (pick ? " hit" : " drawn") : "");
    }
    const t = KENO[knPicks.length];
    $("knPays").textContent = "";
    if (t) t.forEach((x, k) => { if (x) $("knPays").append(h("span", knLast && knLast.hits === k ? "on" : "", `${k} hit${k === 1 ? "" : "s"} · ${x}×`)); });
    $("knBtn").disabled = !knPicks.length || knBusy;
    $("knBtn").textContent = `Play · ${fmtC(C.chip())}`;
  }
  $("knGrid").addEventListener("click", (e) => {
    const b = e.target.closest(".kn-n");
    if (!b || knBusy) return;
    const n = +b.dataset.n;
    knLast = null;
    if (knPicks.includes(n)) knPicks = knPicks.filter((x) => x !== n);
    else if (knPicks.length < 10) knPicks.push(n);
    GameUtil.sfx("click");
    knPaint();
  });
  $("knAuto").addEventListener("click", () => { if (knBusy) return; knLast = null; const all = GameUtil.shuffle([...Array(40).keys()].map((x) => x + 1)); knPicks = all.slice(0, knPicks.length || 8); knPaint(); });
  $("knClear").addEventListener("click", () => { if (knBusy) return; knPicks = []; knLast = null; knPaint(); });
  $("knBtn").addEventListener("click", () => { if (knPicks.length && coinsOk(C.chip())) { knBusy = true; knPaint(); C.act({ t: "keno", amt: C.chip(), picks: knPicks }); } });
  C.register({
    engine: (E) => ({
      handle(from, m) {
        if (m.t !== "keno") return false;
        const picks = [...new Set((Array.isArray(m.picks) ? m.picks : []).map((x) => x | 0).filter((x) => x >= 1 && x <= 40))].slice(0, 10);
        if (!picks.length) return true;
        const b = bet(E, from, m.amt);
        if (!b) return true;
        const draw = GameUtil.shuffle([...Array(40).keys()].map((x) => x + 1)).slice(0, 10);
        const hits = picks.filter((x) => draw.includes(x)).length, mult = KENO[picks.length][hits] || 0, pay = Math.floor(b.amt * mult);
        E.give(b.p, pay);
        if (mult >= 20) E.note(`${b.p.name} hit ${hits}/${picks.length} on Keno for ${mult}×!`);
        E.to(from, { t: "keno", draw, hits, pay, amt: b.amt, mult });
        E.publish();
        return true;
      },
    }),
    onPrivate(m) {
      if (m.t !== "keno") return false;
      knLast = { draw: [], hits: -1 };
      m.draw.forEach((n, i) => setTimeout(() => {
        knLast.draw.push(n);
        GameUtil.sfx(knPicks.includes(n) ? "good" : "tick");
        if (i === m.draw.length - 1) {
          knLast.hits = m.hits; knBusy = false;
          msg($("knMsg"), m.pay ? `${m.hits} hits · ${m.mult}× · won ${fmtC(m.pay)}!` : `${m.hits} hit${m.hits === 1 ? "" : "s"} · no win`, m.pay > m.amt);
          if (m.pay > m.amt) GameUtil.sfx("win");
        }
        knPaint();
      }, 130 * i));
      return true;
    },
    render(V, tab) { if (tab === "keno") knPaint(); },
  });

  // =====================================================================
  // Hi-Lo: is the next card higher or lower? Keep going to grow the payout, cash out any time.
  // =====================================================================
  pane("hilo", "cs-dark", `
    <div class="hl-mult"><small>Current payout</small><b id="hlMult">1.00×</b></div>
    <div class="hl-cards" id="hlCards"></div>
    <div class="cs-row hl-actions">
      <button class="btn lg" id="hlLo" type="button">⬇ Lower</button>
      <button class="btn lg" id="hlSkip" type="button">Skip</button>
      <button class="btn lg" id="hlHi" type="button">⬆ Higher</button>
    </div>
    <button class="btn primary lg" id="hlBtn" type="button">Bet</button>
    <p class="cs-msg" id="hlMsg">Guess if the next card is higher or lower. Same rank is a free redraw.</p>`);
  const RV = { A: 1, T: 10, J: 11, Q: 12, K: 13 };
  const rankVal = (c) => RV[c[0]] || +c[0];
  const hlProb = (r, dir) => (dir === "hi" ? (13 - r) / 13 : (r - 1) / 13);
  const hlFactor = (r, dir) => { const p = hlProb(r, dir); return p > 0 ? 0.99 * (12 / 13) / p : 0; };
  let HL = null;
  function hlPaint() {
    const live = HL && !HL.over;
    $("hlMult").textContent = (HL ? HL.mult : 1).toFixed(2) + "×";
    const cards = $("hlCards");
    cards.textContent = "";
    for (const c of HL ? HL.cards.slice(-6) : []) cards.append(C.cardEl(c));
    const cur = HL && HL.cards[HL.cards.length - 1], r = cur ? rankVal(cur) : 7;
    for (const [id, dir] of [["hlHi", "hi"], ["hlLo", "lo"]]) {
      const b = $(id), f = hlFactor(r, dir);
      b.disabled = !live || !f;
      b.textContent = (dir === "hi" ? "⬆ Higher" : "⬇ Lower") + (live && f ? ` · ${f.toFixed(2)}×` : "");
    }
    $("hlSkip").disabled = !live || HL.skips >= 5;
    $("hlSkip").textContent = live ? `Skip (${5 - HL.skips})` : "Skip";
    const btn = $("hlBtn");
    btn.classList.toggle("cash", !!live);
    if (live) { btn.textContent = HL.steps ? `Cash out ${fmtC(HL.amt * HL.mult)}` : "Make a guess"; btn.disabled = !HL.steps; }
    else { btn.textContent = `Bet ${fmtC(C.chip())}`; btn.disabled = false; }
  }
  $("hlBtn").addEventListener("click", () => {
    if (HL && !HL.over) { if (HL.steps) C.act({ t: "hlc" }); return; }
    if (!coinsOk(C.chip())) return;
    msg($("hlMsg"), "Higher or lower?");
    C.act({ t: "hls", amt: C.chip() });
  });
  for (const [id, a] of [["hlHi", "hi"], ["hlLo", "lo"], ["hlSkip", "skip"]]) $(id).addEventListener("click", () => { if (HL && !HL.over) C.act({ t: "hlg", a }); });
  C.register({
    engine: (E) => {
      const st = {};
      const view = (id) => { const g = st[id]; return g ? { t: "hl", amt: g.amt, cards: g.cards, mult: g.mult, steps: g.steps, skips: g.skips, over: g.over, pay: g.pay, lost: g.lost } : { t: "hl", none: true }; };
      const draw = () => C.RANKS[Math.floor(rnd() * 13)] + C.SUITS[Math.floor(rnd() * 4)];
      return {
        handle(from, m) {
          if (m.t === "hls") {
            if (st[from] && !st[from].over) return true;
            const b = bet(E, from, m.amt, 5);
            if (!b) return true;
            st[from] = { amt: b.amt, cards: [draw()], mult: 1, steps: 0, skips: 0, over: false, pay: 0 };
          } else if (m.t === "hlg") {
            const g = st[from];
            if (!g || g.over) return true;
            const cur = rankVal(g.cards[g.cards.length - 1]);
            if (m.a === "skip") { if (g.skips >= 5) return true; g.skips++; g.cards.push(draw()); }
            else if (m.a === "hi" || m.a === "lo") {
              const f = hlFactor(cur, m.a);
              if (!f) return true;
              const next = draw(), r = rankVal(next);
              g.cards.push(next);
              if (r === cur) { /* same rank: free redraw */ }
              else if ((m.a === "hi") === (r > cur)) { g.mult = Math.floor(g.mult * f * 100) / 100; g.steps++; }
              else { g.over = true; g.lost = true; }
              if (g.cards.length > 60) g.cards = g.cards.slice(-30);
            }
          } else if (m.t === "hlc") {
            const g = st[from], p = E.P(from);
            if (!g || g.over || !g.steps || !p) return true;
            g.over = true; g.pay = Math.floor(g.amt * g.mult);
            E.give(p, g.pay);
            if (g.mult >= 10) E.note(`${p.name} cashed out ${g.mult.toFixed(2)}× on Hi-Lo!`);
            E.publish();
          } else return false;
          E.to(from, view(from));
          if (m.t === "hls" || (st[from] && st[from].lost)) E.publish();
          return true;
        },
        rejoin(id) { E.to(id, view(id)); },
        leave(id) { delete st[id]; },
      };
    },
    onPrivate(m) {
      if (m.t !== "hl") return false;
      const was = HL;
      HL = m.none ? null : m;
      if (HL && was && HL.cards.length > was.cards.length) GameUtil.sfx(HL.lost ? "bad" : "pop");
      if (HL && HL.over && was && !was.over) {
        if (HL.lost) msg($("hlMsg"), `Wrong call. You lost ${fmtC(HL.amt)}.`);
        else { msg($("hlMsg"), `Cashed out ${HL.mult.toFixed(2)}× · won ${fmtC(HL.pay)}!`, true); GameUtil.sfx("win"); }
      }
      hlPaint();
      return true;
    },
    render(V, tab) { if (tab === "hilo") hlPaint(); },
  });
  hlPaint();

  // =====================================================================
  // Wheel: 30 slices, three risk levels (about 97% back on average).
  // =====================================================================
  const WHEELS = {
    low: [[1.2, 12], [1.5, 10], [0, 8]],
    mid: [[0, 15], [1.5, 6], [1.7, 3], [2, 3], [3, 3]],
    high: [[0, 29], [29, 1]],
  };
  // Spread each table around the wheel so equal slices don't bunch together.
  const wheelSlices = (risk) => {
    const flat = WHEELS[risk].flatMap(([m, c]) => Array(c).fill(m));
    const out = [], byM = {};
    for (const m of flat) (byM[m] = byM[m] || []).push(m);
    const keys = Object.keys(byM).sort((a, b) => byM[b].length - byM[a].length);
    while (out.length < 30) for (const k of keys) if (byM[k].length) out.push(+byM[k].pop());
    return out;
  };
  const WSL = { low: wheelSlices("low"), mid: wheelSlices("mid"), high: wheelSlices("high") };
  const wColor = (m) => (m === 0 ? "#2a1f28" : m >= 20 ? "#ffd23f" : m >= 3 ? "#ff2e93" : m >= 2 ? "#c084fc" : m >= 1.5 ? "#38bdf8" : "#4ade80");
  pane("wheel", "cs-dark", `
    <div class="seg plk-risk" id="whRisk"><button type="button" data-r="low">Low risk</button><button type="button" data-r="mid">Medium</button><button type="button" data-r="high">High risk</button></div>
    <div class="wh-wrap"><canvas id="whCanvas" width="420" height="420"></canvas><i class="wh-pointer"></i><b class="wh-center" id="whCenter">SPIN</b></div>
    <button class="btn primary lg" id="whBtn" type="button">Spin</button>
    <div class="wh-legend" id="whLegend"></div>
    <p class="cs-msg" id="whMsg">Pick a risk level and spin.</p>`);
  let whRisk = "mid", whAngle = 0, whBusy = false;
  function whDraw() {
    const cv = $("whCanvas"), x = cv.getContext("2d"), R = cv.width / 2, sl = WSL[whRisk], a = (Math.PI * 2) / 30;
    x.clearRect(0, 0, cv.width, cv.height);
    x.save(); x.translate(R, R); x.rotate(whAngle);
    sl.forEach((m, i) => {
      x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, R - 6, i * a - Math.PI / 2, (i + 1) * a - Math.PI / 2); x.closePath();
      x.fillStyle = wColor(m); x.fill(); x.strokeStyle = "#0a0610"; x.lineWidth = 2; x.stroke();
    });
    x.restore();
    x.beginPath(); x.arc(R, R, R - 3, 0, Math.PI * 2); x.strokeStyle = "#ff2e93"; x.lineWidth = 5; x.stroke();
    const leg = $("whLegend"); leg.textContent = "";
    for (const [m, c] of WHEELS[whRisk]) { const s = h("span", "", `${m}× · ${c}/30`); s.style.setProperty("--c", wColor(m)); leg.append(s); }
    for (const b of $("whRisk").children) b.classList.toggle("on", b.dataset.r === whRisk);
    $("whBtn").textContent = `Spin · ${fmtC(C.chip())}`;
  }
  for (const b of $("whRisk").children) b.addEventListener("click", () => { if (!whBusy) { whRisk = b.dataset.r; whDraw(); } });
  $("whBtn").addEventListener("click", () => { if (!whBusy && coinsOk(C.chip())) { whBusy = true; $("whBtn").disabled = true; C.act({ t: "whl", amt: C.chip(), risk: whRisk }); } });
  C.register({
    engine: (E) => ({
      handle(from, m) {
        if (m.t !== "whl") return false;
        const sl = WSL[m.risk];
        if (!sl) return true;
        const b = bet(E, from, m.amt);
        if (!b) return true;
        const i = Math.floor(rnd() * 30), mult = sl[i], pay = Math.floor(b.amt * mult);
        E.to(from, { t: "whl", i, mult, pay, amt: b.amt, risk: m.risk });
        E.publish();
        E.later("whl" + from + Date.now(), 4200, () => { const p = E.P(from); if (p) { E.give(p, pay); if (mult >= 20) E.note(`${p.name} hit ${mult}× on the Wheel!`); E.publish(); } });
        return true;
      },
    }),
    onPrivate(m) {
      if (m.t !== "whl") return false;
      whRisk = m.risk;
      const a = (Math.PI * 2) / 30, start = whAngle % (Math.PI * 2);
      const target = Math.PI * 2 * 6 - (m.i + 0.5) * a + (rnd() - 0.5) * a * 0.6;
      const t0 = performance.now(), T = 4000;
      $("whCenter").textContent = "…";
      const step = (now) => {
        const u = Math.min(1, (now - t0) / T), e = 1 - Math.pow(1 - u, 4);
        whAngle = start + (target - start) * e;
        whDraw();
        if (u < 1) requestAnimationFrame(step);
        else {
          whBusy = false; $("whBtn").disabled = false;
          $("whCenter").textContent = m.mult + "×";
          msg($("whMsg"), m.pay ? `${m.mult}× · won ${fmtC(m.pay)}!` : "0× · no luck", m.pay > m.amt);
          GameUtil.sfx(m.mult >= 3 ? "win" : m.pay > m.amt ? "good" : "bad");
        }
      };
      requestAnimationFrame(step);
      return true;
    },
    render(V, tab) { if (tab === "wheel" && !whBusy) whDraw(); },
  });

  // =====================================================================
  // Scratch cards: find three matching symbols. Scratch with your mouse or finger.
  // =====================================================================
  const SC_TIERS = [100, 500, 2500];
  const SC_PRIZES = [[1, 0.2, "🍒"], [2, 0.1, "🍋"], [5, 0.04, "🔔"], [10, 0.01, "⭐"], [50, 0.003, "💎"], [200, 0.0005, "👑"]];
  const SC_SYMS = SC_PRIZES.map((p) => p[2]);
  pane("scratch", "cs-dark", `
    <div class="sc-tiers" id="scTiers"></div>
    <div class="sc-card" id="scCard"><div class="sc-grid" id="scGrid"></div><canvas id="scCover" width="360" height="360"></canvas></div>
    <div class="cs-row"><button class="btn" id="scReveal" type="button" hidden>Reveal all</button></div>
    <p class="cs-msg" id="scMsg">Buy a card and scratch it. Three of a kind wins.</p>
    <p class="cs-note">🍒 1× · 🍋 2× · 🔔 5× · ⭐ 10× · 💎 50× · 👑 200×</p>`);
  let SC = null;
  function scTiers() {
    const box = $("scTiers");
    box.textContent = "";
    for (const c of SC_TIERS) {
      const b = h("button", "sc-tier", "");
      b.type = "button";
      b.append(h("b", "", `${fmtC(c)}`), h("small", "", c === 100 ? "Pink" : c === 500 ? "Gold" : "Black"));
      b.disabled = !!(SC && !SC.done) || c > C.limit();
      b.addEventListener("click", () => { if (coinsOk(c)) C.act({ t: "scb", amt: c }); });
      box.append(b);
    }
  }
  function scFinish() {
    if (!SC || SC.done) return;
    SC.done = true;
    $("scCover").style.opacity = "0";
    $("scReveal").hidden = true;
    C.act({ t: "scd" });
    const g = $("scGrid").children;
    if (SC.win >= 0) for (let i = 0; i < 9; i++) if (SC.grid[i] === SC_SYMS[SC.win]) g[i].classList.add("hit");
    msg($("scMsg"), SC.pay ? `Three ${SC_SYMS[SC.win]}! Won ${fmtC(SC.pay)}` : "No match this time", SC.pay > SC.amt);
    GameUtil.sfx(SC.pay > SC.amt ? "win" : SC.pay ? "good" : "bad");
    scTiers();
  }
  (() => {
    const cv = $("scCover"), x = cv.getContext("2d");
    let down = false, last = null, scratched = 0;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height }; };
    const scratch = (p) => {
      x.globalCompositeOperation = "destination-out";
      x.lineWidth = 46; x.lineCap = "round";
      x.beginPath(); x.moveTo((last || p).x, (last || p).y); x.lineTo(p.x, p.y); x.stroke();
      last = p;
      if (++scratched % 12 === 0) {
        const d = x.getImageData(0, 0, cv.width, cv.height).data;
        let clear = 0;
        for (let i = 3; i < d.length; i += 64) if (d[i] === 0) clear++;
        if (clear / (d.length / 64) > 0.6) scFinish();
      }
    };
    cv.addEventListener("pointerdown", (e) => { if (!SC || SC.done) return; down = true; last = null; cv.setPointerCapture(e.pointerId); scratch(pos(e)); });
    cv.addEventListener("pointermove", (e) => { if (down) scratch(pos(e)); });
    cv.addEventListener("pointerup", () => { down = false; });
    window.__scCover = () => {
      x.globalCompositeOperation = "source-over";
      const g = x.createLinearGradient(0, 0, cv.width, cv.height);
      g.addColorStop(0, "#c0c0c8"); g.addColorStop(0.5, "#f1f1f6"); g.addColorStop(1, "#9a9aa6");
      x.fillStyle = g; x.fillRect(0, 0, cv.width, cv.height);
      x.fillStyle = "rgba(0,0,0,.35)"; x.font = "700 26px Geist, system-ui, sans-serif"; x.textAlign = "center";
      x.fillText("SCRATCH HERE", cv.width / 2, cv.height / 2 + 8);
      scratched = 0; cv.style.opacity = "1";
    };
  })();
  $("scReveal").addEventListener("click", scFinish);
  C.register({
    engine: (E) => {
      const pend = {};
      const payOut = (id) => { const q = pend[id]; if (!q) return; delete pend[id]; clearTimeout(q.t); const p = E.P(id); if (p && q.pay) { E.give(p, q.pay); if (q.pay >= q.amt * 50) E.note(`${p.name} won ${fmtC(q.pay)} on a scratch card!`); } E.publish(); };
      return {
        handle(from, m) {
          if (m.t === "scd") { payOut(from); return true; }
          if (m.t !== "scb") return false;
          if (pend[from] || !SC_TIERS.includes(+m.amt)) return true;
          const b = bet(E, from, m.amt);
          if (!b) return true;
          let r = rnd(), win = -1;
          for (let i = SC_PRIZES.length - 1; i >= 0; i--) { r -= SC_PRIZES[i][1]; if (r < 0) { win = i; break; } }
          // Nine cells: three of the winning symbol (if any); no other symbol appears three times.
          const cells = win >= 0 ? [SC_SYMS[win], SC_SYMS[win], SC_SYMS[win]] : [];
          const count = {};
          for (const c of cells) count[c] = (count[c] || 0) + 1;
          while (cells.length < 9) { const s = SC_SYMS[Math.floor(rnd() * SC_SYMS.length)]; if (s !== SC_SYMS[win] && (count[s] || 0) < 2) { cells.push(s); count[s] = (count[s] || 0) + 1; } }
          const grid = GameUtil.shuffle(cells), pay = win >= 0 ? b.amt * SC_PRIZES[win][0] : 0;
          pend[from] = { pay, amt: b.amt, t: setTimeout(() => payOut(from), 60000) };
          E.to(from, { t: "scb", grid, win, pay, amt: b.amt });
          E.publish();
          return true;
        },
        leave(id) { if (pend[id]) { clearTimeout(pend[id].t); delete pend[id]; } },
        stop() { for (const q of Object.values(pend)) clearTimeout(q.t); },
      };
    },
    onPrivate(m) {
      if (m.t !== "scb") return false;
      SC = { ...m, done: false };
      const g = $("scGrid");
      g.textContent = "";
      for (const s of m.grid) g.append(h("span", "sc-cell", s));
      $("scCard").className = "sc-card t" + SC_TIERS.indexOf(m.amt);
      window.__scCover();
      $("scReveal").hidden = false;
      msg($("scMsg"), "Scratch the card!");
      GameUtil.sfx("pop");
      scTiers();
      return true;
    },
    render(V, tab) { if (tab === "scratch") scTiers(); },
  });
  window.__scCover();
})();

(() => {
  const C = window.Casino;
  if (!C) return;
  const { h, $, fmtC } = C;
  const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  const main = document.querySelector(".cs-main");
  const pane = (id, cls, html) => { const el = document.createElement("div"); el.className = "cs-pane " + cls; el.dataset.pane = id; el.hidden = true; el.innerHTML = html; main.append(el); return el; };
  const bet = (E, id, amt, min = 1) => { const p = E.P(id); if (!p) return null; amt = Math.floor(+amt); if (!(amt >= min) || amt > E.maxBet(p) || !E.take(p, amt)) return null; return { p, amt }; };
  const coinsOk = (amt) => { if (C.wallet().coins < amt) { GameUtil.toast("Not enough coins for that bet"); return false; } return true; };
  const msg = (el, text, good) => { el.textContent = text; el.className = "cs-msg" + (good ? " good" : ""); };
  const clockTo = (key, ms, el) => C.clock(key, ms, el);

  // =====================================================================
  // Pink Diamonds: 5 reels, 3 rows, 10 lines, 🌸 wild, progressive jackpot for 5 💎 on a line.
  // =====================================================================
  const PD_SY = ["🍒", "🍋", "🍇", "🔔", "⭐", "7️⃣", "💎", "🌸"], PD_W = [22, 20, 18, 14, 11, 8, 4, 3];
  const PD_PAY = { "🍒": [7, 18, 53], "🍋": [11, 28, 70], "🍇": [14, 35, 105], "🔔": [18, 53, 175], "⭐": [28, 88, 350], "7️⃣": [53, 175, 875], "💎": [88, 350, 3500], "🌸": [35, 140, 1050] };
  const PD_LINES = [[1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [1, 0, 1, 2, 1]];
  const JP_SEED = 25000, JP_CUT = 0.015;
  const pdPick = () => { let r = rnd() * 100; for (let i = 0; i < PD_SY.length; i++) { r -= PD_W[i]; if (r < 0) return PD_SY[i]; } return PD_SY[0]; };
  function pdLine(sy) {
    const b = sy.find((s) => s !== "🌸") || "🌸";
    let n = 0;
    for (const s of sy) { if (s === b || (s === "🌸" && b !== "💎")) n++; else break; }
    let best = n >= 3 ? PD_PAY[b][n - 3] : 0, w = 0;
    for (const s of sy) { if (s === "🌸") w++; else break; }
    if (w >= 3) best = Math.max(best, PD_PAY["🌸"][w - 3]);
    return { pay: best, n: Math.max(n, w), jackpot: b === "💎" && n === 5 };
  }
  pane("pd", "pd-pane", `
    <div class="pd-top"><div class="pd-title">💎 PINK DIAMONDS</div><div class="pd-jp"><small>JACKPOT</small><b id="pdJp">25,000</b></div></div>
    <div class="pd-machine"><div class="pd-reels" id="pdReels"></div><svg class="pd-lines" id="pdLines" viewBox="0 0 500 300" preserveAspectRatio="none"></svg></div>
    <div class="pd-bar"><div><small>Total bet</small><b id="pdBet"></b></div><button class="btn primary lg pd-spin" id="pdSpin" type="button">SPIN</button><div><small>Win</small><b id="pdWin">0</b></div></div>
    <label class="check pd-auto"><input type="checkbox" id="pdAuto"> Auto spin</label>
    <p class="cs-note">10 lines · 🌸 is wild (except for 💎) · 5 💎 on a line wins the jackpot (bigger bets win a bigger share) · 1.5% of every spin feeds the jackpot</p>
    <div class="pd-paytable" id="pdPaytable"></div>`);
  let pdBusy = false, pdGrid = null;
  function pdBuild() {
    const r = $("pdReels");
    if (r.childElementCount) return;
    for (let c = 0; c < 5; c++) { const col = h("div", "pd-reel"); for (let k = 0; k < 3; k++) col.append(h("span", "pd-sym", PD_SY[(c + k * 2) % 7])); r.append(col); }
    const pt = $("pdPaytable");
    for (const s of [...PD_SY].reverse()) { const row = h("div", "pd-pt"); row.append(h("span", "", s), h("small", "", PD_PAY[s].map((x, i) => `${i + 3}× ${x / 10}`).join(" · "))); pt.append(row); }
  }
  function pdPaint(V) {
    pdBuild();
    $("pdBet").textContent = fmtC(C.chip());
    if (V && V.x && V.x.jp != null) $("pdJp").textContent = fmtC(V.x.jp);
    $("pdSpin").disabled = pdBusy;
  }
  const pdSpin = () => { if (pdBusy || !coinsOk(C.chip())) { $("pdAuto").checked = false; return; } pdBusy = true; $("pdSpin").disabled = true; C.act({ t: "pds", amt: C.chip() }); };
  $("pdSpin").addEventListener("click", pdSpin);
  C.register({
    engine: (E) => {
      let jp = JP_SEED;
      return {
        pub: () => ({ jp: Math.floor(jp) }),
        handle(from, m) {
          if (m.t !== "pds") return false;
          const b = bet(E, from, m.amt, 10);
          if (!b) return true;
          jp += b.amt * JP_CUT;
          const grid = [0, 1, 2, 3, 4].map(() => [pdPick(), pdPick(), pdPick()]);
          let pay = 0, jack = 0;
          const wins = [];
          PD_LINES.forEach((L, i) => {
            const r = pdLine(L.map((row, c) => grid[c][row]));
            if (r.jackpot) { const share = Math.min(1, b.amt / 500); jack += Math.floor(jp * share); jp = Math.max(JP_SEED, jp - jp * share); }
            if (r.pay) { pay += Math.floor((b.amt / 10) * r.pay); wins.push({ line: i, n: r.n }); }
          });
          pay += jack;
          E.to(from, { t: "pds", grid, pay, jack, wins, amt: b.amt });
          E.publish();
          E.later("pds" + from + Date.now(), 1900, () => {
            const p = E.P(from);
            if (!p) return;
            E.give(p, pay);
            if (jack) E.note(`💎 ${p.name} HIT THE JACKPOT for ${fmtC(jack)}!`);
            else if (pay >= b.amt * 20) E.note(`${p.name} won ${fmtC(pay)} on Pink Diamonds!`);
            E.publish();
          });
          return true;
        },
      };
    },
    onPrivate(m) {
      if (m.t !== "pds") return false;
      pdBuild();
      const cols = [...$("pdReels").children];
      $("pdLines").innerHTML = "";
      $("pdWin").textContent = "…";
      cols.forEach((col) => col.classList.add("spinning"));
      const iv = setInterval(() => { for (const col of cols) if (col.classList.contains("spinning")) for (const s of col.children) s.textContent = PD_SY[Math.floor(rnd() * 8)]; }, 60);
      cols.forEach((col, c) => setTimeout(() => {
        col.classList.remove("spinning");
        [...col.children].forEach((s, r) => { s.textContent = m.grid[c][r]; s.classList.remove("win"); });
        GameUtil.sfx("tick");
        if (c === 4) { clearInterval(iv); done(); }
      }, 700 + c * 280));
      function done() {
        pdBusy = false;
        $("pdSpin").disabled = false;
        $("pdWin").textContent = fmtC(m.pay);
        const svg = $("pdLines");
        for (const w of m.wins) {
          const L = PD_LINES[w.line];
          L.slice(0, w.n).forEach((row, c) => cols[c].children[row].classList.add("win"));
          const pts = L.map((row, c) => `${50 + c * 100},${50 + row * 100}`).join(" ");
          svg.insertAdjacentHTML("beforeend", `<polyline points="${pts}" />`);
        }
        if (m.jack) { GameUtil.sfx("win"); GameUtil.toast(`💎💎💎 JACKPOT! +${fmtC(m.jack)}`, 5000); GameUtil.achieve("jackpot"); }
        else GameUtil.sfx(m.pay >= m.amt * 5 ? "win" : m.pay > m.amt ? "good" : m.pay ? "pop" : "bad");
        if ($("pdAuto").checked) setTimeout(() => { if ($("pdAuto").checked && C.tab() === "pd") pdSpin(); else $("pdAuto").checked = false; }, 900);
      }
      return true;
    },
    render(V, tab) { pdPaint(V); if (tab !== "pd") $("pdAuto").checked = false; },
  });

  // =====================================================================
  // Baccarat: shared table. Bet Player, Banker or Tie, then the cards are dealt by the rules.
  // =====================================================================
  const BAC_BET_MS = 15000, BAC_DEAL_MS = 5200, BAC_SHOW_MS = 4500;
  const bv = (c) => (c[0] === "A" ? 1 : "TJQK".includes(c[0]) ? 0 : +c[0]);
  const bTot = (cs) => cs.reduce((a, c) => a + bv(c), 0) % 10;
  pane("bac", "felt", `
    <div class="bac-hands">
      <div class="bac-side p"><h3>PLAYER <b id="bacPT"></b></h3><div class="bj-cards" id="bacP"></div></div>
      <div class="bac-side b"><h3>BANKER <b id="bacBT"></b></h3><div class="bj-cards" id="bacB"></div></div>
    </div>
    <div class="bac-bets" id="bacBets">
      <button class="bac-bet p" data-k="P" type="button"><b>PLAYER</b><small>pays 1:1</small><span></span></button>
      <button class="bac-bet t" data-k="T" type="button"><b>TIE</b><small>pays 8:1</small><span></span></button>
      <button class="bac-bet b" data-k="B" type="button"><b>BANKER</b><small>pays 0.95:1</small><span></span></button>
    </div>
    <p class="cs-msg"><span id="bacStatus"></span> <span class="cs-timer" id="bacTimer"></span></p>
    <div class="bac-road" id="bacRoad"></div>
    <p class="cs-note">Closest to 9 wins. A tie returns Player and Banker bets.</p>`);
  let bacShown = null;
  $("bacBets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]"), V = C.state();
    if (!b || !V || !V.x.bac || V.x.bac.phase !== "bet") return;
    if (!coinsOk(C.chip())) return;
    GameUtil.sfx("click");
    C.act({ t: "bac", k: b.dataset.k, amt: C.chip() });
  });
  function bacPaint(V) {
    const s = V && V.x && V.x.bac;
    if (!s) return;
    const mine = s.bets[C.myId()] || {};
    for (const b of $("bacBets").children) {
      const k = b.dataset.k;
      b.querySelector("span").textContent = mine[k] ? fmtC(mine[k]) : "";
      b.classList.toggle("on", !!mine[k]);
      b.classList.toggle("won", s.phase === "show" && s.result === k);
      b.disabled = s.phase !== "bet";
    }
    // Deal the cards out one by one on screen.
    const key = s.phase === "bet" ? "" : s.n + ":" + s.phase;
    if (s.phase === "bet") { $("bacP").textContent = ""; $("bacB").textContent = ""; $("bacPT").textContent = ""; $("bacBT").textContent = ""; bacShown = null; }
    else if (bacShown !== s.n) {
      bacShown = s.n;
      $("bacP").textContent = ""; $("bacB").textContent = ""; $("bacPT").textContent = ""; $("bacBT").textContent = "";
      const order = [["p", 0], ["b", 0], ["p", 1], ["b", 1]];
      if (s.hands.p[2]) order.push(["p", 2]);
      if (s.hands.b[2]) order.push(["b", 2]);
      order.forEach(([side, i], k) => setTimeout(() => {
        const V2 = C.state();
        if (!V2 || !V2.x.bac || V2.x.bac.n !== s.n) return;
        $(side === "p" ? "bacP" : "bacB").append(C.cardEl(s.hands[side][i]));
        const shown = (sd) => s.hands[sd].slice(0, order.slice(0, k + 1).filter((o) => o[0] === sd).length);
        $("bacPT").textContent = bTot(shown("p")); $("bacBT").textContent = bTot(shown("b"));
        GameUtil.sfx("pop");
      }, 500 + k * 750));
    }
    void key;
    const staked = (mine.P || 0) + (mine.B || 0) + (mine.T || 0);
    $("bacStatus").textContent = s.phase === "bet" ? (staked ? `You've bet ${fmtC(staked)}. Dealing soon…` : "Place your bets") : s.phase === "deal" ? "Dealing…" : `${{ P: "Player", B: "Banker", T: "Tie" }[s.result]} wins${s.wins[C.myId()] ? ` · you won ${fmtC(s.wins[C.myId()])}` : ""}`;
    clockTo("bac", s.phase === "bet" ? s.ends : 0, $("bacTimer"));
    const road = $("bacRoad");
    road.textContent = "";
    for (const r of s.road) road.append(h("i", "r" + r, r));
  }
  C.register({
    engine: (E) => {
      const s = { phase: "bet", ends: 0, bets: {}, hands: { p: [], b: [] }, result: null, wins: {}, road: [], n: 0, shoe: C.deck(6) };
      const card = () => { if (s.shoe.length < 20) s.shoe = C.deck(6); return s.shoe.pop(); };
      function deal() {
        if (!Object.keys(s.bets).length) { s.ends = 0; return E.publish(); }
        s.n++;
        const p = [card(), card()], b = [card(), card()];
        let pt = bTot(p), bt = bTot(b);
        if (pt < 8 && bt < 8) {
          let third = null;
          if (pt <= 5) { third = card(); p.push(third); }
          const t = third ? bv(third) : null;
          const draw = t == null ? bt <= 5 : bt <= 2 || (bt === 3 && t !== 8) || (bt === 4 && t >= 2 && t <= 7) || (bt === 5 && t >= 4 && t <= 7) || (bt === 6 && (t === 6 || t === 7));
          if (draw) b.push(card());
        }
        pt = bTot(p); bt = bTot(b);
        s.hands = { p, b };
        s.result = pt > bt ? "P" : bt > pt ? "B" : "T";
        s.phase = "deal"; s.ends = Date.now() + BAC_DEAL_MS;
        E.publish();
        E.later("bac", BAC_DEAL_MS, () => {
          s.wins = {};
          for (const [idS, bb] of Object.entries(s.bets)) {
            let pay = 0;
            if (s.result === "T") pay = (bb.T || 0) * 9 + (bb.P || 0) + (bb.B || 0);
            else if (s.result === "P") pay = (bb.P || 0) * 2;
            else pay = Math.floor((bb.B || 0) * 1.95);
            const pl = E.P(+idS);
            if (pl && pay) { E.give(pl, pay); s.wins[idS] = pay; if (pay >= 5000) E.note(`${pl.name} won ${fmtC(pay)} at Baccarat`); }
          }
          s.road.unshift(s.result); s.road.length = Math.min(s.road.length, 24);
          s.phase = "show"; s.ends = Date.now() + BAC_SHOW_MS;
          E.publish();
          E.later("bac", BAC_SHOW_MS, () => { s.phase = "bet"; s.bets = {}; s.wins = {}; s.ends = 0; E.publish(); });
        });
      }
      return {
        pub: () => ({ bac: { phase: s.phase, ends: s.ends - Date.now(), bets: s.bets, hands: s.phase === "bet" ? { p: [], b: [] } : s.hands, result: s.phase === "show" ? s.result : null, wins: s.wins, road: s.road, n: s.n } }),
        handle(from, m) {
          if (m.t !== "bac") return false;
          if (s.phase !== "bet" || !["P", "B", "T"].includes(m.k)) return true;
          const p = E.P(from);
          if (!p) return true;
          const mine = s.bets[from] || {}, already = (mine.P || 0) + (mine.B || 0) + (mine.T || 0);
          if (already + Math.floor(+m.amt) > E.maxBet(p)) return true;
          const b = bet(E, from, m.amt, 5);
          if (!b) return true;
          mine[m.k] = (mine[m.k] || 0) + b.amt;
          s.bets[from] = mine;
          if (!s.ends || s.ends < Date.now()) { s.ends = Date.now() + BAC_BET_MS; E.later("bac", BAC_BET_MS, deal); }
          E.publish();
          return true;
        },
        leave(id) { if (s.phase === "bet") delete s.bets[id]; },
      };
    },
    render(V) { bacPaint(V); },
  });

  // =====================================================================
  // Video Poker (Jacks or Better, 9/6 pay table, about 99.5% back with good play).
  // =====================================================================
  const VP_PAY = [["Royal Flush", 800], ["Straight Flush", 50], ["Four of a Kind", 25], ["Full House", 9], ["Flush", 6], ["Straight", 4], ["Three of a Kind", 3], ["Two Pair", 2], ["Jacks or Better", 1]];
  const vpRank = (c) => "23456789TJQKA".indexOf(c[0]) + 2;
  function vpEval(hand) {
    const r = hand.map(vpRank).sort((a, b) => a - b), suits = hand.map((c) => c[1]);
    const flush = suits.every((x) => x === suits[0]);
    const uniq = [...new Set(r)];
    const straight = uniq.length === 5 && (r[4] - r[0] === 4 || r.join() === "2,3,4,5,14");
    const cnt = {};
    for (const x of r) cnt[x] = (cnt[x] || 0) + 1;
    const groups = Object.entries(cnt).map(([k, n]) => [n, +k]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    if (straight && flush) return r[0] === 10 ? 0 : 1;
    if (groups[0][0] === 4) return 2;
    if (groups[0][0] === 3 && groups[1][0] === 2) return 3;
    if (flush) return 4;
    if (straight) return 5;
    if (groups[0][0] === 3) return 6;
    if (groups[0][0] === 2 && groups[1][0] === 2) return 7;
    if (groups[0][0] === 2 && groups[0][1] >= 11) return 8;
    return -1;
  }
  pane("vp", "cs-dark vp-pane", `
    <div class="vp-table" id="vpTable"></div>
    <div class="vp-hand" id="vpHand"></div>
    <button class="btn primary lg" id="vpBtn" type="button">Deal</button>
    <p class="cs-msg" id="vpMsg">Deal five cards, tap the ones to keep, then draw.</p>`);
  let VP = null, vpHold = [false, false, false, false, false];
  function vpPaint() {
    const t = $("vpTable");
    t.textContent = "";
    VP_PAY.forEach(([n, x], i) => { const row = h("div", "vp-row" + (VP && VP.stage === "done" && VP.hand === i ? " hit" : ""), ""); row.append(h("span", "", n), h("b", "", fmtC(x * C.chip()))); t.append(row); });
    const hand = $("vpHand");
    hand.textContent = "";
    const cards = VP ? VP.cards : ["??", "??", "??", "??", "??"];
    cards.forEach((c, i) => {
      const w = h("button", "vp-card" + (vpHold[i] ? " held" : ""));
      w.type = "button";
      w.append(C.cardEl(c), h("small", "", vpHold[i] ? "HELD" : ""));
      w.disabled = !VP || VP.stage !== "hold";
      w.addEventListener("click", () => { vpHold[i] = !vpHold[i]; GameUtil.sfx("click"); vpPaint(); });
      hand.append(w);
    });
    $("vpBtn").textContent = VP && VP.stage === "hold" ? "Draw" : `Deal · ${fmtC(C.chip())}`;
  }
  $("vpBtn").addEventListener("click", () => {
    if (VP && VP.stage === "hold") { C.act({ t: "vpd", hold: vpHold }); return; }
    if (!coinsOk(C.chip())) return;
    C.act({ t: "vps", amt: C.chip() });
  });
  C.register({
    engine: (E) => {
      const st = {};
      const view = (id) => { const g = st[id]; return g ? { t: "vp", cards: g.cards, stage: g.stage, hand: g.hand, pay: g.pay, amt: g.amt } : { t: "vp", none: true }; };
      return {
        handle(from, m) {
          if (m.t === "vps") {
            if (st[from] && st[from].stage === "hold") return true;
            const b = bet(E, from, m.amt, 5);
            if (!b) return true;
            const d = C.deck(1);
            st[from] = { amt: b.amt, deck: d, cards: d.splice(-5), stage: "hold", hand: -1, pay: 0 };
            E.publish();
          } else if (m.t === "vpd") {
            const g = st[from], p = E.P(from);
            if (!g || g.stage !== "hold" || !p) return true;
            const hold = Array.isArray(m.hold) ? m.hold : [];
            g.cards = g.cards.map((c, i) => (hold[i] ? c : g.deck.pop()));
            g.hand = vpEval(g.cards);
            g.pay = g.hand >= 0 ? g.amt * VP_PAY[g.hand][1] : 0;
            g.stage = "done";
            E.give(p, g.pay);
            if (g.hand >= 0 && g.hand <= 2) E.note(`${p.name} got a ${VP_PAY[g.hand][0]} on Video Poker!`);
            E.publish();
          } else return false;
          E.to(from, view(from));
          return true;
        },
        rejoin(id) { E.to(id, view(id)); },
        leave(id) { delete st[id]; },
      };
    },
    onPrivate(m) {
      if (m.t !== "vp") return false;
      const was = VP;
      VP = m.none ? null : m;
      if (VP && VP.stage === "hold" && (!was || was.stage !== "hold")) { vpHold = [false, false, false, false, false]; GameUtil.sfx("pop"); msg($("vpMsg"), "Tap the cards you want to keep, then draw."); }
      if (VP && VP.stage === "done" && was && was.stage === "hold") {
        msg($("vpMsg"), VP.hand >= 0 ? `${VP_PAY[VP.hand][0]}! Won ${fmtC(VP.pay)}` : "No winning hand", VP.pay > VP.amt);
        GameUtil.sfx(VP.hand >= 0 && VP.hand <= 3 ? "win" : VP.pay ? "good" : "bad");
        vpHold = [false, false, false, false, false];
      }
      vpPaint();
      return true;
    },
    render(V, tab) { if (tab === "vp") vpPaint(); },
  });

  // =====================================================================
  // Horse Racing: shared races. Six horses, odds from their form, bet before the gates open.
  // =====================================================================
  const HORSES = [["Pink Thunder", "#ff2e93"], ["Midnight", "#6366f1"], ["Lucky Star", "#facc15"], ["Neon Dash", "#22d3ee"], ["Cherry Bomb", "#ef4444"], ["Mint Rocket", "#4ade80"]];
  const HR_BET_MS = 20000, HR_RUN_MS = 9000, HR_SHOW_MS = 5500;
  pane("race", "cs-dark", `
    <div class="hr-track" id="hrTrack"></div>
    <div class="hr-board" id="hrBoard"></div>
    <p class="cs-msg"><span id="hrStatus"></span> <span class="cs-timer" id="hrTimer"></span></p>
    <p class="cs-note">Odds include your stake: a 3.5 horse turns 100 into 350. Races run every few seconds once someone bets.</p>`);
  let hrAnimN = -1;
  function hrPaint(V) {
    const s = V && V.x && V.x.hr;
    if (!s) return;
    const track = $("hrTrack");
    if (!track.childElementCount) HORSES.forEach(([n, c], i) => { const lane = h("div", "hr-lane"); lane.append(h("span", "hr-num", i + 1), h("i", "hr-horse", "🏇")); lane.querySelector(".hr-horse").style.setProperty("--c", c); track.append(lane); });
    const mine = s.bets[C.myId()] || {};
    const board = $("hrBoard");
    board.textContent = "";
    HORSES.forEach(([n, c], i) => {
      const b = h("button", "hr-pick" + (mine[i] ? " on" : "") + (s.phase === "show" && s.order[0] === i ? " won" : ""));
      b.type = "button";
      b.style.setProperty("--c", c);
      b.append(h("span", "hr-dot", i + 1), h("b", "", n), h("small", "", s.odds[i].toFixed(1)), h("em", "", mine[i] ? fmtC(mine[i]) : ""));
      b.disabled = s.phase !== "bet";
      b.addEventListener("click", () => { if (coinsOk(C.chip())) { GameUtil.sfx("click"); C.act({ t: "hr", h: i, amt: C.chip() }); } });
      board.append(b);
    });
    const lanes = [...track.children];
    if (s.phase === "run" && hrAnimN !== s.n) {
      hrAnimN = s.n;
      const t0 = performance.now() - (HR_RUN_MS - s.ends), place = {};
      s.order.forEach((hIdx, k) => { place[hIdx] = k; });
      const seeds = HORSES.map(() => rnd() * 6);
      GameUtil.sfx("start");
      const step = (now) => {
        const V2 = C.state();
        if (!V2 || !V2.x.hr || V2.x.hr.n !== s.n) return;
        const t = (now - t0) / 1000;
        lanes.forEach((lane, i) => {
          const fin = (HR_RUN_MS / 1000) * (0.8 + 0.035 * place[i]);
          const u = Math.min(1, t / fin), e = u < 1 ? u * u * (3 - 2 * u) : 1;
          const wob = u < 1 ? Math.sin(t * 3 + seeds[i]) * 0.02 * (1 - u) : 0;
          lane.querySelector(".hr-horse").style.left = `calc(${Math.max(0, Math.min(1, e + wob)) * 88}% )`;
        });
        if (t < HR_RUN_MS / 1000 + 0.5) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    if (s.phase === "bet") lanes.forEach((l) => { l.querySelector(".hr-horse").style.left = "0%"; });
    const staked = Object.values(mine).reduce((a, b) => a + b, 0);
    $("hrStatus").textContent = s.phase === "bet" ? (staked ? `You've bet ${fmtC(staked)}. Gates open soon…` : "Pick a horse to bet on") : s.phase === "run" ? "And they're off!" : `🏆 ${HORSES[s.order[0]][0]} wins!${s.wins[C.myId()] ? ` You won ${fmtC(s.wins[C.myId()])}` : ""}`;
    clockTo("hr", s.phase === "bet" ? s.ends : 0, $("hrTimer"));
  }
  C.register({
    engine: (E) => {
      const s = { phase: "bet", ends: 0, bets: {}, odds: [], probs: [], order: [], wins: {}, n: 0 };
      function newOdds() {
        const str = HORSES.map(() => Math.pow(0.6 + rnd(), 3));
        const tot = str.reduce((a, b) => a + b, 0);
        s.probs = str.map((x) => x / tot);
        s.odds = s.probs.map((p) => Math.max(1.2, Math.floor((0.92 / p) * 10) / 10));
      }
      newOdds();
      function run() {
        if (!Object.keys(s.bets).length) { s.ends = 0; return E.publish(); }
        // Finishing order: draw horses one at a time, weighted by their chances.
        const left = HORSES.map((_, i) => i);
        s.order = [];
        while (left.length) {
          const tot = left.reduce((a, i) => a + s.probs[i], 0);
          let r = rnd() * tot, pick = left[0];
          for (const i of left) { r -= s.probs[i]; if (r < 0) { pick = i; break; } }
          s.order.push(pick); left.splice(left.indexOf(pick), 1);
        }
        s.n++; s.phase = "run"; s.ends = Date.now() + HR_RUN_MS;
        E.publish();
        E.later("hr", HR_RUN_MS, () => {
          const w = s.order[0];
          s.wins = {};
          for (const [idS, bb] of Object.entries(s.bets)) {
            const pay = bb[w] ? Math.floor(bb[w] * s.odds[w]) : 0, p = E.P(+idS);
            if (p && pay) { E.give(p, pay); s.wins[idS] = pay; if (s.odds[w] >= 8) E.note(`${p.name} backed ${HORSES[w][0]} at ${s.odds[w]} and won ${fmtC(pay)}!`); }
          }
          s.phase = "show"; s.ends = Date.now() + HR_SHOW_MS;
          E.publish();
          E.later("hr", HR_SHOW_MS, () => { s.phase = "bet"; s.bets = {}; s.wins = {}; s.ends = 0; newOdds(); E.publish(); });
        });
      }
      return {
        pub: () => ({ hr: { phase: s.phase, ends: s.ends - Date.now(), bets: s.bets, odds: s.odds, order: s.phase === "bet" ? [] : s.order, wins: s.wins, n: s.n } }),
        handle(from, m) {
          if (m.t !== "hr") return false;
          const i = m.h | 0;
          if (s.phase !== "bet" || i < 0 || i >= HORSES.length) return true;
          const p = E.P(from);
          if (!p) return true;
          const mine = s.bets[from] || {}, already = Object.values(mine).reduce((a, b) => a + b, 0);
          if (already + Math.floor(+m.amt) > E.maxBet(p)) return true;
          const b = bet(E, from, m.amt, 5);
          if (!b) return true;
          mine[i] = (mine[i] || 0) + b.amt;
          s.bets[from] = mine;
          if (!s.ends || s.ends < Date.now()) { s.ends = Date.now() + HR_BET_MS; E.later("hr", HR_BET_MS, run); }
          E.publish();
          return true;
        },
        leave(id) { if (s.phase === "bet") delete s.bets[id]; },
      };
    },
    render(V) { hrPaint(V); },
  });
})();

(() => {
  const C = window.Casino;
  if (!C) return;
  const { h, $, fmtC } = C;
  const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  const main = document.querySelector(".cs-main");
  const pane = (id, cls, html) => { const el = document.createElement("div"); el.className = "cs-pane " + cls; el.dataset.pane = id; el.hidden = true; el.innerHTML = html; main.append(el); return el; };
  const today = () => new Date().toDateString();

  // =====================================================================
  // VIP Club: tiers from how much you've wagered in total. Better tiers boost the daily bonus
  // and pay rakeback (a slice of everything you've bet, claimable any time).
  // =====================================================================
  const TIERS = [
    { n: "Bronze", i: "🥉", at: 0, daily: 1, rb: 0.002 }, { n: "Silver", i: "🥈", at: 20000, daily: 1.5, rb: 0.004 },
    { n: "Gold", i: "🥇", at: 100000, daily: 2, rb: 0.006 }, { n: "Platinum", i: "💠", at: 500000, daily: 3, rb: 0.008 },
    { n: "Diamond", i: "💎", at: 2500000, daily: 4, rb: 0.01 }, { n: "Pink Diamond", i: "🩷", at: 10000000, daily: 5, rb: 0.015 },
  ];
  const tierOf = (w) => { let t = 0; TIERS.forEach((x, i) => { if (w >= x.at) t = i; }); return t; };
  C.dailyMult = () => TIERS[tierOf(C.wallet().wag || 0)].daily;
  pane("vip", "vip-pane", `
    <div class="vip-hero"><div class="vip-badge-big" id="vipIcon">🥉</div><div><small>Your VIP level</small><h2 id="vipName">Bronze</h2><div class="lvl-track"><i id="vipBar"></i></div><p class="muted" id="vipNext"></p></div></div>
    <div class="vip-claim"><div><small>Rakeback ready</small><b id="vipRb">0</b></div><button class="btn primary" id="vipClaim" type="button">Claim</button></div>
    <div class="vip-tiers" id="vipTiers"></div>
    <p class="cs-note">Every coin you bet counts toward your level. Levels are saved with your wallet.</p>`);
  let lastWag = null;
  const rbReady = () => { const W = C.wallet(); return Math.floor(Math.max(0, (W.wag || 0) - (W.rbFrom || 0)) * TIERS[tierOf(W.wag || 0)].rb); };
  function vipPaint() {
    const W = C.wallet(), w = W.wag || 0, t = tierOf(w), cur = TIERS[t], nxt = TIERS[t + 1];
    $("vipBadge").textContent = `${cur.i} ${cur.n}`;
    $("vipIcon").textContent = cur.i;
    $("vipName").textContent = cur.n;
    $("vipBar").style.width = nxt ? Math.min(100, ((w - cur.at) / (nxt.at - cur.at)) * 100) + "%" : "100%";
    $("vipNext").textContent = nxt ? `${fmtC(nxt.at - w)} more wagered to reach ${nxt.i} ${nxt.n}` : "Top level. You're a legend.";
    $("vipRb").textContent = fmtC(rbReady());
    $("vipClaim").disabled = rbReady() < 1 || !C.room();
    const box = $("vipTiers");
    box.textContent = "";
    TIERS.forEach((x, i) => {
      const el = h("div", "vip-tier" + (i === t ? " on" : i < t ? " done" : ""));
      el.append(h("span", "vip-i", x.i), h("b", "", x.n), h("small", "", i ? `${fmtC(x.at)} wagered` : "Everyone starts here"), h("em", "", `Daily bonus ×${x.daily} · ${(x.rb * 100).toFixed(1)}% rakeback`));
      box.append(el);
    });
  }
  $("vipClaim").addEventListener("click", () => {
    const amt = rbReady(), W = C.wallet();
    if (amt < 1 || !C.room()) return;
    W.rbFrom = W.wag || 0; W.coins += amt; C.saveWallet();
    C.act({ t: "adj", amt });
    GameUtil.toast(`💸 Rakeback: +${fmtC(amt)} coins`); GameUtil.sfx("win");
    vipPaint();
  });

  // =====================================================================
  // Daily free spin: one free prize wheel spin a day.
  // =====================================================================
  const PRIZES = [[100, 30], [250, 25], [500, 18], [1000, 12], [2500, 8], [5000, 5], [10000, 1.5], [25000, 0.5]];
  const SLICES = [100, 1000, 250, 5000, 500, 2500, 100, 10000, 250, 1000, 500, 25000];
  pane("spin", "cs-dark", `
    <h2 class="sp-title">🎁 Daily free spin</h2>
    <div class="wh-wrap"><canvas id="spCanvas" width="420" height="420"></canvas><i class="wh-pointer"></i><b class="wh-center" id="spCenter">FREE</b></div>
    <button class="btn primary lg" id="spBtn" type="button">Spin for free</button>
    <p class="cs-msg" id="spMsg">One free spin every day. Prizes up to 25,000 coins.</p>`);
  let spAngle = 0, spBusy = false;
  const spColor = (v) => (v >= 10000 ? "#ffd23f" : v >= 2500 ? "#ff2e93" : v >= 1000 ? "#c084fc" : v >= 500 ? "#38bdf8" : "#3a2a36");
  function spDraw() {
    const cv = $("spCanvas"), x = cv.getContext("2d"), R = cv.width / 2, a = (Math.PI * 2) / SLICES.length;
    x.clearRect(0, 0, cv.width, cv.height);
    x.save(); x.translate(R, R); x.rotate(spAngle);
    SLICES.forEach((v, i) => {
      x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, R - 6, i * a - Math.PI / 2, (i + 1) * a - Math.PI / 2); x.closePath();
      x.fillStyle = spColor(v); x.fill(); x.strokeStyle = "#0a0610"; x.lineWidth = 3; x.stroke();
      x.save(); x.rotate(i * a + a / 2); x.fillStyle = v >= 10000 ? "#1a1000" : "#fff"; x.font = "800 20px Geist, system-ui, sans-serif"; x.textAlign = "center";
      x.fillText(v >= 1000 ? v / 1000 + "K" : v, 0, -R + 48); x.restore();
    });
    x.restore();
    x.beginPath(); x.arc(R, R, R - 3, 0, Math.PI * 2); x.strokeStyle = "#ffd23f"; x.lineWidth = 6; x.stroke();
    const ready = C.wallet().lastSpin !== today();
    $("spBtn").disabled = !ready || spBusy || !C.room();
    $("spBtn").textContent = ready ? "Spin for free" : "Come back tomorrow";
  }
  $("spBtn").addEventListener("click", () => {
    const W = C.wallet();
    if (spBusy || W.lastSpin === today() || !C.room()) return;
    spBusy = true; W.lastSpin = today(); C.saveWallet();
    let r = rnd() * PRIZES.reduce((a, p) => a + p[1], 0), prize = 100;
    for (const [v, w] of PRIZES) { r -= w; if (r < 0) { prize = v; break; } }
    const idxs = SLICES.map((v, i) => (v === prize ? i : -1)).filter((i) => i >= 0), i = idxs[Math.floor(rnd() * idxs.length)];
    const a = (Math.PI * 2) / SLICES.length, start = spAngle % (Math.PI * 2), target = Math.PI * 2 * 7 - (i + 0.5) * a;
    const t0 = performance.now(), T = 5000;
    const step = (now) => {
      const u = Math.min(1, (now - t0) / T), e = 1 - Math.pow(1 - u, 4);
      spAngle = start + (target - start) * e; spDraw();
      if (u < 1) return requestAnimationFrame(step);
      spBusy = false;
      W.coins += prize; C.saveWallet(); C.act({ t: "adj", amt: prize });
      $("spCenter").textContent = fmtC(prize);
      $("spMsg").textContent = `You won ${fmtC(prize)} coins! See you tomorrow.`; $("spMsg").className = "cs-msg good";
      GameUtil.sfx("win"); spDraw();
    };
    requestAnimationFrame(step);
  });

  // =====================================================================
  // Lobby: game tiles by category, live wins ticker, jackpot.
  // =====================================================================
  const TILES = [
    ["Originals", [["cr", "🚀", "Crash", "#ff2e93", "#3a0620", "Hot"], ["plk", "🔻", "Plinko", "#f472b6", "#2a0a2e"], ["mn", "💣", "Mines", "#22d3ee", "#062a33"], ["dice", "🎲", "Dice", "#a78bfa", "#1e1038", "New"], ["keno", "🔢", "Keno", "#facc15", "#2e2406", "New"], ["hilo", "🃏", "Hi-Lo", "#4ade80", "#082a14", "New"], ["wheel", "🎡", "Wheel", "#fb923c", "#2e1406", "New"], ["scratch", "🎟️", "Scratch cards", "#e5e7eb", "#1f1f27", "New"]]],
    ["Slots", [["pd", "💎", "Pink Diamonds", "#ff2e93", "#1a0010", "Jackpot"], ["slots", "🎰", "Classic 7s", "#facc15", "#2a1500"]]],
    ["Table games", [["bj", "🂡", "Blackjack", "#4ade80", "#0b3a22"], ["rl", "🎯", "Roulette", "#ef4444", "#2e0808"], ["bac", "🀄", "Baccarat", "#38bdf8", "#06243a", "New"], ["vp", "♠️", "Video Poker", "#c084fc", "#200a33", "New"]]],
    ["Live with friends", [["race", "🏇", "Horse Racing", "#facc15", "#1f1a06", "New"], ["cf", "🪙", "Coinflip duels", "#fbbf24", "#2a1d04"]]],
    ["Rewards", [["spin", "🎁", "Daily free spin", "#ff2e93", "#2a0618", "Free"], ["vip", "👑", "VIP Club", "#ffd23f", "#2a2006"], ["crate", "📦", "Crates", "#a78bfa", "#1a0f2e"], ["shop", "⬆️", "Upgrades", "#4ade80", "#0a2a14"]]],
  ];
  (() => {
    const box = $("lobbyTiles");
    for (const [cat, list] of TILES) {
      box.append(h("h2", "cs-cat", cat));
      const grid = h("div", "cs-tiles");
      for (const [id, icon, name, c1, c2, tag] of list) {
        const t = h("button", "cs-tile");
        t.type = "button"; t.dataset.go = id;
        t.style.setProperty("--c1", c1); t.style.setProperty("--c2", c2);
        t.append(h("span", "cs-tile-i", icon), h("b", "", name));
        if (tag) t.append(h("em", "tag-" + tag.toLowerCase(), tag));
        t.append(h("span", "cs-tile-play", "▶ Play"));
        grid.append(t);
      }
      box.append(grid);
    }
  })();
  let tickSig = null;
  function ticker(V) {
    const items = V.log.map((l) => l.t).filter((t) => /won|hit|cashed|JACKPOT|backed|got a/i.test(t)).slice(0, 10);
    const sig = items.join("|");
    if (sig === tickSig) return;
    tickSig = sig;
    const tr = $("tickerTrack");
    tr.textContent = "";
    const list = items.length ? items : ["Welcome to OXID Casino! Big wins at your table show up here.", "💎 Hit 5 diamonds on Pink Diamonds to win the jackpot", "🎁 Spin the free daily wheel for up to 25,000 coins"];
    for (const t of [...list, ...list]) tr.append(h("span", "", t));
    tr.style.animationDuration = Math.max(20, list.length * 7) + "s";
  }

  // Keep the VIP level up to date with what the table says you've wagered.
  C.register({
    render(V, tab) {
      const me = V.players.find((p) => p.id === C.myId());
      if (me) {
        const W = C.wallet();
        if (lastWag == null || me.wag < lastWag) lastWag = me.wag || 0;
        else if (me.wag > lastWag) { W.wag = (W.wag || 0) + (me.wag - lastWag); lastWag = me.wag; C.saveWallet(); }
      }
      if (V.x && V.x.jp != null) $("jackpot").textContent = fmtC(V.x.jp);
      ticker(V);
      vipPaint();
      if (tab === "spin" && !spBusy) spDraw();
      $("chipsBar").hidden = ["lobby", "vip", "spin", "crate", "shop", "scratch"].includes(tab);
      document.body.dataset.tab = tab;
    },
  });

  // ---- Invite friends: copy the table link ----
  const invite = async () => {
    const r = C.room();
    if (!r) return;
    const url = location.origin + location.pathname.replace(/\.html$/, "") + "#" + r.code;
    try { await navigator.clipboard.writeText(url); GameUtil.toast("Table link copied! Send it to your friends."); }
    catch { GameUtil.toast("Your table code: " + r.code, 5000); }
  };
  $("inviteBtn").addEventListener("click", invite);
  $("inviteBtn2").addEventListener("click", invite);
  if (window.CASINO_SUB) $("backLink").href = window.MAIN_ORIGIN + "/";

  // ---- Walk straight in: open your own table unless you came from a friend's link ----
  (() => {
    if (location.hash) return;
    let tries = 0, stage = 0;
    const iv = setInterval(() => {
      if (++tries > 60 || C.room()) return clearInterval(iv);
      const host = document.querySelector('[data-act="host"]'), start = document.querySelector('[data-act="start"]');
      if (stage === 0 && host && host.offsetParent) { stage = 1; host.click(); }
      else if (stage === 1 && start && start.offsetParent && !start.disabled) { stage = 2; start.click(); }
    }, 150);
  })();
})();
