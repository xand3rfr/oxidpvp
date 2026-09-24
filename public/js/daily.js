// Daily Word: one five-letter word a day, the same for everyone. Six guesses; green means right
// letter in the right spot, yellow means it's in the word somewhere else. Your streak, stats
// and today's progress are saved on this device.
(() => {
  const WORDS = (
    "about above actor adapt admit adopt adult after again agent agree ahead alarm album alert alien align alive allow alone along alter amber among angel anger angle angry apart apple apply arena argue arise armor array arrow aside asset audio avoid awake award aware bacon badge basic beach beast began begin being below bench berry birth black blade blame blank blast blaze blend bless blind block bloom board boost booth brain brand brave bread break brick bride brief bring broad brown brush build bunch burst buyer cabin cable camel candy cargo carry catch cause chain chair chalk charm chart chase cheap check cheek chess chest chief child chill choir civil claim class clean clear click cliff climb clock close cloud coach coast color comet coral count court cover craft crane crash crazy cream crime crisp cross crowd crown cruel crush curve cycle daily dance dealt death delay depth devil diary dirty dizzy doubt dough draft drain drama dream dress drift drink drive eager eagle early earth eight elbow elder elite empty enemy enjoy enter entry equal error event every exact extra fable faint faith false fancy feast fence ferry fever field fiery fifth fifty fight final flame flash fleet flesh float flock flood floor flour fluid flute focus force forge forth forty found frame fresh front frost fruit funny giant given glass globe glory glove goose grace grade grain grand grape graph grass great green greet grill grind group grove guard guess guest guide habit happy harsh haven heart heavy hello hinge hobby honey honor horse hotel house human humor hurry ideal image index inner input irony issue ivory jelly jewel joint judge juice jumbo karma kayak kneel knife knock label laser later laugh layer learn lemon level light limit linen liver llama lobby local logic loose lucky lunar lunch magic major maker mango manor maple march match mayor medal media melon mercy merit metal meter minor mixer model money month moral motor mound mount mouse mouth movie music naval nerve never night ninja noble noise north novel nurse ocean offer often olive onion opera orbit order organ other otter outer owner oxide paint panel panic paper party pasta patch pause peace peach pearl penny phase phone photo piano piece pilot pinch pixel pizza place plain plane plant plate plaza point polar porch pound power press price pride prime print prize proof proud prune pulse punch pupil puppy purse queen quest quick quiet quilt quota quote radar radio raise rally ranch range rapid raven reach react ready realm rebel relax reply rider ridge rifle right rival river roast robin robot rocky rogue round route royal rugby ruler rumor rural salad sauce scale scare scarf scene scent scoop score scout screw seize sense serve seven shade shake shape share shark sharp sheep shelf shell shift shine shirt shock shore short shout sight silly since skate skill skirt skull slate sleep slice slide slope smart smile smoke snack snake solar solid solve sound south space spare spark speak speed spell spend spice spike spine spoon sport spray squad stack staff stage stair stamp stand start state steak steam steel stick still stone storm story stove straw strip stuck study style sugar sunny super swamp sweet swift swing sword table taste teach tempo thank theme thick thing think third thumb tiger toast token topic torch total touch tower toxic track trade trail train treat trend trial tribe trick truck truly trust truth tulip twist ultra uncle under unity upper upset urban usual valid value vapor vault venue verse video vital vivid vocal voice waste watch water whale wheat wheel while whole witch woman world worry worth wound wrist yacht young youth zebra"
  ).split(" ");
  const KEY = "oxidpvp-daily", TRIES = 6, LEN = 5;
  const $ = (id) => document.getElementById(id);

  const now = new Date();
  const day = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(2026, 0, 1)) / 864e5);
  const answer = WORDS[(((day * 97 + 13) % WORDS.length) + WORDS.length) % WORDS.length].toUpperCase();
  const num = day + 1;

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(D)); } catch {} };
  const D = { streak: 0, best: 0, played: 0, wins: 0, dist: [0, 0, 0, 0, 0, 0], lastWin: -9, ...load() };
  if (D.day !== day) { D.day = day; D.guesses = []; D.done = false; D.won = false; }
  if (D.lastWin < day - 1 && !(D.day === day && D.won)) D.streak = 0; // missed a day
  save();

  let cur = "";

  function score(guess) {
    const res = Array(LEN).fill("x"), pool = {};
    for (let i = 0; i < LEN; i++) {
      if (guess[i] === answer[i]) res[i] = "g";
      else pool[answer[i]] = (pool[answer[i]] || 0) + 1;
    }
    for (let i = 0; i < LEN; i++) {
      if (res[i] === "g") continue;
      if (pool[guess[i]]) { res[i] = "y"; pool[guess[i]]--; }
    }
    return res;
  }

  function render(revealRow = -1) {
    const grid = $("grid");
    grid.textContent = "";
    for (let r = 0; r < TRIES; r++) {
      const row = document.createElement("div");
      row.className = "dw-row";
      const g = D.guesses[r], res = g ? score(g) : null;
      for (let c = 0; c < LEN; c++) {
        const t = document.createElement("span");
        const ch = g ? g[c] : r === D.guesses.length ? cur[c] || "" : "";
        t.className = "dw-tile" + (res ? " " + res[c] : ch ? " typed" : "") + (r === revealRow ? " flip" : "");
        if (r === revealRow) t.style.animationDelay = c * 0.12 + "s";
        t.textContent = ch;
        row.append(t);
      }
      grid.append(row);
    }
    // keyboard colors
    const best = {};
    const rank = { g: 3, y: 2, x: 1 };
    for (const g of D.guesses) score(g).forEach((r, i) => { if ((rank[r] || 0) > (rank[best[g[i]]] || 0)) best[g[i]] = r; });
    for (const b of document.querySelectorAll(".dw-key[data-k]")) {
      const k = b.dataset.k;
      b.className = "dw-key" + (k.length > 1 ? " wide" : "") + (best[k] ? " " + best[k] : "");
    }
    $("num").textContent = `#${num}`;
    $("stats").innerHTML = "";
    const stat = (n, l) => { const el = document.createElement("div"); el.innerHTML = `<b></b><span></span>`; el.querySelector("b").textContent = n; el.querySelector("span").textContent = l; $("stats").append(el); };
    stat(D.played, "played");
    stat(D.played ? Math.round((D.wins / D.played) * 100) + "%" : "–", "win rate");
    stat(D.streak, "streak");
    stat(D.best, "best");
    $("done").hidden = !D.done;
    if (D.done) {
      $("doneTitle").textContent = D.won ? ["Genius!", "Magnificent!", "Impressive!", "Splendid!", "Great!", "Phew!"][D.guesses.length - 1] : `The word was ${answer}`;
      $("doneSub").textContent = D.won ? `Solved in ${D.guesses.length}/${TRIES}. New word tomorrow.` : "Your streak resets. Try again tomorrow!";
    }
  }

  function toast(m) { if (window.GameUtil) GameUtil.toast(m); }
  function sfx(n) { if (window.GameUtil) GameUtil.sfx(n); }

  function submit() {
    if (D.done) return;
    if (cur.length < LEN) { shake(); toast("Not enough letters"); return; }
    D.guesses.push(cur);
    const won = cur === answer;
    cur = "";
    if (won || D.guesses.length >= TRIES) {
      D.done = true; D.won = won; D.played++;
      if (won) {
        D.wins++; D.dist[D.guesses.length - 1]++;
        D.streak = D.lastWin === day - 1 ? D.streak + 1 : 1;
        D.lastWin = day;
        D.best = Math.max(D.best, D.streak);
      } else D.streak = 0;
    }
    save();
    render(D.guesses.length - 1);
    sfx(won ? "win" : D.done ? "lose" : "pop");
    if (won && window.GameUtil) { GameUtil.achieve("daily"); if (D.streak >= 7) GameUtil.achieve("daily7"); }
  }
  function shake() { const row = $("grid").children[D.guesses.length]; if (row) { row.classList.remove("shake"); void row.offsetWidth; row.classList.add("shake"); } }
  function type(k) {
    if (D.done) return;
    if (k === "ENTER") return submit();
    if (k === "⌫" || k === "BACKSPACE") { cur = cur.slice(0, -1); return render(); }
    if (/^[A-Z]$/.test(k) && cur.length < LEN) { cur += k; sfx("click"); render(); }
  }

  // on-screen keyboard (works with touch)
  for (const row of ["QWERTYUIOP", "ASDFGHJKL", "↵ZXCVBNM⌫"]) {
    const r = document.createElement("div");
    r.className = "dw-krow";
    for (const ch of row) {
      const b = document.createElement("button");
      b.type = "button";
      const k = ch === "↵" ? "ENTER" : ch;
      b.dataset.k = k;
      b.className = "dw-key" + (k.length > 1 ? " wide" : "");
      b.textContent = ch === "↵" ? "Enter" : ch;
      b.addEventListener("click", () => type(k));
      r.append(b);
    }
    $("keys").append(r);
  }
  addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.tagName === "INPUT") return;
    const k = e.key.toUpperCase();
    if (k === "ENTER" || k === "BACKSPACE" || /^[A-Z]$/.test(k)) { e.preventDefault(); type(k); }
  });

  $("share").addEventListener("click", async () => {
    const rows = D.guesses.map((g) => score(g).map((r) => (r === "g" ? "🟩" : r === "y" ? "🟨" : "⬛")).join(""));
    const text = `OXIDPVP Daily Word #${num} ${D.won ? D.guesses.length : "X"}/${TRIES}\n${rows.join("\n")}\n${location.origin}/daily`;
    try { await navigator.clipboard.writeText(text); toast("Copied! Paste it to your friends."); }
    catch { toast("Couldn't copy on this device"); }
  });

  // countdown to the next word
  const tick = () => {
    const t = new Date(), next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    const s = Math.max(0, Math.floor((next - t) / 1000));
    $("next").textContent = `Next word in ${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  tick(); setInterval(tick, 1000);
  render();
})();
