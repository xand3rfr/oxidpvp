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
