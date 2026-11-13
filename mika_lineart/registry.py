"""Registro de preprocesadores de lineart (vendorizados de comfyui_controlnet_aux).

`run(name, image_pil, resolution)` devuelve PIL RGB con 255 = línea (lo que espera el
canvas del nodo, que usa el canal rojo como alfa) y con el lado menor = `resolution`.
"""

import warnings

import numpy as np
from PIL import Image

from . import canny, pyracanny, lineart_standard

# Los 7 del workflow LINEARTS.json, en su orden.
PREPROCESSORS = [
    "AnyLineArtPreprocessor_aux", "CannyEdgePreprocessor", "AnimeLineArtPreprocessor",
    "LineArtPreprocessor", "Manga2Anime_LineArt_Preprocessor",
    "LineartStandardPreprocessor", "PyraCannyPreprocessor",
]

# build: fábrica del detector. kwargs: defaults del NODO AIO (no del detector).
# invert: True si la salida natural es "línea oscura sobre blanco" (hay que invertir
#         para dejar 255 = línea).
_SPECS = {
    "CannyEdgePreprocessor": {
        "build": lambda: canny.CannyDetector(), "kwargs": {}, "invert": False,
    },
    "PyraCannyPreprocessor": {
        "build": lambda: pyracanny.PyraCannyDetector(),
        "kwargs": {"low_threshold": 64, "high_threshold": 128}, "invert": False,
    },
    "LineartStandardPreprocessor": {
        "build": lambda: lineart_standard.LineartStandardDetector(), "kwargs": {}, "invert": False,
    },
}


def run(name, image_pil, resolution=512):
    spec = _SPECS.get(name)
    if spec is None:
        raise ValueError(f"preprocesador desconocido: {name}")
    det = spec["build"]()
    # En imágenes planas los detectores dividen por percentiles degenerados:
    # numpy avisa (división inválida) pero la salida igual queda en ~0.
    with warnings.catch_warnings(), np.errstate(all="ignore"):
        warnings.simplefilter("ignore")
        out = det(np.array(image_pil.convert("RGB")),
                  detect_resolution=int(resolution or 512), **spec["kwargs"])
    x = np.asarray(out).astype(np.uint8)
    if x.ndim == 2:
        x = np.stack([x, x, x], axis=2)
    x = x[:, :, :3]
    if spec["invert"]:
        x = 255 - x
    return Image.fromarray(np.ascontiguousarray(x), "RGB")
