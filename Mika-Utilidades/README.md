# Mika Utilidades

Paquete de nodos personalizados para ComfyUI:

- **String Selector (Cut First Line)** — selector de líneas de texto, con
  botón para ir cortando la primera línea.
- **Score List** — lista de puntajes numerados y renombrables, con filas
  que se pueden agregar o quitar.
- **Text Box Editor-Mika** — caja de texto con copiar / seleccionar
  todo / pegar (pegado real en el cursor, con saltos de línea), disponibles
  incluso con el nodo colapsado.
- **Float OutputList** — separa un texto con números en una OutputList de
  valores FLOAT (compatible con ComfyUI-outputlists-combiner).
- **⏱ Tiempos de Ejecución** — mide y muestra visualmente, dentro del propio
  workflow, cuánto tarda en ejecutarse cada nodo.

## Instalación

1. Copia toda la carpeta `Mika-Utilidades` dentro de:
   `ComfyUI/custom_nodes/`
2. Reinicia ComfyUI.

---

## String Selector (Cut First Line)

Nodo basado en el "String Selector" de Impact-Pack, con un botón extra para
cortar la primera línea del texto (todo hasta el primer salto de renglón).

Búscalo como **"String Selector (Cut First Line)"** (categoría
`Mika Utilidades/string`).

- **strings**: campo multilinea, igual que el original (una entrada por línea).
- **select**: índice de la línea a devolver como salida `STRING` (con
  wraparound, igual que las flechas ◀ ▶ del nodo de Impact-Pack).
- **✂ Cortar primera línea** (botón nuevo): al hacer click, elimina la
  primera línea del campo `strings` junto con su salto de línea, dejando el
  resto del texto listo para seguir trabajando (útil por ejemplo para ir
  consumiendo un listado línea por línea).

---

## Score List

Nodo similar al "SCORE" de JPS-Nodes: una fila por cada valor, con flechas
◀ ▶ para ajustar el número. A diferencia del original, la cantidad de filas
no es fija: se pueden agregar manualmente con un botón, y **cada fila tiene
un nombre editable**.

Búscalo como **"Score List"** (categoría `Mika Utilidades/score`).

> Nota: si ya tenés este nodo puesto en un workflow viejo (con el título
> "Score List (Extendable)"), el nombre no cambia solo — hay que borrarlo y
> poner uno nuevo desde el buscador de nodos, o renombrarlo a mano
> (doble click sobre el título).

- Empieza con 6 filas (1 a 6), igual que el nodo original.
- Cada fila tiene un campo de texto arriba del número, con un nombre por
  defecto ("Opción 1", "Opción 2", ...). Se puede **renombrar con un click**,
  igual que cualquier otro campo de texto de ComfyUI.
- **+ Agregar opción**: agrega una fila nueva al final (hasta 50).
- **− Quitar opción**: quita la última fila (deja mínimo 1). Al ocultarla
  se reinicia (nombre y valor por defecto), así si se vuelve a agregar
  arranca limpia.
- **int_out**: suma de todos los valores de todas las filas presentes.
- **detalle**: texto con "nombre: valor" de cada fila, uno por renglón —
  útil para loguear o mostrar el desglose de puntajes.
- Las filas, sus nombres y sus valores se guardan y se recuperan
  correctamente al guardar/recargar el workflow.

---

## ⏱ Tiempos de Ejecución

Mide automáticamente cuánto tarda cada nodo en ejecutarse, **sin necesidad
de agregar nada al workflow**: se activa solo apenas instalás el paquete.

- **Etiqueta sobre cada nodo**: muestra el tiempo de su última corrida, en
  la esquina superior derecha del nodo.
  - 🟢 verde = rápido · 🟡 amarillo = medio · 🔴 rojo = lento (relativo al
    total de la corrida)
  - 🔵 azul = resultado tomado de caché (no se volvió a ejecutar)
- **Panel flotante** (esquina inferior derecha, se puede arrastrar desde el
  título y colapsar con el botón "–"): lista todos los nodos de la corrida
  actual ordenados de más lento a más rápido, con una mini barra de tiempo
  relativo, y el total general abajo de todo.
- **Contraído**, el panel se achica a solo el título y funciona como un
  cronómetro en vivo: muestra el tiempo transcurrido de la corrida actual,
  actualizándose solo mientras el workflow está corriendo, y se detiene al
  terminar.
- El puntito junto al título del panel se pone verde mientras el workflow
  está corriendo, y gris cuando termina.

### Nodo de configuración (opcional)

Si querés cambiar el comportamiento por defecto, agregá al workflow el nodo
**"⏱ Tiempos de Ejecución (config)"** (categoría `Mika Utilidades/tiempos`).
No hace falta conectarlo a nada: se ejecuta igual porque es un nodo de
salida (`OUTPUT_NODE`).

