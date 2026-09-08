/* ============ Manaos · Proyección Larga 2025-26 — app.js ============ */
"use strict";

/* ---------------- utils ---------------- */
const $ = s => document.querySelector(s);
const range = n => Array.from({ length: n }, (_, i) => i);
const nfAR = new Intl.NumberFormat("es-AR");
const nfAR1 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 });

function fmtARS(v) {
  if (v == null || isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return nfAR1.format(v / 1e9) + " MM";      // mil millones
  if (a >= 1e6) return nfAR1.format(v / 1e6) + " M";       // millones
  if (a >= 1e4) return nfAR.format(Math.round(v));
  return nfAR.format(v);
}
function fmtInt(v) { return v == null || isNaN(v) ? "—" : nfAR.format(Math.round(v)); }
function fmtPct(v, signed) {
  if (v == null || !isFinite(v)) return "—";
  const s = v * 100;
  const t = nfAR1.format(Math.abs(s));
  if (signed) return (s >= 0 ? "+" : "−") + t + " %";
  return (s < 0 ? "−" : "") + t + " %";
}
function yoyClass(v) { return v > 0.0005 ? "pos" : (v < -0.0005 ? "negc" : "mut"); }
function deltaHTML(v, label) {
  if (v == null || !isFinite(v)) return "";
  const up = v >= 0;
  return `<span class="delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${fmtPct(Math.abs(v))}</span> <span class="mut">${label}</span>`;
}
const PALETTE = ["#0f4c81", "#e8590c", "#2f9e44", "#9c36b5", "#1098ad", "#e8890c", "#d6336c", "#495057", "#5f3dc4", "#087f5b", "#f06595", "#1864ab"];

/* ---------------- data ---------------- */
let D = null;
let charts = {};
/* Cantidad de meses de la temporada: la define el JSON (meta.mes_labels),
   así el tablero acompaña al ETL si la carga trae más o menos meses. */
let NM = 20;
/* Meses marcados como parciales por el ETL (meta.mes_parcial = {"19": "Solo desde…"}).
   Se usan para avisar en el header, en el filtro de meses y en los charts. */
let PARC = new Map();          // índice 0-based -> motivo
const esParcial = m => PARC.has(m);
function parcialTexto(sep = " · ") {
  if (!PARC.size) return "sin meses parciales";
  return [...PARC.entries()].sort((a, b) => a[0] - b[0])
    .map(([m, t]) => `${D.meta.mes_labels[m] || ("MES " + (m + 1))}: ${t.toLowerCase()}`).join(sep);
}

const baseOpts = (extra = {}) => Object.assign({
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { ticks: { font: { size: 10.5 }, maxRotation: 45 }, grid: { display: false } },
    y: { ticks: { font: { size: 10.5 }, callback: v => fmtARS(v) }, grid: { color: "#edf1f5" } }
  }
}, extra);

function newChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id).getContext("2d"), cfg);
  return charts[id];
}

/* ---------------- state ----------------
   Modelos EXPLÍCITOS: cada set contiene los elementos SELECCIONADOS.
   Default (todo) = set completo. "Ninguno" = set vacío.               */
const state = {
  mes: new Set(),      // se llena en init con todos
  vnd: new Set(), vnd2: new Set(), prov: new Set(), linea: new Set(),
  tab: "general",
  trend: new Set(),    // vendedores en comparación de tendencia
  sort: {}
};
function fillSet(s, n) { s.clear(); for (let i = 0; i < n; i++) s.add(i); }

function effVndIdx() {
  let base = new Set(state.vnd);
  if (state.vnd2.size < D.meta.vnd2s.length) {
    const allowed = new Set();
    for (const i of state.vnd2) {
      for (const n of (D.meta.vnd2_to_vnds[D.meta.vnd2s[i]] || [])) {
        const j = D.meta.vnds.indexOf(n);
        if (j >= 0) allowed.add(j);
      }
    }
    base = new Set([...base].filter(i => allowed.has(i)));
  }
  return base;
}
function effVndNames() { return new Set([...effVndIdx()].map(i => D.meta.vnds[i])); }
function provNames() { return new Set([...state.prov].map(i => D.meta.provs[i])); }
function lineaIdx() { return state.linea; }
function is2026(i) { return i >= 12; }

/* ---------------- motor de cálculo ---------------- */
function computeAll() {
  const eff = effVndIdx();
  const provSet = state.prov;
  const lineSet = state.linea;
  const mesSet = state.mes;
  const T = { b: 0, n: 0, v: 0, dev: 0, bo: 0 };
  const perMes = range(NM).map(() => ({ b: 0, n: 0, v: 0, dev: 0, bo: 0 }));
  const perVnd = new Map(), perProv = new Map(), perLinea = new Map();
  const C1 = D.C1;
  for (const m of mesSet) {
    for (const vi of eff) {
      for (const pi of provSet) {
        const prow = C1[m][vi][pi];
        for (const li of lineSet) {
          const c = prow[li];
          if (!c || (c[0] === 0 && c[1] === 0 && c[2] === 0)) continue;
          T.b += c[0]; T.n += c[1]; T.v += c[2]; T.dev += c[3]; T.bo += c[4];
          const pm = perMes[m];
          pm.b += c[0]; pm.n += c[1]; pm.v += c[2]; pm.dev += c[3]; pm.bo += c[4];
          let p = perVnd.get(vi); if (!p) { p = { bruto: 0, neto: 0, v: 0 }; perVnd.set(vi, p); }
          p.bruto += c[0]; p.neto += c[1]; p.v += c[2];
          p = perProv.get(pi); if (!p) { p = { b: 0, v: 0 }; perProv.set(pi, p); }
          p.b += c[1]; p.v += c[2];
          p = perLinea.get(li); if (!p) { p = { b: 0 }; perLinea.set(li, p); }
          p.b += c[1];
        }
      }
    }
  }
  let docs = 0;
  const docsVnd = new Map();
  for (const m of mesSet) for (const vi of eff) {
    const d = D.C2[m][vi][3];
    docs += d;
    docsVnd.set(vi, (docsVnd.get(vi) || 0) + d);
  }
  const vndNames = effVndNames(), provNm = provNames();
  let cliAct = 0;
  const cliMes = range(NM).map(() => 0);
  for (const c of D.C5) {
    if (c.vnd && !vndNames.has(c.vnd)) continue;
    if (c.prov && !provNm.has(c.prov)) continue;
    let s = 0;
    for (const m of mesSet) { s += c.h[m][0]; if (c.h[m][0] !== 0) cliMes[m] += 1; }
    if (s !== 0) cliAct++;
  }
  return { T, perMes, perVnd, perProv, perLinea, docs, docsVnd, cliAct, cliMes, eff };
}

