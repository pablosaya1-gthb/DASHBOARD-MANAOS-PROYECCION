# -*- coding: utf-8 -*-
"""
ETL — Proyección larga 2025-26 (Manaos)
========================================
Convierte el detalle de ventas (renglones) en `data/proyeccion.json`
(cubes pre-agregados, ~4 MB) para el dashboard estático.

Formatos de entrada aceptados
-----------------------------
  * .xlsx / .xlsm  → el archivo que publica el ERP en Drive
                     ("Proyección larga_2025-26.xlsx", ~158 MB)
  * .csv           → mismo contenido exportado (separador ; , cp1252)
  * .zip           → con un .xlsx o un .csv adentro

Uso:
    python3 scripts/procesar_proyeccion.py [ruta] [opciones]

    --hoja NOMBRE     hoja del Excel a leer (por defecto: la primera)
    --via-csv         convierte el Excel a CSV en streaming antes de procesar
                      (mucha menos RAM; requiere `openpyxl`)
    --salida RUTA     JSON de salida (por defecto data/proyeccion.json)

Si no se pasa ruta, busca (en este orden) en `datos/` y en la raíz:
    proyeccion_larga_2025-26.xlsx | .csv
    Proyección larga_2025-26.xlsx | .csv
    (o el primer .xlsx/.csv/.zip que encuentre)

Dependencias:
    pip install polars fastexcel        # fastexcel = motor calamine para .xlsx
    pip install openpyxl                # solo si usás --via-csv

Limpieza aplicada (ver sección "Calidad de datos" del README):
  * Decimales con coma o punto normalizados (y separador de miles).
  * 'Porc. imp. int.' > 100 (error de coma, ej. 869.56) -> /100.
  * Filas de DIFERENCIAS/AJUSTES (contables) excluidas de los cubes
    comerciales; su total mensual va en `ajustes`.
  * Filas con 'Total renglón' nulo: se cuentan y no suman.
  * MES = mes de la temporada (1..N). Si la columna MES no viene o está
    vacía, se reconstruye desde `Fecha` tomando el primer mes con datos
    como MES 1.
  * El último mes se marca como parcial automáticamente si la carga no
    llega al final del mes calendario (ej. jul-2026 desde el 20/07).
"""
import json
import sys
import zipfile
import glob
import os
import re
import unicodedata
import polars as pl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NUM_COLS = ["Cantidad", "Cantidad venta", "Precio renglón", "Recargo financiero",
            "Bonificación", "Descuento", "Total renglón", "Total m. local",
            "Porc. IVA", "Porc. imp. int."]

# Columnas de texto usadas por los cubes (se crean vacías si faltan)
TXT_COLS = ["Vendedor", "Vendedor #2", "Provincia", "Localidad", "Línea",
            "Tipo artículo", "Presentación", "Sabor", "Desc. artículo",
            "Nombre fantasía", "Estado", "Tipo comp.", "Número", "Fecha"]

MESES_ES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun",
            "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]

# Etiquetas por defecto (temporada 2025-26). Si los datos traen más/menos
# meses, se recalculan solas a partir de la primera fecha.
MES_LABELS = ["Ene 25", "Feb 25", "Mar 25", "Abr 25", "May 25", "Jun 25",
              "Jul 25", "Ago 25", "Sep 25", "Oct 25", "Nov 25", "Dic 25",
              "Ene 26", "Feb 26", "Mar 26", "Abr 26", "May 26", "Jun 26",
              "Jul 26", "Ago 26"]
MES_PARCIAL = {19: "Solo desde el 20/07/2026"}

CSV_KW = dict(separator=";", encoding="cp1252", infer_schema_length=50000,
              truncate_ragged_lines=True, schema_overrides={c: pl.Utf8 for c in NUM_COLS})

EXTS_EXCEL = (".xlsx", ".xlsm", ".xlsb", ".ods")


# ---------------------------------------------------------------- utilidades

def _key(s):
    """Clave normalizada de un nombre de columna: sin acentos, sin espacios,
    minúscula. Permite tolerar 'Línea'/'Linea'/'LINEA ' del ERP."""
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9#]", "", s.lower())


