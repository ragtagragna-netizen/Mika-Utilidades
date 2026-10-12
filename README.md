# Mika Utilidades — Paquete de nodos para ComfyUI

Colección de nodos de utilidad para ComfyUI: texto y prompts, tags, listas,
índices, imágenes, sampling, resoluciones, bypass/mute y medición de tiempos.

Todos los nodos aparecen en la categoría **`Mika Utilidades/...`**.

## Instalación

1. Copiá o cloná la carpeta como `ComfyUI/custom_nodes/Mika-Utilidades`.
2. Reiniciá ComfyUI y recargá el navegador con `Ctrl + F5`.

Sin dependencias extra: usa lo que ComfyUI ya trae. La traducción requiere
`transformers`.

## Nodos

### Tags y Prompts

| Nodo | Descripción |
|---|---|
| **FILTROS-Mika** | Filtros GEN/CARA/ROPA/LUGAR sobre el prompt, extras de personajes por conteo, detección de lenguaje natural y 14 salidas. |
| **FILTROS Select-Mika** | Igual que FILTROS-Mika, con la salida elegida por combo (8 opciones). |
| **FILTROS Prompt-Mika** | Solo extrae los 4 filtros + TAGS SIN FILTRO + TAGS NATURAL. |
| **Prompt Reorganize-Mika** | Ordena el prompt por secciones y agrupa tags similares. |
| **Anima Prompt Organizer** | Reordena un prompt libre al formato de tags de Anima. |
| **Text Clean & Organize-Mika** | Limpia listas: sin repetidos, sin colores, agrupadas; muestra IN/QUITADOS/OUT. |
| **Text Clean & Organize Concat-Mika** | Igual, pero concatena varias listas antes de limpiar. |
| **Text Cleaner Compare-Mika** | Quita de `tags_in` lo repetido en `base`. |
| **Smart Tag Filter-Mika** | Filtro de tags con pesos y prefijos de color, include/exclude. |
| **Tag If-Mika** | Condicional por presencia de tags (hasta 6 pares). |
| **Tag Remover-Mika** | Remueve tags de un prompt. |
| **Tag Enchant-Mika** | Encanta un tag o palabra con sintaxis `(tag:peso)`: rango automático (`start`/`step`/`count` tan largo como quieras), salida simple (primer peso) + `prompt_list` (lista, ideal para XY plot) + `weights`. Si el tag no está, el prompt sale intacto. |
| **Tag Swap List-Mika** | Cambia el tag seleccionado por una serie de tags: lista `repl_1..N` expandible manualmente con `replacement_count`, salida simple (primer reemplazo) + `prompt_list` (lista) + `replaced` (lista con los tags de reemplazo). |
| **Tag Enchant List-Mika** | Variante sobre lista (un item por línea): sin expandir, cada línea sale encantada con su peso `start + i·step` + `weights` con los pesos usados. |
| **Prompt Clean & Dedupe-Mika** | Normaliza separadores y quita duplicados. |
| **Prompt Edit (Loop)-Mika** | Edita el prompt con memoria entre ejecuciones. |

### String / Texto

| Nodo | Descripción |
|---|---|
| **String Selector-Mika** | Una línea por índice, con control fixed/increment/decrement/randomize. |
| **String Selector Cut-Mika** | Igual, más botón para cortar la primera línea. |
| **String Selector Multi-Mika** | Igual, más selección de varias líneas (count + modo). |
| **File Picker-Mika** | Elige archivos de una carpeta con preview; click = uno, Ctrl+click + ✔ = varios como lista. |
| **Text Box-Mika** | Caja de texto con botones copiar/seleccionar/pegar. Clic derecho → 🔒 Bloquear borrado (impide borrar, deja escribir y pegar; se guarda en el workflow), solo o en grupo (seleccionados). Bloqueado muestra candado en el header (clic = desbloquear) y contador de líneas sobre la salida. Colapsado de ancho adaptativo al título (con tope). |
| **Text Box Paste-Mika** | Igual, con botón de pegar que reemplaza todo. |
| **Note-Mika** | Nota con botones de portapapeles. |
| **Visor-Mika** | Muestra cualquier valor con preview en vivo. |
| **Tag Filter-Mika** | Conserva los primeros N segmentos de un texto. |
| **Text Affix-Mika** | Añade texto al inicio/final o reemplaza, en modo párrafo o por línea (lista). |
| **Text Replace Dynamic-Mika** | Pares find/replace dinámicos, regex opcional. |
| **Text Concatenate-Mika** | Concatena varios textos con separador. |
| **Prompt Preset Selector-Mika** | Clon del Prompt Preset Selector. Lee presets (.txt/.yaml/.yml) desde la carpeta dedicada `presets/` o desde una carpeta externa escrita en `absolute_path` (el dropdown `preset_file` se rellena con sus archivos; recursivo). |
| **Prompt Preset Stepper-Mika** | Prompt Preset Selector-Mika con el motor escalonado del Index Stepper: selecciona bloques de `steps` presets (salida `text` como lista) y auto-avanza. |
| **Text Line Selector-Mika** | Rango de líneas como LISTA. |
| **Text Line Stepper-Mika** | Recorrido escalonado de líneas con auto-avance. |
| **Text Save-Mika** | Guarda texto en un archivo local. |
| **Primitive-Mika** | Primitivo genérico que adopta las opciones del slot conectado. |

### Traducción

