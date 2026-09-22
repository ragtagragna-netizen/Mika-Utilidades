# Mika Utilidades — Paquete de nodos para ComfyUI

Colección personal de nodos de utilidad para ComfyUI: manejo de texto/prompts,
tags, listas, índices, imágenes, sampling, resoluciones, control de
bypass/mute y medición de tiempos. Incluye extensiones JavaScript que
mejoran la UI (botones en headers, filas compactas, panel de tiempos, etc.).

## Instalación

1. Copiá/cloná la carpeta como `ComfyUI/custom_nodes/Mika-Utilidades`.
2. Los archivos `.js` deben quedar en la carpeta de extensiones web que
   carga tu ComfyUI (junto al resto de extensiones del paquete).
3. Reiniciá ComfyUI y recargá el navegador con `Ctrl + F5`.

No requiere dependencias extra: usa lo que ComfyUI ya trae
(`Pillow`, `requests`, `numpy`, `torch`).

---

## 📄 String / Texto

| Nodo | Clase | Descripción |
|---|---|---|
| **String Selector (Cut First Line)** | `StringSelectorCut` | Selecciona una línea por índice con wraparound. La UI agrega botón para cortar la primera línea. |
| **Text Box-Mika** | `TextBoxClipboard` | Caja de texto multilinea con botones de **copiar / seleccionar todo / pegar** en el header (expandido y colapsado). Tamaño por defecto mínimo. |
| **Visor-Mika** | `TextBoxVisor` | Muestra **cualquier tipo de valor** (str, int, float, bool, list, tuple, set, dict, Tensor, ndarray, bytes) como preview legible. Botones en header y preview en vivo por websocket. Lista de hasta 50 elementos. `text` es socketless: los links se conectan al slot `valor`. |
| **Tag Filter-Mika** | `TagFilter` | Conserva solo los primeros N segmentos de un texto separado por comas. |
| **Text Replace Dynamic-Mika** | `TextReplaceDynamic` | Reemplaza texto con hasta 30 pares find/replace dinámicos. Regex opcional. |
| **Text Concatenate Dynamic-Mika** | `TextConcatenateDynamic` | Concatena hasta 30 textos con separador configurable y limpieza opcional (`clean_output`). |
| **Prompt Edit (Loop)-Mika** | `PromptEditLoopMika` | Edición de prompt con memoria entre ejecuciones. Devuelve el prompt anterior y el actual. |
| **Text Line Selector-Mika** | `TextLineSelectorMika` | Selecciona un rango de líneas como LISTA, con opción de eliminarlas del cuadro (`delete_selected_lines`). |
| **Text Line Stepper-Mika** | `TextLineStepperMika` | Recorrido **escalonado** de líneas: `start_index` es el índice base que avanza automáticamente cada generación y `steps` es la cantidad de líneas por bloque (fija). `auto_advance=False` fija `start_index`. Salidas: `selected_lines` (lista) y `current_end` (string). |
| **Prompt Clean & Dedupe-Mika** | `PromptCleanDedupeMika` | Une **AnimaPromptFormatter** + **Remove Duplicate Tags [LP]**: quita saltos de línea, normaliza separadores a `", "` (sin espacios extra ni tags vacíos) y elimina tags repetidos conservando la primera aparición. `trailing_comma` activa la coma final como la del de LevelPixel. |

## 🧮 Score / Listas

| Nodo | Clase | Descripción |
|---|---|---|
| **Score List** | `ScoreListExtendable` | Filas numeradas nombre+valor (hasta 50) con `num_rows` visible. UI compacta: nombre y valor en la misma fila (valor = 1/3 del ancho). Suma solo las filas visibles. |
| **Float OutputList** | `FloatOutputList` | Convierte una lista de números en texto a una OutputList de FLOAT (`OUTPUT_IS_LIST`). |
| **List Unpack-Mika** | `ListUnpackMika` | **Unpack** de listas/tuplas/batches: separa la entrada en hasta 50 salidas según `output_count`. Soporta batches de IMAGE/LATENT (tensor 4D) y listas anidadas. |

## 🖼️ Imagen

| Nodo | Clase | Descripción |
|---|---|---|
| **Load Image-Mika** | `LoadImageMika` | Carga imagen desde ruta local o URL. Opción RGBA, máscara de alfa, dimensiones y nombre de archivo. |
| **Image Preview Clean-Mika** | `ImagePreviewCleanMika` | Preview de imagen **sin metadata ni workflow** (PNG limpio). |
| **Image Save Auto-Mika** | `ImageSaveAutoMika` | Guarda **automáticamente** cada imagen en la ruta local indicada (`save_path`, crea la carpeta si no existe). Prefijo, contador, timestamp, formato (png/jpg/webp) y preview limpio opcional. Salidas: `saved_paths`, `saved_count`. |

## 🏷️ Tags

