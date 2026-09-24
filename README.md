# Mika Utilidades — Paquete de nodos para ComfyUI

Colección personal de nodos de utilidad para ComfyUI: manejo de texto y
prompts, tags, listas, índices, imágenes, sampling, resoluciones, control de
bypass/mute y medición de tiempos. Incluye extensiones JavaScript que mejoran
la UI (botones en headers, filas compactas, paneles flotantes, colores de
nodo extra, etc.).

Todos los nodos aparecen bajo la categoría **`Mika Utilidades/...`**.

## Instalación

1. Copiá/cloná la carpeta como `ComfyUI/custom_nodes/Mika-Utilidades`.
2. Reiniciá ComfyUI y recargá el navegador con `Ctrl + F5`.

No requiere dependencias extra: usa lo que ComfyUI ya trae
(`Pillow`, `requests`, `numpy`, `torch`).

---

## 🏷️ Tags y Prompts (nucleo del paquete)

El corazón del paquete es la familia **FILTROS**, una versión sólida del
subgrafo "FILTROS": un solo nodo reemplaza una docena de nodos encadenados.

- **FILTROS-Mika** (`FiltrosMika`) — 4 filtros GEN/CARA/ROPA/LUGAR sobre el
  prompt, extras de personajes por conteo (`2girls` → 1 extra,
  `3girls` → 2... desde `per_f_extra`/`per_m_extra`, en modo **index** por
  orden de línea o **random** por seed), detección de lenguaje natural con
  `min_palabras` (salida `TAGS NATURAL` + opción `concatenar_natural` para
  sumarlas a F GEN), modo **NSFW/SFW** (agrega el tag `uncensored` cuando el
  prompt contiene tags de `penis`/`pussy`/`sex`, o los elimina en SFW) y
  coma final opcional. 14 salidas: 7 combinaciones, `TAGS SIN FILTRO`
  (ignora pesos y prefijos de color: `shirt` también filtra `white shirt`),
  los 4 filtros passthrough y `PROMPT SIN FILTRO`. Todas las entradas de
  filtro son opcionales (desconectadas = vacías).
- **FILTROS Select-Mika** (`FiltrosMikaSelect`) — misma lógica con **una
  salida elegida por combo** (`salida`, las 8 opciones del clásico switch
  EZ) más salidas fijas `FILTRO GENERAL/ROPA/CARA/LUGAR`, `TAGS SIN FILTRO`
  y `TAGS NATURAL`.

Organización de prompts sin más filtrado:

- **Prompt Reorganize-Mika** (`PromptReorganizeMika`) — ordena el prompt por
  secciones (`GEN`, `ROPA`, `CARA`, `LUGAR`, `NATURAL`, `SIN FILTRO`)
  asignándolas por cascada (`all_gen` → ropa → cara → `all_lugar` → natural
  → resto). El orden se elige manualmente con 6 combos. Con
  `agrupar_similares`, agrupa tags que comparten palabras dentro de cada
  sección (`shirt` con `white shirt`, `ass` con `huge ass`) sin mezclar
  secciones. Las frases naturales van al final de cada sección.
- **Text Clean & Organize-Mika** (`TextCleanOrganizeMika`) — procesa listas
  o párrafos (artistas, tags, etc.): elimina repetidos, quita palabras de
  color (`black_hair` → `hair`), agrupa por similares, todo **respetando el
  formato** (comas y saltos de línea). Muestra `IN / QUITADOS / OUT` dentro
  del nodo y tiene salida extra `eliminados`.
- **Text Clean & Organize Concat-Mika** (`TextCleanOrganizeConcatMika`) —
  igual, pero con slots dinámicos `text_1..N` (control por `text_count`)
  para **concatenar varias listas** antes de limpiar.
- **Text Cleaner Compare-Mika** (`TextCleanerCompareMika`) — elimina de
  `tags_in` lo que se repite en `base` (ignora mayúsculas, pesos y
  guiones bajos). Salidas: `text` y `eliminados`.

Utilidades sueltas de tags:

