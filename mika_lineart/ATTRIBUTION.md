# Atribución

El código de los detectores de este subpaquete (`canny`, `pyracanny`,
`lineart_standard`, `lineart`, `lineart_anime`, `manga_line`, `model_torch`,
`teed`) y las utilidades de `util.py` provienen de
**comfyui_controlnet_aux** (https://github.com/Fannovel16/comfyui_controlnet_aux),
licencia **Apache-2.0** (ver `LICENSE` en esta carpeta).

Los pesos de los modelos se descargan de HuggingFace (no se versionan en el repo):

- `lllyasviel/Annotators` — `sk_model.pth` (Realistic Lineart), `netG.pth`
  (Anime Lineart), `erika.pth` (Manga Lineart).
- `TheMistoAI/MistoLine` — `Anyline/MTEED.pth` (AnyLine).

Se incluyen aquí para que el nodo **Anima Lineart Canvas-Mika** funcione sin
necesitar el paquete `comfyui_controlnet_aux` instalado.
