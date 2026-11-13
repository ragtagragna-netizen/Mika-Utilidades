"""Descarga los pesos de los preprocesadores de lineart (Mika-Utilidades).

Uso (desde la raíz del paquete):  python scripts\\download_lineart_models.py
Sin red, los 3 preprocesadores sin modelo (Canny, PyraCanny, Standard) igual andan.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from mika_lineart.util import download_hf  # noqa: E402

WEIGHTS = [
    ("lllyasviel/Annotators", "sk_model.pth", ""),
    ("lllyasviel/Annotators", "netG.pth", ""),
    ("lllyasviel/Annotators", "erika.pth", ""),
    ("TheMistoAI/MistoLine", "MTEED.pth", "Anyline"),
]

if __name__ == "__main__":
    for repo, filename, sub in WEIGHTS:
        print(download_hf(repo, filename, subfolder=sub))
    print("Listo.")
