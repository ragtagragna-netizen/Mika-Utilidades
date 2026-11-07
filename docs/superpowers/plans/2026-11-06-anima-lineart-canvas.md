# Anima Lineart Canvas-Mika Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir un nodo que combine las resoluciones nativas de Anima con un lienzo de dibujo dentro de ComfyUI, que entregue lineart (fondo blanco, trazos negros) para el ControlNet-LLLite de Anima.

**Architecture:** Nodo Python (`nodes.py`) que decodifica un PNG base64 a un tensor `IMAGE` a la resolución elegida, más un widget DOM en `web/` (canvas HTML) que dibuja, persiste el PNG base64 en un widget oculto y compone la capa de calco.

**Tech Stack:** Python 3.13 (PIL, numpy, torch ya presentes), JavaScript del frontend de ComfyUI (`/scripts/app.js`), canvas 2D del navegador.

**Spec:** `docs/superpowers/specs/2026-11-06-anima-lineart-canvas-design.md`

## Global Constraints

- Sin dependencias nuevas: usar PIL, numpy, torch y el canvas del navegador.
- Sin requests a internet en el nodo.
- Seguir el patrón del repo: nodo Python en `nodes.py` + `.js` en `web/`; los datos van en un widget oculto (como `score_list_mika.js`).
- Widget del combo: `resolucion`. Widget oculto de datos: `dibujo` (base64 PNG **sin** prefijo `data:`).
- Resolución interna del lienzo = resolución elegida; la salida es exactamente esa resolución.
- Resoluciones (lista oficial CircleStone): `1024x1024 (1:1)` (default), `896x1152 (3:4)`, `832x1216 (5:8)`, `768x1344 (9:16)`, `640x1536 (9:21)`.
- **No hay git en esta carpeta** (`custom_nodes/` está en el `.gitignore` de ComfyUI y Mika-Utilidades no tiene repo propio). Los pasos de commit se reemplazan por verificación; no intentar `git commit`.
- Verificación Python: `C:\ComfyUI_portable\python_embeded\python.exe` (sin pytest; el test es un script con asserts).

## Review Focus

- **Dibujar con el lienzo escalado:** el nodo se ve más chico que la resolución nativa; el mapeo de puntero debe usar el `getBoundingClientRect()` del canvas, o los trazos caen corridos. (Test en Task 2, paso manual.)
- **Cambiar la resolución tras dibujar:** los trazos deben conservarse anclados arriba-izquierda, sin perder el dibujo ni romper el nodo. (Test manual, Task 2.)
- **Dibujo vacío:** el nodo Python debe devolver un lienzo blanco de la resolución, sin error. (Test automático, Task 1.)
- **Round-trip del workflow:** guardar y recargar el workflow debe restaurar el dibujo. (Test manual, Task 2.)
- **El calco no debe filtrarse:** la imagen importada nunca debe aparecer en la salida `IMAGE`. (Test manual, Task 3.)

---

### Task 1: Nodo Python + helper de decodificación + mappings

**Files:**
- Modify: `nodes.py` (imports arriba; helper junto a los otros helpers privados; clase nueva antes de `NODE_CLASS_MAPPINGS`; dos mappings al final)
- Create: `tests/test_anima_lineart_canvas.py`

**Interfaces:**
- Produce: `_mika_lineart_to_tensor(dibujo: str, width: int, height: int) -> torch.Tensor` — tensor `[1, H, W, 3]`, `float32`, rango 0..1; blanco si `dibujo` está vacío o inválido; ancla arriba-izquierda y recorta si el PNG no coincide con `width`/`height`.
- Produce: clase `AnimaLineartCanvasMika` con `INPUT_TYPES()` (`resolucion`, `dibujo`), `RETURN_TYPES = ("IMAGE", "INT", "INT")`, `RETURN_NAMES = ("image", "width", "height")`, `FUNCTION = "render"`, `CATEGORY = "Mika Utilidades/image"`, `render(self, resolucion, dibujo="")`.
- Produce: claves de mapping `"AnimaLineartCanvasMika"` en `NODE_CLASS_MAPPINGS` y `NODE_DISPLAY_NAME_MAPPINGS` (`"Anima Lineart Canvas-Mika"`).

- [ ] **Step 1: Escribir el test que falla en `tests/test_anima_lineart_canvas.py`**