def normalizar_columnas(df):
    """Renombra las columnas del origen a los nombres canónicos que usa el ETL
    y agrega como nulas las que falten (así el resto del script no rompe)."""
    canon = {_key(c): c for c in NUM_COLS + TXT_COLS + ["MES", "Índice"]}
    ren = {}
    for c in df.columns:
        k = _key(c)
        if k in canon and canon[k] != c:
            ren[c] = canon[k]
    if ren:
        df = df.rename(ren)
    faltan = [c for c in NUM_COLS + TXT_COLS if c not in df.columns]
    if faltan:
        print(f"  aviso: columnas ausentes en el origen -> {', '.join(faltan)}")
        df = df.with_columns([pl.lit(None, dtype=pl.Utf8).alias(c) for c in faltan])
    return df


def find_input(argv):
    """Primer argumento posicional que exista, o autodetección."""
    for a in argv[1:]:
        if not a.startswith("-") and os.path.exists(a):
            return a
    bases = ["proyeccion_larga_2025-26", "Proyección larga_2025-26",
             "proyeccion_larga", "Proyección larga"]
    for d in ("datos", ""):
        for b in bases:
            for e in (".xlsx", ".xlsm", ".csv", ".zip"):
                c = os.path.join(ROOT, d, b + e)
                if os.path.exists(c):
                    return c
    for pat in ["datos/*.xlsx", "datos/*.csv", "datos/*.zip",
                "*.xlsx", "*.csv", "*.zip"]:
        hits = sorted(glob.glob(os.path.join(ROOT, pat)))
        if hits:
            return hits[0]
    print("No se encontró el archivo de datos.\n"
          "Usá: python3 scripts/procesar_proyeccion.py RUTA_AL_XLSX_CSV_O_ZIP\n"
          "(o bajalo con: python3 scripts/descargar_datos.py)")
    sys.exit(1)


# ------------------------------------------------------------------ lectura

def _leer_excel(path_or_bytes, hoja=None):
    """Lee un Excel con el motor calamine (rápido, tolerante a tipos mixtos).
    Todas las columnas se traen como texto y después se castean: el ERP mezcla
    números reales con textos tipo '1.234,50' en la misma columna."""
    try:
        import fastexcel  # noqa: F401
    except ImportError:
        print("Falta el motor de Excel. Instalá:  pip install fastexcel\n"
              "(o convertí el archivo a CSV y pasá el .csv)")
        sys.exit(1)
    kw = dict(engine="calamine", infer_schema_length=0)  # 0 = todo string
    if hoja is not None:
        kw["sheet_name"] = hoja
    try:
        df = pl.read_excel(path_or_bytes, **kw)
    except TypeError:
        kw.pop("infer_schema_length", None)
        df = pl.read_excel(path_or_bytes, **kw)
    if isinstance(df, dict):  # varias hojas -> la primera
        df = list(df.values())[0]
    return df


def excel_a_csv(path, destino=None, hoja=None):
    """Convierte un .xlsx grande a CSV leyendo fila por fila (openpyxl
    read_only): usa poca RAM aunque el Excel pese cientos de MB."""
    try:
        from openpyxl import load_workbook
    except ImportError:
        print("--via-csv necesita openpyxl:  pip install openpyxl")
        sys.exit(1)
    import csv as _csv
    destino = destino or os.path.join(ROOT, "datos", "_convertido.csv")
    os.makedirs(os.path.dirname(destino), exist_ok=True)
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb[hoja] if hoja else wb[wb.sheetnames[0]]
    print(f"  convirtiendo hoja '{ws.title}' -> {destino}")
    n = 0
    with open(destino, "w", newline="", encoding="utf-8") as f:
        w = _csv.writer(f, delimiter=";")
        for row in ws.iter_rows(values_only=True):
            w.writerow(["" if v is None else v for v in row])
            n += 1
            if n % 100000 == 0:
                print(f"    {n:,} filas…")
    wb.close()
    print(f"  {n:,} filas convertidas")
    return destino


