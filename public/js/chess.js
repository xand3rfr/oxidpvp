// Chess, 1v1 with 10-minute clocks. Rules come from chess.js (public/vendor, BSD-2-Clause).
// The host keeps the real game (with full history for repetition draws) and the clocks; the
// guest sends moves and gets the new position back. Spectators watch from the guest's side.
import { Chess } from "../vendor/chess.js";

const START_MS = 10 * 60 * 1000;
const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const FILES = "abcdefgh";
const $ = (id) => document.getElementById(id);
const { h, results, hideResults } = Party;

// =====================================================================
// Host: the authoritative game
// =====================================================================
function createGame(send) {
  const S = { chess: new Chess(), hostColor: "w", clocks: { w: START_MS, b: START_MS }, turnStart: 0, last: null, over: null, drawOffer: null, n: 1, timer: 0 };

  function tickClock() {
    if (S.over || !S.turnStart) return;
    const t = S.chess.turn();
    const left = S.clocks[t] - (Date.now() - S.turnStart);
    if (left <= 0) {
      S.clocks[t] = 0;
      // Flag fall is a draw if the other side can't possibly mate.
      const other = t === "w" ? "b" : "w";
      const material = S.chess.board().flat().filter((p) => p && p.color === other && p.type !== "k");
      const canMate = material.some((p) => p.type !== "b" && p.type !== "n") || material.length > 1;
      finish(canMate ? other : "d", "on time");
    }
  }
  function state() {
    const now = Date.now();
    const t = S.chess.turn();
    const clocks = { ...S.clocks };
    if (S.turnStart && !S.over) clocks[t] = Math.max(0, clocks[t] - (now - S.turnStart));
    return {
      t: "st", fen: S.chess.fen(), last: S.last, clocks, running: S.turnStart && !S.over ? t : null,
      over: S.over, san: S.chess.history(), hostColor: S.hostColor, drawOffer: S.drawOffer, n: S.n, check: S.chess.inCheck(),
    };
  }
  const publish = () => send(state());

  function move(color, from, to, promo) {
    if (S.over || S.chess.turn() !== color) return false;
    let m;
    try { m = S.chess.move({ from, to, promotion: promo || "q" }); } catch { return false; }
    const now = Date.now();
    if (S.turnStart) S.clocks[color] = Math.max(0, S.clocks[color] - (now - S.turnStart));
    // Clocks start once White has made a move.
    S.turnStart = now;
    S.last = { from: m.from, to: m.to };
    S.drawOffer = null;
    if (S.chess.isCheckmate()) finish(color, "by checkmate");
    else if (S.chess.isStalemate()) finish("d", "by stalemate");
    else if (S.chess.isThreefoldRepetition()) finish("d", "by repetition");
    else if (S.chess.isInsufficientMaterial()) finish("d", "by insufficient material");
    else if (S.chess.isDrawByFiftyMoves()) finish("d", "by the 50-move rule");
    publish();
    return true;
  }
  function finish(result, reason) {
    const now = Date.now();
    if (S.turnStart && !S.over) { const t = S.chess.turn(); S.clocks[t] = Math.max(0, S.clocks[t] - (now - S.turnStart)); }
    S.over = { result, reason };
    S.turnStart = 0;
    publish();
  }
  function resign(color) { if (!S.over) finish(color === "w" ? "b" : "w", "by resignation"); }
  function offerDraw(color) {
    if (S.over) return;
    if (S.drawOffer && S.drawOffer !== color) return finish("d", "by agreement");
    S.drawOffer = color;
    publish();
  }
  function rematch() {
    S.chess = new Chess();
    S.hostColor = S.hostColor === "w" ? "b" : "w";
    S.clocks = { w: START_MS, b: START_MS };
    S.turnStart = 0; S.last = null; S.over = null; S.drawOffer = null; S.n++;
    publish();
  }
  S.timer = setInterval(tickClock, 200);
  return { S, move, resign, offerDraw, rematch, publish, stop: () => clearInterval(S.timer) };
}

// =====================================================================
// UI
// =====================================================================
let link = null, game = null, V = null, local = new Chess(), myColor = "w", sel = null, targets = [], gotAt = 0, clockRaf = 0, pendingPromo = null;
const boardEl = $("board");

const squareAt = (r, c) => {
  // r/c are screen rows/cols; flip for Black.
  const file = myColor === "w" ? c : 7 - c;
  const rank = myColor === "w" ? 8 - r : r + 1;
  return FILES[file] + rank;
};

