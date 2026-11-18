"""Genera data/poses.json para el nodo Pose Gallery-Mika.

Junta dos galerías públicas en un solo listado:

- WaveSpeed AI (491 poses): API JSON con estilo line/3d y 3 ángulos por
  estilo; las imágenes se sirven del CDN de WaveSpeed.
- POSE-DB-01 (288 poses, https://ai-pose-gallery.pages.dev/, catálogo de
  ギア @giaaibusi): listado espejado en
  github.com/anhao/ai-pose-gallery-zh (data/pose.json). Cada grupo trae 5
  ángulos; acá se usan Frente (正面), 3/4 (斜め) y Side (横), que son los
  tres que maneja el nodo. Los metadatos originales son japoneses: el
  nombre se conserva tal cual y la descripción/tag van en español. Las
  imágenes NO se descargan acá: el nodo las baja del sitio original y las
  cachea en user/.

Uso (desde la raíz del paquete):  python scripts\\build_pose_manifest.py

Nota: la API de WaveSpeed responde 200 solo con cabeceras de navegador; sin
ellas CloudFront devuelve 403. Por eso HEADERS.
"""

import json
import os
import re
from datetime import datetime, timezone

import requests

# --- WaveSpeed AI -----------------------------------------------------
# La API entrega 48 poses por página; 11 páginas cubren las 491 actuales.
PAGES = 11
EXPECTED_WAVESPEED = 491
API_URL = "https://wavespeed.ai/api/free-tools/poses?locale=en&page={page}"

# --- POSE-DB-01 (ai-pose-gallery.pages.dev) ---------------------------
POSEDB_SOURCE = "https://ai-pose-gallery.pages.dev/"
POSEDB_REPO = "https://github.com/anhao/ai-pose-gallery-zh"
POSEDB_API_URL = (
    "https://raw.githubusercontent.com/anhao/ai-pose-gallery-zh/main/data/pose.json")
POSEDB_IMAGE_BASE = "https://ai-pose-gallery.pages.dev/img/"
POSEDB_THUMB_BASE = "https://ai-pose-gallery.pages.dev/thumbs/"
EXPECTED_POSEDB = 288

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "poses.json")

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

ANGLES = ["Front", "3/4", "Side"]
IMAGE_BASE = "https://static.wavespeed.ai/media/images/"
THUMB_BASE = (
    "https://img.wavespeed.ai/fit-in/{w}x{h}/filters:format(webp)"
    "/filters:quality(82)/media/images/"
)
SOURCE = "https://wavespeed.ai/free-tools/ai-pose-gallery"

N_IMAGES_PER_STYLE = 3  # Front / 3/4 / Side

# Nombres de archivo seguros (los valida también el nodo al servir la cache).
_FILE_RE = re.compile(r"^[0-9a-zA-Z][0-9a-zA-Z_\-]*\.(?:webp|png|jpe?g)$")

# --- POSE-DB: traducciones (el sitio está en japonés) -----------------

#: 系統 (serie) -> (etiqueta en español para la descripción).
POSEDB_SERIES_ES = {
    "全身1人・セクシー系": "Cuerpo completo · sexy",
    "全身1人・標準系": "Cuerpo completo · estándar",
    "上半身1人": "Medio cuerpo",
    "2人絡み": "Dos personas (pareja)",
}

#: 分類 (tipo de pose) -> (id de categoría del nodo, etiqueta en español).
POSEDB_BUNRUI = {
    "立ち": ("standing", "de pie"),
    "座り": ("sitting", "sentada"),
    "膝立ち・四つん這い": ("kneeling", "arrodillada o en cuatro apoyos"),
    "膝立ち": ("kneeling", "arrodillada"),
    "寝そべり": ("lying", "recostada"),
    "横座り・女の子座り": ("sitting-floor", "sentada de lado"),
    "しゃがみ": ("crouching", "agachada"),
    "前かがみ": ("leaning", "inclinada al frente"),
    "のけぞり・反り": ("arching", "arqueada hacia atrás"),
    "ひねり": ("twisting", "girada"),
    "特殊": ("special", "especial"),
    "かわいい系": ("cute", "tierna"),
    "胸寄せ・谷間強調系": ("pinup", "pin-up (pecho resaltado)"),
    "セクシー・露骨寄り系": ("sexy", "sexy"),
    # Serie de parejas (2人絡み): todas caen en la categoría "couple".
    "立位": ("couple", "pareja de pie"),
    "顔寄せ系": ("couple", "pareja, caras juntas"),
    "正常位": ("couple", "pareja, frontal"),
    "後背位": ("couple", "pareja, desde atrás"),
    "座位": ("couple", "pareja sentada"),
    "背面座位": ("couple", "pareja sentada, ella de espaldas"),
    "騎乗位": ("couple", "pareja, ella arriba"),
    "側位": ("couple", "pareja de lado"),
    "対面座位": ("couple", "pareja sentada frente a frente"),
    "立位密着": ("couple", "pareja de pie, abrazados"),
    "座位密着": ("couple", "pareja sentados, abrazados"),
    "密着": ("couple", "pareja abrazada"),
}

