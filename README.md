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
- **6 secciones**: General (serie mensual, curva de temporada, YoY, mix), Vendedores (ranking
  + tendencia comparada + tabla), Clientes (Pareto, nuevos, top 30 e historia por cliente),
  Productos (líneas, escala de precios, presentaciones, sabores, top 30 artículos),
  Territorio (provincias y top 15 localidades) y Datos (calidad + metodología).
- **Filtros combinables** (período, vendedor, 2º vendedor/equipo, provincia, línea) con
  recálculo instantáneo en cliente, búsqueda en tablas, ordenamiento y **link compartible**
  con el estado de los filtros en la URL.

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

1. Subir el CSV nuevo al repo (o dejarlo en `datos/proyeccion_larga_2025-26.csv`).
   Acepta también `.zip` con el CSV dentro.
2. Ejecutar:
   ```
   python3 scripts/procesar_proyeccion.py [ruta_al_csv_o_zip]
   ```
3. Listo: `data/proyeccion.json` se regenera y el tablero carga los datos nuevos.
   (Requiere Python 3 + `pip install polars`.)

## Estructura

```
index.html                          → estructura del tablero
tablero.css                         → estilos (tema claro, responsive)
app.js                              → lógica: filtros, motor de cálculo, charts, tablas
data/proyeccion.json                → cubes pre-agregados (~4 MB, generado)
scripts/procesar_proyeccion.py      → ETL: CSV → JSON (documentado)
datos/                              → (opcional) fuente CSV
```

## Arquitectura de datos

El CSV original pesa ~290 MB (751.435 renglones, 38 columnas). No se carga en el navegador:
el ETL (polars) lo limpia y pre-agrega en **cubes densos** (mes × vendedor × provincia × línea,
etc.) de ~4 MB. El navegador recorta y suma en cliente en <10 ms.

Métricas por celda del cube principal: `bruto, neto, volumen, devoluciones, bonificaciones`.

## Calidad de datos (resumen — ver panel "Datos" y el modal del tablero)

- Decimales con coma y punto mezclados → normalizados.
- 237 filas con "% imp. interno" = 869,56 (error de coma) → corregidas a 8,6956.
- 22.294 renglones con total en blanco → no suman (<3 % del total).
- 1.026 renglones de **DIFERENCIAS/AJUSTES** (contables, usuario CASTILLO 2 / "RECICLAR S.A")
  → excluidos de los cubes comerciales; se exhiben en el panel Datos.
- **Jul-2026 es parcial**: la carga trae datos solo desde el 20/07 (marcado en el tablero;
  excluirlo de comparaciones).
- Fórmula validada: `neto × (1 + IVA% + imp.int.%) = bruto` exacta en el 96,5 % de renglones.
- `Índice` no es único → no se usa como clave.

## Fuente

`Proyección larga_2025-26.csv` — separador `;`, codificación Windows-1252, decimales con
coma o punto. Columnas clave: `MES` (1-20 = mes de temporada), `Fecha`, `Vendedor`,
`Vendedor #2`, `Provincia`, `Línea`, `Tipo artículo`, `Presentación`, `Sabor`,
`Cantidad`, `Precio renglón`, `Total m. local` (neto), `Total renglón` (bruto),
`Tipo comp.` (FVW, FEW, NCW, NCI, NDI…).
