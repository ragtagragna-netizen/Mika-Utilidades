Mika Utilidades
Paquete de nodos custom para ComfyUI orientado a la manipulación de texto, tags, prompts y utilidades de workflow. Nodos minimalistas, pensados para acelerar pipelines de generación con Stable Diffusion y workflows iterativos.
📦 Nodos incluidos
🔤 String
Nodo
Descripción
String Selector (Cut First Line)
Selecciona una línea de un texto multilínea por índice, con botón para cortar la primera línea.
Text Box Editor-Mika
Caja de texto con botones de copiar / seleccionar todo / pegar en el cursor, disponibles en modo expandido y colapsado (iconos en el header).
Text Box Visor-Mika
Visor universal que acepta cualquier tipo (STRING, INT, FLOAT, listas, dicts, tensores) y muestra una preview legible. Preview en vivo por websocket.
Tag Filter-Mika
Filtra un texto separado por comas conservando solo los primeros N segmentos (útil para rutas con tags).
Text Replace Dynamic-Mika
Reemplaza texto con pares find/replace dinámicos (botones +/- para agregar hasta 30 pares). Soporte regex opcional.
Text Concatenate Dynamic-Mika
Concatena múltiples textos con separador configurable. Slots dinámicos (hasta 30) con botones +/-.
🏷️ Tags
Nodo
Descripción
Smart Tag Filter-Mika
Filtro inteligente de tags con soporte de pesos (tag:1.1), paréntesis anidados ((tag)), emoticones =), :D, y prefijos de color (aqua shirt coincide con shirt). Modo include/exclude.
Tag If-Mika
Condicional por presencia de tags. Hasta 6 pares find/output dinámicos con botones +/-. Cada output se activa solo si su tag está presente.
Tag Remover-Mika
Remueve tags de un prompt con la misma inteligencia que Smart Tag Filter: pesos, emoticones y prefijos de color.
🖼️ Imagen
Nodo
Descripción
Load Image-Mika
Carga imágenes desde ruta local o URL. Soporte RGBA, máscara de alfa, dimensiones opcionales y nombre de archivo. Hash SHA-256 para detectar cambios.
📋 Lista
Nodo
Descripción
Float OutputList
Convierte una lista de números en texto a una OutputList de FLOAT (OUTPUT_IS_LIST), compatible con ComfyUI-outputlists-combiner.
📝 Score
Nodo
Descripción
Score List
Lista numerada de valores INT con nombres editables. Filas dinámicas (hasta 50) con botones +/-. Devuelve suma total y detalle.
✏️ Prompt
Nodo
Descripción
Prompt Edit (Loop)-Mika
Edición de prompt con memoria entre ejecuciones (bucle), sin guardado en disco. Retiene el prompt anterior y el actual. Resaltado inline de tags coincidentes mientras escribís.
⏱️ Tiempos
Nodo
Descripción
⏱ Tiempos de Ejecución (config)
Nodo opcional de configuración para el registro de tiempos de ejecución por nodo. Muestra/oculta panel flotante y badges, ajusta decimales.
🚀 Instalación
bash
12
O descargá el ZIP y descomprimilo en ComfyUI/custom_nodes/Mika-Utilidades/.
Reiniciá ComfyUI. Los nodos aparecen en el menú contextual bajo las categorías:
Mika Utilidades/string
Mika Utilidades/tags
Mika Utilidades/image
Mika Utilidades/lista
Mika Utilidades/score
Mika Utilidades/prompt
Mika Utilidades/tiempos
🎨 Extras incluidos
Colores extra para nodos: al instalar el paquete se agregan automáticamente 18 colores adicionales al menú "Colors" del click derecho en cualquier nodo (red, blue, cyan, magenta, pink, teal, brown, etc.), adaptados al tema activo.
Iconos SVG uniformes: los nodos de texto usan iconos vectoriales coherentes en modo expandido y colapsado.
Slots tipo switch: los nodos de tags usan entradas * (socket puro, sin caja de texto) para integración limpia con subgrafos.
🧩 Compatibilidad
ComfyUI 0.30+
Python 3.10+
Frontend clásico y nuevo (detecta automáticamente el tipo de widget y claves de color)
📄 Licencia
MIT
🙏 Créditos
Inspirado en nodos de:
WASasquatch/was-node-suite-comfyui (Load Image)
sugarkwork/comfyui_tag_filter (TagFilter, TagIf, TagRemover)
Suzie1/ComfyUI_Comfyroll_CustomNodes (Text Replace, Text Concatenate)
ShammiG/ComfyUI_Text_Tools_SG (funciones de portapapeles)
geroldmeisinger/ComfyUI-outputlists-combiner (OutputList)
Adaptados y extendidos con mejoras de UI, manejo de caracteres especiales, slots dinámicos y estilo consistente.
