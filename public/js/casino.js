// Casino: play-money gambling with friends. No real money, nothing to buy with real money.
// Your wallet (coins, upgrades, stats) is saved on this device, and you can move it to another
// device with a transfer code. At a table the host runs every game (Blackjack, Roulette, Slots and
// Coinflip duels between players), deals with everyone's bets and pays out; each player's copy of
// the wallet follows the balance the host reports.
(() => {
  const { h } = Party;
  const $ = (id) => document.getElementById(id);
  const WALLET_KEY = "oxidpvp-wallet", START = 1000, DAILY_BASE = 250, BAILOUT = 100;

  // =====================================================================
  // Wallet + upgrades (saved on this device)
  // =====================================================================
  const UPGRADES = [
    { id: "daily", name: "Daily bonus+", icon: "📅", desc: (l) => `Daily bonus ${DAILY_BASE + l * 150} → ${DAILY_BASE + (l + 1) * 150}`, cost: [500, 1500, 4000, 10000, 25000] },
    { id: "limit", name: "High roller", icon: "💎", desc: (l) => `Max bet ${limitFor(l).toLocaleString()} → ${limitFor(l + 1).toLocaleString()}`, cost: [800, 5000, 25000, 100000] },
    { id: "lucky", name: "Lucky charm", icon: "🍀", desc: (l) => `Slots pay +${l * 10}% → +${(l + 1) * 10}%`, cost: [1500, 6000, 20000] },
    { id: "insure", name: "Insurance", icon: "🛡️", desc: (l) => `Get ${l * 10}% → ${(l + 1) * 10}% back on lost blackjack hands`, cost: [2000, 8000, 30000] },
    { id: "gold", name: "Golden chips", icon: "🪙", desc: () => "Your name shines gold at every table", cost: [15000] },
    { id: "table", name: "VIP felt", icon: "🎨", desc: (l) => `Unlock table color ${l + 2} of 5`, cost: [3000, 6000, 12000, 24000] },
  ];
  const limitFor = (l) => [500, 2500, 10000, 50000, 250000][l] || 250000;
  const FELTS = ["#0f5132", "#1e3a8a", "#7f1d1d", "#831843", "#111827"];
  function loadWallet() {
    let w = null;
    try { w = JSON.parse(localStorage.getItem(WALLET_KEY)); } catch {}
    w = { coins: START, up: {}, lastDaily: 0, lastBail: 0, best: 0, won: 0, lost: 0, felt: 0, ...(w || {}) };
    w.coins = Math.max(0, Math.floor(+w.coins || 0));
    return w;
  }
  let W = loadWallet();
  const saveWallet = () => { try { localStorage.setItem(WALLET_KEY, JSON.stringify(W)); } catch {} };
  saveWallet();
  const lvl = (id) => W.up[id] | 0;
  const fmtC = (n) => Math.floor(n).toLocaleString();
  const today = () => new Date().toDateString();

  // Transfer codes: the wallet as base64 plus a checksum, so typos are caught.
  const sum = (str) => { let x = 7; for (const c of str) x = (x * 31 + c.charCodeAt(0)) % 1000003; return x.toString(36); };
  const exportCode = () => { const b = btoa(JSON.stringify(W)); return `OXC-${b}-${sum(b)}`; };
  function importCode(code) {
    const m = String(code).trim().match(/^OXC-([A-Za-z0-9+/=]+)-([a-z0-9]+)$/);
    if (!m || sum(m[1]) !== m[2]) return false;
    try { const w = JSON.parse(atob(m[1])); if (typeof w.coins !== "number") return false; W = { ...loadWallet(), ...w }; saveWallet(); return true; } catch { return false; }
  }

  // =====================================================================
  // Cards
  // =====================================================================
  const RANKS = "A23456789TJQK", SUITS = "shdc", SUIT_CH = { s: "♠", h: "♥", d: "♦", c: "♣" };
  const deck = (n) => GameUtil.shuffle(Array.from({ length: n }, () => [...RANKS].flatMap((r) => [...SUITS].map((s) => r + s))).flat());
  const cardVal = (c) => (c[0] === "A" ? 11 : "TJQK".includes(c[0]) ? 10 : +c[0]);
  function total(cards) {
    let t = 0, aces = 0;
    for (const c of cards) { t += cardVal(c); if (c[0] === "A") aces++; }
    while (t > 21 && aces) { t -= 10; aces--; }
    return t;
  }
  const isBJ = (cards) => cards.length === 2 && total(cards) === 21;

  // Roulette: European wheel
  const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const RL_BETS = {
    red: { label: "Red", pays: 1, wins: (n) => REDS.has(n) }, black: { label: "Black", pays: 1, wins: (n) => n > 0 && !REDS.has(n) },
    odd: { label: "Odd", pays: 1, wins: (n) => n % 2 === 1 }, even: { label: "Even", pays: 1, wins: (n) => n > 0 && n % 2 === 0 },
    low: { label: "1–18", pays: 1, wins: (n) => n >= 1 && n <= 18 }, high: { label: "19–36", pays: 1, wins: (n) => n >= 19 },
    d1: { label: "1st 12", pays: 2, wins: (n) => n >= 1 && n <= 12 }, d2: { label: "2nd 12", pays: 2, wins: (n) => n >= 13 && n <= 24 }, d3: { label: "3rd 12", pays: 2, wins: (n) => n >= 25 },
  };
  const rlBet = (k) => (RL_BETS[k] ? RL_BETS[k] : /^n(\d{1,2})$/.test(k) && +k.slice(1) <= 36 ? { label: "#" + k.slice(1), pays: 35, wins: (n) => n === +k.slice(1) } : null);

  // Slots
  const SYMS = ["🍒", "🍋", "🔔", "⭐", "💎", "7️⃣"];
  const SYM_W = [30, 25, 18, 13, 9, 5];
  const PAY3 = { "🍒": 5, "🍋": 8, "🔔": 12, "⭐": 20, "💎": 40, "7️⃣": 100 };
  const spinSym = () => { let r = Math.random() * 100; for (let i = 0; i < SYMS.length; i++) { r -= SYM_W[i]; if (r < 0) return SYMS[i]; } return SYMS[0]; };

  // Crash: the multiplier grows as e^(K·ms); it doubles about every 5.8 seconds.
  const CR_K = 0.00012, CR_BET_MS = 10000, CR_SHOW_MS = 4000;
  const crMult = (ms) => Math.floor(Math.exp(CR_K * Math.max(0, ms)) * 100) / 100;
  // 1% house edge: P(crash ≥ x) = 0.99 / x.
  const crashPoint = () => Math.max(1, Math.floor((0.99 / (1 - Math.random())) * 100) / 100);

  // Plinko: 12 rows, so 13 slots. Each table pays back about 99% on average.
  const PLK_ROWS = 12, PLK_MS = 2600;
  const PLINKO = {
    low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    mid: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
    high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
  };

  // Mines: a 5×5 grid. Each safe tile raises the payout; hit a mine and you lose the bet.
  const MN_COUNTS = [1, 3, 5, 10, 15, 24];
  const mnMult = (count, k) => { let m = 0.99; for (let i = 0; i < k; i++) m *= (25 - i) / (25 - count - i); return Math.floor(m * 100) / 100; };

  // =====================================================================
  // Host engine
  // =====================================================================
  const BJ_BET_MS = 15000, BJ_TURN_MS = 20000, BJ_SHOW_MS = 5500, RL_BET_MS = 20000, RL_SPIN_MS = 5200, RL_SHOW_MS = 5000;
  function createEngine(room, out) {
    const G = {
      players: [], log: [],
      bj: { phase: "bet", ends: 0, seats: {}, dealer: [], turn: null, shoe: deck(4) },
      rl: { phase: "bet", ends: 0, bets: {}, result: null, spinAt: 0 },
      cf: { offers: [], last: null },
      cr: { phase: "bet", ends: 0, start: 0, crash: 0, bets: {}, hist: [], n: 0 },
      mn: {},
      timers: {},
    };
    const P = (id) => G.players.find((p) => p.id === id);
    const note = (t) => { G.log.unshift({ t, at: Date.now() }); G.log.length = Math.min(G.log.length, 12); };
    const pub = () => ({
      t: "st",
      players: G.players.map((p) => ({ id: p.id, name: p.name, av: p.av, coins: p.coins, gold: p.gold, delta: p.delta })),
      bj: { phase: G.bj.phase, ends: G.bj.ends - Date.now(), seats: G.bj.seats, dealer: G.bj.phase === "play" ? [G.bj.dealer[0], "??"] : G.bj.dealer, turn: G.bj.turn },
      rl: { phase: G.rl.phase, ends: G.rl.ends - Date.now(), bets: G.rl.bets, result: G.rl.result },
      cr: { phase: G.cr.phase, ends: G.cr.ends - Date.now(), el: G.cr.phase === "run" ? Date.now() - G.cr.start : 0, crash: G.cr.phase === "crash" ? G.cr.crash : null, bets: G.cr.bets, hist: G.cr.hist, n: G.cr.n },
      cf: G.cf, log: G.log,
    });
    const publish = () => out.all(pub());
    const later = (k, ms, fn) => { clearTimeout(G.timers[k]); G.timers[k] = setTimeout(fn, ms); };

    function addPlayer(p, info) {
      if (P(p.id)) return;
      G.players.push({ id: p.id, name: p.name, av: p.av, coins: Math.max(0, Math.floor(+info.coins || 0)), up: info.up || {}, gold: !!(info.up && info.up.gold), delta: 0 });
      note(`${p.name} sat down with ${fmtC(G.players[G.players.length - 1].coins)} coins`);
      publish();
    }
    function hello(id, info) {
      const rp = room.players.find((x) => x.id === id);
      if (!rp) return;
      const p = P(id);
      if (p) { p.coins = Math.max(0, Math.floor(+info.coins || 0)); p.up = info.up || {}; p.gold = !!(p.up && p.up.gold); publish(); return; }
      addPlayer(rp, info);
    }
    const maxBet = (p) => limitFor(p.up.limit | 0);
    // Daily bonus, bailouts and upgrade purchases happen in the player's wallet; they send the
    // change (not a new total) so it can't clobber a bet the host is in the middle of settling.
    function adjust(id, amt, up) {
      const p = P(id);
      if (!p) return;
      amt = Math.floor(+amt) || 0;
      if (amt < 0 && -amt > p.coins) return;
      if (Math.abs(amt) > 1e7) return;
      p.coins += amt;
      if (up && typeof up === "object") { p.up = up; p.gold = !!up.gold; }
      publish();
    }
    function take(p, amt) {
      amt = Math.floor(+amt);
      if (!(amt >= 1) || amt > p.coins) return 0;
      p.coins -= amt; p.delta = -amt;
      return amt;
    }
    function give(p, amt) { if (p && amt > 0) { p.coins += Math.floor(amt); p.delta = Math.floor(amt); } }

    // ---------- Blackjack ----------
    const bj = G.bj;
    function bjBet(id, amt) {
      const p = P(id);
      if (!p || bj.phase !== "bet" || bj.seats[id]) return;
      amt = Math.floor(+amt);
      if (!(amt >= 5) || amt > maxBet(p)) return;
      if (!take(p, amt)) return;
      bj.seats[id] = { bet: amt, hand: [], done: false, result: null, doubled: false };
      if (!bj.ends || bj.ends < Date.now()) { bj.ends = Date.now() + BJ_BET_MS; later("bj", BJ_BET_MS, bjDeal); }
      // Everyone at the table has bet: deal now.
      if (G.players.every((q) => bj.seats[q.id] || q.coins < 5)) later("bj", 600, bjDeal);
      publish();
    }
    function bjDeal() {
      const ids = Object.keys(bj.seats).map(Number).filter((id) => P(id));
      if (!ids.length) { bj.ends = 0; bj.phase = "bet"; return publish(); }
      if (bj.shoe.length < 60) bj.shoe = deck(4);
      bj.dealer = [bj.shoe.pop(), bj.shoe.pop()];
      for (const id of ids) bj.seats[id].hand = [bj.shoe.pop(), bj.shoe.pop()];
      bj.phase = "play";
      for (const id of ids) if (isBJ(bj.seats[id].hand)) bj.seats[id].done = true;
      if (isBJ(bj.dealer)) return bjDealer();
      bjNext();
    }
    function bjNext() {
      const id = Object.keys(bj.seats).map(Number).find((x) => !bj.seats[x].done && P(x));
      if (id == null) return bjDealer();
      bj.turn = id;
      bj.ends = Date.now() + BJ_TURN_MS;
      later("bj", BJ_TURN_MS, () => bjAct(id, "stand"));
      publish();
    }
    function bjAct(id, a) {
      const s = bj.seats[id], p = P(id);
      if (bj.phase !== "play" || bj.turn !== id || !s || s.done) return;
      if (a === "hit") { s.hand.push(bj.shoe.pop()); if (total(s.hand) >= 21) s.done = true; }
      else if (a === "stand") s.done = true;
      else if (a === "double") {
        if (s.hand.length !== 2 || !p || !take(p, s.bet)) return;
        s.bet *= 2; s.doubled = true;
        s.hand.push(bj.shoe.pop());
        s.done = true;
      } else return;
      if (s.done) bjNext(); else { bj.ends = Date.now() + BJ_TURN_MS; later("bj", BJ_TURN_MS, () => bjAct(id, "stand")); publish(); }
    }
    function bjDealer() {
      bj.turn = null;
      const anyLive = Object.values(bj.seats).some((s) => total(s.hand) <= 21 && !isBJ(s.hand));
      if (anyLive && !isBJ(bj.dealer)) while (total(bj.dealer) < 17) bj.dealer.push(bj.shoe.pop());
      const d = total(bj.dealer), dBJ = isBJ(bj.dealer);
      for (const [idS, s] of Object.entries(bj.seats)) {
        const p = P(+idS), t = total(s.hand);
        let pay = 0, res;
        if (t > 21) res = "bust";
        else if (isBJ(s.hand) && !dBJ) { res = "blackjack"; pay = s.bet * 2.5; }
        else if (dBJ && !isBJ(s.hand)) res = "lose";
        else if (d > 21 || t > d) { res = "win"; pay = s.bet * 2; }
        else if (t === d) { res = "push"; pay = s.bet; }
        else res = "lose";
        if (p && (res === "bust" || res === "lose") && p.up.insure) pay = Math.floor(s.bet * 0.1 * p.up.insure);
        s.result = res; s.pay = Math.floor(pay);
        if (p) give(p, pay);
        if (p && (res === "win" || res === "blackjack")) note(`${p.name} won ${fmtC(pay - s.bet)} at blackjack${res === "blackjack" ? " (blackjack!)" : ""}`);
      }
      bj.phase = "show";
      bj.ends = Date.now() + BJ_SHOW_MS;
      later("bj", BJ_SHOW_MS, () => { bj.seats = {}; bj.dealer = []; bj.phase = "bet"; bj.ends = 0; publish(); });
      publish();
    }

    // ---------- Roulette ----------
    const rl = G.rl;
    function rlBetPlace(id, k, amt) {
      const p = P(id), b = rlBet(k);
      if (!p || !b || rl.phase !== "bet") return;
      amt = Math.floor(+amt);
      const mine = rl.bets[id] || [];
      const already = mine.reduce((a, x) => a + x.amt, 0);
      if (!(amt >= 5) || already + amt > maxBet(p) || mine.length >= 12) return;
      if (!take(p, amt)) return;
      const ex = mine.find((x) => x.k === k);
      if (ex) ex.amt += amt; else mine.push({ k, amt });
      rl.bets[id] = mine;
      rl.result = null;
      if (!rl.ends || rl.ends < Date.now()) { rl.ends = Date.now() + RL_BET_MS; later("rl", RL_BET_MS, rlSpin); }
      publish();
    }
    function rlSpin() {
      if (!Object.keys(rl.bets).length) { rl.ends = 0; return publish(); }
      rl.phase = "spin";
      const n = WHEEL[Math.floor(Math.random() * WHEEL.length)];
      rl.result = { n, wins: {} };
      rl.ends = Date.now() + RL_SPIN_MS;
      publish();
      later("rl", RL_SPIN_MS, () => {
        for (const [idS, list] of Object.entries(rl.bets)) {
          const p = P(+idS);
          let pay = 0;
          for (const b of list) { const def = rlBet(b.k); if (def && def.wins(n)) pay += b.amt * (def.pays + 1); }
          rl.result.wins[idS] = pay;
          if (p) { give(p, pay); if (pay) note(`${p.name} won ${fmtC(pay)} on roulette (${n})`); }
        }
        rl.phase = "show";
        rl.ends = Date.now() + RL_SHOW_MS;
        publish();
        later("rl", RL_SHOW_MS, () => { rl.bets = {}; rl.phase = "bet"; rl.ends = 0; publish(); });
      });
    }

    // ---------- Slots (per player, instant) ----------
    function slot(id, amt) {
      const p = P(id);
      if (!p) return;
      amt = Math.floor(+amt);
      if (!(amt >= 1) || amt > maxBet(p) || !take(p, amt)) return;
      const reels = [spinSym(), spinSym(), spinSym()];
      let mult = 0;
      if (reels[0] === reels[1] && reels[1] === reels[2]) mult = PAY3[reels[0]];
      else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) mult = 1.5;
      else if (reels.includes("🍒")) mult = 0.5;
      mult *= 1 + 0.1 * (p.up.lucky | 0);
      const pay = Math.floor(amt * mult);
      give(p, pay);
      if (pay >= amt * 10) note(`${p.name} hit ${reels.join("")} for ${fmtC(pay)}!`);
      out.to(id, { t: "slot", reels, pay, bet: amt });
      publish();
    }

    // ---------- Coinflip duels ----------
    const cf = G.cf;
    let offerSeq = 1;
    function cfOffer(id, to, amt) {
      const p = P(id), q = P(to);
      amt = Math.floor(+amt);
      if (!p || !q || id === to || !(amt >= 10) || amt > p.coins || amt > maxBet(p)) return;
      cf.offers = cf.offers.filter((o) => o.from !== id);
      cf.offers.push({ id: offerSeq++, from: id, to, amt, at: Date.now() });
      note(`${p.name} challenged ${q.name} to a ${fmtC(amt)} coinflip`);
      publish();
    }
    function cfAnswer(id, offerId, yes) {
      const o = cf.offers.find((x) => x.id === offerId);
      if (!o || o.to !== id) return;
      cf.offers = cf.offers.filter((x) => x !== o);
      const a = P(o.from), b = P(o.to);
      if (!yes || !a || !b) { if (a && b) note(`${b.name} declined ${a.name}'s coinflip`); return publish(); }
      if (a.coins < o.amt || b.coins < o.amt) { note("Coinflip cancelled: not enough coins"); return publish(); }
      take(a, o.amt); take(b, o.amt);
      const winner = Math.random() < 0.5 ? a : b;
      give(winner, o.amt * 2);
      cf.last = { a: a.id, b: b.id, w: winner.id, amt: o.amt, n: offerSeq++ };
      note(`${winner.name} won the ${fmtC(o.amt)} coinflip against ${winner === a ? b.name : a.name}`);
      publish();
    }
    function cfCancel(id) { cf.offers = cf.offers.filter((o) => o.from !== id); publish(); }

    // ---------- Crash (one shared round for the whole table) ----------
    const cr = G.cr;
    function crBet(id, amt, auto) {
      const p = P(id);
      if (!p || cr.phase !== "bet" || cr.bets[id]) return;
      amt = Math.floor(+amt);
      if (!(amt >= 5) || amt > maxBet(p) || !take(p, amt)) return;
      auto = +auto >= 1.01 ? Math.min(10000, Math.floor(+auto * 100) / 100) : 0;
      cr.bets[id] = { amt, auto, out: 0, pay: 0 };
      if (!cr.ends || cr.ends < Date.now()) { cr.ends = Date.now() + CR_BET_MS; later("cr", CR_BET_MS, crRun); }
      if (G.players.every((q) => cr.bets[q.id] || q.coins < 5)) later("cr", 800, crRun);
      publish();
    }
    function crRun() {
      if (!Object.keys(cr.bets).length) { cr.ends = 0; return publish(); }
      cr.phase = "run"; cr.start = Date.now(); cr.crash = crashPoint(); cr.n++; cr.ends = 0;
      for (const [idS, b] of Object.entries(cr.bets)) if (b.auto && b.auto < cr.crash) later("cra" + idS, Math.log(b.auto) / CR_K, () => crOut(+idS, b.auto));
      later("cr", Math.log(cr.crash) / CR_K, crCrash);
      publish();
    }
    function crOut(id, at) {
      const b = cr.bets[id], p = P(id);
      if (cr.phase !== "run" || !b || b.out || !p) return;
      const m = Math.min(at || crMult(Date.now() - cr.start), cr.crash);
      if (m < 1) return;
      b.out = m; b.pay = Math.floor(b.amt * m);
      give(p, b.pay);
      if (m >= 5) note(`${p.name} cashed out at ${m.toFixed(2)}× for ${fmtC(b.pay)}`);
      publish();
    }
    function crCrash() {
      cr.phase = "crash";
      for (const k of Object.keys(G.timers)) if (k.startsWith("cra")) clearTimeout(G.timers[k]);
      cr.hist.unshift(cr.crash); cr.hist.length = Math.min(cr.hist.length, 14);
      if (cr.crash >= 10) note(`Crash went to ${cr.crash.toFixed(2)}×!`);
      cr.ends = Date.now() + CR_SHOW_MS;
      publish();
      later("cr", CR_SHOW_MS, () => { cr.bets = {}; cr.phase = "bet"; cr.ends = 0; publish(); });
    }

    // ---------- Plinko (per player) ----------
    function plinko(id, amt, risk) {
      const p = P(id), table = PLINKO[risk];
      if (!p || !table) return;
      amt = Math.floor(+amt);
      if (!(amt >= 1) || amt > maxBet(p) || !take(p, amt)) return;
      const path = Array.from({ length: PLK_ROWS }, () => (Math.random() < 0.5 ? 0 : 1));
      const slot = path.reduce((a, b) => a + b, 0), pay = Math.floor(amt * table[slot]);
      out.to(id, { t: "plk", path, slot, pay, bet: amt, risk });
      publish();
      // Pay out once the ball has landed on screen.
      setTimeout(() => { const q = P(id); if (!q) return; give(q, pay); if (table[slot] >= 10) note(`${q.name} hit ${table[slot]}× on Plinko!`); publish(); }, PLK_MS);
    }

    // ---------- Mines (per player) ----------
    const mn = G.mn;
    const mnView = (id) => {
      const g = mn[id];
      if (!g) return { t: "mn", none: true };
      return { t: "mn", amt: g.amt, count: g.count, open: g.open, over: g.over, boom: g.boom, pay: g.pay, mult: mnMult(g.count, g.open.length), next: mnMult(g.count, g.open.length + 1), mines: g.over ? g.mines : null };
    };
    function mnStart(id, amt, count) {
      const p = P(id);
      if (!p || (mn[id] && !mn[id].over)) return;
      count = MN_COUNTS.includes(+count) ? +count : 3;
      amt = Math.floor(+amt);
      if (!(amt >= 5) || amt > maxBet(p) || !take(p, amt)) return;
      mn[id] = { amt, count, mines: GameUtil.shuffle([...Array(25).keys()]).slice(0, count), open: [], over: false, boom: -1, pay: 0 };
      out.to(id, mnView(id));
      publish();
    }
    function mnPick(id, cell) {
      const g = mn[id];
      cell = cell | 0;
      if (!g || g.over || cell < 0 || cell > 24 || g.open.includes(cell)) return;
      if (g.mines.includes(cell)) { g.over = true; g.boom = cell; out.to(id, mnView(id)); return publish(); }
      g.open.push(cell);
      if (g.open.length === 25 - g.count) return mnCash(id);
      out.to(id, mnView(id));
    }
    function mnCash(id) {
      const g = mn[id], p = P(id);
      if (!g || g.over || !g.open.length || !p) return;
      g.over = true;
      const m = mnMult(g.count, g.open.length);
      g.pay = Math.floor(g.amt * m);
      give(p, g.pay);
      if (m >= 10) note(`${p.name} cashed out ${m}× on Mines!`);
      out.to(id, mnView(id));
      publish();
    }

    function leave(id) {
      const p = P(id);
      G.players = G.players.filter((x) => x.id !== id);
      delete bj.seats[id]; delete rl.bets[id]; delete mn[id];
      cf.offers = cf.offers.filter((o) => o.from !== id && o.to !== id);
      if (bj.turn === id) bjNext();
      if (p) note(`${p.name} left the table`);
      publish();
    }
    const stop = () => { for (const t of Object.values(G.timers)) clearTimeout(t); };
    return { G, hello, adjust, bjBet, bjAct, rlBetPlace, slot, cfOffer, cfAnswer, cfCancel, crBet, crOut, plinko, mnStart, mnPick, mnCash, mnView, leave, pub, stop };
  }

  // =====================================================================
  // UI
  // =====================================================================
  let room = null, engine = null, V = null, tab = "bj", chip = 25, clocks = {};
  try { tab = sessionStorage.getItem("oxid-casino-tab") || "bj"; } catch {}
  const me = () => (V ? V.players.find((p) => p.id === room.myId) : null);
  const nm = (id) => { const p = V && V.players.find((x) => x.id === id); return p ? (p.id === room.myId ? "You" : p.name) : "?"; };
  function act(m) { if (room.isHost) hostHandle(room.myId, m); else room.send(m); }
  function hostHandle(from, m) {
    if (!engine || !m) return;
    if (m.t === "hi") engine.hello(from, m);
    else if (m.t === "adj") engine.adjust(from, m.amt, m.up);
    else if (m.t === "bj") engine.bjBet(from, m.amt);
    else if (m.t === "bja") engine.bjAct(from, m.a);
    else if (m.t === "rl") engine.rlBetPlace(from, m.k, m.amt);
    else if (m.t === "slot") engine.slot(from, m.amt);
    else if (m.t === "cf") engine.cfOffer(from, m.to, m.amt);
    else if (m.t === "cfa") engine.cfAnswer(from, m.id, !!m.yes);
    else if (m.t === "cfx") engine.cfCancel(from);
    else if (m.t === "cr") engine.crBet(from, m.amt, m.auto);
    else if (m.t === "cro") engine.crOut(from);
    else if (m.t === "plk") engine.plinko(from, m.amt, m.risk);
    else if (m.t === "mns") engine.mnStart(from, m.amt, m.count);
    else if (m.t === "mnp") engine.mnPick(from, m.cell);
    else if (m.t === "mnc") engine.mnCash(from);
  }

  function cardEl(c) {
    if (c === "??") return h("span", "pk-card back big");
    const el = h("span", "pk-card big" + (c[1] === "h" || c[1] === "d" ? " red" : ""));
    el.append(h("b", "", c[0] === "T" ? "10" : c[0]), h("i", "", SUIT_CH[c[1]]));
    return el;
  }

  function renderWallet() {
    $("coins").textContent = fmtC(W.coins);
    const dailyReady = W.lastDaily !== today();
    $("daily").disabled = !dailyReady;
    $("daily").textContent = dailyReady ? `🎁 Daily +${fmtC(DAILY_BASE + lvl("daily") * 150)}` : "🎁 Come back tomorrow";
    $("bail").hidden = W.coins >= 10;
    $("limit").textContent = `Max bet ${fmtC(limitFor(lvl("limit")))}`;
    document.documentElement.style.setProperty("--felt", FELTS[W.felt] || FELTS[0]);
  }

  function renderChips() {
    const box = $("chips");
    box.textContent = "";
    for (const v of [5, 25, 100, 500, 2500, 10000, 50000]) {
      if (v > limitFor(lvl("limit"))) continue;
      const b = h("button", "cs-chip c" + v + (chip === v ? " on" : ""), v >= 1000 ? v / 1000 + "K" : v);
      b.type = "button";
      b.addEventListener("click", () => { chip = v; renderChips(); render(); renderMN(); GameUtil.sfx("click"); });
      box.append(b);
    }
  }

  function clock(key, ms, el) {
    if (clocks[key]) clocks[key]();
    clocks[key] = Party.countdown(performance.now() + Math.max(0, ms), (left) => { el.textContent = left > 0 ? Math.ceil(left / 1000) + "s" : ""; });
  }

  function renderBJ() {
    const v = V.bj, mine = v.seats[room.myId];
    $("bjDealer").textContent = "";
    for (const c of v.dealer) $("bjDealer").append(cardEl(c));
    $("bjDealerTotal").textContent = v.dealer.length && !v.dealer.includes("??") ? total(v.dealer) : "";
    const seats = $("bjSeats");
    seats.textContent = "";
    for (const [idS, s] of Object.entries(v.seats)) {
      const id = +idS;
      const el = h("div", "bj-seat" + (v.turn === id ? " turn" : "") + (id === room.myId ? " me" : "") + (s.result ? " r-" + s.result : ""));
      const who = h("div", "bj-who");
      const p = V.players.find((x) => x.id === id);
      if (p) who.append(GameUtil.avatar(p, "xs"));
      who.append(h("span", p && p.gold ? "gold" : "", nm(id)), h("b", "", fmtC(s.bet)));
      const cards = h("div", "bj-cards");
      for (const c of s.hand) cards.append(cardEl(c));
      el.append(who, cards, h("div", "bj-total", s.hand.length ? String(total(s.hand)) + (s.result ? " · " + { win: `won ${fmtC(s.pay)}`, blackjack: `blackjack! ${fmtC(s.pay)}`, push: "push", bust: "bust", lose: "lost" }[s.result] + (s.pay && (s.result === "bust" || s.result === "lose") ? ` (${fmtC(s.pay)} back)` : "") : "") : "waiting…"));
      seats.append(el);
    }
    const myTurn = v.phase === "play" && v.turn === room.myId;
    $("bjActions").hidden = !myTurn;
    $("bjDouble").disabled = !(mine && mine.hand.length === 2 && W.coins >= mine.bet);
    $("bjBet").hidden = !(v.phase === "bet" && !mine);
    $("bjBet").textContent = `Bet ${fmtC(chip)}`;
    $("bjStatus").textContent = v.phase === "bet" ? (mine ? "Bet placed. Waiting for the deal…" : "Place a bet to play the next hand") : v.phase === "play" ? (myTurn ? "Your move" : v.turn != null ? `${nm(v.turn)} is playing…` : "") : "";
    clock("bj", v.ends, $("bjTimer"));
  }

  function renderRL() {
    const v = V.rl, mine = v.bets[room.myId] || [];
    const board = $("rlBoard");
    if (!board.childElementCount) {
      const nums = h("div", "rl-nums");
      const z = h("button", "rl-n green", "0"); z.type = "button"; z.dataset.k = "n0"; nums.append(z);
      for (let n = 1; n <= 36; n++) { const b = h("button", "rl-n " + (REDS.has(n) ? "red" : "black"), n); b.type = "button"; b.dataset.k = "n" + n; nums.append(b); }
      const outs = h("div", "rl-outs");
      for (const [k, d] of Object.entries(RL_BETS)) { const b = h("button", "rl-o " + k, d.label); b.type = "button"; b.dataset.k = k; outs.append(b); }
      board.append(nums, outs);
      board.addEventListener("click", (e) => {
        const b = e.target.closest("[data-k]");
        if (!b || !V || V.rl.phase !== "bet") return;
        GameUtil.sfx("click");
        act({ t: "rl", k: b.dataset.k, amt: chip });
      });
    }
    for (const b of board.querySelectorAll("[data-k]")) {
      const bet = mine.find((x) => x.k === b.dataset.k);
      b.dataset.amt = bet ? (bet.amt >= 1000 ? Math.round(bet.amt / 100) / 10 + "K" : bet.amt) : "";
      b.classList.toggle("bet", !!bet);
      b.classList.toggle("hit", !!(v.result && v.phase === "show" && ((/^n\d+$/.test(b.dataset.k) && +b.dataset.k.slice(1) === v.result.n) || (RL_BETS[b.dataset.k] && RL_BETS[b.dataset.k].wins(v.result.n)))));
    }
    const ball = $("rlBall");
    if (v.phase === "spin" && v.result && ball.dataset.spun !== String(v.result.n) + v.ends) {
      ball.dataset.spun = String(v.result.n) + v.ends;
      const idx = WHEEL.indexOf(v.result.n);
      const turns = 5 * 360 + (360 - ((idx + 0.5) / WHEEL.length) * 360);
      $("rlWheel").style.transition = "none";
      $("rlWheel").style.transform = "rotate(0deg)";
      void $("rlWheel").offsetWidth;
      $("rlWheel").style.transition = `transform ${RL_SPIN_MS - 400}ms cubic-bezier(.12,.7,.18,1)`;
      $("rlWheel").style.transform = `rotate(${turns}deg)`;
      GameUtil.sfx("tick");
    }
    const res = v.result && v.phase === "show" ? v.result : null;
    $("rlResult").textContent = res ? String(res.n) : v.phase === "spin" ? "…" : "";
    $("rlResult").className = "rl-result" + (res ? (res.n === 0 ? " green" : REDS.has(res.n) ? " red" : " black") : "");
    const staked = mine.reduce((a, x) => a + x.amt, 0);
    $("rlStatus").textContent = v.phase === "bet" ? (staked ? `You've bet ${fmtC(staked)}. Spinning soon…` : `Click the table to bet ${fmtC(chip)} per click`) : v.phase === "spin" ? "No more bets!" : res ? (res.wins[room.myId] ? `You won ${fmtC(res.wins[room.myId])}!` : staked ? "No luck this time" : `The ball landed on ${res.n}`) : "";
    clock("rl", v.phase === "bet" ? v.ends : 0, $("rlTimer"));
  }

  function renderCF() {
    const v = V.cf, list = $("cfPlayers");
    list.textContent = "";
    const others = V.players.filter((p) => p.id !== room.myId);
    if (!others.length) list.append(h("p", "cs-note", "Invite friends to this room to flip coins against them."));
    for (const p of others) {
      const row = h("div", "cf-row");
      row.append(GameUtil.avatar(p, "xs"), h("span", p.gold ? "gold" : "", p.name), h("small", "", fmtC(p.coins) + " coins"));
      const mineOffer = v.offers.find((o) => o.from === room.myId && o.to === p.id);
      const b = h("button", "btn sm " + (mineOffer ? "ghost" : "primary"), mineOffer ? "Cancel" : `Flip ${fmtC(chip)}`);
      b.type = "button";
      b.addEventListener("click", () => { GameUtil.sfx("click"); act(mineOffer ? { t: "cfx" } : { t: "cf", to: p.id, amt: chip }); });
      row.append(b);
      list.append(row);
    }
    const inc = $("cfIncoming");
    inc.textContent = "";
    for (const o of v.offers.filter((x) => x.to === room.myId)) {
      const row = h("div", "cf-offer");
      row.append(h("span", "", `${nm(o.from)} challenges you to a ${fmtC(o.amt)} coinflip`));
      const yes = h("button", "btn primary sm", "Accept"), no = h("button", "btn ghost sm", "No");
      yes.type = no.type = "button";
      yes.addEventListener("click", () => act({ t: "cfa", id: o.id, yes: true }));
      no.addEventListener("click", () => act({ t: "cfa", id: o.id, yes: false }));
      row.append(yes, no);
      inc.append(row);
    }
    const coin = $("coin");
    if (v.last && coin.dataset.n !== String(v.last.n)) {
      coin.dataset.n = String(v.last.n);
      coin.classList.remove("flip-a", "flip-b");
      void coin.offsetWidth;
      coin.classList.add(v.last.w === v.last.a ? "flip-a" : "flip-b");
      coin.querySelector(".ca").textContent = nm(v.last.a).slice(0, 10);
      coin.querySelector(".cb").textContent = nm(v.last.b).slice(0, 10);
      $("cfLast").textContent = "";
      setTimeout(() => {
        $("cfLast").textContent = `${nm(v.last.w)} won ${fmtC(v.last.amt * 2)}!`;
        if (v.last.a === room.myId || v.last.b === room.myId) GameUtil.sfx(v.last.w === room.myId ? "win" : "lose");
      }, 1800);
    }
  }

  function renderShop() {
    const box = $("shop");
    box.textContent = "";
    for (const u of UPGRADES) {
      const l = lvl(u.id), maxed = l >= u.cost.length;
      const el = h("div", "shop-item" + (maxed ? " maxed" : ""));
      el.append(h("span", "shop-i", u.icon));
      const body = h("div", "shop-body");
      body.append(h("b", "", `${u.name}${u.cost.length > 1 ? ` · lvl ${l}/${u.cost.length}` : ""}`), h("small", "", maxed ? "Maxed out" : u.desc(l)));
      el.append(body);
      const b = h("button", "btn sm " + (maxed ? "ghost" : "primary"), maxed ? "✓" : `${fmtC(u.cost[l])}`);
      b.type = "button";
      b.disabled = maxed || W.coins < u.cost[l] || !V;
      b.addEventListener("click", () => buy(u));
      el.append(b);
      box.append(el);
    }
    // table felt picker
    const felts = $("felts");
    felts.textContent = "";
    FELTS.forEach((c, i) => {
      const b = h("button", "felt-opt" + (W.felt === i ? " on" : ""));
      b.type = "button"; b.style.background = c; b.disabled = i > lvl("table");
      b.title = i > lvl("table") ? "Unlock with VIP felt" : "Use this felt";
      b.addEventListener("click", () => { W.felt = i; saveWallet(); renderWallet(); renderShop(); });
      felts.append(b);
    });
    $("stats").textContent = `Biggest balance ${fmtC(W.best)} · Won ${fmtC(W.won)} · Lost ${fmtC(W.lost)}`;
  }
  function buy(u) {
    const l = lvl(u.id);
    if (l >= u.cost.length || W.coins < u.cost[l] || !room) return;
    // Spending goes through the table so the host's balance stays in sync.
    W.coins -= u.cost[l];
    W.up[u.id] = l + 1;
    saveWallet();
    act({ t: "adj", amt: -u.cost[l], up: W.up });
    GameUtil.sfx("win");
    GameUtil.toast(`${u.icon} ${u.name} upgraded!`);
    renderWallet(); renderShop(); renderChips();
  }

  function render() {
    if (!V) return;
    for (const b of document.querySelectorAll(".cs-tab")) b.classList.toggle("on", b.dataset.tab === tab);
    for (const s of document.querySelectorAll(".cs-pane")) s.hidden = s.dataset.pane !== tab;
    renderWallet();
    renderBJ(); renderRL(); renderCF(); renderCR();
    if (tab === "shop") renderShop();
    if (tab === "crate") renderCrates();
    if (tab === "mn") renderMN();
    const list = $("people");
    list.textContent = "";
    for (const p of [...V.players].sort((a, b) => b.coins - a.coins)) {
      const row = h("div", "cs-person" + (p.id === room.myId ? " me" : ""));
      row.append(GameUtil.avatar(p, "xs"), h("span", p.gold ? "gold" : "", p.id === room.myId ? "You" : p.name), h("b", "", fmtC(p.coins)));
      list.append(row);
    }
    const log = $("log");
    log.textContent = "";
    for (const l of V.log.slice(0, 8)) log.append(h("li", "", l.t));
  }

  function onState(v) {
    const prev = V;
    V = v;
    crRecv = performance.now();
    if (prev && prev.cr.phase === "run" && v.cr.phase === "crash") {
      const b = v.cr.bets[room.myId];
      GameUtil.sfx(b && !b.out ? "boom" : "bad");
    }
    const mine = v.players.find((p) => p.id === room.myId);
    if (mine) {
      const diff = mine.coins - W.coins;
      if (diff > 0) W.won += diff; else if (diff < 0) W.lost -= diff;
      W.coins = mine.coins;
      W.best = Math.max(W.best, W.coins);
      saveWallet();
      if (W.coins >= 100000) GameUtil.achieve("whale");
    }
    if (prev && prev.bj.phase !== "show" && v.bj.phase === "show") {
      const s = v.bj.seats[room.myId];
      if (s) GameUtil.sfx(s.result === "win" || s.result === "blackjack" ? "good" : s.result === "push" ? "pop" : "bad");
      if (s && s.result === "blackjack") GameUtil.achieve("blackjack");
    }
    if (prev && prev.bj.turn !== room.myId && v.bj.turn === room.myId) GameUtil.sfx("turn");
    if (v.cf.offers.some((o) => o.to === room.myId && !(prev && prev.cf.offers.some((x) => x.id === o.id)))) { GameUtil.sfx("turn"); if (tab !== "cf") GameUtil.toast("You've been challenged to a coinflip!"); }
    render();
  }
  function onPrivate(m) {
    if (m.t === "slot") onSlot(m);
    else if (m.t === "plk") onPlinko(m);
    else if (m.t === "mn") onMines(m);
  }
  function onSlot(m) {
    const reels = [...document.querySelectorAll(".reel")];
    $("slotSpin").disabled = true;
    let k = 0;
    const iv = setInterval(() => { for (const r of reels) r.textContent = SYMS[Math.floor(Math.random() * SYMS.length)]; if (++k % 3 === 0) GameUtil.sfx("tick"); }, 70);
    reels.forEach((r, i) => setTimeout(() => { r.textContent = m.reels[i]; r.classList.add("stop"); setTimeout(() => r.classList.remove("stop"), 300); if (i === 2) { clearInterval(iv); done(); } }, 600 + i * 350));
    function done() {
      $("slotSpin").disabled = false;
      $("slotMsg").textContent = m.pay ? `You won ${fmtC(m.pay)}!` : "No win. Spin again?";
      $("slotMsg").className = "cs-msg" + (m.pay > m.bet ? " good" : "");
      GameUtil.sfx(m.pay >= m.bet * 10 ? "win" : m.pay > m.bet ? "good" : m.pay ? "pop" : "bad");
      if (m.reels.every((x) => x === "7️⃣")) GameUtil.achieve("jackpot");
    }
  }

  // ---------- Crash ----------
  let crRecv = 0, crAnim = 0;
  const crCv = $("crCanvas"), crCtx = crCv.getContext("2d");
  function crElapsed() { return V && V.cr.phase === "run" ? V.cr.el + (performance.now() - crRecv) : 0; }
  function renderCR() {
    const v = V.cr, mine = v.bets[room.myId];
    $("crHist").textContent = "";
    for (const x of v.hist) $("crHist").append(h("span", x >= 2 ? "hi" : x < 1.2 ? "lo" : "", x.toFixed(2) + "×"));
    const pl = $("crPlayers");
    pl.textContent = "";
    for (const [idS, b] of Object.entries(v.bets)) {
      const p = V.players.find((x) => x.id === +idS);
      const row = h("div", "cr-p" + (b.out ? " out" : v.phase === "crash" ? " bust" : ""));
      if (p) row.append(GameUtil.avatar(p, "xs"));
      row.append(h("span", "", nm(+idS)), h("small", "", fmtC(b.amt)), h("b", "", b.out ? `${b.out.toFixed(2)}× · +${fmtC(b.pay)}` : v.phase === "crash" ? "busted" : b.auto ? `auto ${b.auto}×` : "…"));
      pl.append(row);
    }
    $("crStatus").textContent = v.phase === "bet" ? (mine ? "You're in. Launching soon…" : Object.keys(v.bets).length ? "Place your bet before launch" : "Place a bet to start the next round") : v.phase === "run" ? (mine && !mine.out ? "Cash out before it crashes!" : "") : `Crashed at ${v.crash.toFixed(2)}×`;
    clock("cr", v.phase === "bet" ? v.ends : 0, $("crTimer"));
    crButton();
    if (v.phase === "run" && !crAnim) crAnim = requestAnimationFrame(crFrame);
    if (v.phase !== "run") crDraw();
  }
  function crButton() {
    const v = V.cr, mine = v.bets[room.myId], b = $("crBtn");
    b.classList.remove("cash");
    if (v.phase === "bet") { b.disabled = !!mine; b.textContent = mine ? `In for ${fmtC(mine.amt)}` : `Bet ${fmtC(chip)}`; }
    else if (v.phase === "run" && mine && !mine.out) { b.disabled = false; b.classList.add("cash"); b.textContent = `Cash out ${fmtC(mine.amt * crMult(crElapsed()))}`; }
    else if (mine && mine.out) { b.disabled = true; b.textContent = `Cashed out ${mine.out.toFixed(2)}×`; }
    else { b.disabled = true; b.textContent = v.phase === "run" ? "Round in progress" : "Next round soon…"; }
  }
  function crFrame() {
    crAnim = 0;
    if (!V || V.cr.phase !== "run") return;
    crDraw();
    if (tab === "cr") crButton();
    crAnim = requestAnimationFrame(crFrame);
  }
  function crDraw() {
    const W2 = crCv.width, H2 = crCv.height, v = V && V.cr;
    crCtx.clearRect(0, 0, W2, H2);
    const run = v && v.phase === "run", crashed = v && v.phase === "crash";
    const el = run ? crElapsed() : crashed ? Math.log(v.crash) / CR_K : 0;
    const m = run ? crMult(el) : crashed ? v.crash : 1;
    $("crMult").textContent = m.toFixed(2) + "×";
    $("crMult").className = "cr-mult" + (crashed ? " crashed" : run ? " live" : "");
    // axes grow with the round
    const tMax = Math.max(8000, el * 1.15), mMax = Math.max(2, m * 1.2);
    const X = (t) => 40 + (t / tMax) * (W2 - 60), Y = (x) => H2 - 30 - ((x - 1) / (mMax - 1)) * (H2 - 60);
    crCtx.strokeStyle = "rgba(255,255,255,.08)"; crCtx.lineWidth = 1; crCtx.font = "12px Geist Mono, monospace"; crCtx.fillStyle = "rgba(255,255,255,.35)";
    for (let i = 0; i <= 4; i++) { const x = 1 + ((mMax - 1) * i) / 4, y = Y(x); crCtx.beginPath(); crCtx.moveTo(40, y); crCtx.lineTo(W2 - 20, y); crCtx.stroke(); crCtx.fillText(x.toFixed(1) + "×", 2, y + 4); }
    if (!run && !crashed) return;
    const col = crashed ? "#ef4444" : getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff2e93";
    crCtx.beginPath(); crCtx.moveTo(X(0), Y(1));
    const steps = 80;
    for (let i = 1; i <= steps; i++) { const t = (el * i) / steps; crCtx.lineTo(X(t), Y(Math.exp(CR_K * t))); }
    crCtx.strokeStyle = col; crCtx.lineWidth = 4; crCtx.stroke();
    crCtx.lineTo(X(el), Y(1)); crCtx.closePath();
    crCtx.fillStyle = crashed ? "rgba(239,68,68,.15)" : "rgba(255,46,147,.15)"; crCtx.fill();
    crCtx.font = "28px serif"; crCtx.textAlign = "center"; crCtx.textBaseline = "middle";
    crCtx.fillText(crashed ? "💥" : "🚀", X(el), Y(m) - 6);
    crCtx.textAlign = "left"; crCtx.textBaseline = "alphabetic";
  }
  $("crBtn").addEventListener("click", () => {
    if (!V) return;
    const v = V.cr, mine = v.bets[room.myId];
    if (v.phase === "bet" && !mine) { const auto = parseFloat($("crAuto").value); act({ t: "cr", amt: chip, auto: auto >= 1.01 ? auto : 0 }); GameUtil.sfx("click"); }
    else if (v.phase === "run" && mine && !mine.out) { act({ t: "cro" }); GameUtil.sfx("good"); }
  });
  $("crAuto").addEventListener("keydown", (e) => e.stopPropagation());

  // ---------- Plinko ----------
  let plkRisk = "mid", plkBalls = [], plkAnim = 0;
  try { plkRisk = localStorage.getItem("oxidpvp-plinko-risk") || "mid"; } catch {}
  const pCv = $("plkCanvas"), pCtx = pCv.getContext("2d");
  const PW = pCv.width, PH = pCv.height, PSX = PW / (PLK_ROWS + 3), PY0 = 40, PGAP = (PH - 100) / PLK_ROWS;
  const plkColor = (m) => (m >= 10 ? "#ff2e93" : m >= 3 ? "#f472b6" : m >= 1.5 ? "#fb923c" : m >= 1 ? "#facc15" : "#64748b");
  function plkDraw() {
    pCtx.clearRect(0, 0, PW, PH);
    pCtx.fillStyle = "rgba(255,255,255,.75)";
    for (let i = 0; i < PLK_ROWS; i++) for (let j = 0; j < i + 3; j++) {
      pCtx.beginPath(); pCtx.arc(PW / 2 + (j - (i + 2) / 2) * PSX, PY0 + i * PGAP, 3.2, 0, Math.PI * 2); pCtx.fill();
    }
    const tbl = PLINKO[plkRisk], by = PY0 + PLK_ROWS * PGAP - 6;
    pCtx.font = "600 11px Geist, system-ui, sans-serif"; pCtx.textAlign = "center"; pCtx.textBaseline = "middle";
    tbl.forEach((m, k) => {
      const x = PW / 2 + (k - PLK_ROWS / 2) * PSX, hit = plkBalls.some((b) => b.done && b.slot === k && performance.now() - b.doneAt < 600);
      pCtx.fillStyle = plkColor(m); pCtx.globalAlpha = hit ? 1 : 0.85;
      pCtx.beginPath(); pCtx.roundRect(x - PSX / 2 + 2, by + (hit ? 4 : 0), PSX - 4, 28, 6); pCtx.fill();
      pCtx.globalAlpha = 1; pCtx.fillStyle = "#111"; pCtx.fillText(m + "×", x, by + 14 + (hit ? 4 : 0));
    });
    const now = performance.now();
    for (const b of plkBalls) {
      const T = PLK_MS - 300, u = Math.min(1, (now - b.t0) / T), seg = u * (PLK_ROWS + 1), i = Math.min(PLK_ROWS, Math.floor(seg)), f = seg - i;
      const pt = (k) => ({ x: PW / 2 + (b.path.slice(0, k).reduce((a, c) => a + c, 0) - k / 2) * PSX, y: k <= PLK_ROWS - 1 ? PY0 + k * PGAP - 12 : by + 8 });
      const a = pt(i), c = pt(Math.min(PLK_ROWS, i + 1));
      const x = a.x + (c.x - a.x) * f, y = a.y + (c.y - a.y) * f - Math.sin(f * Math.PI) * 10;
      pCtx.fillStyle = "#ff2e93"; pCtx.shadowColor = "#ff2e93"; pCtx.shadowBlur = 12;
      pCtx.beginPath(); pCtx.arc(x, y, 7, 0, Math.PI * 2); pCtx.fill(); pCtx.shadowBlur = 0;
      if (u >= 1 && !b.done) { b.done = true; b.doneAt = now; plkLanded(b); }
    }
    plkBalls = plkBalls.filter((b) => !b.done || now - b.doneAt < 700);
  }
  function plkLoop() { plkDraw(); plkAnim = plkBalls.length ? requestAnimationFrame(plkLoop) : 0; if (!plkAnim) plkDraw(); }
  function onPlinko(m) {
    plkBalls.push({ ...m, t0: performance.now(), done: false });
    GameUtil.sfx("pop");
    if (!plkAnim) plkAnim = requestAnimationFrame(plkLoop);
  }
  function plkLanded(b) {
    const mult = PLINKO[b.risk][b.slot];
    $("plkMsg").textContent = `${mult}× · ${b.pay ? "won " + fmtC(b.pay) : "no win"}`;
    $("plkMsg").className = "cs-msg" + (b.pay > b.bet ? " good" : "");
    GameUtil.sfx(mult >= 10 ? "win" : b.pay > b.bet ? "good" : "tick");
  }
  function paintRisk() { for (const b of $("plkRisk").querySelectorAll("button")) b.classList.toggle("on", b.dataset.r === plkRisk); plkDraw(); }
  for (const b of $("plkRisk").querySelectorAll("button")) b.addEventListener("click", () => { plkRisk = b.dataset.r; try { localStorage.setItem("oxidpvp-plinko-risk", plkRisk); } catch {} paintRisk(); });
  $("plkDrop").addEventListener("click", () => {
    if (!room) return;
    if (W.coins < chip) { GameUtil.toast("Not enough coins for that bet"); return; }
    if (plkBalls.filter((b) => !b.done).length >= 8) return;
    act({ t: "plk", amt: chip, risk: plkRisk });
  });
  paintRisk();

  // ---------- Mines ----------
  let MN = null;
  function onMines(m) {
    const was = MN;
    MN = m.none ? null : m;
    if (MN && MN.over && was && !was.over) {
      if (MN.boom >= 0) { GameUtil.sfx("boom"); $("mnMsg").textContent = `💥 Boom! You lost ${fmtC(MN.amt)}.`; $("mnMsg").className = "cs-msg"; }
      else { GameUtil.sfx("win"); $("mnMsg").textContent = `Cashed out ${MN.mult}× · won ${fmtC(MN.pay)}!`; $("mnMsg").className = "cs-msg good"; }
    } else if (MN && !MN.over && MN.open.length && (!was || was.open.length < MN.open.length)) GameUtil.sfx("good");
    renderMN();
  }
  function renderMN() {
    const g = $("mnGrid");
    if (g.childElementCount !== 25) {
      g.textContent = "";
      for (let i = 0; i < 25; i++) { const b = h("button", "mn-c"); b.type = "button"; b.dataset.i = i; g.append(b); }
    }
    const live = MN && !MN.over;
    [...g.children].forEach((b, i) => {
      const open = MN && MN.open.includes(i), mine = MN && MN.mines && MN.mines.includes(i);
      b.className = "mn-c" + (open ? " gem" : "") + (mine ? " mine" : "") + (MN && MN.boom === i ? " boom" : "") + (MN && MN.over && !open && !mine ? " dim" : "");
      b.textContent = open ? "💎" : mine ? "💣" : "";
      b.disabled = !live || open;
    });
    const btn = $("mnBtn");
    btn.classList.toggle("cash", !!live);
    if (live) { btn.textContent = MN.open.length ? `Cash out ${fmtC(MN.amt * MN.mult)}` : "Pick a tile"; btn.disabled = !MN.open.length; }
    else { btn.textContent = `Bet ${fmtC(chip)}`; btn.disabled = false; }
    $("mnCount").disabled = !!live;
    const count = live ? MN.count : +$("mnCount").value;
    $("mnInfo").textContent = live ? `Now ${MN.mult}× · next tile ${MN.next}×` : `First tile pays ${mnMult(count, 1)}×`;
  }
  $("mnGrid").addEventListener("click", (e) => {
    const b = e.target.closest(".mn-c");
    if (!b || !MN || MN.over) return;
    act({ t: "mnp", cell: +b.dataset.i });
  });
  $("mnBtn").addEventListener("click", () => {
    if (!room) return;
    if (MN && !MN.over) { if (MN.open.length) act({ t: "mnc" }); return; }
    if (W.coins < chip) { GameUtil.toast("Not enough coins for that bet"); return; }
    $("mnMsg").textContent = "Find the gems, dodge the mines."; $("mnMsg").className = "cs-msg";
    act({ t: "mns", amt: chip, count: +$("mnCount").value });
  });
  $("mnCount").addEventListener("change", renderMN);
  renderMN();

  // ---------- Crates: cosmetics only ----------
  const RARITY = [{ id: "common", name: "Common", color: "#94a3b8" }, { id: "rare", name: "Rare", color: "#38bdf8" }, { id: "epic", name: "Epic", color: "#c084fc" }, { id: "legend", name: "Legendary", color: "#ff2e93" }];
  const ITEMS = [
    [{ k: "sticker:goat" }, { k: "sticker:clown" }, { k: "sticker:brain" }, { k: "sticker:ghost" }, { k: "coins:500" }, { k: "coins:1000" }],
    [{ k: "av:🦩" }, { k: "av:🧁" }, { k: "av:🍓" }, { k: "av:🦋" }, { k: "av:🌸" }, { k: "av:🍒" }, { k: "av:🪩" }, { k: "av:🐲" }, { k: "sticker:heart" }, { k: "sticker:fire" }],
    [{ k: "title:menace" }, { k: "title:goat" }, { k: "title:main" }, { k: "title:sweaty" }, { k: "frame:8" }, { k: "frame:9" }, { k: "sticker:crown" }, { k: "sticker:rocket" }],
    [{ k: "frame:10" }, { k: "frame:11" }, { k: "frame:12" }, { k: "sticker:money" }, { k: "coins:25000" }],
  ];
  const CRATES = [
    { id: "basic", name: "Pink Crate", icon: "📦", cost: 2500, w: [70, 24, 5, 1] },
    { id: "premium", name: "Neon Crate", icon: "🎁", cost: 10000, w: [38, 40, 17, 5] },
    { id: "legend", name: "Black Crate", icon: "🖤", cost: 40000, w: [0, 38, 44, 18] },
  ];
  const itemInfo = (k) => {
    const [type, v] = k.split(/:(.+)/);
    if (type === "coins") return { icon: "🪙", name: `${(+v).toLocaleString()} coins` };
    if (type === "av") return { icon: v, name: "Avatar" };
    if (type === "frame") return { icon: "🖼️", name: `${GameUtil.frames[+v].name} frame`, frame: +v };
    if (type === "title") return { icon: "🏷️", name: `“${GameUtil.titleName(v)}”` };
    if (type === "sticker") return { icon: (GameUtil.stickers().find((x) => x.id === v) || {}).e || "✨", name: "Sticker" };
    return { icon: "?", name: k };
  };
  const rollRarity = (w) => { let r = Math.random() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; } return 0; };
  let opening = false;
  function renderCrates() {
    const box = $("crates");
    box.textContent = "";
    for (const c of CRATES) {
      const el = h("div", "crate crate-" + c.id);
      el.append(h("span", "crate-i", c.icon), h("b", "", c.name));
      const odds = h("small", "", c.w.map((x, i) => (x ? `${RARITY[i].name} ${x}%` : "")).filter(Boolean).join(" · "));
      const b = h("button", "btn primary", `Open · ${fmtC(c.cost)}`);
      b.type = "button"; b.disabled = opening || W.coins < c.cost || !room;
      b.addEventListener("click", () => openCrate(c));
      el.append(odds, b);
      box.append(el);
    }
    const own = $("crateOwned");
    own.textContent = "";
    const all = ITEMS.flat().filter((x) => !x.k.startsWith("coins"));
    let n = 0;
    for (const it of all) {
      const has = GameUtil.owns(it.k), inf = itemInfo(it.k);
      if (has) n++;
      const t = h("span", "crate-own" + (has ? " has" : ""), has ? inf.icon : "❔");
      t.title = has ? inf.name : "Not found yet";
      own.append(t);
    }
    own.previousElementSibling.textContent = `Your collection · ${n} of ${all.length}`;
  }
  function openCrate(c) {
    if (opening || W.coins < c.cost || !room) return;
    opening = true;
    W.coins -= c.cost; saveWallet();
    act({ t: "adj", amt: -c.cost });
    const tier = rollRarity(c.w), pool = ITEMS[tier], prize = pool[Math.floor(Math.random() * pool.length)];
    // Build a strip of random items that lands on the prize.
    const strip = $("crateStrip");
    strip.textContent = "";
    const LAND = 38;
    for (let i = 0; i < 46; i++) {
      const it = i === LAND ? prize : ITEMS[rollRarity(c.w)][Math.floor(Math.random() * 5)] || prize;
      const r = i === LAND ? tier : ITEMS.findIndex((pl) => pl.includes(it));
      const inf = itemInfo(it.k);
      const tile = h("div", "crate-tile");
      tile.style.setProperty("--rc", RARITY[r].color);
      tile.append(h("span", "", inf.icon), h("small", "", inf.name));
      strip.append(tile);
    }
    $("crateReel").hidden = false;
    strip.style.transition = "none"; strip.style.transform = "translateX(0)";
    void strip.offsetWidth;
    const tileW = 110, reelW = $("crateReel").clientWidth;
    const target = LAND * tileW - reelW / 2 + tileW / 2 + (Math.random() - 0.5) * 60;
    strip.style.transition = "transform 4.2s cubic-bezier(.08,.6,.12,1)";
    strip.style.transform = `translateX(${-target}px)`;
    $("crateMsg").textContent = "Opening…";
    let ticks = 0;
    const tk = setInterval(() => { if (++ticks > 26) clearInterval(tk); GameUtil.sfx("tick"); }, 140);
    renderCrates();
    setTimeout(() => {
      clearInterval(tk);
      const inf = itemInfo(prize.k);
      let msg;
      if (prize.k.startsWith("coins:")) {
        const amt = +prize.k.split(":")[1];
        W.coins += amt; saveWallet(); act({ t: "adj", amt });
        msg = `🪙 ${amt.toLocaleString()} coins!`;
      } else if (GameUtil.grant(prize.k)) {
        const how = prize.k.startsWith("sticker:") ? "Send it from the 😀 button in any room." : prize.k.startsWith("title:") ? "Wear it from your profile page." : "Equip it in Settings.";
        msg = `${RARITY[tier].name}! ${inf.icon} ${inf.name}. ${how}`;
      } else {
        const back = Math.floor(c.cost * 0.4);
        W.coins += back; saveWallet(); act({ t: "adj", amt: back });
        msg = `Duplicate ${inf.icon} ${inf.name}. +${fmtC(back)} coins back.`;
      }
      $("crateMsg").textContent = msg;
      GameUtil.sfx(tier >= 2 ? "win" : "good");
      opening = false;
      renderCrates(); renderWallet();
    }, 4400);
  }

  // ---------- Richest this week ----------
  let lastPosted = -1, lastPostAt = 0;
  async function loadRichest() {
    try {
      const d = await (await fetch("/api/casino", { cache: "no-store" })).json();
      const ol = $("richest");
      ol.textContent = "";
      for (const r of d.rows.slice(0, 10)) { const li = h("li", r.name === GameUtil.myName() ? "me" : ""); li.append(h("span", "", r.name), h("b", "", fmtC(r.coins))); ol.append(li); }
      if (!d.rows.length) ol.append(h("li", "cs-note", "No one yet. Be the first!"));
    } catch {}
  }
  function postRichest() {
    const name = GameUtil.myName();
    if (!name || W.coins === lastPosted || Date.now() - lastPostAt < 25000) return;
    lastPosted = W.coins; lastPostAt = Date.now();
    fetch("/api/casino", { method: "POST", body: JSON.stringify({ name, coins: W.coins }) }).then(() => loadRichest()).catch(() => {});
  }
  loadRichest();
  setInterval(() => { postRichest(); loadRichest(); }, 30000);

  // ---------- controls ----------
  for (const b of document.querySelectorAll(".cs-tab")) b.addEventListener("click", () => {
    tab = b.dataset.tab;
    try { sessionStorage.setItem("oxid-casino-tab", tab); } catch {}
    render();
    if (tab === "shop") renderShop();
    if (tab === "crate") renderCrates();
    if (tab === "plk") plkDraw();
  });
  $("bjBet").addEventListener("click", () => { GameUtil.sfx("click"); act({ t: "bj", amt: chip }); });
  $("bjHit").addEventListener("click", () => act({ t: "bja", a: "hit" }));
  $("bjStand").addEventListener("click", () => act({ t: "bja", a: "stand" }));
  $("bjDouble").addEventListener("click", () => act({ t: "bja", a: "double" }));
  $("slotSpin").addEventListener("click", () => {
    if (W.coins < chip) { GameUtil.toast("Not enough coins for that bet"); return; }
    act({ t: "slot", amt: chip });
  });
  $("daily").addEventListener("click", () => {
    if (W.lastDaily === today() || !room) return;
    W.lastDaily = today();
    const bonus = DAILY_BASE + lvl("daily") * 150;
    W.coins += bonus;
    saveWallet();
    act({ t: "adj", amt: bonus });
    GameUtil.sfx("win");
    renderWallet();
  });
  $("bail").addEventListener("click", () => {
    if (W.coins >= 10 || !room) return;
    if (Date.now() - W.lastBail < 3600000) { GameUtil.toast(`Bailout ready in ${Math.ceil((3600000 - (Date.now() - W.lastBail)) / 60000)} min`); return; }
    W.lastBail = Date.now();
    W.coins += BAILOUT;
    saveWallet();
    act({ t: "adj", amt: BAILOUT });
    GameUtil.toast(`The house spots you ${BAILOUT} coins. Good luck!`);
  });
  $("exportBtn").addEventListener("click", async () => {
    const code = exportCode();
    $("xferCode").value = code;
    try { await navigator.clipboard.writeText(code); GameUtil.toast("Transfer code copied"); } catch {}
  });
  $("importBtn").addEventListener("click", () => {
    const code = $("xferCode").value;
    if (!code.trim()) return;
    if (!confirm("Replace the wallet on this device with the one in this code?")) return;
    if (importCode(code)) { GameUtil.toast("Wallet loaded!"); if (room) act({ t: "hi", coins: W.coins, up: W.up }); renderWallet(); renderShop(); renderChips(); }
    else GameUtil.toast("That code doesn't look right");
  });
  $("xferCode").addEventListener("keydown", (e) => e.stopPropagation());

  // Paint the roulette wheel: 37 pockets in real wheel order, 0 at the top.
  (() => {
    const seg = 360 / WHEEL.length, stops = WHEEL.map((n, i) => `${n === 0 ? "#15803d" : REDS.has(n) ? "#b91c1c" : "#18181b"} ${i * seg}deg ${(i + 1) * seg}deg`);
    $("rlWheel").style.background = `conic-gradient(${stops.join(",")})`;
    WHEEL.forEach((n, i) => {
      const t = h("i", "", n);
      t.style.transform = `rotate(${(i + 0.5) * seg}deg) translateY(-86px)`;
      $("rlWheel").append(t);
    });
  })();
  renderWallet(); renderChips();

  Room.mount({
    game: "casino",
    title: "Casino",
    subtitle: "Blackjack, roulette, slots and coinflips with play coins. Your wallet and upgrades are saved. 1 to 8 players, drop in any time.",
    min: 1,
    max: 8,
    lateJoin: true,
    onStart(r) {
      room = r; V = null;
      if (r.isHost) {
        const out = {
          all: (m) => { r.broadcast(m); onState(m); },
          to: (id, m) => (id === r.myId ? onPrivate(m) : r.sendTo(id, m)),
        };
        engine = createEngine(r, out);
        r.onData((from, m) => hostHandle(from, m));
        r.onLeave((id) => engine.leave(id));
        r.onRejoin((id) => { r.sendTo(id, engine.pub()); r.sendTo(id, engine.mnView(id)); });
        r.onJoin(() => {});
        setTimeout(() => engine && engine.hello(r.myId, { coins: W.coins, up: W.up }), 100);
      } else {
        r.onData((_, m) => {
          if (!m) return;
          if (m.t === "st") onState(m);
          else onPrivate(m);
        });
        setTimeout(() => r.send({ t: "hi", coins: W.coins, up: W.up }), 200);
      }
      postRichest();
      return () => { if (engine) engine.stop(); for (const c of Object.values(clocks)) c(); room = null; engine = null; V = null; MN = null; };
    },
  });
})();