```python
import base64
import importlib.util
import os
import sys
from io import BytesIO

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)

_spec = importlib.util.spec_from_file_location(
    "mika_nodes", os.path.join(os.path.dirname(__file__), "..", "nodes.py"))
mika = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mika)

from PIL import Image


def _b64_png(size, color):
    img = Image.new("RGB", size, color)
    buf = BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_empty_returns_white_canvas():
    t = mika._mika_lineart_to_tensor("", 64, 48)
    assert tuple(t.shape) == (1, 48, 64, 3), t.shape
    assert float(t.min()) == 1.0 and float(t.max()) == 1.0


def test_decodes_png_anchored_top_left():
    t = mika._mika_lineart_to_tensor(_b64_png((10, 10), (0, 0, 0)), 20, 20)
    assert tuple(t.shape) == (1, 20, 20, 3), t.shape
    assert float(t[0, 0, 0, 0]) == 0.0
    assert float(t[0, 19, 19, 0]) == 1.0


def test_invalid_base64_returns_white():
    t = mika._mika_lineart_to_tensor("no-es-base64!!", 8, 8)
    assert float(t.min()) == 1.0


def test_data_url_prefix_stripped():
    data = "data:image/png;base64," + _b64_png((4, 4), (0, 0, 0))
    t = mika._mika_lineart_to_tensor(data, 4, 4)
    assert float(t.max()) == 0.0


if __name__ == "__main__":
    count = 0
    for name in sorted(list(globals())):
        fn = globals()[name]
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
            count += 1
    print(f"ALL PASSED ({count})")
```

- [ ] **Step 2: Correr el test para ver que falla**

Run (desde `C:\ComfyUI_portable\ComfyUI`):
`C:\ComfyUI_portable\python_embeded\python.exe custom_nodes\Mika-Utilidades\tests\test_anima_lineart_canvas.py`
Expected: `AttributeError: module 'mika_nodes' has no attribute '_mika_lineart_to_tensor'`

- [ ] **Step 3: Implementar el helper en `nodes.py`**

Agregar `import base64` al bloque de imports (junto a `import hashlib`). Definir el helper a nivel de módulo, junto a los otros `_mika_*_` (por ejemplo antes del bloque `# NODOS`):

```python
def _mika_lineart_to_tensor(dibujo, width, height):
    """PNG base64 (lineart) -> tensor IMAGE [1,H,W,3] en 0..1. Lienzo
    blanco del tamaño pedido; los datos se anclan arriba-izquierda."""
    canvas = Image.new("RGB", (width, height), (255, 255, 255))
    if isinstance(dibujo, str) and dibujo:
        data = dibujo.split(",", 1)[1] if dibujo.startswith("data:") else dibujo
        try:
            img = Image.open(BytesIO(base64.b64decode(data))).convert("RGB")
            canvas.paste(img, (0, 0))
        except Exception:
            pass
    arr = np.asarray(canvas).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]
```

- [ ] **Step 4: Agregar la clase `AnimaLineartCanvasMika` en `nodes.py`**

Colocarla junto a `AnimaResolutionsMika`. El cuerpo de `render` separa `width`/`height` del primer token de `resolucion` (ej. `"896x1152 (3:4)"` → `896`, `1152`) y llama al helper.

- [ ] **Step 5: Registrar los mappings**

Agregar `"AnimaLineartCanvasMika": AnimaLineartCanvasMika,` al final de `NODE_CLASS_MAPPINGS` y `"AnimaLineartCanvasMika": "Anima Lineart Canvas-Mika",` al final de `NODE_DISPLAY_NAME_MAPPINGS`.

- [ ] **Step 6: Correr el test para ver que pasa**

Run: igual que el Step 2.
Expected: cuatro líneas `ok ...` y `ALL PASSED (4)`.

- [ ] **Step 7: Verificar que ComfyUI carga el módulo**

Run (desde `C:\ComfyUI_portable\ComfyUI`):
`C:\ComfyUI_portable\python_embeded\python.exe -c "import importlib.util,os;ROOT=os.getcwd();import sys;sys.path.insert(0,ROOT);spec=importlib.util.spec_from_file_location('mika_nodes','custom_nodes/Mika-Utilidades/nodes.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);print('AnimaLineartCanvasMika' in m.NODE_CLASS_MAPPINGS, m.NODE_DISPLAY_NAME_MAPPINGS['AnimaLineartCanvasMika'])"`
Expected: `True Anima Lineart Canvas-Mika`

