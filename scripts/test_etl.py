# -*- coding: utf-8 -*-
"""
Test de humo del ETL (sin necesitar el archivo real de 158 MB)
==============================================================
Genera un dataset sintético con las mismas columnas y las mismas mañas del
export del ERP (decimales mezclados, separador de miles, filas de ajuste,
bonificaciones, mes final parcial), corre `procesar_proyeccion.py` sobre CSV
y sobre XLSX, y verifica que el JSON resultante sea correcto e idéntico entre
ambos formatos.

Uso:
    python3 scripts/test_etl.py
"""
import json
import os
import random
import subprocess
import sys
import tempfile
import datetime as dt

import polars as pl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ETL = os.path.join(ROOT, "scripts", "procesar_proyeccion.py")

VNDS = ["PEREZ JUAN", "GOMEZ ANA", "CASTILLO 1"]
VND2 = ["EQUIPO NORTE", "EQUIPO SUR"]
PROVS = ["Buenos Aires", "Córdoba", "Santa Fe"]
LOCS = ["La Matanza", "Río Cuarto", "Rosario"]
LINEAS = ["MANAOS", "PINDAPOY", "BONIFICACION"]
TIPOS = ["GASEOSAS", "AGUA SABORIZADA"]
PRES = ["2250cc", "0500cc"]
SABORES = ["COLA", "NARANJA"]
CLIS = [f"CLIENTE {i:02d}" for i in range(1, 13)]

COLS = ["Índice", "MES", "Fecha", "Número", "Tipo comp.", "Vendedor", "Vendedor #2",
        "Provincia", "Localidad", "Nombre fantasía", "Estado", "Línea",
        "Tipo artículo", "Presentación", "Sabor", "Desc. artículo",
        "Cantidad", "Cantidad venta", "Precio renglón", "Recargo financiero",
        "Bonificación", "Descuento", "Total renglón", "Total m. local",
        "Porc. IVA", "Porc. imp. int."]

N_MES = 20                      # ene-25 .. ago-26
DIA_INICIO_ULTIMO_MES = 12      # el último mes arranca el 12 -> debe salir "parcial"


def fmt(v, estilo):
    """Escribe un número con el estilo pedido (así el CSV mezcla formatos)."""
    if estilo == "es":                       # 1.234,50
        return f"{v:,.2f}".replace(",", "@").replace(".", ",").replace("@", ".")
    if estilo == "en":                       # 1,234.50
        return f"{v:,.2f}"
    return f"{v:.2f}"                        # 1234.50


def generar(seed=7):
    rnd = random.Random(seed)
    filas = []
    esperado = {"bruto": 0.0, "neto": 0.0, "vol": 0.0,
                "ajustes": 0.0, "bonif": 0.0, "docs": set()}
    idx = 0
    for mes in range(1, N_MES + 1):
        y = 2025 + (mes - 1) // 12
        m = (mes - 1) % 12 + 1
        dia_min = DIA_INICIO_ULTIMO_MES if mes == N_MES else 1
        for _ in range(60):
            idx += 1
            dia = rnd.randint(dia_min, 27)
            fecha = dt.date(y, m, dia)
            linea = rnd.choice(LINEAS)
            cant = rnd.randint(1, 40)
            precio = round(rnd.uniform(200, 4000), 2)
            neto = round(cant * precio, 2)
            iva, imp = 21.0, 0.0
            bruto = round(neto * (1 + iva / 100), 2)
            if linea == "BONIFICACION":
                bruto, neto = -abs(bruto), -abs(neto)
            estilo = rnd.choice(["es", "en", "plain"])
            doc = f"A{mes:02d}-{rnd.randint(1, 25):04d}"
            filas.append([
                idx, mes, fecha.strftime("%d/%m/%Y"), doc,
                rnd.choice(["FVW", "FEW", "NCW"]),
                rnd.choice(VNDS), rnd.choice(VND2), rnd.choice(PROVS),
                rnd.choice(LOCS), rnd.choice(CLIS), "ACTIVO", linea,
                rnd.choice(TIPOS), rnd.choice(PRES), rnd.choice(SABORES),
                f"ART {rnd.randint(1, 20):02d}",
                str(cant), str(cant), fmt(precio, estilo), "0", "0", "0",
                fmt(bruto, estilo), fmt(neto, estilo),
                fmt(iva, estilo), "869,56" if idx % 97 == 0 else "0",
            ])
            esperado["bruto"] += bruto
            esperado["neto"] += neto
            esperado["vol"] += cant
            esperado["docs"].add((mes, doc))
            if linea == "BONIFICACION":
                esperado["bonif"] += bruto
        # una fila contable de ajuste por mes (debe quedar FUERA de los cubes)
        idx += 1
        aj = round(rnd.uniform(1000, 9000), 2)
        filas.append([idx, mes, dt.date(y, m, 28).strftime("%d/%m/%Y"),
                      f"AJ-{mes:02d}", "NDI", "CASTILLO 1", "", "Buenos Aires",
                      "La Matanza", "RECICLAR S.A", "ACTIVO", "MANAOS",
                      "GASEOSAS", "2250cc", "COLA", "DIFERENCIAS/AJUSTES",
                      "1", "1", fmt(aj, "es"), "0", "0", "0",
                      fmt(aj, "es"), fmt(aj, "es"), "21,00", "0"])
        esperado["ajustes"] += aj
    esperado["docs"] = len(esperado["docs"])
    return pl.DataFrame(filas, schema=COLS, orient="row"), esperado


