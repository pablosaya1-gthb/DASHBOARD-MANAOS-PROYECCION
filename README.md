# Manaos · Proyección Larga 2025-26 — Dashboard comercial

Dashboard web **estático, interactivo y responsive** sobre el detalle de ventas (renglones de
comprobantes) de la temporada **Ene 2025 → Ago 2026** (20 meses).

> ⚠️ **No confundir con el proyecto de PROGRESIÓN** (tableros mensuales por equipo con
> objetivo): ese vive en la rama `arena/01a03426-dashboard-manaos-progre`.
> Esta rama (`arena/02a03426-dashboard-manaos-proye`) es exclusivamente **PROYECCIÓN**.

## Links online (GitHub Pages)

- **PROYECCIÓN (este tablero)**: https://pablosaya1-gthb.github.io/DASHBOARD-MANAOS-PROGRE-/
- **PROGRESIÓN** (snapshot del tablero antiguo): https://pablosaya1-gthb.github.io/DASHBOARD-MANAOS-PROGRE-/progresion/

> Nota: GitHub Pages publica **una sola rama por repo**. Hoy el sitio apunta a
> `arena/01a03426` (progresión). Para publicar ESTE dashboard en la raíz:
> **Settings → Pages → Branch → `arena/01a05d7a-dashboard-manaos-progre` → Save**
> (o, mejor, mergear el PR #2 y apuntar a `arena/02a03426-dashboard-manaos-proye`).
> Tras el cambio: raíz = PROYECCIÓN, y PROGRESIÓN queda en `/progresion/` (snapshot).

## Qué muestra

- **8 KPIs**: facturación neta/bruta, volumen, clientes activos, documentos, ticket promedio,
  devoluciones y bonificaciones — todos con variación interanual (mes 2026 vs mismo mes 2025).
- **8 secciones**:
  - **General** — serie mensual, curva de temporada, YoY, mix por línea y tipo.
  - **Proyección** — pronóstico de los próximos 3/6/12 meses con tres escenarios
    (conservador · base · optimista), real vs proyectado, acumulado móvil 12 meses y
    apertura por vendedor y por línea.
  - **Vendedores** — ranking, tendencia comparada, tabla y **comparativo por equipo**
    (2º vendedor) con YoY y participación.
  - **Clientes** — Pareto, nuevos, top 30 e historia por cliente.
  - **Alertas** — clientes **perdidos / en riesgo / recuperados / nuevos / creciendo**,
    con ventana configurable (1-6 meses), umbral de caída, mayores caídas en $,
    alertas por vendedor y **descarga a CSV**.
  - **Productos** — líneas, escala de precios, presentaciones, sabores, top 30 artículos.
  - **Territorio** — provincias y top 15 localidades.
  - **Datos** — calidad y metodología.
- **Filtros combinables** (período, vendedor, 2º vendedor/equipo, provincia, línea) con
  recálculo instantáneo en cliente, búsqueda en tablas, ordenamiento y **link compartible**
  con el estado de los filtros en la URL (incluye escenario, horizonte y ventana de alertas).

### Cómo se calcula la proyección

`proyección(mes) = neto del mismo mes del año anterior × ritmo reciente`

El **ritmo** es la suma de los últimos 3 meses comparables dividida por la del mismo período
del año anterior (se saltean los meses parciales). El escenario **base** usa ese ritmo, el
**conservador** el peor YoY reciente y el **optimista** el mejor (acotados a ±50 %). Si el
último mes viene parcial, se completa a ritmo diario antes de proyectar. La pestaña usa
siempre la historia completa: el filtro de período no la afecta (sí los de vendedor,
equipo, provincia y línea).

### Cómo se calculan las alertas

Se compara la **ventana actual** (últimos N meses con datos, salteando los parciales) contra
la **ventana previa** del mismo largo — o contra el **mismo período del año anterior**, útil en
un negocio estacional — sobre el bruto de cada cliente:

| Estado | Regla |
|---|---|
| Perdido | compraba antes y **no compró** en la ventana actual |
| En riesgo | sigue comprando pero **cae** más que el umbral elegido (20/35/50 %) |
| Recuperado | no compró en la ventana previa y **volvió** |
| Nuevo | primera compra de la temporada dentro de la ventana |
| Creciendo | sube más que el umbral |

## Cómo usarlo

Opción A — abrir directo: abrir `index.html` en el navegador (necesita internet para el
CDN de Chart.js y la fuente).

Opción B — servir (recomendado):
```
python3 -m http.server 8080
# → http://localhost:8080
```

Opción C — GitHub Pages: configurar Pages sobre esta rama (archivos en la raíz).

## Cómo actualizar los datos

La fuente oficial es el archivo de Drive **`Proyección larga_2025-26.xlsx`** (~158 MB):
<https://docs.google.com/spreadsheets/d/1BxaNGBMDiXbSowF8so1JB1ABMs6ibRra/edit?usp=sharing>

```bash
pip install polars fastexcel          # una sola vez  (openpyxl si vas a usar --via-csv)

python3 scripts/descargar_datos.py    # baja el xlsx del link a datos/
python3 scripts/procesar_proyeccion.py datos/proyeccion_larga_2025-26.xlsx
```

Eso regenera `data/proyeccion.json` y el tablero ya muestra los datos nuevos
(no hay que tocar HTML/CSS/JS). Después: commit del JSON y listo.

Opciones del ETL:

| Opción | Para qué |
|---|---|
| `--hoja NOMBRE` | elegir la hoja del Excel (por defecto, la primera) |
| `--via-csv` | convierte el Excel a CSV en streaming antes de procesar: mucha menos RAM (requiere `openpyxl`). Recomendado en máquinas con < 8 GB |
| `--salida RUTA` | escribir el JSON en otro lado (útil para comparar contra el actual) |

Formatos aceptados: `.xlsx` / `.xlsm`, `.csv` (`;`, cp1252) y `.zip` con cualquiera
de los dos adentro. Si no pasás ruta, busca solo en `datos/` y en la raíz.

### ¿Dónde corro estos comandos?

Cuatro opciones, de menos a más instalación:

| Dónde | Qué necesitás | Cómo |
|---|---|---|
| **GitHub Actions** (recomendado) | solo el navegador | Pestaña **Actions** → *Actualizar datos del tablero* → **Run workflow**. Baja el xlsx, regenera el JSON y lo commitea solo. El botón aparece cuando el workflow está en la rama `main` (mergear el PR). |
| **Google Colab** | cuenta de Google | Abrir `notebooks/actualizar_datos_colab.ipynb` en [Colab](https://colab.research.google.com/) y correr las celdas. Puede tomar el archivo del link **o** directo de tu Drive. |
| **GitHub Codespaces** | cuenta de GitHub | Botón verde **Code → Codespaces → Create**. Te da una terminal Linux en el navegador; ahí sí van los comandos tal cual. |
| **Tu PC** | Python 3 instalado | Windows: **PowerShell** (`python` en vez de `python3`). Mac/Linux: **Terminal**. Primero `cd` a la carpeta del repo. |

En Windows, si `python` no existe, instalalo desde <https://www.python.org/downloads/>
tildando *"Add Python to PATH"*, y usá:

```powershell
py -m pip install polars fastexcel
py scripts\descargar_datos.py
py scripts\procesar_proyeccion.py datos\proyeccion_larga_2025-26.xlsx
```

### Verificar sin tener el archivo

```bash
python3 scripts/test_etl.py     # dataset sintético → CSV, XLSX y --via-csv deben dar lo mismo
python3 scripts/test_ui_json.py # valida el data/proyeccion.json publicado (sin dependencias)
node scripts/test_ui.mjs        # corre app.js contra el JSON real en un DOM simulado (npm i jsdom)
```

## Estructura

```
index.html                          → estructura del tablero
tablero.css                         → estilos (tema claro, responsive)
app.js                              → lógica: filtros, motor de cálculo, charts, tablas
data/proyeccion.json                → cubes pre-agregados (~4 MB, generado)
scripts/procesar_proyeccion.py      → ETL: XLSX/CSV/ZIP → JSON (documentado)
scripts/descargar_datos.py          → baja el xlsx del link de Drive a datos/
scripts/test_etl.py                 → test de humo del ETL con datos sintéticos
scripts/test_ui_json.py             → valida el JSON generado (forma y cuadratura)
scripts/test_ui.mjs                 → test de humo del tablero (jsdom, sin navegador)
notebooks/actualizar_datos_colab.ipynb → actualizar los datos desde Google Colab
.github/workflows/actualizar-datos.yml → actualizar los datos desde la web (Actions)
datos/                              → fuente descargada (ignorada por git)
```

## Arquitectura de datos

El archivo original pesa ~158 MB en xlsx / ~290 MB en csv (751.435 renglones, 38 columnas).
No se carga en el navegador:
el ETL (polars) lo limpia y pre-agrega en **cubes densos** (mes × vendedor × provincia × línea,
etc.) de ~4 MB. El navegador recorta y suma en cliente en <10 ms.

Métricas por celda del cube principal: `bruto, neto, volumen, devoluciones, bonificaciones`.

## Calidad de datos (resumen — ver panel "Datos" y el modal del tablero)

- Decimales con coma y punto mezclados → normalizados.
- 237 filas con "% imp. interno" = 869,56 (error de coma) → corregidas a 8,6956.
- 22.294 renglones quedaban en `null` al sumar. **Corregido (sep-2026):** el parser numérico
  usaba `\1\2` como reemplazo de regex, que polars no soporta, así que **todo importe con
  separador de miles** (`1.234,50`) se convertía en nulo y no sumaba. El parser nuevo resuelve
  es-AR / en-US / negativos entre paréntesis o con signo al final.
  ⚠️ **Hay que regenerar `data/proyeccion.json`** con el xlsx para que los totales incorporen
  esos renglones (el JSON publicado todavía es el de la versión con el bug).
- 1.026 renglones de **DIFERENCIAS/AJUSTES** (contables, usuario CASTILLO 2 / "RECICLAR S.A")
  → excluidos de los cubes comerciales; se exhiben en el panel Datos.
- **Jul-2026 es parcial**: la carga trae datos solo desde el 20/07. El ETL ahora **detecta solo**
  los meses incompletos y el tablero los marca (badge en el header, ⚠ en el filtro de período,
  barra naranja en la serie mensual).
- Fórmula validada: `neto × (1 + IVA% + imp.int.%) = bruto` exacta en el 96,5 % de renglones.
- `Índice` no es único → no se usa como clave.

## Fuente

`Proyección larga_2025-26.xlsx` (Drive) o su export `.csv` — separador `;`, codificación Windows-1252, decimales con
coma o punto. Columnas clave: `MES` (1-20 = mes de temporada), `Fecha`, `Vendedor`,
`Vendedor #2`, `Provincia`, `Línea`, `Tipo artículo`, `Presentación`, `Sabor`,
`Cantidad`, `Precio renglón`, `Total m. local` (neto), `Total renglón` (bruto),
`Tipo comp.` (FVW, FEW, NCW, NCI, NDI…).