#: Serie de parejas: su 分类 va toda a la categoría "couple" del nodo.
POSEDB_COUPLE_SERIES = "2人絡み"

#: アングル -> (sufijo de archivo, índice de ángulo del nodo). POSE-DB trae
#: cinco ángulos por pose; WaveSpeed tres. El orden define los índices con
#: que el nodo indexa img.line.
POSEDB_ANGLES = {
    "正面": ("front", 0),   # Front
    "斜め": ("diag", 1),    # 3/4
    "横": ("side", 2),      # Side
    "上から": ("high", 3),  # Desde arriba
    "下から": ("low", 4),   # Desde abajo
}
POSEDB_ANGLE_COUNT = 5

#: Etiquetas de los ángulos de POSE-DB (las tres primeras son las comunes).
POSEDB_ANGLE_LABELS = ANGLES + ["Desde arriba", "Desde abajo"]


def _clean_pose(pose):
    """Valida y normaliza una pose de WaveSpeed. Lanza ValueError si falta algo."""
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
        "source": "wavespeed",
        "category": pose["category"],
        "name": pose["name"],
        "desc": pose["desc"],
        "tags": list(pose.get("tags") or []),
        "img": {"line": list(img["line"]), "3d": list(img["3d"])},
    }


def _clean_posedb_pose(pose):
    """Valida una pose de POSE-DB ya convertida al schema del nodo.

    Difiere de WaveSpeed: no tiene estilo 3d (el nodo cae a "line"), puede
    traer hasta POSEDB_ANGLE_COUNT ángulos (un ángulo sin imagen va como
    string vacío) y trae base/thumb_base/thumbs propios (las imágenes viven
    en su sitio).
    """
    if not isinstance(pose, dict):
        raise ValueError(f"pose inválida: {pose!r}")

    for key in ("id", "category", "name"):
        if not pose.get(key):
            raise ValueError(f"pose sin '{key}': {pose.get('id')!r}")

    files = (pose.get("img") or {}).get("line") or []
    if not (0 < len(files) <= POSEDB_ANGLE_COUNT):
        raise ValueError(
            f"pose {pose['id']!r}: 'line' debe traer entre 1 y "
            f"{POSEDB_ANGLE_COUNT} archivos (trae {len(files)})")
    for f in files:
        if f and not _FILE_RE.match(f):
            raise ValueError(f"pose {pose['id']!r}: archivo raro {f!r}")
    if not any(files):
        raise ValueError(f"pose {pose['id']!r}: sin imágenes")

    out = {
        "id": pose["id"],
        "source": "posedb",
        "category": pose["category"],
        "name": pose["name"],
        "desc": pose.get("desc", ""),
        "tags": list(pose.get("tags") or []),
        "img": {"line": list(files)},
    }
    # Campos opcionales que apuntan al origen de las imágenes.
    for key in ("base", "thumb_base"):
        if pose.get(key):
            out[key] = pose[key]
    thumbs = (pose.get("thumbs") or {}).get("line")
    if thumbs:
        out["thumbs"] = {"line": list(thumbs)}
    return out


def _clean_any(pose):
    """Limpia una pose según su origen (claves japonesas = POSE-DB cruda)."""
    if isinstance(pose, dict) and "系統" in pose:
        raise ValueError(
            "pose de POSE-DB sin agrupar; pasá las salidas de "
            "build_posedb_poses(), no la API cruda")
    if isinstance(pose, dict) and pose.get("source") == "posedb":
        return _clean_posedb_pose(pose)
    return _clean_pose(pose)


def build_manifest(poses, generated=None):
    """Lista de poses (ambas fuentes) -> dict del manifiesto (ordenado por id)."""
    cleaned = sorted((_clean_any(p) for p in poses), key=lambda p: p["id"])

    counts = {}
    for p in cleaned:
        counts[p["category"]] = counts.get(p["category"], 0) + 1
    categories = [{"id": cid, "count": counts[cid]} for cid in sorted(counts)]

    if generated is None:
        generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "generated": generated,
        "source": SOURCE,
        # Cada fuente con sus ángulos y estilos; la UI arma por acá el combo
        # de ángulos y el toggle de estilo de cada galería.
        "sources": [
            {"id": "wavespeed", "label": "WaveSpeed AI",
             "angles": list(ANGLES), "styles": ["line", "3d"]},
            {"id": "posedb", "label": "POSE-DB-01",
             "angles": list(POSEDB_ANGLE_LABELS), "styles": ["line"]},
        ],
        "image_base": IMAGE_BASE,
        "thumb_base": THUMB_BASE,
        "total": len(cleaned),
        "angles": list(ANGLES),
        "categories": categories,
        "poses": cleaned,
    }


