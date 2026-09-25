// Daily Chess: one "mate in one" a day, the same for everyone. Find the move that checkmates.
// Puzzles come from js/chess-puzzles.js (each has exactly one mating move); chess.js checks
// your answer, so any move that mates is accepted.
import { Chess } from "../vendor/chess.js";

const KEY = "oxidpvp-chesspuzzle";
const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const FILES = "abcdefgh";
const $ = (id) => document.getElementById(id);
const now = new Date();
const day = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(2026, 0, 1)) / 864e5);
const list = window.CHESS_PUZZLES;
const [fen] = list[((day * 37) % list.length + list.length) % list.length];

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const D = { streak: 0, best: 0, solved: 0, lastWin: -9, ...load() };
if (D.day !== day) { D.day = day; D.tries = 0; D.done = false; D.move = null; }
if (D.lastWin < day - 1 && !D.done) D.streak = 0;
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(D)); } catch {} };
save();

const ch = new Chess(fen);
const side = ch.turn();
let sel = null, targets = [], flash = null;
if (D.done && D.lastMove) { try { ch.move({ ...D.lastMove, promotion: "q" }); } catch {} }

function squareAt(r, c) { return side === "w" ? FILES[c] + (8 - r) : FILES[7 - c] + (r + 1); }
function render() {
  const board = $("board");
  board.textContent = "";
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const sq = squareAt(r, c), p = ch.get(sq), fi = FILES.indexOf(sq[0]), rank = +sq[1];
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "sq-c " + ((fi + rank) % 2 ? "dark" : "light") + (sel === sq ? " sel" : "") + (flash && flash.includes(sq) ? " bad" : "");
    const t = targets.find((m) => m.to === sq);
    if (t) cell.classList.add(t.captured ? "cap" : "dot");
    if (D.done && D.lastMove && (D.lastMove.from === sq || D.lastMove.to === sq)) cell.classList.add("last");
    if (p) { const s = document.createElement("span"); s.className = "pc " + p.color; s.textContent = GLYPH[p.type]; cell.append(s); }
    cell.addEventListener("click", () => click(sq));
    board.append(cell);
  }
  $("who").textContent = D.done ? "Checkmate! 🎉" : `${side === "w" ? "White" : "Black"} to move. Find mate in one.`;
  $("tries").textContent = D.done ? `Solved${D.tries ? ` after ${D.tries} wrong ${D.tries === 1 ? "try" : "tries"}` : " first try!"}` : D.tries ? `Wrong tries: ${D.tries}` : "";
  $("streak").textContent = `Streak ${D.streak}🔥 · best ${D.best} · solved ${D.solved}`;
  $("done").hidden = !D.done;
}
function click(sq) {
  if (D.done) return;
  const t = targets.find((m) => m.to === sq);
  if (sel && t) return attempt(t);
  const p = ch.get(sq);
  if (p && p.color === side) { sel = sq; targets = ch.moves({ square: sq, verbose: true }); GameUtil.sfx("click"); }
  else { sel = null; targets = []; }
  render();
}
function attempt(m) {
  sel = null; targets = [];
  ch.move({ from: m.from, to: m.to, promotion: "q" });
  if (ch.isCheckmate()) {
    D.done = true; D.move = m.lan || m.from + m.to; D.lastMove = { from: m.from, to: m.to };
    D.solved++;
    D.streak = D.lastWin === day - 1 ? D.streak + 1 : 1;
    D.lastWin = day; D.best = Math.max(D.best, D.streak);
    save();
    GameUtil.sfx("win");
    GameUtil.dailySolved();
    GameUtil.achieve("puzzle");
    render();
    return;
  }
  // Not mate: show it briefly, then take it back.
  D.tries++;
  save();
  flash = [m.from, m.to];
  GameUtil.sfx("bad");
  render();
  setTimeout(() => { ch.undo(); flash = null; render(); }, 700);
}
render();