- `mostrar_panel_flotante`: muestra u oculta el panel de la esquina.
- `mostrar_etiquetas_en_nodos`: muestra u oculta las etiquetas sobre cada nodo.
- `decimales`: cantidad de decimales al mostrar segundos (0 a 4).

---

## Text Box Editor-Mika

Caja de texto, con 3 funciones portadas y adaptadas de
[ComfyUI_Text_Tools_SG (nodo "Text Tools 🪶 Editor-SG")](https://github.com/ShammiG/ComfyUI_Text_Tools_SG):

- 📋 **Copiar** al portapapeles. Si hay texto seleccionado dentro del
  cuadro, copia solo la selección; si no, copia todo.
- ☑ **Seleccionar todo** el texto (para copiarlo/cortarlo a mano).
- 📄 **Pegar** el contenido del portapapeles **en la posición del cursor**
  (como un paste normal, no reemplaza todo el texto).

Búscalo como **"Text Box Editor-Mika"** (categoría `Mika Utilidades/string`).
El tipo interno del nodo (`TextBoxClipboard`) no cambió, así que los
workflows viejos que ya lo tenían siguen funcionando igual, solo que ahora
el pegado es más confiable.

**La diferencia con el original:** estas 3 funciones siguen disponibles
**aunque el nodo esté colapsado** — se dibujan como iconos chiquitos al
lado del título, son clickeables, y al pasar el mouse por encima muestran
un tooltip con su nombre (igual que los botones del modo expandido, que
usan el tooltip nativo del navegador). Además, las mismas 3 acciones
también están siempre en el **menú del click derecho** sobre el nodo,
como respaldo.

**Arreglos sobre la versión anterior ("Text Box (Portapapeles)"):**

- El botón 📄 **insertaba mal el texto y a veces parecía no hacer nada**:
  ahora inserta en la posición del cursor y, sobre todo, avisa a ComfyUI
  del cambio (dispara los eventos `input`/`change` sobre el textarea real),
  que es lo que hace que el cuadro se actualice y crezca correctamente con
  texto de varias líneas.
- Los saltos de línea del texto pegado se normalizan (`\r\n` → `\n`), para
  que el contenido pegado desde Windows no se vea raro.
- Si el navegador no permite leer el portapapeles con el botón (pasa en
  Firefox, o si no se otorgó el permiso), **pegar con Ctrl+V directo en el
  cuadro de texto siempre funciona igual de bien**, gracias a un listener
  nativo de "paste" agregado sobre el textarea — no depende de la Clipboard
  API ni de sus permisos.
- El botón 📋 ahora también respeta la selección de texto (si seleccionás
  una parte del texto y copiás, copia solo eso).

> Nota: "Pegar" con el botón usa el portapapeles del sistema a través del
> navegador — la primera vez puede pedir permiso para leer el portapapeles.
> Si tu navegador no lo permite, usá Ctrl+V directo sobre el cuadro de
> texto: funciona siempre, con o sin ese permiso.

---

## Float OutputList

Igual que **"String OutputList"** de la extensión de terceros
[ComfyUI-outputlists-combiner](https://github.com/geroldmeisinger/ComfyUI-outputlists-combiner),
pero convierte cada elemento a **FLOAT** en vez de dejarlo como texto. Es
compatible con los demás nodos de esa extensión (`OutputLists Combinations`,
`XYZ-GridPlot`, `Formatted String`, etc.) porque sigue el mismo patrón de
OutputList.

Búscalo como **"Float OutputList"** (categoría `Mika Utilidades/lista`).

- **separator**: texto usado para separar los valores (por defecto `\n`,
  o sea uno por línea).
- **values**: campo multilinea con un número por línea (o separados por
  `separator`). Las líneas vacías se ignoran.
- **value** (`FLOAT` 𝌠): cada número de la lista, uno por vez — los nodos
  conectados acá se ejecutan una vez por cada valor, en orden.
- **index** (`INT` 𝌠): posición de cada valor (0, 1, 2, ...).
- **count** (`INT`): cantidad total de valores.

Si algún renglón no se puede convertir a número, el nodo tira un error
claro indicando cuál fue.

---

## Estructura

```
Mika-Utilidades/
├── __init__.py              # registra los nodos y la carpeta web
├── nodes.py                 # lógica Python de los 5 nodos
└── web/
    ├── cut_first_line.js       # botón de cortar primera línea (String Selector)
    ├── score_list.js           # botones +/- y nombres editables (Score List)
    ├── text_box_editor_mika.js # copiar/seleccionar/pegar, incluso colapsado
    └── execution_timer.js      # etiquetas + panel de tiempos de ejecución
```