def open_source(path, hoja=None, via_csv=False):
    """Devuelve (DataFrame, nombre_de_origen) para csv / xlsx / zip."""
    low = path.lower()

    if low.endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist()
                     if n.lower().endswith((".csv",) + EXTS_EXCEL)]
            if not names:
                print("El zip no contiene CSV ni Excel")
                sys.exit(1)
            inner = names[0]
            raw = z.read(inner)
            if inner.lower().endswith(EXTS_EXCEL):
                tmp = os.path.join(ROOT, "datos", "_tmp_excel" + os.path.splitext(inner)[1])
                os.makedirs(os.path.dirname(tmp), exist_ok=True)
                with open(tmp, "wb") as f:
                    f.write(raw)
                try:
                    df = _leer_excel(tmp, hoja)
                finally:
                    os.remove(tmp)
            else:
                df = pl.read_csv(io_bytes(raw), **CSV_KW)
            return df, inner

    if low.endswith(EXTS_EXCEL):
        if via_csv:
            csv_path = excel_a_csv(path, hoja=hoja)
            kw = dict(CSV_KW)
            kw["encoding"] = "utf8"
            return pl.read_csv(csv_path, **kw), os.path.basename(path)
        return _leer_excel(path, hoja), os.path.basename(path)

    return pl.read_csv(path, **CSV_KW), os.path.basename(path)


def io_bytes(raw):
    import io
    return io.BytesIO(raw)


# ------------------------------------------------------- parseo de columnas

def parse_num(col):
    """Texto del ERP -> Float64, tolerando el desorden de separadores.

    El export mezcla estilos en la misma columna: '1.234,50' (es-AR),
    '1,234.50' (en-US), '1234.5', '(123,45)' para negativos, '123,45-'
    con signo al final, vacíos y espacios duros.

    Regla: si aparecen los dos separadores, manda el que esté MÁS A LA
    DERECHA (ese es el decimal); si aparece uno solo, se interpreta como
    miles cuando el patrón es de grupos de 3 exactos (1.234.567) y como
    decimal en cualquier otro caso.

    (Antes se usaba `\1\2` como reemplazo, que polars/regex no soporta:
    todo importe con separador de miles terminaba en null y no sumaba.)
    """
    s = (col.cast(pl.Utf8, strict=False)
            .str.strip_chars()
            .str.replace_all(r"[\s\u00a0$]", "")
            .str.replace_all(r"^\((.*)\)$", "-$1")      # (123,45) -> -123,45
            .str.replace_all(r"^(.*)-$", "-$1"))          # 123,45-  -> -123,45
    has_dot = s.str.contains(".", literal=True)
    has_com = s.str.contains(",", literal=True)
    com_ult = s.str.contains(r",[^.]*$")                  # la coma va después del último punto
    miles_com = s.str.contains(r"^-?\d{1,3}(,\d{3})+$")
    miles_dot = s.str.contains(r"^-?\d{1,3}(\.\d{3})+$")

    dec_coma = (has_com & has_dot & com_ult) | (has_com & ~has_dot & ~miles_com)
    dec_punto = (has_dot & has_com & ~com_ult) | (has_dot & ~has_com & ~miles_dot)

    out = (pl.when(dec_coma)
             .then(s.str.replace_all(".", "", literal=True)
                    .str.replace_all(",", ".", literal=True))
           .when(dec_punto)
             .then(s.str.replace_all(",", "", literal=True))
           .otherwise(s.str.replace_all(",", "", literal=True)
                       .str.replace_all(".", "", literal=True)))
    return (out.str.replace_all(r"^-?$", "0")
               .cast(pl.Float64, strict=False))


def parse_fecha(df, col="Fecha"):
    """Devuelve una Serie de fechas soportando dd/mm/aaaa, ISO, datetime real
    de Excel y seriales numéricos (días desde 1899-12-30)."""
    dt = df[col].dtype
    if dt in (pl.Date, pl.Datetime):
        return df[col].cast(pl.Date)
    if dt.is_numeric():
        return (pl.date(1899, 12, 30).cast(pl.Date)
                + pl.duration(days=df[col].cast(pl.Int64, strict=False)))
    s = df[col].cast(pl.Utf8, strict=False).str.strip_chars().str.head(19)
    out = s.str.to_date("%d/%m/%Y", strict=False)
    if out.null_count() > 0.5 * len(out):
        alt = s.str.to_datetime("%Y-%m-%d %H:%M:%S", strict=False).cast(pl.Date)
        if alt.null_count() < out.null_count():
            out = alt
        alt2 = s.str.to_date("%Y-%m-%d", strict=False)
        if alt2.null_count() < out.null_count():
            out = alt2
    # seriales de Excel guardados como texto ("45123")
    if out.null_count() > 0.5 * len(out):
        num = s.cast(pl.Float64, strict=False)
        if num.null_count() < out.null_count():
            out = pl.select(pl.date(1899, 12, 30) +
                            pl.duration(days=num.cast(pl.Int64, strict=False)))\
                   .to_series()
    return out


