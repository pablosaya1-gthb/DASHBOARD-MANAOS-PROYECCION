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
  esc: "base",         // escenario de proyección: cons | base | opt
  hz: 6,               // horizonte de proyección en meses
  win: 3,              // ventana (meses) para las alertas de clientes
  drop: 0.35,          // caída mínima para marcar "en riesgo"
  cat: "todas",        // categoría de alerta mostrada
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
  /* Series completas (TODOS los meses, ignorando el filtro de período): las usa
     la pestaña Proyección, que necesita la historia entera para estimar. */
  const perMesAll = range(NM).map(() => ({ b: 0, n: 0, v: 0 }));
  const vndMes = new Map();     // vi -> [neto por mes]
  const linMes = new Map();     // li -> [neto por mes]
  const perVnd = new Map(), perProv = new Map(), perLinea = new Map();
  const C1 = D.C1;
  for (let m = 0; m < NM; m++) {
    const sel = mesSet.has(m);
    for (const vi of eff) {
      for (const pi of provSet) {
        const prow = C1[m][vi][pi];
        for (const li of lineSet) {
          const c = prow[li];
          if (!c || (c[0] === 0 && c[1] === 0 && c[2] === 0)) continue;
          const pma = perMesAll[m];
          pma.b += c[0]; pma.n += c[1]; pma.v += c[2];
          let sv = vndMes.get(vi); if (!sv) { sv = range(NM).map(() => 0); vndMes.set(vi, sv); }
          sv[m] += c[1];
          let sl = linMes.get(li); if (!sl) { sl = range(NM).map(() => 0); linMes.set(li, sl); }
          sl[m] += c[1];
          if (!sel) continue;
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
  return { T, perMes, perMesAll, vndMes, linMes, perVnd, perProv, perLinea, docs, docsVnd, cliAct, cliMes, eff };
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
  if (state.esc !== "base") p.push("esc=" + state.esc);
  if (state.hz !== 6) p.push("hz=" + state.hz);
  if (state.win !== 3) p.push("win=" + state.win);
  if (state.drop !== 0.35) p.push("drop=" + state.drop);
  if (state.cat !== "todas") p.push("cat=" + state.cat);
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
  if (g.esc) state.esc = g.esc;
  if (g.hz) state.hz = parseInt(g.hz, 10) || 6;
  if (g.win) state.win = parseInt(g.win, 10) || 3;
  if (g.drop) state.drop = parseFloat(g.drop) || 0.35;
  if (g.cat) state.cat = g.cat;
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

/* ================= PROYECCIÓN (forecast) =================
   Método: estacionalidad del año anterior × ritmo de crecimiento reciente.
     ritmo (g) = Σ neto de los últimos K meses comparables ÷ Σ del mismo
                 período del año anterior  (K = 3, sin meses parciales)
     proyección(mes) = neto del mismo mes del año anterior × g
   Escenarios: base = g ponderado · conservador = peor YoY reciente ·
               optimista = mejor YoY reciente (acotados a ±50 %).      */
const MESES_CORTOS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

function siguienteLabel(label, pasos) {
  const m = /^([A-Za-zÁÉÍÓÚáéíóú]{3})\s*(\d{2,4})$/.exec((label || "").trim());
  if (!m) return "+" + pasos;
  let mi = MESES_CORTOS.findIndex(x => x.toLowerCase() === m[1].toLowerCase());
  let y = parseInt(m[2], 10);
  if (mi < 0) return "+" + pasos;
  mi += pasos;
  y += Math.floor(mi / 12);
  mi = ((mi % 12) + 12) % 12;
  return `${MESES_CORTOS[mi]} ${String(y).padStart(2, "0").slice(-2)}`;
}

/* cobertura de días de un mes parcial (0..1); usa serie[m].dias si el ETL lo trae */
function coberturaMes(m) {
  const d = (D.serie[m] || {}).dias;
  if (d && d.dm) return Math.min(1, (d.d2 - d.d1 + 1) / d.dm);
  const txt = (D.meta.mes_parcial || {})[m + 1] || "";
  const desde = /desde el (\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(txt);
  if (desde) {
    const dia = +desde[1], mes = +desde[2], anio = +desde[3];
    const dm = new Date(anio, mes, 0).getDate();
    return Math.min(1, (dm - dia + 1) / dm);
  }
  const hasta = /hasta el (\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(txt);
  if (hasta) {
    const dia = +hasta[1], mes = +hasta[2], anio = +hasta[3];
    return Math.min(1, dia / new Date(anio, mes, 0).getDate());
  }
  return 1;
}

/* último mes con datos (el parcial cuenta como dato, pero se avisa) */
function ultimoMesConDatos(vals) {
  for (let m = NM - 1; m >= 0; m--) if (vals[m] > 0) return m;
  return -1;
}

function ritmos(vals, last, K = 3) {
  const yoy = [];
  for (let m = last; m >= 0 && yoy.length < 6; m--) {
    if (m < 12 || esParcial(m)) continue;
    if (vals[m] > 0 && vals[m - 12] > 0) yoy.push({ m, r: vals[m] / vals[m - 12] });
  }
  const usados = yoy.slice(0, K);
  let g = null;
  if (usados.length) {
    const num = usados.reduce((a, x) => a + vals[x.m], 0);
    const den = usados.reduce((a, x) => a + vals[x.m - 12], 0);
    g = den > 0 ? num / den : null;
  }
  if (g == null) {                       // sin comparable: tendencia de 3 meses
    const ult = [], prev = [];
    for (let m = last; m > last - 3 && m >= 0; m--) if (!esParcial(m)) ult.push(vals[m]);
    for (let m = last - 3; m > last - 6 && m >= 0; m--) if (!esParcial(m)) prev.push(vals[m]);
    const a = ult.reduce((x, y) => x + y, 0), b = prev.reduce((x, y) => x + y, 0);
    g = b > 0 ? a / b : 1;
  }
  const clamp = x => Math.max(0.5, Math.min(1.5, x));
  const rs = yoy.map(x => x.r);
  return {
    base: clamp(g),
    cons: clamp(rs.length ? Math.min(...rs) : g * 0.9),
    opt: clamp(rs.length ? Math.max(...rs) : g * 1.1),
    n: usados.length, yoy
  };
}

/* Proyecta H meses hacia adelante. Devuelve series por escenario. */
function proyectar(vals, H) {
  const last = ultimoMesConDatos(vals);
  if (last < 0) return null;
  const g = ritmos(vals, last);
  const real = vals.slice(0, last + 1);
  // el mes parcial se completa a ritmo diario para no ensuciar la proyección
  const cob = esParcial(last) ? coberturaMes(last) : 1;
  const realAjust = real.slice();
  if (cob < 1 && cob > 0) realAjust[last] = real[last] / cob;

  const out = {};
  for (const esc of ["cons", "base", "opt"]) {
    const ext = realAjust.slice();
    for (let h = 1; h <= H; h++) {
      const t = last + h;
      const ref = t - 12;
      let base;
      if (ref >= 0 && ref < ext.length && ext[ref] > 0) base = ext[ref];
      else {
        const ult3 = ext.slice(Math.max(0, ext.length - 3)).filter(x => x > 0);
        base = ult3.length ? ult3.reduce((a, b) => a + b, 0) / ult3.length : 0;
      }
      ext[t] = base * g[esc];
    }
    out[esc] = ext;
  }
  const labels = range(last + 1 + H).map(i => i <= last ? D.meta.mes_labels[i]
    : siguienteLabel(D.meta.mes_labels[last], i - last));
  return { last, g, labels, real, realAjust, cob, esc: out, H };
}

function sumaRango(arr, desde, hasta) {
  let s = 0;
  for (let i = desde; i <= hasta && i < arr.length; i++) if (i >= 0) s += arr[i] || 0;
  return s;
}

function renderProyeccion(C) {
  const vals = C.perMesAll.map(x => x.n);
  const H = state.hz;
  const P = proyectar(vals, H);
  const cont = $("#proj-kpis");
  if (!P || P.last < 0) {
    cont.innerHTML = `<div class="kpi"><div class="kpi-label">Sin datos</div><div class="kpi-value">—</div>
      <div class="kpi-sub">Los filtros actuales no dejan meses con ventas.</div></div>`;
    ["ch-proy", "ch-proyacum"].forEach(id => newChart(id, { type: "line", data: { labels: [], datasets: [] } }));
    $("#tb-proy").innerHTML = ""; $("#tb-proyvnd").innerHTML = ""; $("#tb-proylin").innerHTML = "";
    return;
  }
  const esc = state.esc;
  const serieEsc = P.esc[esc];
  const proyTot = sumaRango(serieEsc, P.last + 1, P.last + H);
  const proyBase = sumaRango(P.esc.base, P.last + 1, P.last + H);
  const proyCons = sumaRango(P.esc.cons, P.last + 1, P.last + H);
  const proyOpt = sumaRango(P.esc.opt, P.last + 1, P.last + H);
  const anioAnt = sumaRango(P.realAjust, P.last + 1 - 12, P.last - 12 + H);
  const ultH = sumaRango(P.realAjust, P.last - H + 1, P.last);
  const dif = anioAnt > 0 ? (proyTot - anioAnt) / anioAnt : null;
  const gPct = (P.g[esc] - 1);

  const kpis = [
    { l: `Proyección ${H} meses`, v: fmtARS(proyTot),
      s: `${P.labels[P.last + 1]} → ${P.labels[P.last + H]} · escenario ${esc === "base" ? "base" : esc === "cons" ? "conservador" : "optimista"}` },
    { l: "vs mismos meses año ant.", v: dif == null ? "—" : fmtPct(dif, true),
      s: `año anterior: ${fmtARS(anioAnt)}`, cls: dif == null ? "" : (dif >= 0 ? "" : "neg") },
    { l: "Ritmo aplicado", v: fmtPct(gPct, true),
      s: `sobre el mismo mes del año anterior (${P.g.n} meses de base)` },
    { l: "Rango de escenarios", v: `${fmtARS(proyCons)} – ${fmtARS(proyOpt)}`,
      s: `base ${fmtARS(proyBase)}` },
    { l: `Últimos ${H} meses reales`, v: fmtARS(ultH),
      s: `promedio mensual ${fmtARS(ultH / H)}` },
  ];
  if (P.cob < 1) {
    kpis.push({ l: `Cierre estimado ${D.meta.mes_labels[P.last]}`, v: fmtARS(P.realAjust[P.last]),
      s: `mes parcial: ${fmtARS(P.real[P.last])} cargado (${fmtPct(P.cob)} del mes)` });
  }
  cont.innerHTML = kpis.map(k => `<div class="kpi"><div class="kpi-label">${k.l}</div>
    <div class="kpi-value ${k.cls || ""}">${k.v}</div><div class="kpi-sub">${k.s}</div></div>`).join("");

  $("#proj-note").innerHTML = `Estacionalidad del año anterior × ritmo reciente
    (últimos ${P.g.n || 3} meses comparables). <b>No usa el filtro de período</b>: siempre parte de
    la historia completa. Último mes con datos: <b>${D.meta.mes_labels[P.last]}</b>${P.cob < 1
      ? ` (parcial, completado a ritmo diario)` : ""}.`;

  // ---- chart real vs proyectado ----
  const lab = P.labels;
  const realArr = lab.map((_, i) => i <= P.last ? P.real[i] : null);
  const ajusteArr = lab.map((_, i) => (i === P.last && P.cob < 1) ? P.realAjust[i] - P.real[i] : null);
  const proyArr = lab.map((_, i) => i > P.last ? serieEsc[i] : null);
  const bandaBaja = lab.map((_, i) => i > P.last ? P.esc.cons[i] : null);
  const bandaAlta = lab.map((_, i) => i > P.last ? P.esc.opt[i] : null);
  const anteriorArr = lab.map((_, i) => (i - 12 >= 0 && i - 12 <= P.last) ? P.realAjust[i - 12] : null);
  newChart("ch-proy", {
    type: "bar",
    data: {
      labels: lab,
      datasets: [
        { type: "bar", label: "Real", data: realArr, backgroundColor: "rgba(15,76,129,.8)", borderRadius: 4, maxBarThickness: 26, stack: "r" },
        { type: "bar", label: "Completado (mes parcial)", data: ajusteArr, backgroundColor: "rgba(15,76,129,.28)", borderRadius: 4, maxBarThickness: 26, stack: "r" },
        { type: "bar", label: "Proyectado", data: proyArr, backgroundColor: "rgba(232,137,12,.75)", borderColor: "#e8590c", borderWidth: 1, borderRadius: 4, maxBarThickness: 26, stack: "r" },
        { type: "line", label: "Escenario conservador", data: bandaBaja, borderColor: "#adb5bd", borderDash: [4, 4], pointRadius: 0, tension: .25 },
        { type: "line", label: "Escenario optimista", data: bandaAlta, borderColor: "#2f9e44", borderDash: [4, 4], pointRadius: 0, tension: .25 },
        { type: "line", label: "Mismo mes año anterior", data: anteriorArr, borderColor: "#1098ad", pointRadius: 2, tension: .25, borderWidth: 1.5 }
      ]
    },
    options: baseOpts({ plugins: { legend: { labels: { boxWidth: 12, font: { size: 10.5 } } },
      tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y == null ? "—" : fmtARS(c.parsed.y)}` } } },
      scales: { x: { stacked: true, ticks: { font: { size: 10 }, maxRotation: 60 }, grid: { display: false } },
                y: { stacked: true, ticks: { font: { size: 10.5 }, callback: v => fmtARS(v) }, grid: { color: "#edf1f5" } } } })
  });

  // ---- acumulado móvil 12 meses ----
  const roll = (arr, hasta) => lab.map((_, i) => {
    if (i < 11 || i > hasta) return null;
    let s = 0; for (let k = i - 11; k <= i; k++) s += arr[k] || 0;
    return s;
  });
  newChart("ch-proyacum", {
    type: "line",
    data: { labels: lab, datasets: [
      { label: "Real (12 meses móviles)", data: roll(P.realAjust, P.last), borderColor: "#0f4c81", backgroundColor: "rgba(15,76,129,.1)", fill: true, tension: .25, pointRadius: 2 },
      { label: "Con proyección base", data: roll(P.esc.base, lab.length - 1).map((v, i) => i > P.last ? v : null), borderColor: "#e8890c", borderDash: [5, 4], tension: .25, pointRadius: 2 },
      { label: "Conservador", data: roll(P.esc.cons, lab.length - 1).map((v, i) => i > P.last ? v : null), borderColor: "#adb5bd", borderDash: [3, 3], tension: .25, pointRadius: 0 },
      { label: "Optimista", data: roll(P.esc.opt, lab.length - 1).map((v, i) => i > P.last ? v : null), borderColor: "#2f9e44", borderDash: [3, 3], tension: .25, pointRadius: 0 }
    ] },
    options: baseOpts({ plugins: { legend: { labels: { boxWidth: 12, font: { size: 10.5 } } } } })
  });

  // ---- tabla mes a mes ----
  $("#tb-proy").innerHTML = range(H).map(h => {
    const t = P.last + 1 + h;
    const prev = (t - 12 >= 0 && t - 12 < P.esc.base.length) ? P.esc.base[t - 12] : null;
    const b = P.esc.base[t];
    const d = prev > 0 ? (b - prev) / prev : null;
    return `<tr><td><b>${lab[t]}</b></td><td class="num">${prev ? fmtARS(prev) : "—"}</td>
      <td class="num mut">${fmtARS(P.esc.cons[t])}</td><td class="num"><b>${fmtARS(b)}</b></td>
      <td class="num mut">${fmtARS(P.esc.opt[t])}</td>
      <td class="num ${yoyClass(d)}">${d == null ? "—" : fmtPct(d, true)}</td></tr>`;
  }).join("");

  // ---- proyección por vendedor ----
  const filas = [...C.vndMes.entries()].map(([vi, serie]) => {
    const p = proyectar(serie, H);
    if (!p) return null;
    const proy = sumaRango(p.esc[esc], p.last + 1, p.last + H);
    const ult = sumaRango(p.realAjust, p.last - H + 1, p.last);
    return { name: D.meta.vnds[vi], proy, ult, d: ult > 0 ? (proy - ult) / ult : null, g: p.g[esc] - 1 };
  }).filter(Boolean).sort((a, b) => b.proy - a.proy);
  const totProy = filas.reduce((a, x) => a + x.proy, 0) || 1;
  $("#tb-proyvnd").innerHTML = filas.slice(0, 15).map(r => `
    <tr><td><b>${r.name}</b></td><td class="num">${fmtARS(r.ult)}</td>
    <td class="num"><b>${fmtARS(r.proy)}</b></td>
    <td class="num ${yoyClass(r.d)}">${r.d == null ? "—" : fmtPct(r.d, true)}</td>
    <td class="num ${yoyClass(r.g)}">${fmtPct(r.g, true)}</td></tr>`).join("");

  // ---- proyección por línea ----
  const flin = [...C.linMes.entries()].map(([li, serie]) => {
    const p = proyectar(serie, H);
    if (!p) return null;
    const proy = sumaRango(p.esc[esc], p.last + 1, p.last + H);
    const ult = sumaRango(p.realAjust, p.last - H + 1, p.last);
    return { name: D.meta.lineas[li], proy, ult, d: ult > 0 ? (proy - ult) / ult : null };
  }).filter(Boolean).sort((a, b) => b.proy - a.proy);
  const totLin = flin.reduce((a, x) => a + Math.max(0, x.proy), 0) || 1;
  $("#tb-proylin").innerHTML = flin.map(r => `
    <tr><td><b>${r.name}</b></td><td class="num">${fmtARS(r.ult)}</td>
    <td class="num"><b>${fmtARS(r.proy)}</b></td>
    <td class="num ${yoyClass(r.d)}">${r.d == null ? "—" : fmtPct(r.d, true)}</td>
    <td class="num">${fmtPct(Math.max(0, r.proy) / totLin)}</td></tr>`).join("");
}

/* ================= ALERTAS de clientes ================= */
const CATS = {
  perdido: { lbl: "Perdido", cls: "bad" },
  riesgo: { lbl: "En riesgo", cls: "warn" },
  recuperado: { lbl: "Recuperado", cls: "info" },
  nuevo: { lbl: "Nuevo", cls: "new" },
  creciendo: { lbl: "Creciendo", cls: "good" },
  estable: { lbl: "Estable", cls: "mut" }
};

function calcAlertas() {
  const W = state.win, DROP = state.drop;
  const vals = D.serie.map(x => x.n);
  let last = ultimoMesConDatos(vals);
  if (last < 0) return { rows: [], last, W };
  const act0 = last - W + 1, prev0 = last - 2 * W + 1;
  const rows = filteredClients().map(c => {
    let act = 0, prev = 0, tot = 0;
    for (let m = 0; m < NM; m++) {
      const b = c.h[m][0];
      tot += b;
      if (m >= act0 && m <= last) act += b;
      else if (m >= prev0 && m < act0) prev += b;
    }
    const delta = act - prev;
    const pct = prev > 0 ? delta / prev : (act > 0 ? null : null);
    const firstIdx = c.first - 1;
    let cat = "estable";
    if (act === 0 && prev > 0) cat = "perdido";
    else if (act > 0 && firstIdx >= act0) cat = "nuevo";
    else if (act > 0 && prev === 0) cat = "recuperado";
    else if (prev > 0 && pct != null && pct <= -DROP) cat = "riesgo";
    else if (prev > 0 && pct != null && pct >= DROP) cat = "creciendo";
    return { c: c.c, vnd: c.vnd || "—", prov: c.prov || "—", last: c.last,
      lastLbl: D.meta.mes_labels[c.last - 1] || "—", act, prev, delta, pct, tot, cat };
  }).filter(r => r.tot !== 0);
  return { rows, last, W, act0, prev0 };
}

function renderAlertas() {
  const A = calcAlertas();
  const mL = D.meta.mes_labels;
  if (A.last < 0) { $("#alert-kpis").innerHTML = ""; $("#tb-alert").innerHTML = ""; return; }
  const rango = (a, b) => `${mL[Math.max(0, a)]} → ${mL[b]}`;
  $("#alert-note").innerHTML = `Compara <b>${rango(A.act0, A.last)}</b> contra
    <b>${rango(A.prev0, A.act0 - 1)}</b> (bruto por cliente). Respeta los filtros de vendedor,
    2º vendedor y provincia; <b>no</b> el de período. Última compra según la temporada completa.`;

  const por = k => A.rows.filter(r => r.cat === k);
  const suma = arr => arr.reduce((a, r) => a + r.prev - r.act, 0);
  const perdidos = por("perdido"), riesgo = por("riesgo"),
        recup = por("recuperado"), nuevos = por("nuevo"), crec = por("creciendo");
  const kpis = [
    { l: "Clientes perdidos", v: fmtInt(perdidos.length), s: `dejaron de comprar · ${fmtARS(suma(perdidos))} menos`, cls: "neg" },
    { l: "En riesgo", v: fmtInt(riesgo.length), s: `caen más de ${fmtPct(state.drop)} · ${fmtARS(suma(riesgo))} menos`, cls: "neg" },
    { l: "Recuperados", v: fmtInt(recup.length), s: `volvieron a comprar · ${fmtARS(-suma(recup))} más` },
    { l: "Nuevos", v: fmtInt(nuevos.length), s: `primera compra en la ventana · ${fmtARS(recup.length ? -suma(nuevos) : -suma(nuevos))}` },
    { l: "Creciendo", v: fmtInt(crec.length), s: `suben más de ${fmtPct(state.drop)} · ${fmtARS(-suma(crec))} más` },
    { l: "Saldo de la ventana", v: fmtARS(-suma(A.rows)), s: "diferencia total contra la ventana previa" }
  ];
  $("#alert-kpis").innerHTML = kpis.map(k => `<div class="kpi"><div class="kpi-label">${k.l}</div>
    <div class="kpi-value">${k.v}</div><div class="kpi-sub">${k.s}</div></div>`).join("");

  // top caídas
  const caidas = A.rows.filter(r => r.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 12);
  newChart("ch-caidas", {
    type: "bar",
    data: { labels: caidas.map(r => shortName(r.c)), datasets: [{ data: caidas.map(r => -r.delta),
      backgroundColor: caidas.map(r => r.cat === "perdido" ? "rgba(214,51,108,.75)" : "rgba(232,137,12,.75)"),
      borderRadius: 4, maxBarThickness: 20 }] },
    options: baseOpts({ indexAxis: "y",
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: c => `pierde ${fmtARS(c.parsed.x)}`,
        afterLabel: c => CATS[caidas[c.dataIndex].cat].lbl } } },
      scales: { x: { ticks: { callback: v => fmtARS(v), font: { size: 10.5 } }, grid: { color: "#edf1f5" } },
                y: { ticks: { font: { size: 10 } }, grid: { display: false } } } })
  });

  // perdidos / en riesgo por vendedor
  const porVnd = new Map();
  for (const r of A.rows) {
    if (r.cat !== "perdido" && r.cat !== "riesgo") continue;
    let o = porVnd.get(r.vnd); if (!o) { o = { p: 0, r: 0 }; porVnd.set(r.vnd, o); }
    if (r.cat === "perdido") o.p++; else o.r++;
  }
  const vs = [...porVnd.entries()].sort((a, b) => (b[1].p + b[1].r) - (a[1].p + a[1].r)).slice(0, 12);
  newChart("ch-alertvnd", {
    type: "bar",
    data: { labels: vs.map(([n]) => shortName(n)), datasets: [
      { label: "Perdidos", data: vs.map(([, o]) => o.p), backgroundColor: "rgba(214,51,108,.8)", stack: "a", maxBarThickness: 20 },
      { label: "En riesgo", data: vs.map(([, o]) => o.r), backgroundColor: "rgba(232,137,12,.8)", stack: "a", maxBarThickness: 20 }
    ] },
    options: baseOpts({ indexAxis: "y",
      scales: { x: { stacked: true, ticks: { font: { size: 10.5 } }, grid: { color: "#edf1f5" } },
                y: { stacked: true, ticks: { font: { size: 10 } }, grid: { display: false } } } })
  });

  renderAlertTable(A);
}

let ALERT_VIEW = [];
function renderAlertTable(A) {
  const q = ($("#search-alert").value || "").toLowerCase();
  let rows = A.rows.filter(r => (state.cat === "todas" ? r.cat !== "estable" : r.cat === state.cat));
  if (q) rows = rows.filter(r => r.c.toLowerCase().includes(q) || (r.vnd || "").toLowerCase().includes(q));
  const s = state.sort["alert"] || { key: "delta", dir: 1 };
  rows.sort((a, b) => {
    const av = a[s.key], bv = b[s.key];
    if (typeof av === "string" || typeof bv === "string")
      return String(av ?? "").localeCompare(String(bv ?? "")) * s.dir;
    return ((av ?? -Infinity) - (bv ?? -Infinity)) * s.dir;
  });
  ALERT_VIEW = rows;
  $("#tb-alert").innerHTML = rows.slice(0, 200).map(r => `
    <tr><td><b>${r.c}</b></td><td><span class="tag ${CATS[r.cat].cls}">${CATS[r.cat].lbl}</span></td>
    <td>${r.vnd}</td><td>${r.prov}</td><td>${r.lastLbl}</td>
    <td class="num">${fmtARS(r.act)}</td><td class="num">${fmtARS(r.prev)}</td>
    <td class="num ${r.delta < 0 ? "negc" : "pos"}">${fmtARS(r.delta)}</td>
    <td class="num ${yoyClass(r.pct)}">${r.pct == null ? "—" : fmtPct(r.pct, true)}</td>
    <td class="num">${fmtARS(r.tot)}</td></tr>`).join("");
  $("#alert-count").textContent = `${rows.length} cliente(s)` +
    (rows.length > 200 ? " — se muestran los primeros 200 (el CSV baja todos)" : "");
}

function descargarAlertasCSV() {
  const head = ["Cliente", "Estado", "Vendedor", "Provincia", "Ultima compra",
    "Ventana actual", "Ventana previa", "Delta $", "Delta %", "Total temporada"];
  const linea = r => [r.c, CATS[r.cat].lbl, r.vnd, r.prov, r.lastLbl,
    Math.round(r.act), Math.round(r.prev), Math.round(r.delta),
    r.pct == null ? "" : (r.pct * 100).toFixed(1).replace(".", ","), Math.round(r.tot)]
    .map(x => `"${String(x).replace(/"/g, '""')}"`).join(";");
  const csv = "\uFEFF" + [head.join(";"), ...ALERT_VIEW.map(linea)].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = `alertas-clientes-${state.cat}-${state.win}m.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ================= Equipos (2º vendedor) ================= */
function renderEquipos() {
  const filas = D.meta.vnd2s.map((name, i) => {
    let b = 0, v = 0, cur = 0, prev = 0;
    for (const m of state.mes) {
      const c = D.C3[m][i];
      if (!c) continue;
      b += c[0]; v += c[1];
      if (is2026(m)) { cur += c[0]; prev += D.C3[m - 12][i] ? D.C3[m - 12][i][0] : 0; }
    }
    return { name, b, v, yoy: prev > 0 ? (cur - prev) / prev : null,
      vnds: (D.meta.vnd2_to_vnds[name] || []) };
  }).filter(r => r.b !== 0).sort((a, b) => b.b - a.b);
  const tot = filas.reduce((a, x) => a + x.b, 0) || 1;
  const top = filas.slice(0, 12);
  newChart("ch-eqrank", {
    type: "bar",
    data: { labels: top.map(r => shortName(r.name)), datasets: [{ data: top.map(r => r.b),
      backgroundColor: top.map((r, i) => PALETTE[i % PALETTE.length] + "cc"), borderRadius: 4, maxBarThickness: 18 }] },
    options: baseOpts({ indexAxis: "y",
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtARS(c.parsed.x) } } },
      scales: { x: { ticks: { callback: v => fmtARS(v), font: { size: 10.5 } }, grid: { color: "#edf1f5" } },
                y: { ticks: { font: { size: 10 } }, grid: { display: false } } } })
  });
  $("#tb-eq").innerHTML = filas.map(r => `
    <tr><td><b>${r.name}</b></td><td class="num">${fmtARS(r.b)}</td>
    <td class="num ${yoyClass(r.yoy)}">${r.yoy == null ? "—" : fmtPct(r.yoy, true)}</td>
    <td class="num">${fmtInt(r.v)}</td><td class="num">${fmtPct(r.b / tot)}</td>
    <td class="mut small">${r.vnds.length ? r.vnds.join(", ") : "—"}</td></tr>`).join("");
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
  if (state.tab === "proyeccion") renderProyeccion(C);
  if (state.tab === "vendedores") { renderVendedores(C); renderEquipos(); }
  if (state.tab === "clientes") renderClientes();
  if (state.tab === "alertas") renderAlertas();
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

  /* --- controles de Proyección y Alertas --- */
  const chipGroup = (sel, attr, apply) => {
    const cont = document.querySelector(sel);
    if (!cont) return;
    cont.querySelectorAll(".chip").forEach(b => {
      b.onclick = () => {
        cont.querySelectorAll(".chip").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        apply(b.dataset[attr]);
        writeURL();
        renderAll();
      };
    });
  };
  const marcarChip = (sel, attr, val) => {
    const cont = document.querySelector(sel);
    if (!cont) return;
    cont.querySelectorAll(".chip").forEach(b =>
      b.classList.toggle("active", String(b.dataset[attr]) === String(val)));
  };
  chipGroup("#esc-ctrl", "esc", v => state.esc = v);
  chipGroup("#hz-ctrl", "hz", v => state.hz = parseInt(v, 10));
  chipGroup("#win-ctrl", "win", v => state.win = parseInt(v, 10));
  chipGroup("#drop-ctrl", "drop", v => state.drop = parseFloat(v));
  chipGroup("#cat-ctrl", "cat", v => state.cat = v);
  marcarChip("#esc-ctrl", "esc", state.esc);
  marcarChip("#hz-ctrl", "hz", state.hz);
  marcarChip("#win-ctrl", "win", state.win);
  marcarChip("#drop-ctrl", "drop", state.drop);
  marcarChip("#cat-ctrl", "cat", state.cat);
  $("#search-alert").addEventListener("input", () => renderAlertas());
  $("#btn-alert-csv").onclick = () => descargarAlertasCSV();
  document.querySelectorAll("#tbl-alert th").forEach(th => th.onclick = () => {
    const k = th.dataset.k; let s2 = state.sort["alert"] || {};
    if (s2.key === k) s2.dir *= -1; else s2 = { key: k, dir: -1 };
    state.sort["alert"] = s2;
    renderAlertas();
  });

  $("#search-vnd").addEventListener("input", () => { const C = computeAll(); renderVendedores(C); });
  $("#search-cli").addEventListener("input", () => renderClientes());
  document.querySelectorAll("#tbl-vnd th").forEach(th => th.onclick = () => {
    const k = th.dataset.k; let s = state.sort["vnd"] || {};
    if (s.key === k) s.dir *= -1; else s = { key: k, dir: -1 };
    state.sort["vnd"] = s;
    const C = computeAll(); renderVendedores(C);
  });
  $("#btn-cli-close").onclick = () => { $("#cli-detail").hidden = true; };

  renderModal();
  renderAll();
}
init();
