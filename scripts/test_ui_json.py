# -*- coding: utf-8 -*-
"""
Valida data/proyeccion.json antes de publicarlo
===============================================
No necesita dependencias: solo la librería estándar. Chequea que el JSON tenga
la forma que espera el tablero y que los cubes cuadren con la serie mensual.

Uso:
    python3 scripts/test_ui_json.py [ruta_al_json]
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUTA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "proyeccion.json")

fallos = []


def chk(cond, msg):
    print(("  ok    " if cond else "  FALLA ") + msg)
    if not cond:
        fallos.append(msg)


def main():
    if not os.path.exists(RUTA):
        print(f"No existe {RUTA} — corré antes scripts/procesar_proyeccion.py")
        return 1
    d = json.load(open(RUTA, encoding="utf-8"))
    mb = os.path.getsize(RUTA) / 1e6
    print(f"Validando {RUTA} ({mb:.2f} MB)")

    for k in ["meta", "calidad", "ajustes", "bonif", "serie",
              "C1", "C2", "C3", "C4a", "C4b", "C4c", "C4d", "C5", "C6", "C7"]:
        chk(k in d, f"existe la clave {k}")
    if fallos:
        return 1

    m = d["meta"]
    NM = len(m["mes_labels"])
    chk(NM >= 12, f"{NM} meses en la temporada ({m['mes_labels'][0]} → {m['mes_labels'][-1]})")
    chk(len(d["serie"]) == NM, "la serie tiene un punto por mes")
    for k in ["vnds", "vnd2s", "provs", "lineas", "tipos", "pres", "sabores", "doctipos"]:
        chk(k in m and len(m[k]) > 0, f"meta.{k}: {len(m.get(k, []))} valores")

    chk(len(d["C1"]) == NM, "C1 tiene un plano por mes")
    chk(len(d["C1"][0]) == len(m["vnds"]), "C1 × vendedores")
    chk(len(d["C1"][0][0]) == len(m["provs"]), "C1 × provincias")
    chk(len(d["C1"][0][0][0]) == len(m["lineas"]), "C1 × líneas")
    chk(len(d["C2"]) == NM and len(d["C2"][0]) == len(m["vnds"]), "C2 mes × vendedor")
    chk(len(d["C3"]) == NM and len(d["C3"][0]) == len(m["vnd2s"]), "C3 mes × 2º vendedor")

    bruto = sum(x["b"] for x in d["serie"])
    neto = sum(x["n"] for x in d["serie"])
    c1 = sum(c[0] for mm in d["C1"] for v in mm for p in v for c in p)
    c2 = sum(c[0] for mm in d["C2"] for c in mm)
    c5 = sum(c["b"] for c in d["C5"])
    c6 = sum(a["b"] for a in d["C6"])
    tol = max(1000.0, abs(bruto) * 1e-6)
    chk(bruto != 0, f"bruto total = {bruto:,.0f}")
    chk(neto != 0, f"neto total  = {neto:,.0f}")
    chk(abs(c1 - bruto) < tol, f"cube C1 cuadra con la serie (dif {c1 - bruto:,.0f})")
    chk(abs(c2 - bruto) < tol, f"cube C2 cuadra con la serie (dif {c2 - bruto:,.0f})")
    chk(abs(c5 - bruto) < tol, f"clientes C5 cuadran (dif {c5 - bruto:,.0f})")
    chk(abs(c6 - bruto) < tol, f"artículos C6 cuadran (dif {c6 - bruto:,.0f})")

    meses_con_datos = sum(1 for x in d["serie"] if x["n"])
    chk(meses_con_datos >= NM - 1, f"{meses_con_datos} de {NM} meses con ventas")
    parciales = m.get("mes_parcial", {})
    print(f"  info  meses parciales: {parciales or 'ninguno'}")
    print(f"  info  clientes: {m['n_clientes']:,} · artículos: {m['n_articulos']:,} · "
          f"filas leídas: {m['filas']:,}")
    nulos = d["calidad"].get("null_total_renglon", 0)
    pct_nulos = 100 * nulos / max(1, m["filas"])
    chk(pct_nulos < 5, f"renglones sin importe: {nulos:,} ({pct_nulos:.2f} % del total)")
    if 0.5 <= pct_nulos < 5:
        print(f"  aviso  {pct_nulos:.2f} % de renglones sin importe — revisá el formato "
              f"numérico del origen antes de publicar")

    print("\n" + ("TODO OK" if not fallos else f"{len(fallos)} FALLAS"))
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