def fetch_poses():
    """Baja todas las páginas de la API de WaveSpeed y devuelve las poses crudas."""
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


def fetch_posedb():
    """Baja el listado crudo de POSE-DB (entradas por ángulo, en japonés)."""
    resp = requests.get(POSEDB_API_URL, headers={"User-Agent": HEADERS["User-Agent"]},
                        timeout=30)
    resp.raise_for_status()
    entries = resp.json()
    if not isinstance(entries, list):
        raise ValueError(f"POSE-DB: se esperaba una lista, llegó {type(entries).__name__}")
    print(f"  pose-db: {len(entries)} entradas ({POSEDB_SOURCE})")
    return entries


def build_posedb_poses(entries):
    """Entradas crudas de POSE-DB (una por ángulo) -> poses con schema del nodo.

    Agrupa por (系統, ポーズ番号): cada grupo es una pose con sus archivos
    Front (正面), 3/4 (斜め) y Side (横), más la miniatura de cada ángulo.
    """
    groups = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        key = (e.get("系統") or "", e.get("ポーズ番号") or "")
        groups.setdefault(key, []).append(e)

    poses = []
    for (kei, num), items in sorted(groups.items()):
        by_angle = {}
        for e in items:
            ang = POSEDB_ANGLES.get(e.get("アングル"))
            if ang:
                by_angle[ang[1]] = e

        if 0 not in by_angle:
            continue  # sin Front no hay pose que mostrar
        front = by_angle[0]
        # Los cinco ángulos en orden canónico; un ángulo que la pose no tiene
        # (p. ej. P018 no trae "desde abajo") va como string vacío y el nodo
        # cae al primero disponible.
        img, thumbs = [], []
        for i in range(POSEDB_ANGLE_COUNT):
            e = by_angle.get(i)
            img.append(str(e.get("原寸") or "").removeprefix("img/") if e else "")
            thumbs.append(str(e.get("サムネ") or "").removeprefix("thumbs/") if e else "")

        # Los tres ángulos base (Front / 3/4 / Side) son obligatorios.
        if any(not img[i] for i in range(N_IMAGES_PER_STYLE)):
            continue
        if not all(thumbs) or len(thumbs) != len(img):
            thumbs = []  # sin miniaturas válidas, el nodo genera del original

        # id = nombre de archivo sin extensión ni sufijo del ángulo
        # (full_sexy_P001_front.png -> full_sexy_P001).
        stem = img[0].rsplit(".", 1)[0]
        pose_id = re.sub(r"_(?:front|diag|side|high|low)$", "", stem)

        bunrui = front.get("分類") or ""
        series_es = POSEDB_SERIES_ES.get(kei, kei)
        if kei == POSEDB_COUPLE_SERIES:
            category = "couple"
        else:
            category = POSEDB_BUNRUI.get(bunrui, ("special", ""))[0]
        bunrui_es = POSEDB_BUNRUI.get(bunrui, (None, bunrui))[1]

        pose = {
            "id": pose_id,
            "source": "posedb",
            "category": category,
            "name": front.get("ポーズ名") or pose_id,
            "desc": f"{series_es} — {bunrui_es}.",
            "tags": [series_es, bunrui_es, "pose-db", num],
            "img": {"line": img},
            "base": POSEDB_IMAGE_BASE,
            "thumb_base": POSEDB_THUMB_BASE,
        }
        if thumbs:
            pose["thumbs"] = {"line": thumbs}
        poses.append(pose)
    return poses


def main():
    print("WaveSpeed AI:")
    ws_poses = fetch_poses()
    print("POSE-DB-01:")
    db_poses = build_posedb_poses(fetch_posedb())

    manifest = build_manifest(ws_poses + db_poses)

    out = os.path.abspath(OUT_PATH)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"{manifest['total']} poses -> {out}")
    if len(ws_poses) != EXPECTED_WAVESPEED:
        print(f"AVISO: WaveSpeed, se esperaban {EXPECTED_WAVESPEED}, "
              f"llegaron {len(ws_poses)}.")
    if len(db_poses) != EXPECTED_POSEDB:
        print(f"AVISO: POSE-DB, se esperaban {EXPECTED_POSEDB}, "
              f"llegaron {len(db_poses)}.")


if __name__ == "__main__":
    main()
