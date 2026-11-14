"""Genera data/poses.json para el nodo Pose Gallery-Mika.

Recorre la API pública de la galería de poses de WaveSpeed AI y escribe el
listado (id, categoría, nombre, descripción, tags y nombres de archivo de
imagen) que el nodo usa como fuente de datos empaquetada. Las imágenes NO se
descargan acá: el nodo las baja del CDN y las cachea en user/.

Uso (desde la raíz del paquete):  python scripts\\build_pose_manifest.py

Nota: la API responde 200 solo con cabeceras de navegador; sin ellas CloudFront
devuelve 403. Por eso HEADERS.
"""

import json
import os
from datetime import datetime, timezone

import requests

# La API entrega 48 poses por página; 11 páginas cubren las 491 actuales.
PAGES = 11
EXPECTED_TOTAL = 491
API_URL = "https://wavespeed.ai/api/free-tools/poses?locale=en&page={page}"
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "poses.json")

ANGLES = ["Front", "3/4", "Side"]
IMAGE_BASE = "https://static.wavespeed.ai/media/images/"
THUMB_BASE = (
    "https://img.wavespeed.ai/fit-in/{w}x{h}/filters:format(webp)"
    "/filters:quality(82)/media/images/"
)
SOURCE = "https://wavespeed.ai/free-tools/ai-pose-gallery"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://wavespeed.ai/free-tools/ai-pose-gallery",
    "Origin": "https://wavespeed.ai",
}

N_IMAGES_PER_STYLE = 3  # Front / 3/4 / Side


def _clean_pose(pose):
    """Valida y normaliza una pose de la API. Lanza ValueError si falta algo."""
    if not isinstance(pose, dict):
        raise ValueError(f"pose inválida: {pose!r}")

    for key in ("id", "category", "name", "desc"):
        if not pose.get(key):
            raise ValueError(f"pose sin '{key}': {pose.get('id')!r}")

    img = pose.get("img") or {}
    for estilo in ("line", "3d"):
        files = img.get(estilo)
        if not isinstance(files, list) or len(files) != N_IMAGES_PER_STYLE:
            raise ValueError(
                f"pose {pose['id']!r}: '{estilo}' debe traer "
                f"{N_IMAGES_PER_STYLE} archivos (trae {len(files or [])})")

    return {
        "id": pose["id"],
        "category": pose["category"],
        "name": pose["name"],
        "desc": pose["desc"],
        "tags": list(pose.get("tags") or []),
        "img": {"line": list(img["line"]), "3d": list(img["3d"])},
    }


def build_manifest(poses, generated=None):
    """Lista de poses de la API -> dict del manifiesto (ordenado por id)."""
    cleaned = sorted((_clean_pose(p) for p in poses), key=lambda p: p["id"])

    counts = {}
    for p in cleaned:
        counts[p["category"]] = counts.get(p["category"], 0) + 1
    categories = [{"id": cid, "count": counts[cid]} for cid in sorted(counts)]

    if generated is None:
        generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "generated": generated,
        "source": SOURCE,
        "image_base": IMAGE_BASE,
        "thumb_base": THUMB_BASE,
        "total": len(cleaned),
        "angles": list(ANGLES),
        "categories": categories,
        "poses": cleaned,
    }


def fetch_poses():
    """Baja todas las páginas de la API y devuelve la lista de poses."""
    poses = []
    for page in range(1, PAGES + 1):
        resp = requests.get(API_URL.format(page=page), headers=HEADERS, timeout=30)
        resp.raise_for_status()
        chunk = resp.json().get("poses") or []
        if not chunk:
            break
        poses.extend(chunk)
        print(f"  page {page}: {len(chunk)} poses (total {len(poses)})")
    return poses


def main():
    poses = fetch_poses()
    manifest = build_manifest(poses)

    out = os.path.abspath(OUT_PATH)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"{manifest['total']} poses -> {out}")
    if manifest["total"] != EXPECTED_TOTAL:
        print(f"AVISO: se esperaban {EXPECTED_TOTAL} poses, llegaron {manifest['total']}.")


if __name__ == "__main__":
    main()