function render() {
  boardEl.textContent = "";
  const pos = local.board(); // pos[0] is rank 8
  const myTurn = V && !V.over && !link.spectator && local.turn() === myColor;
  boardEl.classList.toggle("live", !!myTurn);
  let kingSq = null;
  if (V && V.check) {
    for (const row of pos) for (const p of row) if (p && p.type === "k" && p.color === local.turn()) kingSq = p.square;
  }
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = squareAt(r, c);
      const fi = FILES.indexOf(sq[0]), rank = +sq[1];
      const piece = pos[8 - rank][fi];
      const cell = h("button", "sq-c " + ((fi + rank) % 2 ? "dark" : "light"));
      cell.type = "button";
      cell.dataset.sq = sq;
      if (V && V.last && (V.last.from === sq || V.last.to === sq)) cell.classList.add("last");
      if (sel === sq) cell.classList.add("sel");
      if (kingSq === sq) cell.classList.add("check");
      const t = targets.find((m) => m.to === sq);
      if (t) cell.classList.add(t.captured ? "cap" : "dot");
      if (piece) {
        const pc = h("span", "pc " + piece.color, GLYPH[piece.type]);
        cell.append(pc);
      }
      if (c === 0) cell.append(h("span", "coord rank", rank));
      if (r === 7) cell.append(h("span", "coord file", sq[0]));
      boardEl.append(cell);
    }
  }
}

boardEl.addEventListener("click", (e) => {
  const cell = e.target.closest(".sq-c");
  if (!cell || !V || V.over || !link || link.spectator || local.turn() !== myColor) return;
  const sq = cell.dataset.sq;
  const t = targets.find((m) => m.to === sq);
  if (sel && t) {
    const promos = targets.filter((m) => m.to === sq && m.promotion);
    if (promos.length) { pendingPromo = { from: sel, to: sq }; showPromo(); return; }
    return doMove(sel, sq);
  }
  const p = local.get(sq);
  if (p && p.color === myColor) {
    sel = sq;
    targets = local.moves({ square: sq, verbose: true });
    GameUtil.sfx("click");
  } else { sel = null; targets = []; }
  render();
});

function showPromo() {
  const box = $("promo");
  box.textContent = "";
  for (const t of ["q", "r", "b", "n"]) {
    const b = h("button", "pc " + myColor, GLYPH[t]);
    b.type = "button";
    b.addEventListener("click", () => { box.hidden = true; doMove(pendingPromo.from, pendingPromo.to, t); pendingPromo = null; });
    box.append(b);
  }
  box.hidden = false;
}

function doMove(from, to, promo) {
  // Show it right away; the host's reply confirms (or corrects) it.
  try { local.move({ from, to, promotion: promo || "q" }); } catch { return; }
  sel = null; targets = [];
  V = { ...V, last: { from, to } };
  render();
  GameUtil.sfx("pop");
  if (link.isHost) game.move(myColor, from, to, promo);
  else link.send({ t: "mv", from, to, promo: promo || "q" });
}

function paintClocks() {
  cancelAnimationFrame(clockRaf);
  if (!V) return;
  const tick = () => {
    const since = performance.now() - gotAt;
    for (const [color, el] of [[myColor, $("clockMe")], [myColor === "w" ? "b" : "w", $("clockOpp")]]) {
      let ms = V.clocks[color];
      if (V.running === color) ms = Math.max(0, ms - since);
      const s = Math.ceil(ms / 1000);
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      el.parentElement.classList.toggle("running", V.running === color);
      el.parentElement.classList.toggle("low", ms < 30000);
    }
    if (V.running) clockRaf = requestAnimationFrame(tick);
  };
  tick();
}

function material() {
  const count = { w: 0, b: 0 };
  for (const row of local.board()) for (const p of row) if (p) count[p.color] += VALUE[p.type];
  return count;
}

