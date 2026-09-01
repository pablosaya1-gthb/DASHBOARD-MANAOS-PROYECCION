# -*- coding: utf-8 -*-
"""
ETL — Proyección larga 2025-26 (Manaos)
========================================
Convierte el CSV de detalle de ventas (renglones) en `data/proyeccion.json`
(cubes pre-agregados, ~5 MB) para el dashboard estático.

Uso:
    python3 scripts/procesar_proyeccion.py [ruta_al_csv_o_zip]

Si no se pasa ruta, busca en:
    datos/proyeccion_larga_2025-26.csv
    Proyección larga_2025-26.csv
    (o el primer .csv/.zip de la raíz)

Limpieza aplicada (ver sección "Calidad de datos" del README):
  * Decimales con coma o punto normalizados.
  * 'Porc. imp. int.' > 100 (error de coma, ej. 869.56) -> /100.
  * Filas de DIFERENCIAS/AJUSTES (contables) excluidas de los cubes
    comerciales; su total mensual va en `ajustes`.
  * Filas con 'Total renglón' nulo: se cuentan y no suman.
  * MES = mes de la temporada (1..20). MES 19 (jul-2026) es parcial:
    la carga solo trae datos desde el 20/07/2026 -> flag `parcial`.
"""
import json
import sys
import zipfile
import glob
import os
import polars as pl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NUM_COLS = ["Cantidad", "Cantidad venta", "Precio renglón", "Recargo financiero",
            "Bonificación", "Descuento", "Total renglón", "Total m. local",
            "Porc. IVA", "Porc. imp. int."]

MES_LABELS = ["Ene 25", "Feb 25", "Mar 25", "Abr 25", "May 25", "Jun 25",
              "Jul 25", "Ago 25", "Sep 25", "Oct 25", "Nov 25", "Dic 25",
              "Ene 26", "Feb 26", "Mar 26", "Abr 26", "May 26", "Jun 26",
              "Jul 26", "Ago 26"]
MES_PARCIAL = {19: "Solo desde el 20/07/2026"}


def find_input(argv):
    if len(argv) > 1 and os.path.exists(argv[1]):
        return argv[1]
    cands = [os.path.join(ROOT, "datos/proyeccion_larga_2025-26.csv"),
             os.path.join(ROOT, "Proyección larga_2025-26.csv"),
             os.path.join(ROOT, "proyeccion_larga.csv")]
    for c in cands:
        if os.path.exists(c):
            return c
    for pat in ["*.csv", "*.zip"]:
        hits = glob.glob(os.path.join(ROOT, pat))
        if hits:
            return hits[0]
    print("No se encontró el CSV. Usá: python3 scripts/procesar_proyeccion.py RUTA")
    sys.exit(1)


def open_csv(path):
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".csv")]
            if not names:
                print("El zip no contiene CSV")
                sys.exit(1)
            import io
            raw = z.read(names[0])
            return pl.read_csv(io.BytesIO(raw), **CSV_KW), names[0]
    return pl.read_csv(path, **CSV_KW), os.path.basename(path)


CSV_KW = dict(separator=";", encoding="cp1252", infer_schema_length=50000,
              truncate_ragged_lines=True, schema_overrides={c: pl.Utf8 for c in NUM_COLS})


def parse_num(s):
    return (s.str.strip_chars()
             .str.replace_all(r"\.(\d{3})($|,)", r"\1\2")
             .str.replace_all(",", ".")
             .str.replace_all("^$", "0")
             .cast(pl.Float64, strict=False))


def main():
    path = find_input(sys.argv)
    print(f"Leiendo: {path}")
    df, src_name = open_csv(path)
    print(f"Filas: {df.height}  Columnas: {df.width}")

    # ---------- normalización ----------
    df = df.with_columns([parse_num(pl.col(c)).alias(c + "_n") for c in NUM_COLS])
    # error de coma en % impuesto interno (869.56 -> 8.6956)
    df = df.with_columns(
        pl.when(pl.col("Porc. imp. int._n") > 100)
          .then(pl.col("Porc. imp. int._n") / 100)
          .otherwise(pl.col("Porc. imp. int._n")).alias("imp_n")
    )
    df = df.with_columns(pl.col("Fecha").str.to_date("%d/%m/%Y", strict=False).alias("dt"))
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

    n_mes = 20

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
            "mes_labels": MES_LABELS,
            "mes_parcial": MES_PARCIAL,
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
            "mes_parcial": MES_PARCIAL,
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

    out_path = os.path.join(ROOT, "data", "proyeccion.json")
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