- [ ] **Step 8: Checkpoint** — No hay git acá; no commitear. Seguir a Task 2.

---

### Task 2: Widget canvas (dibujo + persistencia + round-trip)

**Files:**
- Create: `web/anima_lineart_canvas_mika.js`
- Modify: `nodes.py` (sin cambios previstos)

**Interfaces:**
- Consume: widget `dibujo` (STRING oculto, base64 PNG sin prefijo) y widget `resolucion` (combo) — definidos en Task 1.
- Produce: el nodo guarda su estado de lienzo en `node._mikaLineart = { paint, underlay: null, undo: [], redo: [] }`; funciones `write(node)` y `load(node)`; el widget `dibujo` recibe `paint` compuesto sobre blanco como base64 PNG sin el prefijo `data:...;base64,`.

- [ ] **Step 1: Crear `web/anima_lineart_canvas_mika.js` con el esqueleto del patrón del repo**

Usar `import { app } from "/scripts/app.js";`, `app.registerExtension({ name: "Mika.AnimaLineartCanvas" })` y `beforeRegisterNodeDef` con guarda `nodeData.name !== "AnimaLineartCanvasMika"`. Helpers `dibujoWidget(node)` y `resolucionWidget(node)` buscan por `w.name`. `parseRes(value)` devuelve `[w, h]` desde el primer token del combo.

- [ ] **Step 2: Montar el DOM (canvas + toolbar) en `build(node)`**

- Ocultar el widget `dibujo` (`w.hidden = true`) y quitar cualquier DOM widget previo (`node._mikaDomWidget`), igual que `score_list_mika.js`.
- Crear `root` (columna), una `toolbar` (fila) y un `stage` con `position: relative`, `background: #fff` y `aspect-ratio: <w> / <h>`.
- Dentro del `stage`: `canvasPaint` (canvas 2D, `width = w`, `height = h`, `style.width = "100%"`, `style.height = "100%"`).
- `node.addDOMWidget("mika_lineart_canvas", "div", root)` con `serialize = false` y `computeSize = (width) => [width, toolbarHeight + stageHeight(width)]`, donde `stageHeight = (width - PAD) * h / w`. Guardar en `node._mikaDomWidget`.

- [ ] **Step 3: Implementar la persistencia y la carga**

- `write(node)`: crear un canvas temporal de `w×h`, rellenar blanco, `drawImage(paint, 0, 0)`, y guardar `tmp.toDataURL("image/png").split(",", 1)[1]` en el widget `dibujo` llamando `w.callback?.(value)`.
- `load(node)`: si el valor de `dibujo` no está vacío, pintarlo en `paint` con `img.onload`.
- Llamar `load` al montar (`onNodeCreated`) y en `onConfigure` (tras reconstruir, para workflows guardados).
- `onRemove`: limpiar el DOM y `node._mikaDomWidget`.

- [ ] **Step 4: Pincel, borrador, limpiar y deshacer/rehacer**

- Pincel: `ctx.strokeStyle = "#000"`, `ctx.lineWidth = grosor`, `lineCap/lineJoin = "round"`. Borrador: `ctx.globalCompositeOperation = "destination-out"` (el canvas de trazos es transparente sobre el fondo blanco del `stage`).
- Un click sin movimiento pinta un punto. `pointerdown` guarda `paint.toDataURL("image/png")` en `node._mikaLineart.undo` (tope 20, descartando el más viejo) y vacía `redo`; `pointermove` traza; `pointerup` llama `write(node)`.
- Botón "🗑️ Limpiar": guarda el estado actual en `undo` y limpia `paint`; luego `write(node)`.
- Botones "↶"/"↷": mueven dataURLs entre `undo` y `redo`, repintan `paint` desde el dataURL y llaman `write(node)`.
- Mapear coordenadas con `const r = canvasPaint.getBoundingClientRect(); x = (e.clientX - r.left) * canvasPaint.width / r.width;` (idéntico para `y`).

- [ ] **Step 5: Cambio de resolución**

- Envolver el `callback` de `resolucionWidget(node)`: al cambiar, snapshot del trazo actual (`paint.toDataURL()`), redimensionar `canvasPaint.width/height` y el `aspect-ratio` del `stage`, y repintar el snapshot en `(0, 0)`. Luego `write(node)` y reajustar la altura del nodo.