/* ---------------- KPIs ---------------- */
function yoyOver(get) {
  let cur = 0, prev = 0, n = 0;
  for (const m of state.mes) if (is2026(m)) { cur += get(m); prev += get(m - 12); n++; }
  if (!n || prev === 0) return null;
  return (cur - prev) / prev;
}
function renderKPIs(C) {
  const { T } = C;
  $("#k-neto").textContent = fmtARS(T.n);
  $("#k-neto-sub").innerHTML = deltaHTML(yoyOver(m => C.perMes[m].n), "vs 2025");
  $("#k-bruto").textContent = fmtARS(T.b);
  $("#k-bruto-sub").innerHTML = deltaHTML(yoyOver(m => C.perMes[m].b), "vs 2025");
  $("#k-vol").textContent = fmtInt(T.v);
  $("#k-vol-sub").innerHTML = deltaHTML(yoyOver(m => C.perMes[m].v), "vs 2025");
  $("#k-cli").textContent = fmtInt(C.cliAct);
  $("#k-cli-sub").textContent = state.mes.size === NM ? "en toda la temporada" : `en ${state.mes.size} mes(es)`;
  const docsAprox = state.prov.size < D.meta.provs.length || state.linea.size < D.meta.lineas.length;
  $("#k-docs").textContent = fmtInt(C.docs);
  $("#k-docs-sub").textContent = docsAprox ? "≈ (docs por vendedor/mes)" : "comprobantes distintos";
  $("#k-ticket").textContent = C.docs ? fmtARS(T.n / C.docs) : "—";
  $("#k-devol").textContent = fmtARS(Math.abs(T.dev));
  $("#k-devol-sub").textContent = T.b > 0 ? fmtPct(Math.abs(T.dev) / T.b) + " de bruto" : "";
  $("#k-bono").textContent = fmtARS(Math.abs(T.bo));
  $("#k-bono-sub").textContent = T.b > 0 ? fmtPct(Math.abs(T.bo) / T.b) + " de bruto (carga promo)" : "";
}

/* ---------------- multiselect ---------------- */
function makeMS(id, items, stateSet) {
  const root = document.getElementById(id);
  root.innerHTML = "";
  const btn = document.createElement("button");
  btn.className = "ms-btn";
  const panel = document.createElement("div");
  panel.className = "ms-panel";
  const search = document.createElement("input");
  search.className = "ms-search"; search.placeholder = "Buscar…";
  const list = document.createElement("div");
  list.className = "ms-list";
  const foot = document.createElement("div");
  foot.className = "ms-foot";
  const bAll = document.createElement("button"); bAll.textContent = "Todas";
  const bNone = document.createElement("button"); bNone.textContent = "Ninguna";
  const bOk = document.createElement("button"); bOk.textContent = "Aplicar";
  foot.append(bAll, bNone, bOk);
  panel.append(search, list, foot);
  root.append(btn, panel);

  const rows = items.map((name, i) => {
    const lab = document.createElement("label");
    lab.className = "ms-item";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = i; cb.checked = stateSet.has(i);
    const span = document.createElement("span"); span.textContent = name; span.title = name;
    lab.append(cb, span);
    cb.addEventListener("change", () => {
      if (cb.checked) stateSet.add(i); else stateSet.delete(i);
      if (syncFilters) syncFilters();
    });
    return { lab, cb };
  });
  list.append(...rows.map(r => r.lab));
  search.addEventListener("input", () => {
    const q = search.value.toLowerCase();
    rows.forEach((r, i) => { r.lab.style.display = items[i].toLowerCase().includes(q) ? "" : "none"; });
  });
  bAll.onclick = () => { fillSet(stateSet, items.length); refresh(); if (syncFilters) syncFilters(); };
  bNone.onclick = () => { stateSet.clear(); refresh(); if (syncFilters) syncFilters(); };
  bOk.onclick = () => close();
  btn.addEventListener("click", e => {
    e.stopPropagation();
    document.querySelectorAll(".ms.open").forEach(x => { if (x !== root) x.classList.remove("open"); });
    root.classList.toggle("open");
    if (root.classList.contains("open")) search.focus();
  });
  function close() { root.classList.remove("open"); }
  document.addEventListener("click", e => { if (!root.contains(e.target)) close(); });

  function label() {
    const n = stateSet.size;
    if (n === items.length) return "Todos";
    if (n === 0) return "Ninguno";
    if (n === 1) {
      const name = items[[...stateSet][0]];
      return name.length > 20 ? name.slice(0, 19) + "…" : name;
    }
    return n + " selecc.";
  }
  function refresh() {
    btn.innerHTML = "";
    const s = document.createElement("span"); s.textContent = label();
    const car = document.createElement("span"); car.className = "caret"; car.textContent = "▼";
    btn.append(s, car);
    btn.classList.toggle("on", stateSet.size !== items.length && stateSet.size > 0);
    rows.forEach((r, i) => { r.cb.checked = stateSet.has(i); });
  }
  refresh();
  return { refresh };
}
let syncFilters = null; // se define en init