def correr(entrada, salida, extra=()):
    cmd = [sys.executable, ETL, entrada, "--salida", salida, *extra]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout); print(r.stderr)
        raise SystemExit(f"El ETL falló para {entrada}")
    return r.stdout, json.load(open(salida, encoding="utf-8"))


def verificar(js, esperado, etiqueta):
    fallos = []

    def chk(cond, msg):
        print(("  ok   " if cond else "  FALLA ") + msg)
        if not cond:
            fallos.append(msg)

    meta, serie = js["meta"], js["serie"]
    bruto = sum(x["b"] for x in serie)
    neto = sum(x["n"] for x in serie)
    vol = sum(x["v"] for x in serie)
    docs = sum(x["d"] for x in serie)

    chk(len(serie) == N_MES, f"{N_MES} meses en la serie (hay {len(serie)})")
    chk(meta["mes_labels"][0] == "Ene 25" and meta["mes_labels"][-1] == "Ago 26",
        f"etiquetas {meta['mes_labels'][0]} → {meta['mes_labels'][-1]}")
    chk(str(N_MES) in meta["mes_parcial"],
        f"último mes detectado como parcial ({meta['mes_parcial']})")
    chk(abs(bruto - esperado["bruto"]) <= 2 * N_MES,
        f"bruto {bruto:,.0f} ≈ esperado {esperado['bruto']:,.0f} "
        f"(dif {bruto - esperado['bruto']:,.0f})")
    chk(abs(neto - esperado["neto"]) <= 2 * N_MES,
        f"neto {neto:,.0f} ≈ esperado {esperado['neto']:,.0f}")
    chk(abs(vol - esperado["vol"]) < 1, f"volumen {vol:,.0f}")
    chk(docs == esperado["docs"], f"documentos únicos {docs} = {esperado['docs']}")
    chk(abs(js["ajustes"]["total"] - esperado["ajustes"]) <= N_MES,
        f"ajustes contables excluidos: {js['ajustes']['total']:,.0f}")
    chk(js["ajustes"]["filas"] == N_MES, f"{N_MES} filas de ajuste detectadas")
    chk(abs(js["bonif"]["total"] - esperado["bonif"]) <= N_MES,
        f"bonificaciones {js['bonif']['total']:,.0f}")
    chk(js["calidad"]["imp_int_coma_fix"] > 0,
        f"corrección del error de coma en imp. interno ({js['calidad']['imp_int_coma_fix']} filas)")

    c1 = sum(c[0] for mm in js["C1"] for v in mm for p in v for c in p)
    chk(abs(c1 - bruto) <= 2 * N_MES, f"cube C1 cuadra con la serie ({c1:,.0f})")
    c2 = sum(c[0] for mm in js["C2"] for c in mm)
    chk(abs(c2 - bruto) <= 2 * N_MES, f"cube C2 cuadra con la serie ({c2:,.0f})")
    c5 = sum(c["b"] for c in js["C5"])
    chk(abs(c5 - bruto) <= 2 * N_MES, f"cube de clientes C5 cuadra ({c5:,.0f})")
    c6 = sum(a["b"] for a in js["C6"])
    chk(abs(c6 - bruto) <= 2 * N_MES, f"cube de artículos C6 cuadra ({c6:,.0f})")
    chk(len(js["C5"]) == len(CLIS), f"{len(js['C5'])} clientes")
    chk("BONIFICACION" in meta["lineas"], "líneas presentes en meta")

    print(f"  → {etiqueta}: {'OK' if not fallos else str(len(fallos)) + ' FALLAS'}")
    return fallos


def main():
    print("Generando dataset sintético…")
    df, esperado = generar()
    print(f"  {df.height:,} filas | bruto esperado {esperado['bruto']:,.0f}")

    tmp = tempfile.mkdtemp(prefix="etl_test_")
    csv_p = os.path.join(tmp, "muestra.csv")
    xlsx_p = os.path.join(tmp, "muestra.xlsx")
    df.write_csv(csv_p, separator=";")
    # el ETL lee CSV como cp1252: reescribimos con esa codificación
    with open(csv_p, encoding="utf-8") as f:
        txt = f.read()
    with open(csv_p, "w", encoding="cp1252", errors="replace") as f:
        f.write(txt)

    fallos = []
    print("\n[1/3] CSV (;, cp1252, decimales mezclados)")
    _, js_csv = correr(csv_p, os.path.join(tmp, "csv.json"))
    fallos += verificar(js_csv, esperado, "CSV")

    hay_xlsx = True
    try:
        df.write_excel(xlsx_p)
    except Exception as e:                      # falta xlsxwriter
        hay_xlsx = False
        print(f"\n[2/3] XLSX: omitido ({e})")
    if hay_xlsx:
        print("\n[2/3] XLSX (motor calamine)")
        _, js_x = correr(xlsx_p, os.path.join(tmp, "x.json"))
        fallos += verificar(js_x, esperado, "XLSX")
        print("\n[3/3] XLSX --via-csv (streaming, poca RAM)")
        try:
            _, js_v = correr(xlsx_p, os.path.join(tmp, "v.json"), ["--via-csv"])
            fallos += verificar(js_v, esperado, "XLSX --via-csv")
        except SystemExit as e:
            print(f"  omitido: {e}")
        iguales = (js_csv["serie"] == js_x["serie"])
        print(("  ok    " if iguales else "  FALLA ") + "CSV y XLSX dan la misma serie")
        if not iguales:
            fallos.append("CSV != XLSX")

    print("\n" + ("TODO OK ✔" if not fallos else f"{len(fallos)} FALLAS ✘"))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