- [ ] **Step 6: Verificar en ComfyUI (manual)**

Reiniciar ComfyUI, recargar con `Ctrl+F5`, añadir **Anima Lineart Canvas-Mika** y comprobar:
1. El combo muestra las 5 resoluciones; cambiar a `896x1152 (3:4)` cambia la forma del lienzo.
2. Dibujar una diagonal, probar el grosor, el borrador, limpiar y deshacer/rehacer; al reconectar `image` a un `PreviewImage` y ejecutar, la salida tiene el trazo en la misma posición relativa (fondo blanco, trazo negro) y mide 896×1152.
3. Reducir el ancho del nodo a la mitad y dibujar en la esquina inferior derecha: el trazo sale en la esquina inferior derecha de la imagen de salida (mapeo de puntero correcto).
4. Con un dibujo hecho, cambiar la resolución y volver: el trazo sigue, anclado arriba-izquierda.
5. Guardar el workflow, recargarlo: el dibujo se restaura.

- [ ] **Step 7: Checkpoint** — No hay git acá; no commitear. Seguir a Task 3.

---

### Task 3: Capa de calco (importar imagen)

**Files:**
- Modify: `web/anima_lineart_canvas_mika.js`

**Interfaces:**
- Consume: el `stage` y `canvasPaint` de Task 2.
- Produce: `canvasUnderlay` (canvas 2D debajo de `canvasPaint`) y el input de archivo + slider de opacidad + toggle de visibilidad. La imagen de calco **no** se escribe en el widget `dibujo` ni se exporta.

- [ ] **Step 1: Agregar `canvasUnderlay` al `stage`**

Canvas de `w×h`, `position: absolute; inset: 0; width: 100%; height: 100%`, insertado **antes** de `canvasPaint` para quedar debajo. Redibujar el calco también al cambiar la resolución (mismo tamaño nuevo).

- [ ] **Step 2: Importar y dibujar "contain"**

Añadir a la toolbar un botón "🖼️ Calcar" que dispara un `<input type="file" accept="image/*">` oculto. Al elegir archivo: `URL.createObjectURL(file)` → `Image` → calcular `scale = min(cw/iw, ch/ih)`, centrar y `drawImage` en `canvasUnderlay`. Guardar el `Image` en `node._mikaLineart.underlay` para poder redibujar al cambiar resolución.

- [ ] **Step 3: Opacidad y mostrar/ocultar**

Slider `opacity` 0..1 (default `0.4`) que setea `canvasUnderlay.style.opacity`. Botón "👁" que alterna `canvasUnderlay.style.display` entre `""` y `"none"`.

- [ ] **Step 4: Asegurar que el calco no se exporta**

`write(node)` compone **solo** `canvasPaint` sobre blanco (nunca `canvasUnderlay`). Confirmar leyendo `write` que no referencia el underlay.

- [ ] **Step 5: Verificar en ComfyUI (manual)**

Con un dibujo hecho y una imagen de calco visible debajo:
1. Ejecutar y confirmar que la salida `IMAGE` contiene **solo** el trazo (sin la imagen de calco).
2. Cambiar opacidad y mostrar/ocultar: el calco responde; el dibujo no cambia.
3. Cambiar la resolución: el calco se reencaja ("contain") y el dibujo se conserva.

- [ ] **Step 6: Checkpoint** — No hay git acá; no commitear. Seguir a Task 4.

---

### Task 4: README

**Files:**
- Modify: `README.md`

**Interfaces:** ninguna.

- [ ] **Step 1: Agregar la fila en la sección "Imagen"**

Añadir a la tabla de `### Imagen` (después de **Load Image Path-Mika** o al final de la sección):

```
| **Anima Lineart Canvas-Mika** | Resoluciones nativas de Anima + lienzo para dibujar lineart a mano (pincel, grosor, borrador, limpiar, deshacer/rehacer). Importa una imagen para calcar (opacidad y mostrar/ocultar, no sale en la salida). Salida `image` (fondo blanco/trazos negros) + `width`/`height`. El dibujo se guarda dentro del workflow. |
```

- [ ] **Step 2: Verificación (manual)** — Abrir `README.md` y confirmar que la fila está en la sección "Imagen" y que el Markdown de la tabla sigue alineado.

- [ ] **Step 3: Checkpoint** — No hay git acá; no commitear. Fin del plan.
