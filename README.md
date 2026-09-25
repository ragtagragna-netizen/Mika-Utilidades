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
| **Text Clean & Organize-Mika** | Limpia listas: sin repetidos, sin colores, agrupadas; muestra IN/QUITADOS/OUT. |
| **Text Clean & Organize Concat-Mika** | Igual, pero concatena varias listas antes de limpiar. |
| **Text Cleaner Compare-Mika** | Quita de `tags_in` lo repetido en `base`. |
| **Smart Tag Filter-Mika** | Filtro de tags con pesos y prefijos de color, include/exclude. |
| **Tag If-Mika** | Condicional por presencia de tags (hasta 6 pares). |
| **Tag Remover-Mika** | Remueve tags de un prompt. |
| **Prompt Clean & Dedupe-Mika** | Normaliza separadores y quita duplicados. |
| **Prompt Edit (Loop)-Mika** | Edita el prompt con memoria entre ejecuciones. |

### String / Texto

| Nodo | Descripción |
|---|---|
| **String Selector-Mika** | Una línea por índice, con control fixed/increment/decrement/randomize. |
| **String Selector Cut-Mika** | Igual, más botón para cortar la primera línea. |
| **String Selector Multi-Mika** | Igual, más selección de varias líneas (count + modo). |
| **File Picker-Mika** | Elige archivos de una carpeta con preview; click = uno, Ctrl+click + ✔ = varios como lista. |
| **Text Box-Mika** | Caja de texto con botones copiar/seleccionar/pegar. |
| **Text Box Paste-Mika** | Igual, con botón de pegar que reemplaza todo. |
| **Note-Mika** | Nota con botones de portapapeles. |
| **Visor-Mika** | Muestra cualquier valor con preview en vivo. |
| **Tag Filter-Mika** | Conserva los primeros N segmentos de un texto. |
| **Text Replace Dynamic-Mika** | Pares find/replace dinámicos, regex opcional. |
| **Text Concatenate Dynamic-Mika** | Concatena varios textos con separador. |
| **Text Line Selector-Mika** | Rango de líneas como LISTA. |
| **Text Line Stepper-Mika** | Recorrido escalonado de líneas con auto-avance. |
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
| **Float OutputList** | Texto de números → lista de FLOAT. |
| **List Unpack-Mika** | Unpack de listas/batches a N salidas. |

### Imagen

| Nodo | Descripción |
|---|---|
| **Load Image-Mika** | Carga desde ruta local o URL (RGBA, máscara, nombre). |
| **Image Preview Clean-Mika** | Preview sin metadata ni workflow. |
| **Image Save Auto-Mika** | Guarda automáticamente cada imagen. |

### Varios

| Nodo | Descripción |
|---|---|
| **⏱ Tiempos de Ejecución** | Panel flotante y badges de tiempo por nodo. |
| **Fast Groups/Nodes Bypasser/Muter-Mika** | Toggles de bypass/mute por grupo o por nodo. |
| **Anima Resolutions-Mika** | Resoluciones Anima, con modo random. |
| **Sampler/Scheduler Selector-Mika** | Lista los samplers y schedulers instalados. |
| **Index Int-Mika / Index Stepper-Mika** | Índices con modos fixed/increment/random y auto-avance. |

## Notas

- Los nodos con avance (steppers, index) persisten su posición en el workflow.
- Si instalás extensiones con samplers/schedulers nuevos, reiniciá ComfyUI
  para que los selectores los detecten.
