# -*- coding: utf-8 -*-
"""
Descarga el archivo de datos desde Google Drive
===============================================
Baja "Proyección larga_2025-26.xlsx" (~158 MB) del link compartido y lo deja
en `datos/`, listo para el ETL.

Uso:
    python3 scripts/descargar_datos.py                    # usa el link por defecto
    python3 scripts/descargar_datos.py LINK_O_ID
    python3 scripts/descargar_datos.py LINK_O_ID -o datos/otro_nombre.xlsx

Después:
    python3 scripts/procesar_proyeccion.py datos/proyeccion_larga_2025-26.xlsx

Sólo usa la librería estándar (urllib): no hace falta instalar nada.
Requisitos: que el archivo esté compartido como "cualquiera con el link".

Nota: los archivos grandes de Drive muestran primero un aviso de "no se pudo
analizar en busca de virus"; el script resuelve ese formulario solo.
"""
import os
import re
import sys
import html
import http.cookiejar
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LINK_DEFECTO = ("https://docs.google.com/spreadsheets/d/"
                "1BxaNGBMDiXbSowF8so1JB1ABMs6ibRra/edit?usp=sharing&rtpof=true&sd=true")
DESTINO_DEFECTO = os.path.join(ROOT, "datos", "proyeccion_larga_2025-26.xlsx")
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def extraer_id(link):
    """Saca el fileId de cualquier forma de link de Drive/Docs (o lo devuelve
    tal cual si ya es un id)."""
    link = link.strip()
    for pat in (r"/d/([A-Za-z0-9_-]{20,})",          # /file/d/ID  /spreadsheets/d/ID
                r"[?&]id=([A-Za-z0-9_-]{20,})",      # uc?id=ID
                r"/folders/([A-Za-z0-9_-]{20,})"):
        m = re.search(pat, link)
        if m:
            return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{20,}", link):
        return link
    raise SystemExit(f"No pude extraer el id de Drive del link:\n  {link}")


def _abrir(op, url, data=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    return op.open(req, timeout=120)


def _resolver_confirmacion(op, resp, url):
    """Si Drive devolvió la página de aviso (HTML), rearma el pedido real."""
    ctype = resp.headers.get("Content-Type", "")
    if "text/html" not in ctype:
        return resp
    cuerpo = resp.read().decode("utf-8", "replace")
    resp.close()

    m = re.search(r'<form[^>]+id="download-form"[^>]+action="([^"]+)"', cuerpo) or \
        re.search(r'<form[^>]+action="([^"]+)"[^>]*id="download-form"', cuerpo)
    if m:
        action = html.unescape(m.group(1))
        campos = dict(re.findall(r'<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"', cuerpo))
        campos = {k: html.unescape(v) for k, v in campos.items()}
        qs = urllib.parse.urlencode(campos)
        return _abrir(op, f"{action}?{qs}" if qs else action)

    m = re.search(r"confirm=([0-9A-Za-z_\-]+)", cuerpo)
    if m:
        sep = "&" if "?" in url else "?"
        return _abrir(op, f"{url}{sep}confirm={m.group(1)}")

    if "no se puede acceder" in cuerpo.lower() or "sign in" in cuerpo.lower() \
            or "Solicitar acceso" in cuerpo:
        raise SystemExit("Drive pide permisos: compartí el archivo como "
                         "'Cualquier persona con el enlace' y reintentá.")
    raise SystemExit("Drive devolvió HTML inesperado (¿cambió el flujo de descarga?). "
                     "Bajalo a mano y pasá la ruta al ETL.")


def descargar(file_id, destino):
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    url = f"https://drive.usercontent.google.com/download?id={file_id}&export=download"

    resp = _abrir(op, url)
    resp = _resolver_confirmacion(op, resp, url)

    nombre = None
    cd = resp.headers.get("Content-Disposition", "")
    m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', cd)
    if m:
        nombre = urllib.parse.unquote(m.group(1))
    total = int(resp.headers.get("Content-Length") or 0)

    if destino is None:
        destino = os.path.join(ROOT, "datos", nombre or f"{file_id}.bin")
    os.makedirs(os.path.dirname(destino), exist_ok=True)

    print(f"Descargando{' ' + nombre if nombre else ''} "
          f"({total/1e6:.1f} MB)" if total else "Descargando…")
    leido = 0
    tmp = destino + ".part"
    with open(tmp, "wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            leido += len(chunk)
            if total:
                pct = 100 * leido / total
                print(f"\r  {leido/1e6:8.1f} / {total/1e6:.1f} MB  ({pct:5.1f} %)",
                      end="", flush=True)
            else:
                print(f"\r  {leido/1e6:8.1f} MB", end="", flush=True)
    print()
    resp.close()
    os.replace(tmp, destino)

    if os.path.getsize(destino) < 100_000:
        with open(destino, "rb") as f:
            cabeza = f.read(400)
        if b"<html" in cabeza.lower():
            os.remove(destino)
            raise SystemExit("Lo descargado era una página HTML, no el archivo. "
                             "Revisá los permisos del link.")
    return destino


def main():
    args = [a for a in sys.argv[1:]]
    destino = None
    if "-o" in args:
        i = args.index("-o")
        destino = args[i + 1]
        del args[i:i + 2]
    link = args[0] if args else LINK_DEFECTO
    if destino is None:
        destino = DESTINO_DEFECTO

    file_id = extraer_id(link)
    print(f"Drive id: {file_id}")
    ruta = descargar(file_id, destino)
    mb = os.path.getsize(ruta) / 1e6
    print(f"OK -> {ruta} ({mb:.1f} MB)")
    print("\nSiguiente paso:\n"
          f"  python3 scripts/procesar_proyeccion.py \"{ruta}\"")


if __name__ == "__main__":
    main()