| Nodo | Clase | Descripción |
|---|---|---|
| **Smart Tag Filter-Mika** | `SmartTagFilterMika` | Filtrado con pesos `(tag:1.2)`, caracteres escapados y prefijos de color. Modos include/exclude. |
| **Tag If-Mika** | `TagIfMika` | Condicional por presencia de tags: hasta 6 pares find/output + `combined`. |
| **Tag Remover-Mika** | `TagRemoverMika` | Remueve tags de un prompt (pesos, paréntesis anidados y escapes). |
| **Prompt Clean & Dedupe-Mika** | `PromptCleanDedupeMika` | Limpia saltos de línea, normaliza separadores y quita duplicados (equivale a AnimaPromptFormatter + Remove Duplicate Tags). |
| **Prompt Edit (Loop)-Mika** | `PromptEditLoopMika` | Edición de prompt con memoria entre ejecuciones. |

## 📄 String / Texto

| Nodo | Clase | Descripción |
|---|---|---|
| **String Selector (Cut First Line)** | `StringSelectorCut` | Línea por índice con wraparound + botón para cortar la primera línea. |
| **Text Box-Mika** | `TextBoxClipboard` | Caja multilínea con botones **copiar / seleccionar todo / pegar** en el header (expandido y colapsado). |
| **Text Box Paste-Mika** | `TextBoxPasteMika` | Igual pero con un único botón de **pegar que reemplaza** todo el texto. |
| **Note-Mika** | `NoteMika` | Nota sin inputs/outputs con los botones de portapapeles del Text Box. |
| **Visor-Mika** | `TextBoxVisor` | Muestra cualquier valor (str, números, listas, tensores...) con preview en vivo por websocket. |
| **Tag Filter-Mika** | `TagFilter` | Conserva los primeros N segmentos separados por comas. |
| **Text Replace Dynamic-Mika** | `TextReplaceDynamic` | Hasta 30 pares find/replace dinámicos, regex opcional. |
| **Text Concatenate Dynamic-Mika** | `TextConcatenateDynamic` | Hasta 30 textos con separador configurable y limpieza opcional. |
| **Text Line Selector-Mika** | `TextLineSelectorMika` | Rango de líneas como LISTA, con `delete_selected_lines`. |
| **Text Line Stepper-Mika** | `TextLineStepperMika` | Recorrido escalonado: `start_index` auto-avanza, `steps` fija el bloque. |
| **Primitive-Mika** | `PrimitiveMika` | Primitivo genérico: al conectarlo a un slot-widget adopta sus opciones (combo, número o texto) **sin controles de seed**. |

## 🌐 Traducción

Port de los nodos MarianMT (antes kkTranslator) — mismos nombres de clase,
así que workflows viejos los cargan directo:

| Nodo | Clase | Descripción |
|---|---|---|
| **Load MarianMT CheckPoint-Mika** | `LoadMarianMTCheckPoint` | Carga un modelo MarianMT desde `models/MikaTranslator/<modelo>` (descarga el checkpoint de Helsinki-NLP a mano). |
| **Smart Prompt Translate-Mika** | `SmartPromptTranslate` | Traduce al inglés solo los segmentos en español; respeta tags SD, comillas dobles, y tiene modos *detectar idioma* / *contar palabras* + `debug_info`. |
| **Prompt Translate to Text-Mika** | `PromptTranslateToText` | Traduce el texto completo con el modelo cargado. |

Requiere `transformers`; el detector usa el propio tokenizer (o
`fast-langdetect` si está instalado, o una lista de palabras como fallback).

## 🧮 Score / Listas

| Nodo | Clase | Descripción |
|---|---|---|
| **Score List** | `ScoreListExtendable` | Filas nombre+valor (hasta 50) en fila compacta; suma solo filas visibles. |
| **Float OutputList** | `FloatOutputList` | Texto de números → OutputList de FLOAT. |
| **List Unpack-Mika** | `ListUnpackMika` | Unpack de listas/tuplas/batches (incluye IMAGE/LATENT 4D) a N salidas. |

