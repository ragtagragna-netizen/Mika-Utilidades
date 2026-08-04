# Mika Utilidades

Paquete de nodos custom para **ComfyUI** orientado a la manipulación de texto, tags, prompts y utilidades de workflow. Nodos minimalistas, pensados para acelerar pipelines de generación con Stable Diffusion y workflows iterativos.

---

## 📦 Nodos incluidos

### 🔤 String

| Nodo | Descripción |
|------|-------------|
| **String Selector (Cut First Line)** | Selecciona una línea de un texto multilínea por índice, con wraparound. La UI agrega un botón para cortar la primera línea. |
| **Text Box Editor-Mika** | Caja de texto con botones de copiar / seleccionar todo / pegar en el cursor, dibujados en el header (modo expandido y colapsado). Incluye pegado nativo con Ctrl+V que respeta saltos de línea. |
| **Text Box Visor-Mika** | Visor universal que acepta cualquier tipo (STRING, INT, FLOAT, listas, dicts, tensores) y muestra una preview legible. Se refresca en vivo por websocket. |
| **Tag Filter-Mika** | Filtra un texto separado por comas conservando solo los primeros N segmentos (útil para rutas con tags). |
| **Text Replace Dynamic-Mika** | Reemplaza texto con pares `find/replace` dinámicos (botones +/-, hasta 30 pares). Soporte regex opcional. |
| **Text Concatenate Dynamic-Mika** | Concatena múltiples textos con separador configurable. Slots dinámicos (hasta 30) con botones +/-. |

### 🏷️ Tags

| Nodo | Descripción |
|------|-------------|
| **Smart Tag Filter-Mika** | Filtro inteligente de tags con soporte de pesos `(tag:1.1)`, paréntesis anidados `((tag))`, emoticones `=)`, `:D`, y prefijos de color (`aqua shirt` coincide con `shirt`). Modo include/exclude. Entradas tipo switch (`*`). |
| **Tag If-Mika** | Condicional por presencia de tags. Hasta 6 pares `find/output` dinámicos con botones +/-. Cada output se activa solo si su tag está presente; `combined` junta todos los activos. |
| **Tag Remover-Mika** | Remueve tags de un prompt con la misma inteligencia que Smart Tag Filter: pesos, emoticones y prefijos de color. Devuelve resultado, tags removidos y cantidad. |

### 🖼️ Imagen

| Nodo | Descripción |
|------|-------------|
| **Load Image-Mika** | Carga imágenes desde ruta local o URL. Soporte RGBA, máscara de alfa, dimensiones opcionales (width/height) y nombre de archivo. Hash SHA-256 para detectar cambios. |

### 📋 Lista

| Nodo | Descripción |
|------|-------------|
| **Float OutputList** | Convierte una lista de números en texto a una OutputList de FLOAT (`OUTPUT_IS_LIST`), compatible con ComfyUI-outputlists-combiner. |

### 📝 Score

| Nodo | Descripción |
|------|-------------|
| **Score List** | Lista numerada de valores INT con nombres editables. Filas dinámicas (hasta 50) con botones +/-. Devuelve suma total y detalle. |

### ✏️ Prompt

| Nodo | Descripción |
|------|-------------|
| **Prompt Edit (Loop)-Mika** | Edición de prompt con memoria entre ejecuciones (bucle), sin guardado en disco. Retiene el prompt anterior y el actual. Resaltado inline de tags coincidentes mientras escribís (sin pop-ups). |

### ⏱️ Tiempos

| Nodo | Descripción |
|------|-------------|
| **⏱ Tiempos de Ejecución (config)** | Nodo opcional de configuración para el registro de tiempos de ejecución por nodo. Muestra/oculta panel flotante y badges, ajusta decimales. |

---

## 🚀 Instalación

### Opción 1: Git

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/ragtagragna-netizen/Mika-Utilidades.git
```

### Opción 2: Manual

Descargá el ZIP y descomprimilo en `ComfyUI/custom_nodes/Mika-Utilidades/`.

Luego **reiniciá ComfyUI**. Los nodos aparecen en el menú contextual bajo estas categorías:

- `Mika Utilidades/string`
- `Mika Utilidades/tags`
- `Mika Utilidades/image`
- `Mika Utilidades/lista`
- `Mika Utilidades/score`
- `Mika Utilidades/prompt`
- `Mika Utilidades/tiempos`

---

## 🎨 Extras incluidos

- **Colores extra para nodos**: el paquete agrega automáticamente 18 colores adicionales al menú "Colors" del click derecho en cualquier nodo (red, blue, cyan, magenta, pink, teal, brown, etc.), adaptados al tema activo y con detección de la forma (box/round/circle/card).
- **Iconos SVG uniformes**: los nodos de texto usan iconos vectoriales coherentes en modo expandido y colapsado, con tooltips y feedback ✓/✗.
- **Slots tipo switch**: los nodos de tags usan entradas `*` (socket puro, sin caja de texto) para integración limpia con subgrafos.
- **Parser inteligente compartido**: Smart Tag Filter, Tag If y Tag Remover usan el mismo parser de tags (pesos, emoticones, prefijos de color), con comportamiento consistente.

---

## 🔁 Cómo funciona Prompt Edit (Loop)-Mika

Cada vez que corrés el workflow:

**Vuelta N:**
1. El cuadro `editable_text_widget` tiene el prompt que quedó de la vuelta N-1 (ya editado a mano si quisiste tocarlo). Ese es el `prompt_anterior` de esta vuelta.
2. Llega el prompt nuevo de la generación actual por `input_text`. Ese es el `prompt_generacion_actual`.
3. El cuadro editable se refresca solo con ese prompt nuevo, listo para que lo edites antes de correr la vuelta N+1.

El nodo se fuerza a ejecutarse siempre (`IS_CHANGED` devuelve `NaN`) para que la retención en memoria se refresque en cada vuelta.

---

## 🧩 Compatibilidad

- ComfyUI 0.30+
- Python 3.10+
- Frontend clásico y nuevo (detecta automáticamente el tipo de widget y claves de color)

## 📄 Licencia

MIT

## 🙏 Créditos

Inspirado en nodos de:

- [WASasquatch/was-node-suite-comfyui](https://github.com/WASasquatch/was-node-suite-comfyui) (Load Image)
- [sugarkwork/comfyui_tag_filter](https://github.com/sugarkwork/comfyui_tag_filter) (TagFilter, TagIf, TagRemover)
- [Suzie1/ComfyUI_Comfyroll_CustomNodes](https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes) (Text Replace, Text Concatenate)
- [ShammiG/ComfyUI_Text_Tools_SG](https://github.com/ShammiG/ComfyUI_Text_Tools_SG) (funciones de portapapeles)
- [geroldmeisinger/ComfyUI-outputlists-combiner](https://github.com/geroldmeisinger/ComfyUI-outputlists-combiner) (OutputList)

Adaptados y extendidos con mejoras de UI, manejo de caracteres especiales, slots dinámicos y estilo consistente.
