// Beacon run kit: the generic page script of the wave 3 demo pages (x402-agent-buyer, natural-language-payment-agent,
// invoice-to-payment-agent, skill-chain-mcp-flow, audit-log-agent, weekly-digest-agent). Needs demo-kit.js (window.Kit).
// The server streams NDJSON steps and one {type:"done", view} line; this draws the lamps, the verdict, the tables and the Evidence.
(function () {
  "use strict";
  const K = window.Kit;
  const { $, esc } = K;
  const cell = (c) => (c && typeof c === "object" ? `<a href="${esc(c.href)}" rel="noopener">${esc(c.t)} ↗</a>` : esc(c));

  window.RunKit = function (cfg) {
    let cur = cfg.scenarios[0].id, running = false, view = "read", last = null, ctrl = null, runN = 0;
    const scenOf = (id) => cfg.scenarios.find((s) => s.id === id);

    function resetStrip() {
      K.drawLamps(cfg.steps(cur));
      $("total").textContent = "idle · press Run live";
      K.setFoot(cfg.idleFoot);
    }
    function pick(id) {
      cur = id;
      $("scen-name").textContent = scenOf(id).label;
      if (cfg.onPick) cfg.onPick(id);
      resetStrip();
    }
    K.scenarios((id) => { if (!running) pick(id); });

    function renderOut() {
      const b = $("out-body"), r = last;
      if (!r) return;
      if (view === "raw") { b.innerHTML = `<pre class="raw">${r.lines.map(esc).join("\n")}</pre>`; return; }
      const v = r.view;
      let h = `<p class="verdict ${esc(v.tone)}">${esc(v.verdict)}</p>`;
      if (v.note) h += `<p class="empty" style="margin:0 0 14px">${esc(v.note)}</p>`;
      for (const t of v.tables) {
        h += `<table class="data" style="margin-bottom:14px"><tr>${t.head.map((x) => `<th>${esc(x)}</th>`).join("")}</tr>` +
          t.rows.map((row) => `<tr>${row.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("") + `</table>`;
      }
      if (v.download) h += `<p class="foot-note" style="margin:0 0 10px"><button class="btn" type="button" id="dl">Download ${esc(v.download.name)}</button></p>`;
      if (v.text) h += `<pre class="raw">${esc(v.text)}</pre>`;
      b.innerHTML = h;
      const dl = $("dl");
      if (dl) dl.addEventListener("click", () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([v.download.text], { type: "text/markdown" })); a.download = v.download.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); });
    }
    function renderEv() {
      const r = last;
      $("run-id").textContent = r.id + " · " + r.at.toISOString().slice(11, 19) + " UTC";
      $("ev").innerHTML = r.view.evidence.map(([k, v]) => `<li><span class="caps">${esc(k)}</span><span class="v">${cell(v)}</span></li>`).join("");
    }
    function addLog() {
      const r = last, body = $("log-body");
      if (runN === 1) body.innerHTML = "";
      body.insertAdjacentHTML("afterbegin", `<tr><td class="mono">${r.at.toISOString().slice(11, 19)}</td><td>${esc(scenOf(r.scen).label)}</td><td>${esc(r.view.verdict)}</td><td class="mono">${K.num(r.totalMs)} ms</td></tr>`);
    }
    K.tabs((t) => { view = t; renderOut(); });

    async function go(request) {
      if (running) return;
      running = true; resetStrip(); $("strip").classList.add("lit");
      const btns = [...document.querySelectorAll("#run, .scen .btn, form button")]; btns.forEach((b) => (b.disabled = true));
      const scen = cur, lines = [];
      let done = null, error = null;
      ctrl = new AbortController();
      K.setFoot(cfg.runningFoot + " (Esc cancels)");
      K.pulseNext();
      try {
        const req = request || scenOf(scen).request;
        await K.stream(`${cfg.api}?action=run${req.qs ? "&" + req.qs : ""}`, (ev) => {
          lines.push(JSON.stringify(ev));
          if (ev.type === "step") {
            if (!document.getElementById("l-" + ev.id)) { const n = document.createElement("li"); n.id = "l-" + ev.id; n.className = "lamp"; n.innerHTML = `<span class="bulb"><i></i></span><span class="name">${esc(ev.label || ev.id)}</span><span class="meta" id="m-${esc(ev.id)}">&nbsp;</span>`; $("lamps").appendChild(n); }
            if (ev.state === "running") document.getElementById("l-" + ev.id).className = "lamp reached state-running";
            else K.light(ev, $("run-label"));
          } else if (ev.type === "done") done = ev;
          else if (ev.type === "error") error = ev.message;
        }, ctrl.signal, req.body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) } : undefined);
      } catch (e) { error = e.name === "AbortError" ? "Cancelled." : e.message; }
      ctrl = null;
      await K.settled();
      if (done) {
        runN++; last = { ...done, lines, scen, id: "run-" + String(runN).padStart(3, "0"), at: new Date() };
        $("total").innerHTML = `<b>${K.num(done.totalMs)} ms</b> total`;
        K.setFoot(done.view.summary, done.view.tone === "bad" ? "bad" : done.view.tone === "warn" ? "warn" : "");
        renderOut(); renderEv(); addLog();
      } else {
        document.querySelectorAll(".lamp.state-running").forEach((l) => (l.className = "lamp reached state-failed"));
        $("total").textContent = "stopped"; K.setFoot(error || "The run ended without a result.", "bad");
        runN++; const fb = $("log-body"); if (runN === 1) fb.innerHTML = ""; fb.insertAdjacentHTML("afterbegin", `<tr><td class="mono">${new Date().toISOString().slice(11, 19)}</td><td>${esc(scenOf(scen).label)}</td><td>${esc(error || "stopped")}</td><td class="mono">—</td></tr>`);
      }
      btns.forEach((b) => (b.disabled = false)); $("run-label").textContent = "Run again "; running = false;
    }
    $("run").addEventListener("click", () => go());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && running && ctrl) ctrl.abort(); });
    const form = $("form");
    if (form) form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (running) return;
      document.querySelectorAll(".scen .btn").forEach((x) => x.setAttribute("aria-pressed", "false"));
      const req = cfg.fromForm(new FormData(form));
      cfg.scenarios.find((s) => s.id === "custom").request = req;
      cur = "custom"; $("scen-name").textContent = scenOf("custom").label; go(req);
    });

    K.drawReqs(cfg.reqs);
    resetStrip();
    fetch(`${cfg.api}?action=info`, { cache: "no-store" }).then((r) => r.json()).then((d) => {
      const c = d.deploy && d.deploy.commit;
      $("deployed").innerHTML = c ? `deployed from <a href="https://github.com/edycutjong/pharos-beacon/commit/${esc(c)}" rel="noopener">${esc(c)}</a> · ${esc(d.deploy.env)}` : `deployed from the working tree (no commit) · ${esc((d.deploy && d.deploy.env) || "")}`;
    }).catch(() => ($("deployed").textContent = "deploy info unavailable"));
  };
})();