## 🖼️ Imagen

| Nodo | Clase | Descripción |
|---|---|---|
| **Load Image-Mika** | `LoadImageMika` | Carga desde ruta local o URL, RGBA, máscara alfa, nombre de archivo. |
| **Image Preview Clean-Mika** | `ImagePreviewCleanMika` | Preview **sin metadata ni workflow** (PNG limpio). |
| **Image Save Auto-Mika** | `ImageSaveAutoMika` | Guarda automáticamente cada imagen (`saved_paths`, `saved_count`). |

## ⏱️ Tiempos de ejecución

| Nodo | Clase | Descripción |
|---|---|---|
| **⏱ Tiempos de Ejecución (config)** | `ExecutionTimerConfig` | Ajusta el panel flotante y badges de tiempo por nodo. El timer funciona solo; el nodo solo configura. |

## 🔀 Bypass / Mute

| Nodo | Clase | Descripción |
|---|---|---|
| **Fast Groups Bypasser/Muter-Mika** | `FastGroupsBypasserMika`, `FastGroupsMuterMika` | Un toggle por grupo, incluso desde fuera de subgrafos vía websocket. |
| **Fast Nodes Bypasser/Muter-Mika** | `FastNodesBypasserMika`, `FastNodesMuterMika` | Slots dinámicos con toggle por nodo conectado. |

## 🎯 Resolución / Sampling

| Nodo | Clase | Descripción |
|---|---|---|
| **Anima Resolutions-Mika** | `AnimaResolutionsMika` | Resoluciones Anima (base 1024); `random` sortea en cada ejecución. |
| **Sampler Selector-Mika** | `SamplerSelectorMika` | Lista todos los samplers instalados (nativos + extensiones). |
| **Scheduler Selector-Mika** | `SchedulerSelectorMika` | Igual para schedulers. |

## 🔢 Índices

| Nodo | Clase | Descripción |
|---|---|---|
| **Index Int-Mika** | `IndexIntMika` | INT en modos fixed / increment (step, wrap) / random, con input conectable. |
| **Index Stepper-Mika** | `IndexStepperMika` | Bloque de `steps` índices desde `start_index` con auto-avance cíclico. |

---

## Extensiones JavaScript incluidas

| Archivo | Qué hace |
|---|---|
| `mika_node_colors.js` | ~30 colores extra para el menú Colors (negros, dorados, esmeralda...), nombres traducidos (en/es) y limpieza de tooltips huérfanos del frontend nuevo. |
| `text_box_editor_mika.js` | Botones copiar/seleccionar/pegar en los headers del Text Box / Note. |
| `text_box_paste_mika.js` | Botón de pegar que reemplaza el texto (Text Box Paste). |
| `text_box_visor_mika.js` | Preview en vivo del Visor por websocket. |
| `text_concatenate_dynamic.js` | Slots dinámicos `text_i` con `text_count` (Concatenate y Clean & Organize Concat). |
| `text_clean_stats_mika.js` | Dibuja las estadísticas IN/QUITADOS/OUT dentro de los nodos Text Clean. |
| `primitive_mika.js` | Primitive-Mika adopta las opciones del slot al que se conecta. |
| `execution_timer.js` | Panel flotante y badges de tiempo por nodo. |
| `index_int_mika.js` / `index_stepper_mika.js` / `text_line_stepper_mika.js` | Reflejan el auto-avance en los widgets tras cada ejecución. |
| `fast_nodes_*` / `fast_groups_*` | Inputs dinámicos y toggles de bypass/mute. |
| `score_list_mika.js` | Filas compactas del Score List. |
| `list_unpack_mika.js` | Salidas visibles del List Unpack según `output_count`. |

## Notas

- Los nodos con estado que avanza (steppers, index increment) usan
  `IS_CHANGED = nan` y mensajes `ui` + JS para persistir el avance en el
  workflow.
- Si agregás extensiones que suman samplers/schedulers nuevos, reiniciá
  ComfyUI para que los selectores los detecten.
