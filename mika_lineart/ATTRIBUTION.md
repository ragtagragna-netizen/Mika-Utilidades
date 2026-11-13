# Atribución

Este subpaquete **vendoriza** código de **comfyui_controlnet_aux**
(https://github.com/Fannovel16/comfyui_controlnet_aux), que reúne obras de distintas
licencias. Cada una viaja con su aviso:

- `util.py`, `canny`, `pyracanny`, `lineart_standard`: **Apache-2.0**
  (ver `LICENSE` en esta carpeta).
- `lineart` ("Realistic Lineart"): **MIT** — © 2022 Caroline Chan
  (ver `lineart/LICENSE`).
- `lineart_anime` ("Anime Lineart"): **MIT** — © 2022 Caroline Chan
  (ver `lineart_anime/LICENSE`).
- `manga_line` + `model_torch` ("Manga Lineart"): **MIT** — © 2021 Miaomiao Li
  (ver `manga_line/LICENSE`).
- `teed` (TED / `MTEED.pth`): **MIT** — © 2022 Xavier Soria Poma
  (ver `teed/LICENSE.txt`).

Los pesos de los modelos se descargan de HuggingFace (no se versionan en el repo):

- `lllyasviel/Annotators` — `sk_model.pth` (Realistic Lineart), `netG.pth`
  (Anime Lineart), `erika.pth` (Manga Lineart).
- `TheMistoAI/MistoLine` — `Anyline/MTEED.pth` (AnyLine).

Se incluyen aquí para que el nodo **Anima Lineart Canvas-Mika** funcione sin
necesitar el paquete `comfyui_controlnet_aux` instalado.
