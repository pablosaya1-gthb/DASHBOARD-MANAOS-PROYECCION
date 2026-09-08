/* ------------------------------------------------------------------
   Test de humo del front-end (sin navegador)
   ------------------------------------------------------------------
   Levanta index.html en un DOM simulado (jsdom), stubbea Chart.js y
   ejecuta app.js contra el data/proyeccion.json real. Verifica que el
   tablero renderice KPIs, tablas y charts sin errores de JS.

   Uso:
     npm install jsdom           (una sola vez, fuera del repo si preferís)
     node scripts/test_ui.mjs
------------------------------------------------------------------ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.log("Falta jsdom:  npm install jsdom   (test omitido)");
  process.exit(0);
}

const fallos = [];
const chk = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FALLA ") + msg);
  if (!cond) fallos.push(msg);
};

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const appjs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const datos = fs.readFileSync(path.join(ROOT, "data", "proyeccion.json"), "utf8");
const D = JSON.parse(datos);

const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" });
const { window } = dom;

// --- stubs: Chart.js y canvas (jsdom no dibuja) ---
const charts = [];
class ChartStub {
  constructor(ctx, cfg) { this.cfg = cfg; charts.push(cfg); }
  destroy() {}
  update() {}
}
ChartStub.defaults = { font: {}, color: "" };
window.Chart = ChartStub;
window.HTMLCanvasElement.prototype.getContext = () => ({ createLinearGradient: () => ({ addColorStop() {} }) });
window.fetch = async () => ({ json: async () => JSON.parse(datos) });
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));

const errores = [];
window.addEventListener("error", e => errores.push(String(e.error || e.message)));
window.onerror = (m) => errores.push(String(m));

console.log("Ejecutando app.js sobre data/proyeccion.json…");
window.eval(appjs);
await new Promise(r => setTimeout(r, 400));   // init() es async

const doc = window.document;
const txt = sel => (doc.querySelector(sel)?.textContent || "").trim();

chk(errores.length === 0, `sin errores de JS ${errores.length ? "→ " + errores[0] : ""}`);
chk(!doc.body.innerHTML.includes("No se pudo cargar"), "el JSON de datos cargó");
chk(charts.length >= 5, `${charts.length} charts construidos en la pestaña General`);

const NM = D.meta.mes_labels.length;
chk(txt(".subtitle").includes(`${D.meta.mes_labels[0]} → ${D.meta.mes_labels[NM - 1]}`),
  `subtítulo con el rango real (${txt(".subtitle").slice(0, 70)}…)`);
const badge = txt("#badge-parcial");
const hayParcial = Object.keys(D.meta.mes_parcial || {}).length > 0;
chk(hayParcial ? badge.includes("parcial") : true, `badge de mes parcial: "${badge}"`);

const kpi = txt("#k-neto");
chk(kpi && kpi !== "—", `KPI facturación neta = ${kpi}`);
chk(txt("#k-vol") !== "" && txt("#k-vol") !== "—", `KPI volumen = ${txt("#k-vol")}`);
chk(doc.querySelectorAll("#ms-mes .ms-item").length === NM,
  `filtro de período con ${NM} meses`);
const marcados = [...doc.querySelectorAll("#ms-mes .ms-item span")].filter(s => s.textContent.includes("⚠")).length;
chk(marcados === Object.keys(D.meta.mes_parcial || {}).length,
  `${marcados} mes(es) marcados como parciales en el filtro`);

// serie mensual: primer chart debe traer NM labels y datos numéricos
const serie = charts[0];
chk(serie.data.labels.length === NM, `chart de serie con ${serie.data.labels.length} meses`);
const suma = serie.data.datasets[0].data.reduce((a, b) => a + (b || 0), 0);
const esperado = D.serie.reduce((a, x) => a + x.n, 0);
chk(Math.abs(suma - esperado) / Math.abs(esperado) < 1e-6,
  `neto del chart = neto del JSON (${Math.round(suma).toLocaleString("es-AR")})`);

// tablas de las otras pestañas
for (const tab of ["vendedores", "clientes", "productos", "territorio", "datos"]) {
  const btn = doc.querySelector(`.tab[data-tab="${tab}"]`);
  if (!btn) { chk(false, `existe la pestaña ${tab}`); continue; }
  const antes = charts.length;
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const pane = doc.querySelector(`#pane-${tab}`);
  const ok = !!pane && pane.classList.contains("active") &&
             (charts.length > antes || pane.textContent.replace(/\s/g, "").length > 200);
  chk(ok, `pestaña ${tab} renderiza (${charts.length - antes} charts, ${pane ? pane.textContent.replace(/\s/g, "").length : 0} chars)`);
}
chk(errores.length === 0, `sin errores de JS al recorrer las pestañas ${errores.length ? "→ " + errores[0] : ""}`);

console.log("\n" + (fallos.length ? `${fallos.length} FALLAS ✘` : "TODO OK ✔"));
process.exit(fallos.length ? 1 : 0);