function onState(s) {
  const prev = V;
  V = s;
  gotAt = performance.now();
  const hostColor = s.hostColor;
  myColor = link.isHost ? hostColor : hostColor === "w" ? "b" : "w";
  local = new Chess(s.fen);
  if (prev && prev.n !== s.n) { sel = null; targets = []; }
  if (sel && (local.turn() !== myColor || !local.get(sel))) { sel = null; targets = []; }
  render();

  const names = { [hostColor]: link.isHost ? link.myName : link.oppName, [hostColor === "w" ? "b" : "w"]: link.isHost ? link.oppName : link.myName };
  const oppColor = myColor === "w" ? "b" : "w";
  $("nameMe").textContent = (link.spectator ? names[myColor] : "You") + (myColor === "w" ? " · White" : " · Black");
  $("nameOpp").textContent = names[oppColor] + (oppColor === "w" ? " · White" : " · Black");
  const mat = material();
  const diff = mat[myColor] - mat[oppColor];
  $("matMe").textContent = diff > 0 ? "+" + diff : "";
  $("matOpp").textContent = diff < 0 ? "+" + -diff : "";

  // move list
  const list = $("moves");
  list.textContent = "";
  for (let i = 0; i < s.san.length; i += 2) {
    const li = h("li");
    li.append(h("span", "mn", i / 2 + 1 + "."), h("span", "", s.san[i]), h("span", "", s.san[i + 1] || ""));
    list.append(li);
  }
  list.scrollTop = list.scrollHeight;

  // status
  const turnName = local.turn() === myColor ? (link.spectator ? names[myColor] : "Your") : names[local.turn()];
  $("status").textContent = s.over ? "" : `${turnName}${turnName === "Your" ? "" : "'s"} move${s.check ? " · check!" : ""}`;
  $("drawBanner").hidden = !(s.drawOffer && s.drawOffer !== myColor && !s.over && !link.spectator);
  $("offerDraw").disabled = !!s.over || s.drawOffer === myColor;
  $("offerDraw").textContent = s.drawOffer === myColor ? "Draw offered" : "Offer draw";
  $("resign").disabled = !!s.over;
  $("actions").hidden = link.spectator;
  paintClocks();

  if (prev && prev.san.length !== s.san.length) {
    const opp = local.turn() === myColor;
    if (s.check) GameUtil.sfx("bad");
    else if (opp) GameUtil.sfx("pop");
    if (opp && !s.over) setTimeout(() => GameUtil.sfx("turn"), 150);
  }
  if (s.over && (!prev || !prev.over || prev.n !== s.n)) {
    const r = s.over.result;
    const winnerName = r === "d" ? null : names[r];
    const won = r === myColor;
    if (!link.spectator) { GameUtil.sfx(r === "d" ? "pop" : won ? "win" : "lose"); GameUtil.record("chess", r === "d" ? "draw" : won ? "win" : "loss"); }
    setTimeout(() => {
      $("resultTitle").textContent = r === "d" ? "Draw" : link.spectator ? `${winnerName} wins` : won ? "You win" : "You lose";
      $("resultScore").textContent = (r === "d" ? "Draw " : "") + s.over.reason;
      $("rematch").hidden = link.spectator;
      $("rematch").disabled = false; $("rematch").textContent = "Rematch";
      $("result").hidden = false;
    }, 700);
  } else if (!s.over) $("result").hidden = true;
}

$("resign").addEventListener("click", () => {
  if (!V || V.over) return;
  const b = $("resign");
  if (b.dataset.armed) {
    delete b.dataset.armed; b.textContent = "Resign";
    if (link.isHost) game.resign(myColor); else link.send({ t: "resign" });
  } else {
    b.dataset.armed = "1"; b.textContent = "Tap again to resign";
    setTimeout(() => { delete b.dataset.armed; b.textContent = "Resign"; }, 3000);
  }
});
$("offerDraw").addEventListener("click", () => { if (link.isHost) game.offerDraw(myColor); else link.send({ t: "draw" }); });
$("acceptDraw").addEventListener("click", () => { if (link.isHost) game.offerDraw(myColor); else link.send({ t: "draw" }); });
$("rematch").addEventListener("click", () => {
  if (!link) return;
  if (link.isHost) game.rematch();
  else { link.send({ t: "rm" }); $("rematch").disabled = true; $("rematch").textContent = "Waiting for host…"; }
});
$("peek").addEventListener("click", () => { $("result").hidden = true; });

render();

Lobby.mount({
  game: "chess",
  title: "Chess",
  subtitle: "Classic chess with 10-minute clocks. Colors swap every game.",
  onStart(l) {
    link = l; V = null; sel = null; targets = [];
    if (l.isHost) {
      game = createGame((m) => { l.send(m); onState(m); });
      l.onData((d) => {
        const guestColor = game.S.hostColor === "w" ? "b" : "w";
        if (d.t === "mv") { if (!game.move(guestColor, String(d.from), String(d.to), String(d.promo || "q"))) game.publish(); }
        else if (d.t === "resign") game.resign(guestColor);
        else if (d.t === "draw") game.offerDraw(guestColor);
        else if (d.t === "rm" && game.S.over) game.rematch();
      });
      l.onRejoin(() => game.publish());
      game.publish();
    } else l.onData((d) => { if (d.t === "st") onState(d); });
    if (!l.spectator) GameUtil.toast(l.isHost ? "You're White. Good luck!" : "You're Black. Good luck!");
    return () => {
      if (game) game.stop();
      cancelAnimationFrame(clockRaf);
      link = null; game = null; V = null; local = new Chess(); sel = null; targets = [];
      $("result").hidden = true;
      render();
    };
  },
});