| Nodo | Clase | Descripción |
|---|---|---|
| **Smart Tag Filter-Mika** | `SmartTagFilterMika` | Filtrado de tags con soporte de pesos `(tag:1.2)`, caracteres escapados (emoticones) y prefijos de color. Modos include/exclude. |
| **Tag If-Mika** | `TagIfMika` | Condicional por presencia de tags: hasta 6 pares find/output + salida `combined`. |
| **Tag Remover-Mika** | `TagRemoverMika` | Remueve tags de un prompt (compatible con pesos, paréntesis anidados y escapes). |

## ️ Tiempos de ejecución

| Nodo | Clase | Descripción |
|---|---|---|
| **⏱ Tiempos de Ejecución (config)** | `ExecutionTimerConfig` | Configura el panel flotante y las etiquetas de tiempo por nodo (`execution_timer.js`): mostrar/ocultar panel, badges y decimales. Arranca **minimizado**. No hace falta agregarlo: el timer funciona solo; este nodo solo ajusta la configuración. |

## 🔀 Utils — Bypass / Mute

| Nodo | Clase | Descripción |
|---|---|---|
| **Fast Groups Bypasser-Mika** | `FastGroupsBypasserMika` | Un toggle BOOLEAN por grupo para hacer **bypass** (mode 4). Controlable desde fuera de subgrafos vía websocket. |
| **Fast Groups Muter-Mika** | `FastGroupsMuterMika` | Igual pero con **mute** (mode 2 / Never). |
| **Fast Nodes Bypasser-Mika** | `FastNodesBypasserMika` | Conectás nodos a slots dinámicos y los bypasseás con toggles que aparecen por nodo conectado. Inputs dinámicos y promoción de toggles en subgrafos. |
| **Fast Nodes Muter-Mika** | `FastNodesMuterMika` | Igual pero con mute. |

## 🎯 Resolución / Sampling

| Nodo | Clase | Descripción |
|---|---|---|
| **Anima Resolutions-Mika** | `AnimaResolutionsMika` | Resoluciones Anima (base 1024) en varias proporciones. `random=True` sortea resolución en cada ejecución (no cacheable). |
| **Sampler Selector-Mika** | `SamplerSelectorMika` | Lista **todos los samplers instalados** (nativos + extensiones) con fallback estándar. Salidas: nombre (wildcard, conectable al KSampler), objeto `SAMPLER` y nombre como STRING. |
| **Scheduler Selector-Mika** | `SchedulerSelectorMika` | Igual pero para **schedulers**: salida wildcard conectable al input `scheduler` del KSampler + nombre como STRING. |

## 🔢 Índices

| Nodo | Clase | Descripción |
|---|---|---|
| **Index Int-Mika** | `IndexIntMika` | Índice INT con 3 modos: **fixed** (fijo) e **increment** (suma `step` por ejecución, con `wrap` opcional entre min/max; el avance se refleja en el widget `index`) y **random** (sorteo entre min/max, ignora `index`). El input `index` es conectable: si se enlaza un nodo, su valor manda. Salidas: `index` e `index_text`. |
| **Index Stepper-Mika** | `IndexStepperMika` | Escalona `steps` índices desde `start_index` (base) en cada ejecución, igual que el Text Line Stepper, cíclico dentro de 0..max_index. `steps` queda fijo; `start_index` auto-avanza (o se detiene con `auto_advance=False`). Salidas: `index_list` (LISTA con cada int del bloque), `current_start`, `current_end` y `range_text`. |

---

## Extensiones JavaScript incluidas

| Archivo | Qué hace |
|---|---|
| `text_box_editor_mika.js` | Botones copiar/seleccionar/pegar en el header del Editor, dibujo propio colapsado y link estable. |
| `text_box_visor_mika.js` | Lo mismo para el Visor + preview en vivo por websocket (`mika-visor-preview`). |
| `text_line_stepper_mika.js` | Refleja el auto-avance en el widget `start_index` tras cada ejecución (`steps` queda fijo). |
| `fast_nodes_bypasser_mika.js` / `fast_nodes_muter_mika.js` | Inputs dinámicos, toggles por nodo conectado y soporte de subgrafos. |
| `score_list_mika.js` | Filas compactas del Score List (nombre 2/3 + valor 1/3) y control de filas con `num_rows`. |
| `execution_timer.js` | Panel flotante arrastrable/colapsable con tiempos por nodo y total, + badges de tiempo sobre cada nodo. |
| `index_int_mika.js` | Actualiza el widget `index` tras cada ejecución (increment). |
| `index_stepper_mika.js` | Refleja el auto-avance en el widget `start_index` tras cada ejecución (`steps` queda fijo). |
| `list_unpack_mika.js` | Sincroniza las salidas visibles del List Unpack con `output_count`. |

## Notas

- Todos los nodos aparecen bajo la categoría **`Mika Utilidades/...`**.
- Los nodos con estado que avanza (steppers, index increment) usan
  `IS_CHANGED = nan` y mensajes `ui` + JS para persistir el avance en el workflow.
- Si agregás extensiones que suman samplers/schedulers nuevos, reiniciá
  ComfyUI para que los selectores los detecten.