/* ---------------- URL sync ---------------- */
function encSet(s, max) {
  if (s.size === max) return "";
  if (s.size === 0) return "NONE";
  return [...s].sort((a, b) => a - b).join(".");
}
function decSet(str, max) {
  if (str == null || str === "") return new Set(range(max));
  if (str === "NONE") return new Set();
  return new Set(str.split(".").map(Number).filter(i => i >= 0 && i < max));
}
function writeURL() {
  const p = ["mes=" + encSet(state.mes, NM)];
  const v = encSet(state.vnd, D.meta.vnds.length); if (v) p.push("vnd=" + v);
  const v2 = encSet(state.vnd2, D.meta.vnd2s.length); if (v2) p.push("v2=" + v2);
  const pr = encSet(state.prov, D.meta.provs.length); if (pr) p.push("prov=" + pr);
  const ln = encSet(state.linea, D.meta.lineas.length); if (ln) p.push("linea=" + ln);
  if (state.tab !== "general") p.push("tab=" + state.tab);
  history.replaceState(null, "", "#" + p.join("&"));
}
function readURL() {
  const h = location.hash.replace(/^#/, "");
  if (!h) return;
  const g = {};
  for (const kv of h.split("&")) { const i = kv.indexOf("="); g[kv.slice(0, i)] = kv.slice(i + 1); }
  state.mes = decSet(g.mes, NM);
  if (g.vnd != null) state.vnd = decSet(g.vnd, D.meta.vnds.length);
  if (g.v2 != null) state.vnd2 = decSet(g.v2, D.meta.vnd2s.length);
  if (g.prov != null) state.prov = decSet(g.prov, D.meta.provs.length);
  if (g.linea != null) state.linea = decSet(g.linea, D.meta.lineas.length);
  if (g.tab) state.tab = g.tab;
}

/* ---------------- render: general ---------------- */
function renderGeneral(C) {
  const mL = D.meta.mes_labels;
  const idx = [...state.mes].sort((a, b) => a - b);
  // serie mensual + mes anterior
  const prevLine = idx.map(m => (is2026(m) ? C.perMes[m - 12].n : null));
  newChart("ch-serie", {
    type: "bar",
    data: {
      labels: idx.map(m => mL[m]),
      datasets: [
        { type: "bar", label: "Neto", data: idx.map(m => C.perMes[m].n),
          backgroundColor: idx.map(m => esParcial(m) ? "rgba(232,89,12,.45)" : "rgba(15,76,129,.75)"),
          borderColor: idx.map(m => esParcial(m) ? "#e8590c" : "transparent"),
          borderWidth: idx.map(m => esParcial(m) ? 1.5 : 0),
          borderRadius: 5, maxBarThickness: 34 },
        { type: "line", label: "Mismo mes 2025", data: prevLine,
          borderColor: "#e8590c", backgroundColor: "#e8590c", borderDash: [5, 4],
          pointRadius: 3, tension: .25, spanGaps: false }
      ]
    },
    options: baseOpts({ plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: {
        label: c => `${c.dataset.label}: ${c.parsed.y == null ? "—" : fmtARS(c.parsed.y)}`,
        afterLabel: c => (c.datasetIndex === 0 && esParcial(idx[c.dataIndex]))
          ? "⚠ mes parcial: " + PARC.get(idx[c.dataIndex]) : undefined
      } } } })
  });

  // acumulada de temporada
  const acc25 = [], acc26 = [], acc25c = [];
  let a25 = 0, a26 = 0, a25c = 0;
  for (let m = 0; m < NM; m++) {
    if (m <= 11) a25 += C.perMes[m].n;
    acc25[m] = m <= 11 ? a25 : null;
    if (m >= 12) { a26 += C.perMes[m].n; a25c += C.perMes[m - 12].n; }
    acc26[m] = m >= 12 ? a26 : null;
    acc25c[m] = m >= 12 ? a25c : null;
  }
  newChart("ch-acum", {
    type: "line",
    data: { labels: mL, datasets: [
      { label: "2025 (acum)", data: acc25, borderColor: "#1098ad", backgroundColor: "#1098ad", tension: .25, pointRadius: 2 },
      { label: "2026 (acum)", data: acc26, borderColor: "#e8590c", backgroundColor: "#e8590c", tension: .25, pointRadius: 2 },
      { label: "2025 comparable", data: acc25c, borderColor: "#8494a5", borderDash: [5, 4], tension: .25, pointRadius: 2 }
    ] },
    options: baseOpts()
  });

  // YoY por mes (2026)
  const yoyIdx = idx.filter(is2026);
  const yoyVal = yoyIdx.map(m => (C.perMes[m - 12].n ? (C.perMes[m].n - C.perMes[m - 12].n) / C.perMes[m - 12].n : null));
  newChart("ch-yoy", {
    type: "bar",
    data: { labels: yoyIdx.map(m => mL[m]), datasets: [{
      label: "YoY %", data: yoyVal,
      backgroundColor: yoyVal.map(v => (v == null ? "#ced4da" : v >= 0 ? "rgba(47,158,68,.7)" : "rgba(214,51,108,.7)")),
      borderRadius: 5, maxBarThickness: 30 }] },
    options: baseOpts({ scales: { x: baseOpts().scales.x, y: { ticks: { callback: v => (v * 100) + " %" }, grid: { color: "#edf1f5" } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtPct(c.parsed.y) } } } })
  });

  // clientes activos por mes
  newChart("ch-cliact", {
    type: "line",
    data: { labels: mL, datasets: [{ label: "Clientes activos", data: C.cliMes,
      borderColor: "#0f4c81", backgroundColor: "rgba(15,76,129,.12)", fill: true, tension: .25, pointRadius: 2 }] },
    options: baseOpts({ scales: { x: baseOpts().scales.x, y: { ticks: { font: { size: 10.5 } }, grid: { color: "#edf1f5" } } } })
  });

  // mix línea donut
  const lineas = D.meta.lineas.map((n, i) => ({ n, v: (C.perLinea.get(i) || {}).b || 0 })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  const totalL = lineas.reduce((s, x) => s + x.v, 0);
  newChart("ch-lineadonut", {
    type: "doughnut",
    data: { labels: lineas.map(x => x.n), datasets: [{ data: lineas.map(x => x.v),
      backgroundColor: PALETTE, borderWidth: 1, borderColor: "#fff" }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: "58%",
      plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.label}: ${fmtARS(c.parsed)} (${totalL ? fmtPct(c.parsed / totalL) : ""})` } } } }
  });

  renderC4bar("ch-tipobar", D.C4a, D.meta.tipos, "b");
}

function renderC4bar(id, cube, names, metric) {
  const vals = names.map((n, i) => {
    let b = 0;
    for (const m of state.mes) { const c = cube[m][i]; if (c) b += c[metric] || 0; }
    return { n, b };
  }).filter(x => x.b > 0).sort((a, b) => b.b - a.b).slice(0, 12);
  const tot = vals.reduce((s, x) => s + x.b, 0);
  newChart(id, {
    type: "bar",
    data: { labels: vals.map(x => x.n), datasets: [{ data: vals.map(x => x.b),
      backgroundColor: PALETTE.slice(0, vals.length).map(c => c + "cc"), borderRadius: 5, maxBarThickness: 26 }] },
    options: baseOpts({ indexAxis: "y", plugins: { legend: { display: false },
      tooltip: { callbacks: { label: c => `${metric === "v" ? fmtInt(c.parsed.x) : fmtARS(c.parsed.x)}${tot ? " (" + fmtPct(c.parsed.x / tot) + ")" : ""}` } } },
      scales: { x: { ticks: { callback: v => (metric === "v" ? fmtInt : fmtARS)(v), font: { size: 10.5 } }, grid: { color: "#edf1f5" } },
        y: { ticks: { font: { size: 10.5 } }, grid: { display: false } } } })
  });
}

/* ---------------- render: vendedores ---------------- */
function vndMonthNet(vi, m) {
  let s = 0;
  for (const pi of state.prov) { const c = D.C1[m][vi][pi]; for (const li of state.linea) { const cell = c[li]; if (cell) s += cell[1]; } }
  return s;
}
function renderVendedores(C) {
  const rows = [...C.eff].map(vi => {
    const p = C.perVnd.get(vi) || { bruto: 0, neto: 0, v: 0 };
    const docs = C.docsVnd.get(vi) || 0;
    let cli = 0;
    for (const m of state.mes) cli += D.C2[m][vi][4];
    let cur = 0, prev = 0;
    for (const m of state.mes) if (is2026(m)) { cur += vndMonthNet(vi, m); prev += vndMonthNet(vi, m - 12); }
    const yoy = prev > 0 ? (cur - prev) / prev : null;
    return { vi, name: D.meta.vnds[vi], b: p.neto, bruto: p.bruto, v: p.v, c: cli, d: docs,
      ticket: docs ? p.neto / docs : null, yoy, pct: C.T.n ? p.neto / C.T.n : 0 };
  }).sort((a, b) => b.b - a.b);
  const top = rows.slice(0, 15);
  newChart("ch-vndrank", {
    type: "bar",
    data: { labels: top.map(r => shortName(r.name)), datasets: [{ data: top.map(r => r.b),
      backgroundColor: top.map((r, i) => PALETTE[i % PALETTE.length] + "cc"), borderRadius: 5, maxBarThickness: 22 }] },
    options: baseOpts({ indexAxis: "y",
      onClick: (e, els) => { if (els.length) toggleTrend(top[els[0].index].name); },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtARS(c.parsed.x) } } },
      scales: { x: { ticks: { callback: v => fmtARS(v), font: { size: 10.5 } }, grid: { color: "#edf1f5" } }, y: { ticks: { font: { size: 10.5 } }, grid: { display: false } } } })
  });
  renderVndTrend();
  renderVndTable(rows);
}
function shortName(n) { return n.length > 22 ? n.slice(0, 21) + "…" : n; }
function toggleTrend(name) {
  if (state.trend.has(name)) state.trend.delete(name);
  else { if (state.trend.size >= 6) state.trend.delete([...state.trend][0]); state.trend.add(name); }
  renderVndTrend();
}
function renderVndTrend() {
  const mL = D.meta.mes_labels;
  const ds = [...state.trend].slice(0, 6).map((name, k) => {
    const vi = D.meta.vnds.indexOf(name);
    if (vi < 0) return null;
    return { label: name, data: range(NM).map(m => (state.mes.has(m) ? vndMonthNet(vi, m) : null)),
      borderColor: PALETTE[k % PALETTE.length], backgroundColor: PALETTE[k % PALETTE.length],
      tension: .25, pointRadius: 2, spanGaps: true };
  }).filter(Boolean);
  newChart("ch-vndtrend", {
    type: "line",
    data: { labels: mL, datasets: ds.length ? ds : [{ label: "clic en el ranking para comparar", data: range(NM).map(() => null), borderColor: "#ced4da", borderDash: [4, 4], pointRadius: 0 }] },
    options: baseOpts()
  });
}
function renderVndTable(rows) {
  const q = ($("#search-vnd").value || "").toLowerCase();
  const filtered = rows.filter(r => r.name.toLowerCase().includes(q));
  const s = state.sort["vnd"] || { key: "b", dir: -1 };
  filtered.sort((a, b) => {
    const av = a[s.key], bv = b[s.key];
    if (typeof av === "string" || typeof bv === "string")
      return String(av ?? "").localeCompare(String(bv ?? "")) * s.dir;
    return ((av ?? -Infinity) - (bv ?? -Infinity)) * s.dir;
  });
  $("#tb-vnd").innerHTML = filtered.map(r => `
    <tr><td><b>${r.name}</b></td><td class="num">${fmtARS(r.b)}</td><td class="num">${fmtARS(r.bruto)}</td>
    <td class="num">${fmtInt(r.v)}</td><td class="num">${fmtInt(r.c)}</td><td class="num">${fmtInt(r.d)}</td>
    <td class="num">${r.ticket ? fmtARS(r.ticket) : "—"}</td>
    <td class="num ${yoyClass(r.yoy)}">${r.yoy == null ? "—" : fmtPct(r.yoy, true)}</td>
    <td class="num">${fmtPct(r.pct)}</td></tr>`).join("");
}

/* ---------------- render: clientes ---------------- */
function cliPeriod(c) {
  let b = 0, v = 0;
  for (const m of state.mes) { b += c.h[m][0]; v += c.h[m][1]; }
  return { b, v };
}
function cliYoY(c) {
  let cur = 0, prev = 0, any = false;
  for (const m of state.mes) if (is2026(m)) { cur += c.h[m][0]; prev += c.h[m - 12][0]; any = true; }
  return any && prev > 0 ? (cur - prev) / prev : null;
}
function filteredClients() {
  const vndNames = effVndNames(), provNm = provNames();
  return D.C5.filter(c =>
    (!c.vnd || vndNames.has(c.vnd)) && (!c.prov || provNm.has(c.prov)));
}
function renderClientes() {
  const list = filteredClients().map(c => ({ ...c, per: cliPeriod(c), yoy: cliYoY(c) }))
    .filter(c => c.per.b > 0).sort((a, b) => b.per.b - a.per.b);
  // pareto
  const tot = list.reduce((s, c) => s + c.per.b, 0);
  let acc = 0;
  const pareto = list.slice(0, 300).map(c => { acc += c.per.b; return acc / (tot || 1); });
  newChart("ch-pareto", {
    type: "line",
    data: { labels: pareto.map((_, i) => i + 1),
      datasets: [{ label: "% acumulado del neto", data: pareto, borderColor: "#0f4c81",
        backgroundColor: "rgba(15,76,129,.10)", fill: true, pointRadius: 0, tension: .15 }] },
    options: baseOpts({ scales: { x: { title: { display: true, text: "cliente (ranking)", font: { size: 10.5 } }, ticks: { font: { size: 10 } } },
      y: { max: 1, ticks: { callback: v => (v * 100) + " %", font: { size: 10.5 } }, grid: { color: "#edf1f5" } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => "Top " + items[0].label, label: c => fmtPct(c.parsed.y) } } } })
  });
  // nuevos por mes
  const nuevos = range(NM).map(m => list.filter(c => c.first === m + 1).length);
  newChart("ch-nuevos", {
    type: "bar",
    data: { labels: D.meta.mes_labels, datasets: [{ data: nuevos,
      backgroundColor: "rgba(16,152,173,.75)", borderRadius: 4, maxBarThickness: 26 }] },
    options: baseOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.parsed.y + " nuevos" } } } })
  });
  // tabla
  const q = ($("#search-cli").value || "").toLowerCase();
  const topList = list.filter(c => c.c.toLowerCase().includes(q)).slice(0, q ? 50 : 30);
  $("#tb-cli").innerHTML = topList.map(c => `
    <tr style="cursor:pointer" data-cli="${c.c.replace(/"/g, "&quot;")}">
    <td><b>${c.c}</b></td><td>${c.prov || "—"}</td><td>${c.vnd || "—"}</td>
    <td class="num">${fmtARS(c.per.b)}</td>
    <td class="num ${yoyClass(c.yoy)}">${c.yoy == null ? "—" : fmtPct(c.yoy, true)}</td>
    <td class="num">${fmtInt(c.per.v)}</td><td class="num">${fmtInt(c.d)}</td>
    <td>${D.meta.mes_labels[c.last - 1]}</td></tr>`).join("");
  document.querySelectorAll("#tb-cli tr[data-cli]").forEach(tr =>
    tr.addEventListener("click", () => showCliDetail(tr.dataset.cli)));
}
function showCliDetail(name) {
  const c = D.C5.find(x => x.c === name);
  if (!c) return;
  const box = $("#cli-detail"); box.hidden = false;
  $("#cli-detail-title").textContent = "Historia del cliente — " + name;
  const mL = D.meta.mes_labels;
  newChart("ch-clihist", {
    type: "bar",
    data: { labels: mL, datasets: [
      { label: "Neto", data: c.h.map(h => h[0]),
        backgroundColor: range(NM).map(m => state.mes.has(m) ? "rgba(15,76,129,.8)" : "rgba(15,76,129,.22)"),
        borderRadius: 4, maxBarThickness: 24 }
    ] },
    options: baseOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: cc => fmtARS(cc.parsed.y) } } } })
  });
  const totB = c.h.reduce((s, h) => s + h[0], 0);
  let cur = 0, prev = 0;
  for (let m = 12; m < NM; m++) { cur += c.h[m][0]; prev += c.h[m - 12][0]; }
  const yoy = prev > 0 ? (cur - prev) / prev : null;
  $("#cli-meta").innerHTML = `
    <div class="row"><span>Provincia</span><b>${c.prov || "—"}</b></div>
    <div class="row"><span>Vendedor (principal)</span><b>${c.vnd || "—"}</b></div>
    <div class="row"><span>Estado</span><b>${c.est || "—"}</b></div>
    <div class="row"><span>Primera compra</span><b>${mL[c.first - 1]}</b></div>
    <div class="row"><span>Última compra</span><b>${mL[c.last - 1]}</b></div>
    <div class="row"><span>Neto temporada</span><b>${fmtARS(totB)}</b></div>
    <div class="row"><span>Volumen temporada</span><b>${fmtInt(c.h.reduce((s, h) => s + h[1], 0))}</b></div>
    <div class="row"><span>Documentos</span><b>${fmtInt(c.d)}</b></div>
    <div class="row"><span>YoY 2026 vs 2025</span><b class="${yoyClass(yoy)}">${yoy == null ? "—" : fmtPct(yoy, true)}</b></div>`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------------- render: productos ---------------- */
function renderProductos(C) {
  const mL = D.meta.mes_labels;
  // tendencia por línea (C1, todos los filtros)
  const ds = D.meta.lineas.map((n, i) => {
    const data = range(NM).map(m => {
      if (!state.mes.has(m) || !state.linea.has(i)) return null;
      let s = 0;
      for (const vi of C.eff) for (const pi of state.prov) { const cell = D.C1[m][vi][pi][i]; if (cell) s += cell[1]; }
      return s;
    });
    const k = D.meta.lineas.indexOf(n);
    return { label: n, data, borderColor: PALETTE[k % PALETTE.length], backgroundColor: PALETTE[k % PALETTE.length], tension: .25, pointRadius: 1.5 };
  }).filter(d => d.data.some(v => v));
  newChart("ch-lineatrend", {
    type: "line", data: { labels: mL, datasets: ds }, options: baseOpts()
  });
  // escala de precios (C4b pm)
  const presMain = D.meta.pres.filter(p => ["2250cc", "3000cc", "1500cc", "2000cc", "6000cc", "0500cc"].includes(p));
  const pds = presMain.map((p, k) => {
    const pi = D.meta.pres.indexOf(p);
    return { label: p, data: range(NM).map(m => (state.mes.has(m) && D.C4b[m][pi]) ? D.C4b[m][pi].pm : null),
      borderColor: PALETTE[k % PALETTE.length], backgroundColor: PALETTE[k % PALETTE.length], tension: .25, pointRadius: 2, spanGaps: true };
  });
  newChart("ch-precio", {
    type: "line", data: { labels: mL, datasets: pds },
    options: baseOpts({ scales: { x: baseOpts().scales.x, y: { ticks: { callback: v => "$" + nfAR.format(v), font: { size: 10.5 } }, grid: { color: "#edf1f5" } } } })
  });
  renderC4bar("ch-presvol", D.C4b, D.meta.pres, "v");
  renderC4bar("ch-sabor", D.C4c, D.meta.sabores, "b");
  // top 30 artículos (C6, período + línea vía campo)
  const arts = D.C6.filter(a => {
    if (a.linea && !state.linea.has(D.meta.lineas.indexOf(a.linea))) return false;
    let b = 0; for (const m of state.mes) b += a.h[m][0];
    return b > 0;
  }).map(a => {
    let b = 0, v = 0, cur = 0, prev = 0;
    for (const m of state.mes) { b += a.h[m][0]; v += a.h[m][1]; if (is2026(m)) { cur += a.h[m][0]; prev += a.h[m - 12][0]; } }
    return { ...a, b, v, yoy: prev > 0 ? (cur - prev) / prev : null };
  }).sort((a, b) => b.b - a.b).slice(0, 30);
  $("#tb-art").innerHTML = arts.map(a => `
    <tr><td><b>${a.a}</b></td><td>${a.linea || "—"}</td><td>${a.pres || "—"}</td>
    <td class="num">${fmtARS(a.b)}</td><td class="num">${fmtInt(a.v)}</td>
    <td class="num">${fmtInt(a.c)}</td><td class="num">${fmtInt(a.d)}</td>
    <td class="num ${yoyClass(a.yoy)}">${a.yoy == null ? "—" : fmtPct(a.yoy, true)}</td></tr>`).join("");
}

/* ---------------- render: territorio ---------------- */
function renderTerritorio(C) {
  const provs = D.meta.provs.map((n, i) => ({ n, v: (C.perProv.get(i) || {}).b || 0 })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  newChart("ch-prov", {
    type: "bar",
    data: { labels: provs.map(p => p.n), datasets: [{ data: provs.map(p => p.v),
      backgroundColor: PALETTE[0] + "b8", borderRadius: 5, maxBarThickness: 30 }] },
    options: baseOpts({ indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtARS(c.parsed.x) } } },
      scales: { x: { ticks: { callback: v => fmtARS(v), font: { size: 10.5 } }, grid: { color: "#edf1f5" } }, y: { ticks: { font: { size: 10.5 } }, grid: { display: false } } } })
  });
  $("#tb-prov").innerHTML = provs.map(p => {
    const i = D.meta.provs.indexOf(p.n);
    const pp = C.perProv.get(i) || { b: 0, v: 0 };
    return `<tr><td><b>${p.n}</b></td><td class="num">${fmtARS(pp.b)}</td>
    <td class="num">${fmtInt(pp.v)}</td><td class="num">${fmtPct(C.T.n ? pp.b / C.T.n : 0)}</td></tr>`;
  }).join("");
  const tot = D.C7.top15.map((l, i) => {
    let b = 0; for (const m of state.mes) { const v = D.C7.top_mes[i][m]; if (v) b += v; }
    return { l, b };
  }).sort((a, b) => b.b - a.b);
  newChart("ch-loc", {
    type: "bar",
    data: { labels: tot.map(t => t.l), datasets: [{ data: tot.map(t => t.b),
      backgroundColor: PALETTE[4] + "b8", borderRadius: 5, maxBarThickness: 22 }] },
    options: baseOpts({ indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtARS(c.parsed.x) } } },
      scales: { x: { ticks: { callback: v => fmtARS(v), font: { size: 10.5 } }, grid: { color: "#edf1f5" } }, y: { ticks: { font: { size: 10.5 } }, grid: { display: false } } } })
  });
}

/* ---------------- render: datos ---------------- */
function renderDatos(C) {
  const m = D.meta, q = D.calidad;
  const rows = (arr) => arr.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join("");
  $("#kv-origen").innerHTML = rows([
    ["Archivo fuente", m.fuente],
    ["Generado", m.generado],
    ["Filas de renglón", nfAR.format(m.filas)],
    ["Período", `${m.mes_labels[0]} → ${m.mes_labels[m.mes_labels.length - 1]} (MES 1-${m.mes_labels.length})`],
    ["Clientes", nfAR.format(m.n_clientes)],
    ["Artículos", nfAR.format(m.n_articulos)],
    ["Vendedores / 2º", `${m.vnds.length} / ${m.vnd2s.length}`],
    ["Provincias", nfAR.format(m.provs.length)],
    ["Meses parciales", PARC.size ? parcialTexto() : "ninguno"]
  ]);
  $("#kv-calidad").innerHTML = rows([
    ["Decimales con coma y punto mezclados", "normalizados en el ETL"],
    ["% imp. interno con coma errónea (869.56)", nfAR.format(q.imp_int_coma_fix) + " filas corregidas a 8.6956"],
    ["Renglones con total nulo", nfAR.format(q.null_total_renglon) + " (excluidos de sumas)"],
    ["Renglones con precio nulo", nfAR.format(q.null_precio)],
    ["Ajustes contables (DIFERENCIAS/AJUSTES)", nfAR.format(q.ajustes_excluidos) + " renglones excluidos (" + fmtARS(D.ajustes.total) + ")"],
    ["Devoluciones y anulaciones (período)", fmtARS(Math.abs(C.T.dev)) + " · " + fmtPct(C.T.b ? Math.abs(C.T.dev) / C.T.b : 0) + " de bruto"],
    ["Línea BONIFICACION (promo)", nfAR.format(D.bonif.filas) + " renglones · " + fmtARS(D.bonif.total)],
    ["Índice no único (490.121)", "nunca usado como clave"],
    ["Vendedor 2º vacío", "53 % de los renglones"]
  ]);
  $("#kv-metricas").innerHTML = rows([
    ["Facturación neta", "Σ 'Total m. local' (base sin impuestos)"],
    ["Facturación bruta", "Σ 'Total renglón' (con IVA e imp. interno)"],
    ["Relación validada", "neto × (1 + IVA% + imp%) = bruto (96,5 % exacto)"],
    ["Volumen", "Σ 'Cantidad' (neto de devoluciones y bonos)"],
    ["Clientes activos", "únicos con ≥1 renglón en el período"],
    ["Documentos", "comprobantes únicos (Σ mensual = único en período)"],
    ["Ticket promedio", "neto ÷ documentos"],
    ["YoY", "mes 2026 vs mismo mes 2025 (solo meses con comparable)"],
    ["Ajustes contables", "excluidos de los cubes; ver gráfica del panel"]
  ]);
  newChart("ch-ajustes", {
    type: "bar",
    data: { labels: D.meta.mes_labels, datasets: [{ label: "Ajustes (bruto)", data: D.ajustes.mes,
      backgroundColor: "rgba(156,54,181,.55)", borderRadius: 4, maxBarThickness: 26 }] },
    options: baseOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtARS(c.parsed.y) } } } })
  });
  $("#gen-info").textContent = "gen. " + m.generado;
  $("#foot-gen").textContent = "Generado " + m.generado;
  $("#foot-src").textContent = m.fuente + " · " + nfAR.format(m.filas) + " renglones";
}

function renderModal() {
  const q = D.calidad;
  $("#modal-body").innerHTML = `
    <h4>1 · Fuente</h4>
    <p><b>${D.meta.fuente}</b> — ${nfAR.format(D.meta.filas)} renglones de venta (detalle de comprobantes),
    ${D.meta.mes_labels[0]} → ${D.meta.mes_labels[NM - 1]}. Origen XLSX del ERP (o CSV con separador ';',
    decimales con coma o punto, codificación Windows-1252).</p>
    <h4>2 · Limpieza aplicada en el ETL</h4>
    <ul>
      <li><span class="ok">✔</span> Decimales mixtos (coma/punto) normalizados.</li>
      <li><span class="ok">✔</span> ${nfAR.format(q.imp_int_coma_fix)} filas con "% imp. interno" = 869,56 (error de coma) corregidas a 8,6956.</li>
      <li><span class="ok">✔</span> ${nfAR.format(q.ajustes_excluidos)} renglones de <i>DIFERENCIAS/AJUSTES</i> (contables, usuario CASTILLO 2) excluidos de los cubes comerciales; se muestran en el panel Datos.</li>
      <li><span class="warn">⚠</span> ${nfAR.format(q.null_total_renglon)} renglones con total en blanco: no suman (impacto &lt;3 %).</li>
      ${PARC.size ? `<li><span class="warn">⚠</span> Meses parciales: ${parcialTexto()} — marcados en el tablero (barra naranja) y en el filtro de período.</li>` : ""}
    </ul>
    <h4>3 · Validaciones</h4>
    <ul>
      <li><span class="ok">✔</span> Fórmula <b>neto × (1 + IVA% + imp. int.%) = bruto</b> exacta en el 96,5 % de los renglones.</li>
      <li><span class="ok">✔</span> Sin filas 100 % duplicadas; 375 pares (documento, artículo) repetidos.</li>
      <li><span class="ok">✔</span> La columna <i>MES</i> coincide con <i>Fecha</i> como índice de temporada (1 = ${D.meta.mes_labels[0]}, ${NM} = ${D.meta.mes_labels[NM - 1]}); si faltara, el ETL la reconstruye desde la fecha.</li>
      <li><span class="warn">⚠</span> <i>Índice</i> no es único (490.121 de 751.435) → no se usa como clave.</li>
      <li><span class="warn">⚠</span> 1.075 renglones con precio unitario &gt; 100.000 (0,14 %) → las métricas de precio usan la mediana.</li>
    </ul>
    <h4>4 · Definiciones</h4>
    <ul>
      <li><b>Neto</b> = Σ Total m. local · <b>Bruto</b> = Σ Total renglón · <b>Vol.</b> = Σ Cantidad (neto de devoluciones/bonos)</li>
      <li><b>Devoluciones</b> = renglones con total negativo (NCW, NCI, anulaciones FVW)</li>
      <li><b>YoY</b> = mes 2026 vs mismo mes 2025; solo meses con comparable. "Clientes activos" usa el vendedor/provincia predominante del cliente (aproximado al combinar filtros).</li>
      <li>Los charts de <b>tipo de artículo / presentación / sabor / localidades</b> aplican solo el filtro de período (no tienen cruce por vendedor en el cube).</li>
    </ul>
    <h4>5 · Cómo actualizar</h4>
    <p>Subí el CSV nuevo al repo (rama de proyección) y corré
    <code>python3 scripts/procesar_proyeccion.py [ruta_csv_o_zip]</code>.
    El tablero se regenera con el nuevo <code>data/proyeccion.json</code>.</p>`;
}

/* ---------------- orquestador ---------------- */
function renderAll() {
  const C = computeAll();
  renderKPIs(C);
  if (state.tab === "general") renderGeneral(C);
  if (state.tab === "vendedores") renderVendedores(C);
  if (state.tab === "clientes") renderClientes();
  if (state.tab === "productos") renderProductos(C);
  if (state.tab === "territorio") renderTerritorio(C);
  if (state.tab === "datos") renderDatos(C);
  const notes = [];
  if (state.mes.size < NM) notes.push(`<b>Período:</b> ${state.mes.size} de ${NM} meses`);
  if (state.vnd.size < D.meta.vnds.length) notes.push(`<b>Vendedores:</b> ${state.vnd.size} seleccionados`);
  if (state.vnd2.size < D.meta.vnd2s.length) notes.push(`<b>Equipo (2º vendedor):</b> aplicado vía mapeo al vendedor principal`);
  if (state.prov.size < D.meta.provs.length) notes.push(`<b>Provincias:</b> ${state.prov.size}`);
  if (state.linea.size < D.meta.lineas.length) notes.push(`<b>Líneas:</b> ${state.linea.size}`);
  if (effVndIdx().size === 0) notes.push("<b>Sin datos</b> con los filtros actuales — revisá la combinación vendedor/equipo");
  $("#filter-note").innerHTML = notes.join(" · ");
  writeURL();
}

/* ---------------- init ---------------- */
/* Encabezado y notas al pie: se arman con lo que diga el JSON, no a mano. */
function pintarEncabezado() {
  const mL = D.meta.mes_labels;
  const sub = document.querySelector(".subtitle");
  if (sub) {
    const txt = `Detalle de ventas por renglón · ${mL[0]} → ${mL[NM - 1]} (${NM} meses de temporada)`;
    sub.childNodes[0].nodeValue = txt + " ";
  }
  const badge = document.getElementById("badge-parcial");
  if (badge) {
    if (PARC.size) {
      badge.textContent = "⚠ " + [...PARC.keys()].sort((a, b) => a - b)
        .map(m => mL[m]).join(", ") + " parcial" + (PARC.size > 1 ? "es" : "");
      badge.title = parcialTexto();
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }
  }
  const nota = document.getElementById("nota-parcial");
  if (nota) {
    nota.textContent = PARC.size
      ? "Meses parciales — " + parcialTexto() + ". Ajustes contables excluidos por defecto."
      : "Ajustes contables excluidos por defecto.";
  }
}

async function init() {
  try {
    D = await (await fetch("data/proyeccion.json", { cache: "no-cache" })).json();
  } catch (e) {
    document.body.innerHTML = "<div style='padding:40px;font-family:sans-serif'><h2>No se pudo cargar data/proyeccion.json</h2><p>Corré <code>python3 scripts/procesar_proyeccion.py</code> para regenerarlo.</p><p>" + e + "</p></div>";
    return;
  }
  NM = (D.meta.mes_labels && D.meta.mes_labels.length) || 20;
  PARC = new Map(Object.entries(D.meta.mes_parcial || {})
    .map(([k, v]) => [parseInt(k, 10) - 1, v])
    .filter(([i]) => i >= 0 && i < NM));
  pintarEncabezado();
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.color = "#4a5a6a";

  // defaults explícitos (todo seleccionado)
  fillSet(state.mes, NM);
  fillSet(state.vnd, D.meta.vnds.length);
  fillSet(state.vnd2, D.meta.vnd2s.length);
  fillSet(state.prov, D.meta.provs.length);
  fillSet(state.linea, D.meta.lineas.length);
  readURL(); // sobrescribe lo que traiga el hash

  const msMes = makeMS("ms-mes", D.meta.mes_labels.map((l, i) => esParcial(i) ? l + " ⚠" : l), state.mes);
  const msVnd = makeMS("ms-vnd", D.meta.vnds, state.vnd);
  const msVnd2 = makeMS("ms-vnd2", D.meta.vnd2s, state.vnd2);
  const msProv = makeMS("ms-prov", D.meta.provs, state.prov);
  const msLinea = makeMS("ms-linea", D.meta.lineas, state.linea);
  const msAll = [msMes, msVnd, msVnd2, msProv, msLinea];
  syncFilters = () => { msAll.forEach(x => x.refresh()); renderAll(); };

  document.querySelectorAll("[data-preset]").forEach(b => {
    b.onclick = () => {
      const p = b.dataset.preset;
      if (p === "full") fillSet(state.mes, NM);
      if (p === "2025") { state.mes.clear(); for (let i = 0; i < Math.min(12, NM); i++) state.mes.add(i); }
      if (p === "2026") { state.mes.clear(); for (let i = 12; i < NM; i++) state.mes.add(i); }
      if (p === "last6") { state.mes.clear(); for (let i = Math.max(0, NM - 6); i < NM; i++) state.mes.add(i); }
      syncFilters();
    };
  });
  $("#btn-reset").onclick = () => {
    fillSet(state.mes, NM); fillSet(state.vnd, D.meta.vnds.length);
    fillSet(state.vnd2, D.meta.vnd2s.length); fillSet(state.prov, D.meta.provs.length);
    fillSet(state.linea, D.meta.lineas.length);
    syncFilters();
  };
  $("#btn-compartir").onclick = async () => {
    writeURL();
    try { await navigator.clipboard.writeText(location.href); }
    catch (e) { prompt("Copiá el link:", location.href); }
    const b = $("#btn-compartir"); const old = b.textContent;
    b.textContent = "✔ Link copiado"; setTimeout(() => b.textContent = old, 1600);
  };
  $("#btn-metodologia").onclick = () => { $("#modal-metodologia").hidden = false; };
  $("#btn-modal-close").onclick = () => { $("#modal-metodologia").hidden = true; };
  $("#modal-metodologia").addEventListener("click", e => { if (e.target.id === "modal-metodologia") e.target.hidden = true; });

  document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
    state.tab = t.dataset.tab;
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
    document.querySelectorAll(".tabpane").forEach(p => p.classList.toggle("active", p.id === "pane-" + state.tab));
    renderAll();
  });
  const tEl = document.querySelector(`.tab[data-tab="${state.tab}"]`);
  if (tEl) {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    tEl.classList.add("active");
    document.querySelectorAll(".tabpane").forEach(p => p.classList.remove("active"));
    document.getElementById("pane-" + state.tab).classList.add("active");
  }

  $("#search-vnd").addEventListener("input", () => { const C = computeAll(); renderVendedores(C); });
  $("#search-cli").addEventListener("input", () => renderClientes());
  document.querySelectorAll("#tbl-vnd th").forEach(th => th.onclick = () => {
    const k = th.dataset.k; const s = state.sort["vnd"] || {};
    if (s.key === k) s.dir *= -1; else s = { key: k, dir: -1 };
    state.sort["vnd"] = s;
    const C = computeAll(); renderVendedores(C);
  });
  $("#btn-cli-close").onclick = () => { $("#cli-detail").hidden = true; };

  renderModal();
  renderAll();
}
init();
