(() => {
  "use strict";
  const REFRESH_MS = 60000;
  const qs = new URLSearchParams(location.search);
  const owner = location.hostname.endsWith("github.io") ? location.hostname.split(".")[0] : (qs.get("owner") || "");
  const repo = location.hostname.endsWith("github.io") ? (location.pathname.split("/")[1] || "") : (qs.get("repo") || "");
  const DATA_BASE = qs.get("data") || `https://raw.githubusercontent.com/${owner}/${repo}/data/`;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (v) => (v == null || isNaN(v) ? "—" : `${Math.round(v)}%`);
  const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(Math.round(v));
  let PRED = null, DATA = null, HIST = [], filter = "key";

  async function getJSON(url) {
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status + " " + url);
    return r.json();
  }

  function timeAgo(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function demMarket(ev) {
    if (!ev || !ev.markets) return null;
    return ev.markets.find((m) => /-D$/.test(m.ticker || "")) || null;
  }

  // ---------- control KPIs ----------
  function renderKPI(id, ev, pred, label) {
    const el = $(id);
    const m = demMarket(ev);
    const live = m ? m.price : null;
    const settled = ev && ev.markets && ev.markets.find((x) => x.result === "yes");
    const pre = pred.ddhq;
    let sub;
    if (settled) {
      sub = `<span class="delta">Called: ${esc(settled.name)}</span>`;
    } else if (live != null) {
      const d = live - pred.kalshi;
      sub = `<span class="delta ${d > 0.5 ? "up" : d < -0.5 ? "down" : ""}">${sign(d)} pts</span> vs Kalshi pre-election (${pred.kalshi}%)`;
    } else sub = "Waiting for market data";
    el.innerHTML = `<div class="label">${label} · Dem. chance</div>
      <div class="value" style="color:${live == null ? "inherit" : live >= 50 ? "var(--dem)" : "var(--rep)"}">${pct(live)}</div>
      <div class="sub">${sub}</div>
      <div class="meter" aria-hidden="true"><span style="width:${live ?? 0}%"></span><i class="tick" style="left:calc(${pre}% - 1px)"></i></div>
      <div class="sub" style="margin-top:6px">Forecasts: DDHQ ${pred.ddhq}% · On Point ${pred.onpoint}%</div>`;
  }

  // ---------- combined outcome ----------
  function classify(name) {
    const n = (name || "").toLowerCase();
    if (/(dem\w*).*(sweep|both|all)|^d.?house.*d.?senate/.test(n)) return "DD";
    if (/(rep\w*|gop).*(sweep|both|all)|^r.?house.*r.?senate/.test(n)) return "RR";
    const h = /(\bd|dem\w*)[\s-]*house/.test(n) ? "D" : /(\br|rep\w*)[\s-]*house/.test(n) ? "R" : "?";
    const s = /(\bd|dem\w*)[\s-]*senate/.test(n) ? "D" : /(\br|rep\w*)[\s-]*senate/.test(n) ? "R" : "?";
    return h + s;
  }
  const COMBO = {
    DD: { label: "Democrats win both", color: "var(--dem)", pre: "Democrats sweep" },
    DR: { label: "Dem. House, Rep. Senate", color: "color-mix(in srgb, var(--dem) 45%, var(--surface))", pre: "D House, R Senate", dark: true },
    RD: { label: "Rep. House, Dem. Senate", color: "color-mix(in srgb, var(--rep) 45%, var(--surface))", pre: "R House, D Senate", dark: true },
    RR: { label: "Republicans win both", color: "var(--rep)", pre: "Republicans sweep" },
  };
  function renderCombo(ev) {
    const rows = $("#combo-rows"), stack = $("#combo-stack");
    if (!ev || !ev.markets || !ev.markets.length) { rows.innerHTML = '<div class="skeleton">Market data not available yet.</div>'; stack.innerHTML = ""; return; }
    const items = ev.markets.map((m) => ({ k: classify(m.name), name: m.name, p: m.price ?? 0 })).sort((a, b) => b.p - a.p);
    const total = items.reduce((s, x) => s + x.p, 0) || 100;
    const order = ["DD", "DR", "RD", "RR"];
    stack.innerHTML = order.map((k) => items.find((x) => x.k === k)).filter(Boolean)
      .map((x) => `<span style="flex:${(x.p / total) * 100};background:${COMBO[x.k].color};color:${COMBO[x.k].dark ? "var(--text)" : "#fff"}">${x.p >= 8 ? pct(x.p) : ""}</span>`).join("");
    stack.setAttribute("aria-label", items.map((x) => `${COMBO[x.k]?.label || x.name} ${pct(x.p)}`).join(", "));
    rows.innerHTML = items.map((x) => {
      const c = COMBO[x.k];
      const pre = c && PRED.combo.ddhq[c.pre];
      return `<div class="combo-row"><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:8px;background:${c ? c.color : "var(--muted)"}"></i>${esc(c ? c.label : x.name)}</span>
        <b>${pct(x.p)}</b><span class="pre">${pre != null ? `DDHQ ${pre}%` : ""}</span></div>`;
    }).join("");
  }

  // ---------- trend chart ----------
  function renderTrend() {
    const svg = $("#trend");
    const pts = HIST.filter((p) => p.house != null || p.senate != null);
    if (pts.length < 2) { svg.innerHTML = `<text x="160" y="64" text-anchor="middle" font-size="11" fill="currentColor" opacity=".55">Trend builds as data comes in</text>`; $("#trend-range").textContent = ""; return; }
    const t0 = new Date(pts[0].t).getTime(), t1 = new Date(pts[pts.length - 1].t).getTime();
    const X = (t) => 4 + ((new Date(t).getTime() - t0) / Math.max(1, t1 - t0)) * 312;
    const Y = (v) => 112 - (v / 100) * 104;
    const line = (key, color) => {
      const d = pts.filter((p) => p[key] != null).map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join("");
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    };
    svg.innerHTML = `<line x1="0" x2="320" y1="${Y(50)}" y2="${Y(50)}" stroke="currentColor" opacity=".18" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
      ${line("house", "var(--dem)")}${line("senate", "var(--ind)")}`;
    const f = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("#trend-range").textContent = `${f(pts[0].t)} – ${f(pts[pts.length - 1].t)} · dashed line = 50%`;
  }

  // ---------- races ----------
  function raceState(p) {
    const ev = DATA && DATA.senate && DATA.senate[p.st];
    const ms = (ev && ev.markets) || [];
    const r = ms.find((m) => /-R$/.test(m.ticker || ""));
    const chal = ms.filter((m) => m !== r).sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0];
    const won = ms.find((m) => m.result === "yes");
    const cP = chal ? chal.price : null, rP = r ? r.price : null;
    const cParty = p.chal.toLowerCase();
    let status = "none", winner = null;
    if (won) { status = "called"; winner = won === r ? "r" : cParty; }
    else if (cP != null && cP >= 97) { status = "proj"; winner = cParty; }
    else if (rP != null && rP >= 97) { status = "proj"; winner = "r"; }
    else if (cP != null) { status = cP >= 35 && cP <= 65 ? "toss" : "lean"; winner = cP > 50 ? cParty : "r"; }
    const holdParty = p.hold.toLowerCase();
    const flip = winner && (status === "called" || status === "proj") && ((holdParty === "r" && winner !== "r") || (holdParty !== "r" && winner === "r"));
    const leanFlip = winner && ((holdParty === "r" && winner !== "r") || (holdParty !== "r" && winner === "r"));
    return { ev, r, chal, cP, rP, status, winner, flip, leanFlip, cName: chal ? chal.name : p.d, rName: r ? r.name : p.r };
  }

  function badge(s, p) {
    const party = s.winner;
    const who = party === "r" ? "R" : party === "i" ? "Ind." : "D";
    if (s.status === "called") return `<span class="badge b-called-${party}">✓ Called ${who}${s.flip ? " · flip" : ""}</span>`;
    if (s.status === "proj") return `<span class="badge b-proj-${party}">Projected ${who}${s.flip ? " · flip" : ""}</span>`;
    if (s.status === "toss") return `<span class="badge b-toss">Toss-up</span>`;
    if (s.status === "lean") return `<span class="badge b-proj-${party}">Leans ${who}</span>`;
    return `<span class="badge b-toss">No market</span>`;
  }

  function renderRaces() {
    const list = $("#races");
    let races = PRED.races.map((p) => ({ p, s: raceState(p) }));
    if (filter === "key") races = races.filter((x) => x.p.kalshi != null || x.p.ddhq != null);
    if (filter === "called") races = races.filter((x) => x.s.status === "called" || x.s.status === "proj");
    if (filter === "flips") races = races.filter((x) => x.s.leanFlip);
    races.sort((a, b) => {
      const rank = (x) => (x.s.status === "called" ? 0 : x.s.status === "proj" ? 1 : 2);
      return rank(a) - rank(b) || Math.abs((a.s.cP ?? 50) - 50) - Math.abs((b.s.cP ?? 50) - 50);
    });
    if (!races.length) { list.innerHTML = `<div class="card skeleton">No races in this view yet.</div>`; return; }
    list.innerHTML = races.map(({ p, s }) => {
      const cls = p.chal === "I" ? "i" : "d";
      const cW = s.cP ?? 0, rW = s.rP ?? 0;
      const pre = p.kalshi;
      const delta = s.cP != null && pre != null ? s.cP - pre : null;
      const chalLabel = p.chal === "I" ? "Ind." : "D";
      return `<article class="card race" aria-label="${esc(p.name)} Senate race">
        <div class="race-top"><span class="race-name">${esc(p.name)}</span>${badge(s, p)}</div>
        <div class="cands"><span><b style="color:var(--${p.chal === "I" ? "ind" : "dem"})">${esc(s.cName)}</b> (${chalLabel}) ${pct(s.cP)}</span>
          <span>${pct(s.rP)} <b style="color:var(--rep)">${esc(s.rName)}</b> (R)</span></div>
        <div class="bar" aria-hidden="true"><span class="${cls}" style="width:${cW}%"></span><span class="r" style="width:${rW}%"></span>
          ${pre != null ? `<i class="pre" style="left:calc(${pre}% - 1px)"></i>` : ""}</div>
        <div class="compare">
          <span>Pre-election: <strong>Kalshi ${pre != null ? pre + "%" : "—"}</strong></span>
          ${p.ddhq != null ? `<span>DDHQ <strong>${p.ddhq}%</strong></span>` : ""}
          ${p.onpoint != null ? `<span>On Point <strong>${p.onpoint}%</strong></span>` : ""}
          ${p.poll != null ? `<span>Polls <strong>${p.poll >= 0 ? chalLabel : "R"}+${Math.abs(p.poll).toFixed(1)}</strong></span>` : ""}
          ${delta != null ? `<span>Since: <strong class="delta ${delta > 0.5 ? "up" : delta < -0.5 ? "down" : ""}">${sign(delta)} pts</strong></span>` : ""}
          <span>Polls close ${esc(p.closes)}</span>
        </div>
      </article>`;
    }).join("");
  }

  // ---------- headlines ----------
  function renderNews() {
    const items = (DATA && DATA.headlines) || [];
    $("#news").innerHTML = items.length ? items.slice(0, 15).map((h) =>
      `<a href="${esc(h.link)}" target="_blank" rel="noopener noreferrer"><div class="h">${esc(h.title)}</div>
       <div class="m">${esc(h.source)}${h.published ? " · " + timeAgo(h.published) : ""}</div></a>`).join("")
      : '<div class="skeleton">No headlines yet.</div>';
  }

  function renderAll() {
    if (!PRED) return;
    const c = (DATA && DATA.control) || {};
    renderKPI("#kpi-house", c.house, PRED.control.house, "House");
    renderKPI("#kpi-senate", c.senate, PRED.control.senate, "Senate");
    renderCombo(c.combo);
    renderTrend();
    renderRaces();
    renderNews();
    const upd = DATA && DATA.updated;
    const age = upd ? (Date.now() - new Date(upd).getTime()) / 60000 : Infinity;
    $("#updated").textContent = upd ? `Updated ${timeAgo(upd)}` : "Waiting for data";
    $("#dot").className = "dot" + (age < 10 ? " live" : "");
    const b = $("#banner");
    if (!upd) { b.textContent = "Live data hasn't arrived yet. The first refresh usually takes 1–2 minutes after the site goes up."; b.classList.add("show"); }
    else if (age > 20) { b.textContent = `Live data is ${Math.round(age)} minutes old. The refresh job may be paused or restarting.`; b.classList.add("show"); }
    else b.classList.remove("show");
  }

  async function load() {
    try { if (!PRED) PRED = await getJSON("predictions.json"); } catch (e) { console.error(e); }
    try { DATA = await getJSON(DATA_BASE + "data.json"); } catch (e) { console.warn("data", e); }
    try { HIST = await getJSON(DATA_BASE + "history.json"); } catch (e) { HIST = HIST || []; }
    renderAll();
  }

  document.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    filter = b.dataset.f;
    document.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderRaces();
  }));
  $("#refresh").addEventListener("click", load);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  setInterval(() => { if (DATA) $("#updated").textContent = `Updated ${timeAgo(DATA.updated)}`; }, 15000);
  load();
})();