| Nodo | Descripción |
|---|---|
| **Load MarianMT CheckPoint-Mika** | Carga un modelo MarianMT desde `models/MikaTranslator/`. |
| **Smart Prompt Translate-Mika** | Traduce al inglés solo lo que está en español, respetando tags. |
| **Prompt Translate to Text-Mika** | Traduce el texto completo. |

### Score / Listas

| Nodo | Descripción |
|---|---|
| **Score List** | Filas nombre+valor (hasta 50) con botones +/−. |
| **Excel-Mika** | Tabla estilo Excel para anotar pruebas (4×2 por defecto): celdas editables, filas/columnas expandibles (+Fila/–Fila/+Col/–Col), Enter baja de celda, pegar multilínea rellena hacia abajo desde la celda con foco (tabs a la derecha). Steppers ▲▼ interiores en cada celda (vacía → 0, número → ±1). Sin salidas. |
| **Float OutputList** | Texto de números → lista de FLOAT. |
| **List Unpack-Mika** | Unpack de listas/batches a N salidas. |

### Imagen

| Nodo | Descripción |
|---|---|
| **Load Image Path-Mika** | Carga desde ruta local o URL (RGBA, máscara, nombre). Sin preview. |
| **Load Image-Mika** | Como el Load Image nativo, pero además devuelve el nombre de la imagen. Compatible con inpaint/mask editor. |
| **Load Image from Dir-Mika** | Carga una imagen desde un directorio, por nombre de archivo o por índice. |
| **Clipboard to MultiRef-Mika** | La imagen del portapapeles cae en la ranura elegida (`image_1..10`) del nodo Multi Image Reference indicado por título. |
| **Load Image Mask-Mika** | Igual que Load Image-Mika, con botón para abrir el MaskEditor. |
| **Image Preview Clean-Mika** | Preview sin metadata ni workflow. |
| **Image Save Auto-Mika** | Guarda automáticamente cada imagen. |

### Loaders

| Nodo | Descripción |
|---|---|
| **Load Lora-Mika** | LoRA con combo buscable de rutas completas (`carpeta\archivo.safetensors`), incluye `strength_model` y `strength_clip`. |
| **Load Lora (no CLIP)-Mika** | Igual que arriba pero solo MODEL (sin CLIP). |
| **Load Lora Stack-Mika** | Apila LoRAs en orden (1 → N), cada slot con combo en cascada, fuerzas propias y toggle para prender/apagar; `lora_count` controla cuántos se usan y se ven. |
| **Load Lora Stack (no CLIP)-Mika** | Igual que arriba pero solo MODEL (sin CLIP). |

### Varios

| Nodo | Descripción |
|---|---|
| **⏱ Tiempos de Ejecución** | Panel flotante y badges de tiempo por nodo. |
| **Switch-Mika** | Switch de hasta 50 inputs dinámicos con modos by index / by random / automatic. |
| **Switch Bypass-Mika** | Switch que devuelve el primer input cuyo nodo origen no está en bypass/mute. |
| **Bypass Detector-Mika** | Detecta si el nodo indicado (por título o id) está en bypass y devuelve el texto según el estado. |
| **If Any-Mika** | Condicional sobre una entrada ANY: devuelve un valor/texto u otro según condición. |
| **Fast Groups/Nodes Bypasser/Muter-Mika** | Toggles de bypass/mute por grupo o por nodo. |
| **Anima Resolutions-Mika** | Resoluciones Anima, con modo random. |
| **Sampler/Scheduler Selector-Mika** | Lista los samplers y schedulers instalados. |
| **Combo PlotXY-Mika** | Listas tipadas para plots: x/y universales `*` ya con el producto cruzado (un valor sale normal, varios salen combo: texto, sampler, scheduler, cfg, steps, seed, denoise, **model**, **checkpoint**, **none**) directo al KSampler, sin loops; cada eje puede quedar vacío. `row/col_labels` a XY Grid-Mika o XYZ-GridPlot. Ojo: model/checkpoint cargan todo en RAM (2-4 como mucho) y checkpoint compara solo el MODEL con tu CLIP/VAE fijos. |
| **Single PlotXY-Mika** | Versión de un eje: una salida universal `*` (normal/combo dinámica) + labels. Para plots 1D. |
| **XY Grid-Mika** | Cuadrícula rows×cols real desde batch en orden de filas + etiquetas compactas (PIL, sin skia). **Las etiquetas mandan**: con row/col_labels conectados definen la forma (con solo `row_labels` deduce las columnas; el `columns` solo vale sin etiquetas). Celdas sobrantes se recortan, faltantes en blanco. Mezcla de tamaños se auto-ajusta a la menor. |
| **Inspector-Mika** | Inspector de slots: conectá su única salida a cualquier slot y copia SUS opciones a su caja `text` (una por línea), lista para copiar con el botón del header. El cable es solo el gesto de inspección y se quita solo. |
| **List Pick-Mika** | Item i-ésimo de una lista (con wrap). Para leer parámetros hermanos con el index del loop. |
| **Text List-Mika** | Multilínea a lista de strings (para row/col labels manuales de XYZ-GridPlot). |
| **Index Int-Mika / Index Stepper-Mika** | Índices con modos fixed/increment/random y auto-avance. |

## Notas

- Los nodos con avance (steppers, index) persisten su posición en el workflow.
- Si instalás extensiones con samplers/schedulers nuevos, reiniciá ComfyUI
  para que los selectores los detecten.
