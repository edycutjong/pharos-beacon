// Beacon demo kit: the client-side pieces the read-only task pages share (event-log-monitor, on-chain-alert-bot,
// doc-search-cli, docs-mcp-onboarding, dapp-support-agent). Plain script, no build step; exposes window.Kit.
// The Sequence strip, NDJSON streaming, requirement "show me" links, evidence rows, copy buttons, recorded proofs.
(function () {
  "use strict";
  const PIN = "1004316"; // the commit the recorded proofs are read from (frozen evidence, in the public repo)
  const RAW = (slug, file) => `https://raw.githubusercontent.com/edycutjong/pharos-beacon/${PIN}/tasks/${slug}/${file}`;
  const BLOB = (slug, file) => `https://github.com/edycutjong/pharos-beacon/blob/${PIN}/tasks/${slug}/${file}`;
  const EXPLORER = { atlantic: "https://atlantic.pharosscan.xyz/tx/", pharos: "https://www.pharosscan.xyz/tx/" };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (h) => (h ? String(h).slice(0, 6) + "…" + String(h).slice(-4) : "—");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  const num = (n) => Number(n).toLocaleString("en-US");
  const txLink = (network, hash, label) => `<a href="${EXPLORER[network] || EXPLORER.atlantic}${esc(hash)}" rel="noopener">${esc(label || short(hash))} ↗</a>`;

  // ---- Sequence strip ----
  let steps = [];
  let queue = Promise.resolve();
  function drawLamps(list) {
    steps = list;
    queue = Promise.resolve();
    $("lamps").innerHTML = list.map((s) => `<li class="lamp" id="l-${s.id}"><span class="bulb"><i></i></span><span class="name">${esc(s.name)}</span><span class="meta" id="m-${s.id}">&nbsp;</span></li>`).join("");
    $("strip").classList.remove("lit");
  }
  const nameOf = (id) => (steps.find((s) => s.id === id) || { name: id }).name;
  /** Light one lamp in arrival order; a step faster than 120 ms is held 120 ms so the eye can follow (the label keeps the true ms). */
  function light(ev, runLabel) {
    queue = queue.then(async () => {
      const li = $("l-" + ev.id);
      if (!li) return;
      if (runLabel) runLabel.textContent = nameOf(ev.id) + "… ";
      li.className = "lamp reached state-running";
      await wait(ev.state === "skip" ? 60 : 120);
      li.className = "lamp reached state-" + ev.state;
      $("m-" + ev.id).innerHTML = ev.state === "skip" ? esc(ev.label) : `<b>${esc(ev.label)}</b><br>${ev.ms == null ? "" : num(ev.ms) + " ms"}`;
    });
    return queue;
  }
  /** Mark the first lamp still idle as running (the step the server is working on). */
  function pulseNext() {
    const idle = [...document.querySelectorAll("#lamps .lamp")].find((l) => !l.classList.contains("reached"));
    if (idle) idle.className = "lamp reached state-running";
  }
  function setFoot(text, tone) {
    const f = $("foot");
    f.textContent = text;
    f.className = "strip-foot" + (tone ? " " + tone : "");
  }

  // ---- NDJSON ----
  /** Read a streamed run; resolves when the stream ends. A non-2xx answer throws with the server's own message. */
  async function stream(url, onEvent, signal, init) {
    const res = await fetch(url, { signal, cache: "no-store", ...(init || {}) });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onEvent(JSON.parse(line));
      }
      if (done) break;
    }
  }

  // ---- requirements, show me, tabs, copy ----
  function drawReqs(rows) {
    $("reqs").innerHTML = rows
      .map((r) => `<li><span class="rn">${esc(r[0])}</span><span class="rt">${esc(r[1])}<small>${r[2]}</small></span><span class="st ${esc(r[3])}">${esc(r[3])}</span><a class="showme" href="#${esc(r[4])}" data-target="${esc(r[4])}">show me ↓</a></li>`)
      .join("");
  }
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-target]");
    if (a) {
      e.preventDefault();
      const el = $(a.dataset.target);
      if (!el) return;
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      return;
    }
    const c = e.target.closest("[data-copy]");
    if (c) {
      const t = c.dataset.copy;
      (navigator.clipboard?.writeText(t) || Promise.reject()).then(() => (c.textContent = "Copied"), () => (c.textContent = "Copy blocked"));
      setTimeout(() => (c.textContent = "Copy"), 1400);
    }
  });
  function tabs(onChange) {
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
        onChange(t.dataset.t);
      }),
    );
  }
  /** Evidence rows: [label, value html, copy text?, explorer url?]. */
  function evidence(rows) {
    $("ev").innerHTML = rows
      .map(([k, v, copy, link]) => `<li><span class="caps">${esc(k)}</span><span class="v"${copy ? ` title="${esc(copy)}"` : ""}>${v}</span>${copy || link ? `<span class="act">${link ? `<a href="${esc(link)}" rel="noopener">Explorer ↗</a>` : ""}${copy ? `<button class="copy" type="button" data-copy="${esc(copy)}">Copy</button>` : ""}</span>` : ""}</li>`)
      .join("");
  }
  function scenarios(onPick) {
    document.querySelectorAll(".scen .btn").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.disabled) return;
        document.querySelectorAll(".scen .btn").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        onPick(b.dataset.s, b);
      }),
    );
  }

  // ---- footer + recorded proofs ----
  async function deploy(api) {
    try {
      const d = await (await fetch(`${api}?action=health`, { cache: "no-store" })).json();
      const c = d.deploy && d.deploy.commit;
      $("deployed").innerHTML = c
        ? `deployed from <a href="https://github.com/edycutjong/pharos-beacon/commit/${esc(c)}" rel="noopener">${esc(c)}</a> · ${esc(d.deploy.env)}`
        : `deployed from the working tree (no commit) · ${esc((d.deploy && d.deploy.env) || "")}`;
    } catch {
      $("deployed").textContent = "deploy info unavailable";
    }
  }
  const cache = new Map();
  /** A committed proof file at the pinned commit; JSON is parsed, anything else is text. */
  function proof(slug, file) {
    const key = slug + "/" + file;
    if (!cache.has(key)) {
      cache.set(
        key,
        fetch(RAW(slug, file)).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${file}`);
          return file.endsWith(".json") ? r.json() : r.text();
        }),
      );
    }
    return cache.get(key);
  }
  const recordedLine = (meta, slug, file) =>
    `<span class="rl">recorded on ${esc(String(meta && meta.createdAt ? meta.createdAt : "").slice(0, 10) || "2026-10-18")} by the CLI, committed in the repo · <a href="${BLOB(slug, file)}" rel="noopener">${esc(file.split("/").pop())} ↗</a></span>`;

  // ---- a deliberately small markdown renderer for Docs MCP answers (escape first, then a few safe patterns) ----
  function md(text) {
    const blocks = String(text || "").split(/```[a-z]*\n?/);
    return blocks
      .map((b, i) => {
        if (i % 2 === 1) return `<pre class="raw">${esc(b.replace(/\n$/, ""))}</pre>`;
        let h = esc(b);
        h = h.replace(/`([^`\n]+)`/g, '<code class="mono">$1</code>');
        h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
        h = h.replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+|\/[^)\s]*)\)/g, (_m, t, u) => `<a href="${u.startsWith("/") ? "https://docs.pharos.xyz" + u : u}" rel="noopener">${t}</a>`);
        h = h.replace(/^#{1,4} (.*)$/gm, "<b>$1</b>");
        h = h.replace(/^\s*[-*] (.*)$/gm, "• $1");
        return h
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => `<p class="md">${p.replace(/\n/g, "<br>")}</p>`)
          .join("");
      })
      .join("");
  }

  window.Kit = { PIN, RAW, BLOB, EXPLORER, $, esc, short, num, wait, reduce, txLink, drawLamps, light, pulseNext, setFoot, stream, drawReqs, tabs, evidence, scenarios, deploy, proof, recordedLine, md, settled: () => queue };
})();