def etiquetas_meses(fechas, n_mes):
    """['Ene 25', ...] a partir del primer mes con datos."""
    f0 = fechas.drop_nulls().min()
    if f0 is None:
        return MES_LABELS[:n_mes]
    y, m = f0.year, f0.month
    out = []
    for _ in range(n_mes):
        out.append(f"{MESES_ES[m - 1]} {str(y)[-2:]}")
        m += 1
        if m == 13:
            m, y = 1, y + 1
    return out


def detectar_parcial(df, n_mes):
    """Marca el último mes como parcial si la carga no cubre el mes completo
    (ej. la exportación arranca el 20 del mes o corta a mitad de mes)."""
    import datetime as _dt
    sub = df.filter(pl.col("MES") == n_mes).select("dt").drop_nulls()
    if sub.height == 0:
        return {}
    d1, d2 = sub["dt"].min(), sub["dt"].max()
    ultimo_dia = (_dt.date(d1.year + (d1.month == 12), d1.month % 12 + 1, 1)
                  - _dt.timedelta(days=1)).day
    if d1.day > 1:
        return {n_mes: f"Solo desde el {d1.strftime('%d/%m/%Y')}"}
    if d2.day < ultimo_dia:
        return {n_mes: f"Solo hasta el {d2.strftime('%d/%m/%Y')}"}
    return {}


def parse_args(argv):
    opts = {"hoja": None, "via_csv": False,
            "salida": os.path.join(ROOT, "data", "proyeccion.json")}
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--hoja" and i + 1 < len(argv):
            opts["hoja"] = argv[i + 1]; i += 1
        elif a == "--via-csv":
            opts["via_csv"] = True
        elif a == "--salida" and i + 1 < len(argv):
            opts["salida"] = argv[i + 1]; i += 1
        i += 1
    return opts


