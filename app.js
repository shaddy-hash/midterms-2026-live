(() => {
  "use strict";
  const REFRESH_MS = 75000;
  const qs = new URLSearchParams(location.search);
  const owner = location.hostname.endsWith("github.io") ? location.hostname.split(".")[0] : (qs.get("owner") || "");
  const repo = location.hostname.endsWith("github.io") ? (location.pathname.split("/")[1] || "") : (qs.get("repo") || "");
  const DATA_BASE = qs.get("data") || `https://raw.githubusercontent.com/${owner}/${repo}/data/`;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (v) => (v == null || isNaN(v) ? "—" : `${Math.round(v)}%`);
  const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(Math.round(v));
  let PRED = null, DATA = null, HIST = [], filter = "key", govFilter = "key", houseFilter = "key", houseQuery = "", houseLimit = 40;

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
  const lastName = (n) => String(n || "").trim().split(/\s+/).pop().toLowerCase();
  const SRC = { senate: ["senate", "raceSummary"], gov: ["governors", "govSummary"], house: ["house", "houseSummary"] };
  function raceState(p, kind) {
    const gov = kind === "gov";
    const [evKey, smKey] = SRC[kind] || SRC.senate;
    const ev = DATA && DATA[evKey] && DATA[evKey][p.st];
    const ms = ((ev && ev.markets) || []).filter((m) => m.price != null);
    const r = ms.find((m) => /-R$/.test(m.ticker || ""));
    const chal = ms.filter((m) => m !== r).sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0];
    const chalParty = chal ? (/-D$/.test(chal.ticker || "") ? "d" : "i") : (p.chal === "I" ? "i" : "d");
    const won = ms.find((m) => m.result === "yes");
    const cP = chal ? chal.price : null, rP = r ? r.price : null;
    const sm = DATA && DATA[smKey] && DATA[smKey][p.st];
    const closed = sm ? sm.closed !== false : true;
    let status = "none", winner = null, winM = null;
    if (won) { status = "called"; winM = won; winner = won === r ? "r" : chalParty; }
    else if (closed && cP != null && cP >= 99) { status = "proj"; winM = chal; winner = chalParty; }
    else if (closed && rP != null && rP >= 99) { status = "proj"; winM = r; winner = "r"; }
    else if (cP != null) { status = cP >= 35 && cP <= 65 ? "toss" : "lean"; winner = cP > 50 ? chalParty : "r"; }
    const decided = status === "called" || status === "proj";
    const hold = p.hold.toLowerCase();
    const flipsSeat = (w) => w && ((hold === "r" && w !== "r") || (hold !== "r" && w === "r"));
    const flip = decided && flipsSeat(winner);
    const nameOf = (m, fb) => (m && !/party/i.test(m.name || "") ? m.name : fb);
    const cName = nameOf(chal, p.d || "Democrat"), rName = nameOf(r, p.r || "Republican");
    // Incumbent: only when the sitting senator is actually on the ballot.
    const incOn = p.inc && [cName, rName].some((n) => lastName(n) === lastName(p.inc) && String(n).toLowerCase().includes(p.inc.split(" ")[0].toLowerCase()));
    const incSide = incOn ? (lastName(rName) === lastName(p.inc) ? "r" : chalParty) : null;
    // Upsets: decided against the state's usual lean, against the pre-election favourite, or an incumbent beaten.
    const lean = p.trump24 ?? 0; // + = Republican-leaning (Trump 2024 margin)
    const againstLean = decided && ((lean >= 0 && winner !== "r") || (lean < 0 && winner === "r"));
    const leanSize = Math.abs(lean);
    const preFav = p.kalshi != null ? (p.kalshi >= 50 ? chalParty : "r") : p.poll != null ? (p.poll >= 0 ? chalParty : "r") : (gov || kind === "house") ? null : (lean >= 0 ? "r" : chalParty);
    const beatFav = decided && preFav && winner !== preFav;
    const incLost = decided && incSide && winner !== incSide;
    let upset = null;
    // Major upset: the seat flips to the party that lost the state by 10+ points in 2024.
    if (decided && flip && againstLean && leanSize >= 10) upset = "major";
    else if (decided && (beatFav || incLost || (flip && againstLean && leanSize >= 5))) upset = "upset";
    return { ev, r, chal, cP, rP, status, winner, winM, decided, flip, upset, incLost, incSide, cName, rName, chalParty,
      leanFlip: flipsSeat(winner), lean };
  }

  function badge(s) {
    const party = s.winner;
    const who = party === "r" ? "R" : party === "i" ? "Ind." : "D";
    if (s.status === "called") return `<span class="badge b-called-${party}">✓ Called ${who}${s.flip ? " · flip" : ""}</span>`;
    if (s.status === "proj") return `<span class="badge b-proj-${party}">Projected ${who}${s.flip ? " · flip" : ""}</span>`;
    if (s.status === "toss") return `<span class="badge b-toss">Toss-up</span>`;
    if (s.status === "lean") return `<span class="badge b-proj-${party}">Leans ${who}</span>`;
    return `<span class="badge b-toss">No market</span>`;
  }

  const leanText = (v) => (v == null ? "" : v >= 0 ? `Trump +${Math.round(v)}` : `Harris +${Math.round(-v)}`);

  function renderRaces(kind) {
    const gov = kind === "gov", house = kind === "house";
    const list = $(gov ? "#govs" : house ? "#house-races" : "#races");
    const all = gov ? PRED.governors || [] : house ? HOUSE || [] : PRED.races;
    const filter = gov ? govFilter : house ? houseFilter : window.__senFilter || "key";
    const pin = gov ? ["KS", "NE"] : house ? ["NE02", "NE01", "NE03"] : [];
    let races = all.map((p) => ({ p, s: raceState(p, kind) }));
    if (house) {
      races.forEach((x) => { x.p.key = x.s.cP != null && x.s.cP >= 8 && x.s.cP <= 92; });
      if (houseQuery) { const q = houseQuery.toLowerCase(); races = races.filter((x) => (x.p.name + " " + x.p.st + " " + x.s.cName + " " + x.s.rName + " " + (x.p.inc || "")).toLowerCase().includes(q)); }
    }
    const n = { key: 0, called: 0, upsets: 0, flips: 0 };
    races.forEach((x) => { if (x.p.key) n.key++; if (x.s.decided) n.called++; if (x.s.upset) n.upsets++; if (x.s.leanFlip) n.flips++; });
    document.querySelectorAll((gov ? "#gov-chips" : house ? "#house-chips" : "#race-chips") + " .chip").forEach((c) => { const k = c.dataset.f; c.textContent = c.dataset.label + (n[k] != null ? ` · ${n[k]}` : ` · ${all.length}`); });
    if (filter === "key") races = races.filter((x) => x.p.key || x.s.upset);
    if (filter === "called") races = races.filter((x) => x.s.decided);
    if (filter === "upsets") races = races.filter((x) => x.s.upset);
    if (filter === "flips") races = races.filter((x) => x.s.leanFlip);
    races.sort((a, b) => {
      const pa = pin.indexOf(a.p.st), pb = pin.indexOf(b.p.st);
      if (pa !== pb) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
      const rank = (x) => (x.s.upset === "major" ? 0 : x.s.upset ? 1 : x.s.status === "called" ? 2 : x.s.status === "proj" ? 3 : 4);
      return rank(a) - rank(b) || Math.abs((a.s.cP ?? 50) - 50) - Math.abs((b.s.cP ?? 50) - 50);
    });
    let more = "";
    if (house && races.length > houseLimit) { more = `<button class="refresh" id="house-more" style="width:100%;min-height:44px">Show ${Math.min(40, races.length - houseLimit)} more of ${races.length - houseLimit} remaining</button>`; races = races.slice(0, houseLimit); }
    if (!races.length) { list.innerHTML = `<div class="card skeleton">${filter === "upsets" ? "No upsets yet. Races appear here once they're called against expectations." : "No races in this view yet."}</div>`; return; }
    list.innerHTML = races.map(({ p, s }) => {
      const cls = s.chalParty;
      const cW = s.cP ?? 0, rW = s.rP ?? 0;
      const pre = p.kalshi;
      const delta = s.cP != null && pre != null ? s.cP - pre : null;
      const chalLabel = s.chalParty === "i" ? "Ind." : "D";
      const inc = (side) => (s.incSide === side ? ` <span class="inc" title="Incumbent">INC</span>` : "");
      const lost = (side) => (s.incLost && s.incSide === side ? " lost" : "");
      const leanLabel = house ? `${p.pvi > 0 ? "R+" + p.pvi : "D+" + -p.pvi} district` : `${leanText(s.lean)} state`;
      const upsetTag = s.upset === "major" ? `<div class="upset-tag">⚡ Major upset · ${s.winner === "r" ? "R" : chalLabel} wins a ${leanLabel}</div>`
        : s.upset ? `<div class="upset-tag">⚡ Upset${s.incLost ? " · incumbent defeated" : ""}</div>` : "";
      return `<article class="card race${s.upset ? " is-upset" : ""}${s.upset === "major" ? " is-major" : ""}" aria-label="${esc(p.name)} ${gov ? "governor" : "Senate"} race">
        ${upsetTag}
        <div class="race-top"><span class="race-name">${esc(p.name)} <span class="seat seat-${p.hold.toLowerCase()}">${p.hold}-held</span></span>${badge(s)}</div>
        <div class="cands"><span class="${lost(cls)}"><b style="color:var(--${cls === "i" ? "ind" : "dem"})">${esc(s.cName)}</b>${inc(cls)} (${chalLabel}) ${pct(s.cP)}</span>
          <span class="${lost("r")}">${pct(s.rP)} <b style="color:var(--rep)">${esc(s.rName)}</b>${inc("r")} (R)</span></div>
        <div class="bar" aria-hidden="true"><span class="${cls}" style="width:${cW}%"></span><span class="r" style="width:${rW}%"></span>
          ${pre != null ? `<i class="pre" style="left:calc(${pre}% - 1px)"></i>` : ""}</div>
        ${(() => { const cm = DATA && DATA.composite && DATA.composite.races && DATA.composite.races[`${kind}:${p.st}`]; if (!cm) return "";
          const pl = cm.p === "R" ? "R" : cm.p === "I" ? "Ind." : "D";
          return `<div class="comp-line"><span class="comp-pill">Composite ${pl} ${pct(cm.c)}</span>
            <span>Kalshi ${pct(cm.k)}</span>${cm.pm != null ? `<span>Polymarket ${pct(cm.pm)}</span>` : ""}${cm.o != null ? `<span>Outlets ${pct(cm.o)}</span>` : ""}</div>`; })()}
        <div class="compare">
          <span>${p.inc ? (s.incSide ? "Incumbent running" : `Open seat (${esc(p.inc)} not on ballot)`) : "Open seat"}</span>
          <span>${house ? `Cook PVI: <strong>${p.pvi > 0 ? "R+" + p.pvi : p.pvi < 0 ? "D+" + -p.pvi : "Even"}</strong>` : `2024: <strong>${leanText(p.trump24)}</strong>`}</span>
          ${pre != null ? `<span>Pre-election Kalshi <strong>${pre}%</strong></span>` : ""}
          ${p.ddhq != null ? `<span>DDHQ <strong>${p.ddhq}%</strong></span>` : ""}
          ${p.onpoint != null ? `<span>On Point <strong>${p.onpoint}%</strong></span>` : ""}
          ${p.poll != null ? `<span>Polls <strong>${p.poll >= 0 ? chalLabel : "R"}+${Math.abs(p.poll).toFixed(1)}</strong></span>` : ""}
          ${delta != null ? `<span>Since: <strong class="delta ${delta > 0.5 ? "up" : delta < -0.5 ? "down" : ""}">${sign(delta)} pts</strong></span>` : ""}
          ${p.closes ? `<span>Polls close ${esc(p.closes)}</span>` : ""}
        </div>
      </article>`;
    }).join("") + more;
    const mb = $("#house-more"); if (house && mb) mb.addEventListener("click", () => { houseLimit += 40; renderRaces("house"); });
  }

  // ---------- House metadata ----------
  let HOUSE = null;
  const STN = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
  const ord = (n) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  function buildHouse(reps, pvi) {
    return Object.entries(reps.reps || {}).map(([d, [name, party]]) => {
      const st = d.slice(0, 2), n = d.slice(2), v = (pvi.pvi || {})[d] ?? 0;
      return { st: d, name: `${STN[st] || st} ${n === "AL" ? "at-large" : ord(+n)}`, hold: party === "D" ? "D" : "R",
        inc: party === "V" ? null : name, pvi: v, trump24: v * 2, chal: "D", closes: "" };
    });
  }

  // ---------- prediction vs. results tracker (5-minute buckets) ----------
  let TRACK = [];
  function renderTracker() {
    const P = PRED.control;
    const cfg = [
      { id: "house", el: "#trk-house", total: 435, maj: 218, pre: P.house.ddhqSeats, label: "House" },
      { id: "senate", el: "#trk-senate", total: 100, maj: 51, pre: P.senate.ddhqSeats, label: "Senate" },
    ];
    const seats = (DATA && DATA.seats) || {};
    cfg.forEach((c) => {
      const box = $(c.el); if (!box) return;
      const rows = TRACK.map((r) => ({ t: r.t, ...(r[c.id] || {}) })).filter((r) => r.exp != null || r.d != null);
      const cur = seats[c.id] || {};
      const nowD = c.id === "senate" ? cur.totalD : cur.calledD, nowR = c.id === "senate" ? cur.totalR : cur.calledR;
      const nowExp = cur.expD_market ?? cur.expD_races;
      const head = `<div class="trk-head">
          <div><div class="kl">Predicted Dem. seats</div><div class="kv" style="color:var(--dem)">${nowExp != null ? Math.round(nowExp) : "—"}</div><div class="ks">Pre-election DDHQ ${c.pre} · majority ${c.maj}</div></div>
          <div><div class="kl">${c.id === "senate" ? "Seats locked in (incl. not up)" : "Seats called so far"}</div>
            <div class="kv"><span style="color:var(--dem)">${nowD ?? "—"}</span> <span class="vs">–</span> <span style="color:var(--rep)">${nowR ?? "—"}</span></div>
            <div class="ks">${c.id === "senate" ? `${cur.racesCalled ?? 0} of 35 races decided` : cur.calledD == null ? "Call feed unavailable" : `${(cur.calledD || 0) + (cur.calledR || 0) + (cur.calledI || 0)} of 435 called · ${cur.counting ?? 0} counting`}</div></div>
        </div>`;
      box.innerHTML = head + trackerChart(rows, c) + trackerTable(rows, c);
    });
  }

  function trackerChart(rows, c) {
    if (rows.length < 2) return `<p class="note" style="margin:8px 0">The 5-minute tracker fills in as results come in.</p>`;
    const W = 320, H = 150, L = 4, R = 316, T = 8, B = 136;
    const t0 = new Date(rows[0].t).getTime(), t1 = new Date(rows[rows.length - 1].t).getTime();
    const X = (t) => L + ((new Date(t).getTime() - t0) / Math.max(1, t1 - t0)) * (R - L);
    const vals = rows.flatMap((r) => [r.exp, r.d, r.r]).concat([c.maj, c.pre]).filter((v) => v != null);
    const pad = c.id === "senate" ? 3 : 12;
    const lo = Math.max(0, Math.floor(Math.min(...vals) - pad)), hi = Math.min(c.total, Math.ceil(Math.max(...vals) + pad));
    const Y = (v) => B - ((v - lo) / (hi - lo)) * (B - T);
    const path = (k) => rows.filter((r) => r[k] != null).map((r, i) => `${i ? "L" : "M"}${X(r.t).toFixed(1)},${Y(r[k]).toFixed(1)}`).join("");
    const step = (k) => { let d = "", prev = null; rows.forEach((r, i) => { if (r[k] == null) return; const x = X(r.t).toFixed(1), y = Y(r[k]).toFixed(1); d += prev == null ? `M${x},${y}` : `H${x}V${y}`; prev = y; }); return d; };
    const hl = (v, dash, op, lab, right, below) => `<line x1="${L}" x2="${R}" y1="${Y(v)}" y2="${Y(v)}" stroke="currentColor" stroke-dasharray="${dash}" opacity="${op}" vector-effect="non-scaling-stroke"/><text x="${right ? R - 2 : L + 2}" y="${Y(v) + (right || below ? 9 : -3)}" text-anchor="${right ? "end" : "start"}" font-size="8" fill="currentColor" opacity=".65">${lab}</text>`;
    const f = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `<svg class="trk-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${c.label}: predicted Democratic seats versus seats called, every 5 minutes">
        ${hl(c.maj, "3 3", ".35", `Majority ${c.maj}`, false, true)}${hl(c.pre, "1 4", ".5", `DDHQ pre-election ${c.pre}`, true)}
        <text x="${L + 2}" y="${B + 10}" font-size="8" fill="currentColor" opacity=".55">${lo}</text><text x="${L + 2}" y="${T + 2}" font-size="8" fill="currentColor" opacity=".55">${hi}</text>
        <path d="${path("exp")}" fill="none" stroke="var(--dem)" stroke-width="2.25" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
        <path d="${step("d")}" fill="none" stroke="var(--dem)" stroke-width="3" opacity=".45" vector-effect="non-scaling-stroke"/>
        <path d="${step("r")}" fill="none" stroke="var(--rep)" stroke-width="3" opacity=".7" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="legend"><span><i style="background:var(--dem)"></i>Predicted D seats (Kalshi)</span><span><i style="background:var(--dem);opacity:.45"></i>D ${c.id === "senate" ? "locked in" : "called"}</span><span><i style="background:var(--rep);opacity:.7"></i>R ${c.id === "senate" ? "locked in" : "called"}</span><span>${f(rows[0].t)} – ${f(rows[rows.length - 1].t)}</span></div>`;
  }

  function trackerTable(rows, c) {
    if (!rows.length) return "";
    const last = rows.slice(-12).reverse();
    const f = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `<details class="trk-table"><summary>Every 5 minutes (last hour)</summary><table>
      <thead><tr><th>Time</th><th>Composite</th><th>Kalshi</th><th>Pred. D seats</th><th>D ${c.id === "senate" ? "locked" : "called"}</th><th>R ${c.id === "senate" ? "locked" : "called"}</th></tr></thead>
      <tbody>${last.map((r) => `<tr><td>${f(r.t)}</td><td>${pct(r.c)}</td><td>${pct(r.p)}</td><td>${r.exp != null ? Math.round(r.exp) : "—"}</td><td>${r.d ?? "—"}</td><td>${r.r ?? "—"}</td></tr>`).join("")}</tbody></table></details>`;
  }

  // ---------- composite forecast ----------
  function renderComposite() {
    const el = $("#composite");
    const c = DATA && DATA.composite;
    if (!c) { el.innerHTML = '<div class="skeleton">The composite appears once the next data refresh runs.</div>'; return; }
    const H = c.chambers.house, S = c.chambers.senate, B = c.chambers.both;
    const col = (v) => (v == null ? "inherit" : v >= 50 ? "var(--dem)" : "var(--rep)");
    const mw = Math.round(c.marketWeight * 100), ow = 100 - mw;
    const cell = (x, lab, maj) => `<div><div class="kl">${lab} · Dem. chance</div>
        <div class="kv" style="color:${col(x.value)}">${x.settled ? (x.settled === "D" ? "Won" : "Lost") : pct(x.value)}</div>
        <div class="ks">${x.seats != null ? `~${Math.round(x.seats)} D seats (majority ${maj})` : ""}</div>
        <div class="ks">Markets ${pct(x.marketAvg)} · Outlets ${pct(x.outletAvg)}</div></div>`;
    const rows = (x, lab) => x.sources.map((s) => `<tr><td>${esc(s.name)} <span class="src-type">${s.type === "market" ? "live market" : "final forecast · " + esc(s.asOf)}</span></td><td>${lab}</td><td><b>${pct(s.value)}</b></td></tr>`).join("");
    el.innerHTML = `<div class="comp-grid">${cell(H, "House", 218)}${cell(S, "Senate", 51)}</div>
      <div class="comp-both"><span>Democrats win both chambers</span><b style="color:${col(B.value)}">${pct(B.value)}</b></div>
      <div class="weights" role="img" aria-label="Weighting: markets ${mw}%, outlets ${ow}%"><span class="wm" style="width:${mw}%"></span><span class="wo" style="width:${ow}%"></span></div>
      <div class="ks" style="font-size:12.5px;color:var(--muted)">Weighting now: live markets ${mw}% · outlet forecasts ${ow}%. Outlets count for half until polls close at 7 PM ET, then fade to zero by 1 AM ET as real votes replace pre-election models.</div>
      <details style="margin-top:6px"><summary>See every source</summary>
        <table class="src-table"><thead><tr><th>Source</th><th>Chamber</th><th>Dem. chance</th></tr></thead>
        <tbody>${rows(H, "House")}${rows(S, "Senate")}${rows(B, "Both")}</tbody></table>
        <p class="note" style="margin-top:8px">Seat projections averaged: ${H.seatSources.map((x) => `${esc(x.name)} ${x.value != null ? Math.round(x.value) : "—"}`).join(" · ")} (House); ${S.seatSources.map((x) => `${esc(x.name)} ${x.value != null ? Math.round(x.value) : "—"}`).join(" · ")} (Senate). Cook and 270toWin publish ratings, not probabilities, so they aren't included.</p>
        <p class="note">Every race card also shows its own composite: Kalshi and Polymarket for that race, plus Decision Desk HQ and On Point where they published a race forecast (Senate), using the same fading weight. ${DATA.composite.polyRaces ? DATA.composite.polyRaces + " races currently have a Polymarket market." : ""}</p>
      </details>`;
  }

  // ---------- Truth Social ----------
  function renderTruth() {
    const t = (DATA && DATA.truth) || {};
    const posts = t.posts || [];
    $("#truth").innerHTML = posts.length ? posts.slice(0, 12).map((p) =>
      `<a class="post" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">
        <div class="post-text">${esc(p.text).replace(/\n+/g, "<br>")}</div>
        <div class="m">${p.time ? timeAgo(p.time) + " · " + new Date(p.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}${p.media ? " · has media" : ""}</div></a>`).join("")
      : '<div class="skeleton">No posts loaded yet.</div>';
    const newest = posts[0] && posts[0].time ? (Date.now() - new Date(posts[0].time).getTime()) / 3600000 : null;
    const stale = t.source && /archive/.test(t.source) && newest != null && newest > 2
      ? ` The archive lags Truth Social (newest post ${Math.round(newest)} hr old); open <a href="https://truthsocial.com/@realDonaldTrump" target="_blank" rel="noopener noreferrer">@realDonaldTrump</a> for the latest.` : "";
    $("#truth-src").innerHTML = t.source ? `Source: ${esc(t.source)}. Original posts only; re-posts and media-only posts are hidden.${stale}` : "";
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
    renderComposite();
    renderRaces("senate");
    renderRaces("house");
    renderRaces("gov");
    renderTracker();
    renderTruth();
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
    if (!HOUSE) { try { HOUSE = buildHouse(await getJSON("house_reps.json"), await getJSON("house_pvi.json")); } catch (e) { HOUSE = []; } }
    // GitHub API serves the freshest copy (raw.githubusercontent caches ~5 min). Conditional (ETag) requests that
    // return 304 don't count against the 60/hr anonymous limit; fall back to the raw CDN if the API refuses.
    try {
      if (qs.get("data")) throw new Error("local");
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/data.json?ref=data`,
        { headers: { Accept: "application/vnd.github.raw+json" }, cache: "no-cache" });
      if (!r.ok) throw new Error("api " + r.status);
      DATA = await r.json();
    } catch (e) {
      try { DATA = await getJSON(DATA_BASE + "data.json"); } catch (e2) { console.warn("data", e2); }
    }
    try { HIST = await getJSON(DATA_BASE + "history.json"); } catch (e) { HIST = HIST || []; }
    try { TRACK = await getJSON(DATA_BASE + "tracker.json"); } catch (e) { TRACK = TRACK || []; }
    renderAll();
  }

  document.querySelectorAll("#house-chips .chip").forEach((b) => b.addEventListener("click", () => {
    houseFilter = b.dataset.f; houseLimit = 40;
    document.querySelectorAll("#house-chips .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderRaces("house");
  }));
  { let t; const q = document.getElementById("house-q"); if (q) q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { houseQuery = q.value.trim(); houseLimit = 40; renderRaces("house"); }, 200); }); }
  document.querySelectorAll("#gov-chips .chip").forEach((b) => b.addEventListener("click", () => {
    govFilter = b.dataset.f;
    document.querySelectorAll("#gov-chips .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderRaces("gov");
  }));
  document.querySelectorAll("#race-chips .chip").forEach((b) => b.addEventListener("click", () => {
    window.__senFilter = b.dataset.f;
    document.querySelectorAll("#race-chips .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderRaces("senate");
  }));
  $("#refresh").addEventListener("click", load);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  setInterval(() => { if (DATA) $("#updated").textContent = `Updated ${timeAgo(DATA.updated)}`; }, 15000);
  load();
})();
