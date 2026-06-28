#!/usr/bin/env python3
"""
get-widevine-keys.py
Obtiene las claves Widevine para un PSSH dado, usando pywidevine y un .wvd device.

Uso:
  python3 scripts/get-widevine-keys.py \\
    --pssh <base64_pssh> \\
    --license-url <url> \\
    --token <firebase_id_token> \\
    [--wvd <path/to/device.wvd>]

Salida JSON:
  {"keys": [{"kid": "hex_kid", "key": "hex_key"}, ...]}
  {"error": "mensaje de error"}
"""

import sys
import json
import base64
import argparse
import ssl
import urllib.request

def main():
    parser = argparse.ArgumentParser(description="Obtener claves Widevine via pywidevine")
    parser.add_argument("--pssh",        required=True,  help="PSSH en base64")
    parser.add_argument("--license-url", required=True,  help="URL del servidor de licencias Widevine")
    parser.add_argument("--token",       required=True,  help="Firebase ID token (Authorization: Bearer)")
    parser.add_argument("--wvd",         required=False, help="Ruta al archivo .wvd (Widevine Device)")
    args = parser.parse_args()

    try:
        from pywidevine.cdm  import Cdm
        from pywidevine.device import Device
        from pywidevine.pssh  import PSSH
    except ImportError:
        print(json.dumps({"error": "pywidevine no instalado: pip install pywidevine"}))
        sys.exit(1)

    # ─── Cargar dispositivo WVD ───────────────────────────────────────────────
    wvd_path = args.wvd
    if not wvd_path:
        # Buscar .wvd en ubicaciones comunes
        import os
        search_dirs = [
            os.path.join(os.path.dirname(__file__), ".."),
            os.path.dirname(__file__),
            os.path.expanduser("~/.config/pywidevine"),
            os.path.expanduser("~/.pywidevine"),
        ]
        for d in search_dirs:
            for f in os.listdir(d) if os.path.isdir(d) else []:
                if f.endswith(".wvd"):
                    wvd_path = os.path.join(d, f)
                    break
            if wvd_path:
                break

    if not wvd_path:
        print(json.dumps({"error": (
            "No se encontró un archivo .wvd. "
            "Provee uno con --wvd <ruta> o colócalo en el directorio del proyecto. "
            "Alternativamente usa --key para proveer la clave directamente."
        )}))
        sys.exit(1)

    try:
        device = Device.load(wvd_path)
    except Exception as e:
        print(json.dumps({"error": f"No se pudo cargar el dispositivo WVD: {e}"}))
        sys.exit(1)

    # ─── Crear CDM y sesión ───────────────────────────────────────────────────
    try:
        cdm        = Cdm.from_device(device)
        session_id = cdm.open()

        # Parsear PSSH — puede venir en base64 con o sin padding
        pssh_b64 = args.pssh
        # Normalizar padding
        pssh_b64 += "=" * (-len(pssh_b64) % 4)
        pssh = PSSH(pssh_b64)

        # Generar license challenge
        challenge = cdm.get_license_challenge(session_id, pssh)
    except Exception as e:
        print(json.dumps({"error": f"Error al crear challenge Widevine: {e}"}))
        sys.exit(1)

    # ─── Enviar challenge al servidor de licencias ────────────────────────────
    try:
        req = urllib.request.Request(
            args.license_url,
            data=challenge,
            headers={
                "Content-Type":      "text/plain;charset=UTF-8",
                "Accept":            "*/*",
                "Accept-Language":   "en-US,en;q=0.9",
                "Origin":            "https://vodscene.com",
                "Referer":           "https://vodscene.com/",
                "User-Agent":        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30, context=ssl._create_unverified_context()) as resp:
            license_bytes = resp.read()
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode(errors="replace")[:500]
        except Exception:
            pass
        print(json.dumps({"error": f"HTTP {e.code} del servidor de licencias: {body}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"Error al contactar servidor de licencias: {e}"}))
        sys.exit(1)

    # ─── Parsear respuesta y extraer claves ───────────────────────────────────
    try:
        cdm.parse_license(session_id, license_bytes)
        keys = cdm.get_keys(session_id)
    except Exception as e:
        print(json.dumps({"error": f"Error al parsear respuesta de licencia: {e}"}))
        sys.exit(1)

    # ─── Emitir resultado ─────────────────────────────────────────────────────
    content_keys = []
    for key in keys:
        if key.type == "CONTENT":
            content_keys.append({
                "kid": key.kid.hex,
                "key": key.key.hex(),
            })

    if not content_keys:
        # Si no hay CONTENT keys, devolver todas
        all_keys = [{"kid": k.kid.hex, "key": k.key.hex(), "type": k.type} for k in keys]
        print(json.dumps({"error": "No se encontraron claves CONTENT", "all_keys": all_keys}))
        sys.exit(1)

    cdm.close(session_id)
    print(json.dumps({"keys": content_keys}))


if __name__ == "__main__":
    main()
