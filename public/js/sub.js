// Script loader for pages that also live on casino.oxidpvp.net. On the subdomain it first copies
// the main site's saved data in through bridge.html (a hidden frame on oxidpvp.net), then keeps
// sending changes back, so both addresses share one wallet, name and level. On the main site it
// just loads the scripts.
(() => {
  const host = location.hostname, sub = /^casino\./.test(host);
  window.CASINO_SUB = sub;
  window.MAIN_ORIGIN = location.protocol + "//" + host.replace(/^casino\./, "") + (location.port ? ":" + location.port : "");
  function inject(list) {
    let i = 0;
    const next = () => {
      if (i >= list.length) return;
      const s = document.createElement("script");
      s.src = list[i++];
      s.onload = s.onerror = next;
      document.body.append(s);
    };
    next();
  }
  window.loadScripts = (list) => {
    if (!sub) return inject(list);
    const main = window.MAIN_ORIGIN;
    const frame = document.createElement("iframe");
    frame.src = main + "/bridge.html";
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    document.body.append(frame);
    const orig = { set: Storage.prototype.setItem, rm: Storage.prototype.removeItem };
    const fwd = (k, v) => { try { frame.contentWindow.postMessage({ t: "set", k, v }, main); } catch {} };
    let started = false, patched = false;
    function patch() {
      if (patched) return;
      patched = true;
      Storage.prototype.setItem = function (k, v) { orig.set.call(this, k, v); if (this === window.localStorage && String(k).startsWith("oxidpvp-")) fwd(String(k), String(v)); };
      Storage.prototype.removeItem = function (k) { orig.rm.call(this, k); if (this === window.localStorage && String(k).startsWith("oxidpvp-")) fwd(String(k), null); };
    }
    const go = () => { if (started) return; started = true; patch(); inject(list); };
    addEventListener("message", (e) => {
      if (e.origin !== main || !e.data) return;
      if (e.data.t === "ready") frame.contentWindow.postMessage({ t: "get" }, main);
      else if (e.data.t === "all" && !started) {
        const all = e.data.all || {};
        try {
          // Anything saved only here (from before the bridge) goes up to the main site first.
          for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("oxidpvp-") && !(k in all)) fwd(k, localStorage.getItem(k)); }
          for (const [k, v] of Object.entries(all)) orig.set.call(localStorage, k, v);
        } catch {}
        go();
      }
    });
    setTimeout(go, 3000); // main site unreachable: carry on with what's saved here
  };
})();