def main():
    opts = parse_args(sys.argv)
    path = find_input(sys.argv)
    print(f"Leyendo: {path}")
    df, src_name = open_source(path, hoja=opts["hoja"], via_csv=opts["via_csv"])
    print(f"Filas: {df.height:,}  Columnas: {df.width}")
    df = normalizar_columnas(df)

    # ---------- normalización ----------
    df = df.with_columns([parse_num(pl.col(c)).alias(c + "_n") for c in NUM_COLS])
    # error de coma en % impuesto interno (869.56 -> 8.6956)
    df = df.with_columns(
        pl.when(pl.col("Porc. imp. int._n") > 100)
          .then(pl.col("Porc. imp. int._n") / 100)
          .otherwise(pl.col("Porc. imp. int._n")).alias("imp_n")
    )
    df = df.with_columns(parse_fecha(df).alias("dt"))

    # ---------- MES de temporada (1..N) ----------
    mes_src = (pl.col("MES").cast(pl.Utf8, strict=False).str.strip_chars()
                 .cast(pl.Float64, strict=False).cast(pl.Int32, strict=False)
               if "MES" in df.columns else pl.lit(None, dtype=pl.Int32))
    df = df.with_columns(mes_src.alias("MES"))
    f0 = df["dt"].drop_nulls().min()
    if f0 is not None:
        mes_calc = ((pl.col("dt").dt.year() - f0.year) * 12
                    + (pl.col("dt").dt.month() - f0.month) + 1).cast(pl.Int32)
        df = df.with_columns(pl.coalesce([pl.col("MES"), mes_calc]).alias("MES"))
    n_sin_mes = int(df["MES"].null_count())
    if n_sin_mes:
        print(f"  aviso: {n_sin_mes:,} filas sin MES ni Fecha -> excluidas")
        df = df.filter(pl.col("MES").is_not_null())
    df = df.filter(pl.col("MES") >= 1)
    df = df.with_columns(pl.col("MES").cast(pl.Int64))
    df = df.with_columns([
        pl.col("Vendedor").fill_null("(sin vendedor)"),
        pl.col("Provincia").fill_null("(sin provincia)"),
        pl.col("Línea").fill_null("(sin línea)"),
        pl.col("Nombre fantasía").fill_null("(sin nombre)"),
    ])
    df = df.with_columns(
        pl.col("Desc. artículo").str.to_lowercase()
          .str.contains("diferencia|ajuste", literal=False)
        .alias("is_ajuste")
    )

    n_total = df.height
    n_null_tot = int(df["Total renglón_n"].null_count())
    n_null_prec = int(df["Precio renglón_n"].null_count())
    n_imp_fix = int((df["imp_n"] != df["Porc. imp. int._n"]).sum())
    n_ajuste = int(df["is_ajuste"].sum())

    # ventas comerciales (sin ajustes contables)
    vc = df.filter(~pl.col("is_ajuste"))

    def r1(x):
        return None if x is None else int(round(x))

    def m1(x):
        """mode puede devolver lista (empates) -> primer valor"""
        if isinstance(x, (list, tuple)) or (hasattr(x, "__len__") and not isinstance(x, str)):
            try:
                return x[0]
            except Exception:
                return None
        return x

    # ---------- diccionarios de dimensiones ----------
    def dim(col, data):
        vals = sorted(data[col].drop_nulls().unique().to_list(),
                      key=lambda v: (str(v).lower()))
        return vals, {v: i for i, v in enumerate(vals)}

    vnds, vnd_i = dim("Vendedor", vc)
    provs, prov_i = dim("Provincia", vc)
    lineas, linea_i = dim("Línea", vc)
    clis, _ = dim("Nombre fantasía", vc)
    arts, _ = dim("Desc. artículo", vc)

    # ---------- rango temporal (dinámico: no está clavado en 20 meses) ----------
    n_mes = int(df["MES"].max())
    mes_labels = (MES_LABELS[:n_mes] if n_mes <= len(MES_LABELS) and f0 is not None
                  and f0.year == 2025 and f0.month == 1
                  else etiquetas_meses(df["dt"], n_mes))
    mes_parcial = detectar_parcial(df, n_mes)
    if not mes_parcial and n_mes == 20 and mes_labels == MES_LABELS:
        mes_parcial = dict(MES_PARCIAL)      # fallback histórico documentado
    mes_parcial = {str(k): v for k, v in mes_parcial.items()}
    print(f"  meses: {n_mes} ({mes_labels[0]} → {mes_labels[-1]})"
          + (f" | parcial: {mes_parcial}" if mes_parcial else ""))

    # ---------- C1: mes x vnd x prov x linea [bruto, neto, vol] ----------
    c1 = (vc.group_by(["MES", "Vendedor", "Provincia", "Línea"])
            .agg(pl.col("Total renglón_n").sum().alias("b"),
                 pl.col("Total m. local_n").sum().alias("n"),
                 pl.col("Cantidad_n").sum().alias("v"),
                 pl.col("Total renglón_n").clip(upper_bound=0).sum().alias("dev"),
                 pl.when(pl.col("Línea") == "BONIFICACION")
                   .then(pl.col("Total renglón_n")).otherwise(0).sum().alias("bo"))
            .sort(["MES", "Vendedor", "Provincia", "Línea"]))
    # mapeo rápido
    idx = {}
    for r in c1.iter_rows():
        key = ((int(r[0]) - 1), vnd_i[r[1]], prov_i[r[2]], linea_i[r[3]])
        idx[key] = (r1(r[4]), r1(r[5]), r1(r[6]), r1(r[7]), r1(r[8]))
    C1 = [[[[[0, 0, 0, 0, 0] for _ in lineas] for _ in provs] for _ in vnds] for _ in range(n_mes)]
    for (m, i, p_, l_), cell in idx.items():
        C1[m][i][p_][l_] = list(cell)

    # ---------- C2: mes x vnd [bruto, neto, vol, docs, cli] ----------
    c2 = (vc.group_by(["MES", "Vendedor"])
            .agg(pl.col("Total renglón_n").sum().alias("b"),
                 pl.col("Total m. local_n").sum().alias("n"),
                 pl.col("Cantidad_n").sum().alias("v"),
                 pl.col("Número").n_unique().alias("d"),
                 pl.col("Nombre fantasía").n_unique().alias("c"))
            .sort(["MES", "Vendedor"]))
    idx2 = {((int(r[0]) - 1), vnd_i[r[1]]): (r1(r[2]), r1(r[3]), r1(r[4]), int(r[5]), int(r[6]))
            for r in c2.iter_rows()}
    C2 = [[[0, 0, 0, 0, 0] for _ in vnds] for _ in range(n_mes)]
    for (m, i), t in idx2.items():
        C2[m][i] = list(t)

    # ---------- C3: mes x vnd2 [bruto, vol] + mapeo vnd2 -> vnds ----------
    c3 = (vc.with_columns(pl.col("Vendedor #2").fill_null("(sin 2º vendedor)"))
            .group_by(["MES", "Vendedor #2"])
            .agg(pl.col("Total renglón_n").sum().alias("b"),
                 pl.col("Cantidad_n").sum().alias("v"))
            .sort(["MES", "Vendedor #2"]))
    vnd2_all = sorted({v for v in vc["Vendedor #2"].drop_nulls().unique().to_list()})
    vnd2_map = {v: i for i, v in enumerate(vnd2_all)}
    C3 = [[[0, 0] for _ in vnd2_all] for _ in range(n_mes)]
    for r in c3.iter_rows():
        m = int(r[0]) - 1
        if 0 <= m < n_mes and r[1] in vnd2_map:
            C3[m][vnd2_map[r[1]]] = [r1(r[2]), r1(r[3])]
    _g2 = (vc.with_columns(pl.col("Vendedor #2").fill_null("")).filter(pl.col("Vendedor #2") != "")
           .group_by("Vendedor #2").agg(pl.col("Vendedor").unique().sort().alias("v"))
           .sort("Vendedor #2").to_dict(as_series=False))
    vnd2_to_vnds = {k: list(v) for k, v in zip(_g2["Vendedor #2"], _g2["v"])}

    # ---------- C4: series mes x dim ----------
    def mes_dim(col, with_price=False, with_n=False, data=None):
        d = data if data is not None else vc
        agg = [pl.col("Total renglón_n").sum().alias("b"), pl.col("Cantidad_n").sum().alias("v")]
        if with_price:
            agg.append(pl.col("Precio renglón_n").median().alias("pm"))
        if with_n:
            agg.append(pl.len().alias("nn"))
        g = d.group_by(["MES", col]).agg(*agg).sort(["MES", col])
        vals = sorted(d[col].drop_nulls().unique().to_list())
        out = [[None] * len(vals) for _ in range(n_mes)]
        vi = {v: j for j, v in enumerate(vals)}
        for r in g.iter_rows():
            m = int(r[0]) - 1
            v = r[1]
            if not (0 <= m < n_mes) or v not in vi:
                continue
            cell = {"b": r1(r[2]), "v": r1(r[3])}
            k = 4
            if with_price:
                cell["pm"] = round(float(r[k]), 2) if r[k] is not None else None
                k += 1
            if with_n:
                cell["nn"] = int(r[k])
            out[m][vi[v]] = cell
        return vals, out

    tipos_v, C4a = mes_dim("Tipo artículo")
    pres_v, C4b = mes_dim("Presentación", with_price=True)
    sabores_v, C4c = mes_dim("Sabor")
    doctipos_v, C4d = mes_dim("Tipo comp.", with_n=True)

    # ---------- C5: clientes x mes [bruto, vol] + master ----------
    c5 = (vc.group_by(["Nombre fantasía", "MES"])
            .agg(pl.col("Total renglón_n").sum().alias("b"),
                 pl.col("Cantidad_n").sum().alias("v"))
            .sort(["Nombre fantasía", "MES"]))
    cli_mes = {r[0]: {} for r in c5.iter_rows()}
    for r in c5.iter_rows():
        cli_mes[r[0]][int(r[1])] = [r1(r[2]), r1(r[3])]
    C5 = []
    cli_master_rows = (vc.group_by("Nombre fantasía")
                        .agg(pl.col("Total renglón_n").sum().alias("b"),
                             pl.col("Cantidad_n").sum().alias("v"),
                             pl.col("Número").n_unique().alias("d"),
                             pl.col("Provincia").mode().alias("prov"),
                             pl.col("Vendedor").mode().alias("vnd"),
                             pl.col("Estado").mode().alias("est"),
                             pl.col("MES").min().alias("first"),
                             pl.col("MES").max().alias("last"))
                        .sort("b", descending=True))
    for r in cli_master_rows.iter_rows():
        name = r[0]
        r = (r[0], r[1], r[2], r[3], m1(r[4]), m1(r[5]), m1(r[6]), r[7], r[8])
        hist = cli_mes.get(name, {})
        C5.append({
            "c": name, "prov": r[4], "vnd": r[5], "est": r[6],
            "first": int(r[7]), "last": int(r[8]),
            "b": r1(r[1]), "v": r1(r[2]), "d": int(r[3]),
            "h": [hist.get(m, [0, 0]) for m in range(1, n_mes + 1)],
        })

    # ---------- C6: artículos x mes + master ----------
    c6 = (vc.group_by(["Desc. artículo", "MES"])
            .agg(pl.col("Total renglón_n").sum().alias("b"),
                 pl.col("Cantidad_n").sum().alias("v"))
            .sort(["Desc. artículo", "MES"]))
    art_mes = {}
    for r in c6.iter_rows():
        art_mes.setdefault(r[0], {})[int(r[1])] = [r1(r[2]), r1(r[3])]
    art_master_rows = (vc.group_by("Desc. artículo")
                        .agg(pl.col("Total renglón_n").sum().alias("b"),
                             pl.col("Cantidad_n").sum().alias("v"),
                             pl.col("Número").n_unique().alias("d"),
                             pl.col("Nombre fantasía").n_unique().alias("c"),
                             pl.col("Línea").mode().alias("linea"),
                             pl.col("Tipo artículo").mode().alias("tipo"),
                             pl.col("Presentación").mode().alias("pres"))
                        .sort("b", descending=True))
    C6 = []
    for r in art_master_rows.iter_rows():
        desc = r[0]
        r = (r[0], r[1], r[2], r[3], r[4], m1(r[5]), m1(r[6]), m1(r[7]))
        hist = art_mes.get(desc, {})
        C6.append({
            "a": desc, "linea": r[5], "tipo": r[6], "pres": r[7],
            "b": r1(r[1]), "v": r1(r[2]), "d": int(r[3]), "c": int(r[4]),
            "h": [hist.get(m, [0, 0]) for m in range(1, n_mes + 1)],
        })

    # ---------- C7: localidades top ----------
    loc_rows = (vc.group_by(["Localidad", "Provincia"])
                 .agg(pl.col("Total renglón_n").sum().alias("b"),
                      pl.col("Cantidad_n").sum().alias("v"),
                      pl.col("Nombre fantasía").n_unique().alias("c"))
                 .sort("b", descending=True).head(40))
    loc_master = [{"l": r[0], "prov": r[1], "b": r1(r[2]), "v": r1(r[3]), "c": int(r[4])}
                  for r in loc_rows.iter_rows()]
    top15 = [r[0] for r in loc_rows.head(15).iter_rows()]
    loc_mes = (vc.filter(pl.col("Localidad").is_in(top15))
               .group_by(["Localidad", "MES"])
               .agg(pl.col("Total renglón_n").sum().alias("b"))
               .to_dict(as_series=False))
    C7m = []
    for l in top15:
        row = [None] * n_mes
        for (mm, ll), bv in zip(zip(loc_mes["MES"], loc_mes["Localidad"]), loc_mes["b"]):
            if ll == l and 0 <= int(mm) - 1 < n_mes:
                row[int(mm) - 1] = r1(bv)
        C7m.append(row)

    # ---------- ajustes (excluidos de cubes) ----------
    aj = df.filter(pl.col("is_ajuste"))
    aj_mes = aj.group_by("MES").agg(pl.col("Total renglón_n").sum().alias("b"),
                                     pl.col("Número").n_unique().alias("d")) \
               .to_dict(as_series=False)
    ajustes = {
        "mes": [r1(aj_mes["b"][aj_mes["MES"].index(m)]) if m in aj_mes["MES"] else 0
                for m in range(1, n_mes + 1)],
        "docs": [int(aj_mes["d"][aj_mes["MES"].index(m)]) if m in aj_mes["MES"] else 0
                 for m in range(1, n_mes + 1)],
        "total": r1(aj["Total renglón_n"].sum()),
        "filas": n_ajuste,
    }

    # ---------- bonificaciones ----------
    bon = vc.filter(pl.col("Línea") == "BONIFICACION")
    bon_mes = bon.group_by("MES").agg(pl.col("Total renglón_n").sum().alias("b")).to_dict(as_series=False)
    bonif = {
        "mes": [r1(bon_mes["b"][bon_mes["MES"].index(m)]) if m in bon_mes["MES"] else 0
                for m in range(1, n_mes + 1)],
        "total": r1(bon["Total renglón_n"].sum()) if bon.height else 0,
        "vol": r1(bon["Cantidad_n"].sum()) if bon.height else 0,
        "filas": int(bon.height),
    }

    # ---------- serie mensual base (validación) ----------
    sm = vc.group_by("MES").agg(pl.col("Total renglón_n").sum().alias("b"),
                                 pl.col("Total m. local_n").sum().alias("n"),
                                 pl.col("Cantidad_n").sum().alias("v"),
                                 pl.col("Número").n_unique().alias("d"),
                                 pl.col("Nombre fantasía").n_unique().alias("c")) \
           .sort("MES").to_dict(as_series=False)
    serie = []
    for m in range(1, n_mes + 1):
        i = sm["MES"].index(m) if m in sm["MES"] else None
        serie.append({
            "b": r1(sm["b"][i]) if i is not None else 0,
            "n": r1(sm["n"][i]) if i is not None else 0,
            "v": r1(sm["v"][i]) if i is not None else 0,
            "d": int(sm["d"][i]) if i is not None else 0,
            "c": int(sm["c"][i]) if i is not None else 0,
        })

    out = {
        "meta": {
            "generado": __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M"),
            "fuente": src_name,
            "filas": n_total,
            "mes_labels": mes_labels,
            "mes_parcial": mes_parcial,
            "vnds": vnds, "vnd2s": vnd2_all, "provs": provs, "lineas": lineas,
            "tipos": tipos_v, "pres": pres_v, "sabores": sabores_v, "doctipos": doctipos_v,
            "n_clientes": len(clis), "n_articulos": len(arts),
            "vnd2_to_vnds": vnd2_to_vnds,
        },
        "calidad": {
            "null_total_renglon": n_null_tot,
            "null_precio": n_null_prec,
            "imp_int_coma_fix": n_imp_fix,
            "ajustes_excluidos": n_ajuste,
            "mes_parcial": mes_parcial,
            "decimales_mixtos": "comas y puntos en columnas numéricas (normalizados)",
        },
        "ajustes": ajustes,
        "bonif": bonif,
        "serie": serie,
        "C1": C1, "C2": C2, "C3": C3,
        "C4a": C4a, "C4b": C4b, "C4c": C4c, "C4d": C4d,
        "C5": C5, "C6": C6,
        "C7": {"master": loc_master, "top_mes": C7m, "top15": top15},
    }

    out_path = opts["salida"]
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    size = os.path.getsize(out_path)
    print(f"OK -> {out_path} ({size/1e6:.2f} MB)")

    # validación
    tot_b = sum(x["b"] for x in serie)
    tot_n = sum(x["n"] for x in serie)
    print(f"Validación: bruto={tot_b:,} neto={tot_n:,} "
          f"(cubes C1: bruto={sum(c[0] for m in C1 for v in m for p_ in v for c in p_):,})")
    print(f"Ajustes excluidos: {ajustes['total']:,} | Bonificaciones: {bonif['total']:,}")


if __name__ == "__main__":
    main()
