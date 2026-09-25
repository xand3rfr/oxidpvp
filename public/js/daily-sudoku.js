// Daily Sudoku: one puzzle a day, the same for everyone (generated from the date, with a unique
// solution). Tap a cell, then a number. Wrong numbers turn red. Progress and streak are saved
// on this device.
(() => {
  const KEY = "oxidpvp-sudoku";
  const $ = (id) => document.getElementById(id);
  const now = new Date();
  const day = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(2026, 0, 1)) / 864e5);

  function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const box = (i) => Math.floor(Math.floor(i / 9) / 3) * 3 + Math.floor((i % 9) / 3);
  const peersOk = (g, i, v) => {
    const r = Math.floor(i / 9), c = i % 9, b = box(i);
    for (let k = 0; k < 81; k++) if (k !== i && g[k] === v && (Math.floor(k / 9) === r || k % 9 === c || box(k) === b)) return false;
    return true;
  };
  // Count solutions up to `limit` (1 fills g in place when order is given).
  function solve(g, limit, order) {
    let count = 0;
    const rec = () => {
      let best = -1, bestOpts = null;
      for (let i = 0; i < 81; i++) {
        if (g[i]) continue;
        const opts = [];
        for (let v = 1; v <= 9; v++) if (peersOk(g, i, v)) opts.push(v);
        if (!opts.length) return false;
        if (!bestOpts || opts.length < bestOpts.length) { best = i; bestOpts = opts; if (opts.length === 1) break; }
      }
      if (best < 0) { count++; return count >= limit; }
      const vals = order ? order(bestOpts) : bestOpts;
      for (const v of vals) { g[best] = v; if (rec()) return true; }
      g[best] = 0;
      return false;
    };
    rec();
    return count;
  }
  function generate(seed) {
    const R = rng(seed);
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const sol = new Array(81).fill(0);
    solve(sol, 1, (opts) => shuffle(opts.slice()));
    const puz = sol.slice();
    const target = 30 + Math.floor(R() * 5); // clues left: 30–34
    let clues = 81;
    for (const i of shuffle([...Array(81).keys()])) {
      if (clues <= target) break;
      const keep = puz[i];
      puz[i] = 0;
      if (solve(puz.slice(), 2) !== 1) puz[i] = keep; else clues--;
    }
    return { puz, sol };
  }

  const { puz, sol } = generate(day * 2654435761 + 99);
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const D = { streak: 0, best: 0, solved: 0, lastWin: -9, ...load() };
  if (D.day !== day) { D.day = day; D.grid = puz.slice(); D.done = false; D.secs = 0; D.mistakes = 0; }
  if (D.lastWin < day - 1 && !D.done) D.streak = 0;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(D)); } catch {} };
  save();

  let sel = D.grid.findIndex((v, i) => !puz[i] && !v);
  if (sel < 0) sel = 0;

  function render() {
    const g = $("grid");
    g.textContent = "";
    const sv = D.grid[sel];
    for (let i = 0; i < 81; i++) {
      const v = D.grid[i];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sd-cell" + (puz[i] ? " given" : "") + (i === sel ? " sel" : "") +
        (!puz[i] && v && v !== sol[i] ? " wrong" : "") +
        (sv && v === sv ? " same" : "") +
        (i !== sel && (Math.floor(i / 9) === Math.floor(sel / 9) || i % 9 === sel % 9 || box(i) === box(sel)) ? " peer" : "") +
        (i % 9 === 2 || i % 9 === 5 ? " br" : "") + (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5 ? " bb" : "");
      b.textContent = v || "";
      b.addEventListener("click", () => { sel = i; render(); });
      g.append(b);
    }
    const left = D.grid.filter((v, i) => v !== sol[i]).length;
    $("info").textContent = D.done ? `Solved in ${fmt(D.secs)} with ${D.mistakes} mistake${D.mistakes === 1 ? "" : "s"}!` : `${left} to go · mistakes: ${D.mistakes}`;
    $("streak").textContent = `Streak ${D.streak}🔥 · best ${D.best} · solved ${D.solved}`;
    // grey out numbers that are all placed
    for (const b of document.querySelectorAll(".sd-pad [data-n]")) {
      const n = +b.dataset.n;
      b.classList.toggle("full", D.grid.filter((v, i) => v === n && v === sol[i]).length === 9);
    }
    $("done").hidden = !D.done;
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  function put(n) {
    if (D.done || puz[sel]) return;
    if (n && D.grid[sel] !== n && n !== sol[sel]) { D.mistakes++; GameUtil.sfx("bad"); } else if (n) GameUtil.sfx("click");
    D.grid[sel] = n;
    if (D.grid.every((v, i) => v === sol[i])) {
      D.done = true; D.solved++;
      D.streak = D.lastWin === day - 1 ? D.streak + 1 : 1;
      D.lastWin = day; D.best = Math.max(D.best, D.streak);
      GameUtil.sfx("win");
      GameUtil.achieve("sudoku");
    }
    save();
    render();
  }

  for (let n = 1; n <= 9; n++) {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.n = n; b.textContent = n;
    b.addEventListener("click", () => put(n));
    $("pad").append(b);
  }
  const er = document.createElement("button");
  er.type = "button"; er.textContent = "⌫"; er.className = "erase"; er.setAttribute("aria-label", "Erase");
  er.addEventListener("click", () => put(0));
  $("pad").append(er);

  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (/^[1-9]$/.test(e.key)) put(+e.key);
    else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") put(0);
    else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const r = Math.floor(sel / 9), c = sel % 9;
      if (e.key === "ArrowUp") sel = ((r + 8) % 9) * 9 + c;
      if (e.key === "ArrowDown") sel = ((r + 1) % 9) * 9 + c;
      if (e.key === "ArrowLeft") sel = r * 9 + (c + 8) % 9;
      if (e.key === "ArrowRight") sel = r * 9 + (c + 1) % 9;
      render();
    }
  });
  setInterval(() => { if (!D.done && !document.hidden) { D.secs++; if (D.secs % 5 === 0) save(); $("time").textContent = fmt(D.secs); } }, 1000);
  $("time").textContent = fmt(D.secs);
  render();
})();
