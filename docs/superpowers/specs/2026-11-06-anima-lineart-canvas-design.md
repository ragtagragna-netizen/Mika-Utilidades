# Anima Lineart Canvas-Mika — Diseño

Fecha: 2026-11-06

## Intención

Añadir a Mika-Utilidades un nodo que reúna dos cosas en un solo lugar:

1. Las resoluciones nativas del modelo **Anima** (CircleStone Labs).
2. Un lienzo para dibujar a mano dentro de ComfyUI, para producir imágenes de
   **lineart** que alimenten el ControlNet-LLLite de Anima (`AnimaLLLiteApply`).

El objetivo es bocetar/crozar a mano alzada una pose o composición y mandarla
como control, sin salir de ComfyUI ni pasar por otro editor.

## Objetivos

- Combo con las resoluciones de `Anima Resolutions-Mika`.
- Lienzo de dibujo con pincel y borrador, cada uno con su propio grosor
  (dos sliders), color de trazo, limpiar y deshacer/rehacer.
- El borrador **marca en un color propio la zona a borrar** mientras se
  arrastra; el borrado real se aplica al soltar.
- **Cursor circular** semitransparente que sigue al mouse y refleja el
  tamaño de la herramienta activa (como el editor de máscaras); se oculta
  durante el trazo.
- **Calco interactivo**: mover, escalar (4 esquinas, con resize libre X/Y) y
  rotar con marco y handles (✥); reestablecer (⟲); ajustar al tamaño del
  nodo estirándolo para llenar el lienzo (⛶).
- **Copiar la imagen** resultado al portapapeles (📄).
- **Indicador numérico** del grosor junto a cada slider (lápiz / borrador).
- **Cursóres contextuales**: cruz chica propia por defecto; en modo ✥,
  resize en las esquinas, giro en el handle de rotación y mover dentro de
  la imagen.
- El calco y los ajustes de herramienta se **conservan al reconstruir el
  nodo** (p. ej. al volver a la pestaña del navegador).
- **Cargar** una imagen local en la capa editable (reemplaza el contenido,
  deshacible) para retocarla, p. ej. una imagen de lineart.
- **Calcar**: importar una imagen local como fondo de referencia (opacidad +
  mostrar/ocultar), que **no** se incluye en la salida.
- **Pegar del portapapeles**: dos botones, uno para editar y otro para calcar.
- **Arrastrar** una imagen sobre el nodo la carga como **calco** (referencia),
  no como contenido editable.
- Modos `lineart` y `dibujo normal`.
- Salida `IMAGE` a exactamente la resolución elegida, más `width`/`height`.
- El contenido del lienzo se guarda dentro del workflow, sin depender de
  archivos externos.

## No-objetivos

- Colores, capas, rellenos, formas, simetría, texturas.
- Edición destructiva de la imagen importada.
- Guardar PNG automáticamente a disco.
- Predetectores de lineart (Canny, lineart extractor): el nodo entrega el
  trazo, no lo procesa.

## Anti-objetivos

- Que el nodo haga requests a internet.
- Que el dibujo se pierda al recargar el workflow.
- Que el tamaño del lienzo se desincronice de la resolución elegida.

## Restricciones

- Sin dependencias nuevas: PIL/numpy/torch, que ya usa el paquete, y el canvas
  del navegador.
- Todo local (sin red).
- Seguir el patrón del repo: nodo Python en `nodes.py` + `.js` en `web/` con
  widget DOM y datos en un widget oculto (como `score_list_mika.js`).

## Enfoques

- **A (elegido):** un nodo autocontenido (combo de resolución + lienzo). El
  dibujo viaja como PNG base64 en un widget oculto. Directo y sin
  desincronización de tamaño.
- **B (descartado):** reusar `Anima Resolutions-Mika` + un nodo de lienzo
  separado que reciba `width`/`height`. Más cableado y el JS tendría que leer
  el tamaño desde aguas arriba.

## Decisiones (cómo queda)

- **Clase/nombre:** `AnimaLineartCanvasMika` → "Anima Lineart Canvas-Mika".
  Categoría `Mika Utilidades/image`.
- **Resoluciones:** las mismas de `AnimaResolutionsMika`
  (`RESOLUTIONS["1024"]`, 13 ratios, base 1024). `1024x1024 (1:1)` es el
  default.
- **Modos** (widget `modo`):
  - `lineart` (default): fondo negro, trazo blanco, según las imágenes de
    referencia de `LINEARTS` (convención de lineart para el LLLite de Anima).
  - `dibujo normal`: fondo blanco y color de trazo libre con selector de
    color (default negro).
- **Lienzo:** resolución interna = resolución elegida; se muestra escalado al
  ancho del nodo (mapa de coordenadas por bounding rect). Fondo según el modo.
- **Herramientas:** pincel (grosor 1–64 px nativos, default 1), borrador
  (grosor 1–128 px, default 40), limpiar, deshacer y rehacer (pila de ~30
  estados).
- **Cargar para editar:** file picker local; la imagen se dibuja *en* la capa
  editable (contain, centrada), reemplazando el contenido (deshacible con
  deshacer). Sí forma parte de la salida y se guarda en el workflow.
- **Calcar:** file picker local; la imagen se dibuja *debajo* de la capa
  editable, con slider de opacidad (default ~40%) y toggle mostrar/ocultar
  (ícono de ojo **abierto** cuando se ve, **cerrado** cuando está oculto).
  No entra en la salida y no se guarda en el workflow (es solo referencia).
- **Pegar:** botones 📋 que leen una imagen del portapapeles
  (`navigator.clipboard.read`) y la aplican como edición o como calco.
- **Borrador:** el arrastre pinta una vista previa en un canvas `overlay`
  (color propio, nunca exportado); al soltar se aplica `destination-out`
  sobre la capa de trazos y se limpia el overlay. Grosor propio.
- **Capas transformables (selector `trazo` / `calco` / `ambas`):** modo ✥ con
  marco, **handles de escala en las 4 esquinas** (la esquina opuesta queda
  fija) y handle de rotación (arriba, mantenido dentro del lienzo); arrastrar
  dentro de la figura la mueve. `ambas` aplica el mismo gesto (mover/rotar/
  escalar proporcional) a las dos capas a la vez. Botón `libre` para resize
  **no proporcional** (X e Y por separado, solo capa única). El trazo guarda su
  transformación `paintTransform` en `node.properties` (sobrevive a recargar);
  el calco no se guarda.
- **⟲ Reestablecer:** según el selector, vuelve el trazo a identidad (llena el
  lienzo) y/o el calco al encaje "contain" centrado.
- **⛶ Ajustar al tamaño del nodo:** estira la capa para ocupar exactamente el
  lienzo (escala X e Y independientes; puede distorsionar). Para el trazo es
  identidad (su fuente ya es del tamaño del lienzo).
- **Figuras del Paint:** 23 figuras (línea, curva, círculo, rectángulo, rect.
  redondeado, polígono, triángulo, triángulo rect., rombo, pentágono, hexágono,
  flechas der./izq./arriba/abajo, estrellas 4/5/6, bocadillo rect./óvalo, nube,
  corazón, rayo). Se dibujan con el color y el grosor del pincel: previsualiza
  en el `overlay` mientras arrastrás y fija al soltar.
- **Texto con fuentes del Paint y de cómic:** selector propio con **vista
  previa de cada fuente** (cada opción dibujada con su tipografía, como el
  desplegable del Paint), agrupadas en Paint, Cómic y Agregadas + tamaño. Con
  la herramienta 🅣, escribir el texto y hacer clic en el lienzo lo coloca
  (relleno con el color actual).
- **Fuentes de cómic incluidas:** ~109 fuentes (nota de gcomics.online + 4
  páginas del tema Tebeo/Cómic de dafont) descargadas a `web/fonts/` (carpeta
  **ignorada por git**, licencia de uso personal) y cargadas con `@font-face`,
  así se ven **sin instalarlas** en Windows. El manifiesto es
  `web/fonts/fonts.json`.
- **Menú ➕ (agregar tipografías):** cargar archivos locales `.ttf/.otf`
  (FontFace, agrega al grupo "Agregadas"), sumar una fuente instalada por
  nombre, o abrir dafont. Los nombres agregados se guardan en `localStorage`;
  los archivos valen para la sesión.
- **Invertir capas:** botones ↔ / ↕ que espejan la capa afectada por el
  selector (o el texto en edición) negando `sx`/`sy` de su transformación.
- **Texto editable:** al colocar el texto con 🅣 queda como objeto con marco
  (mover, **escalar** por esquinas, **invertir** con ↔/↕) y se **fija con
  Enter** (Escape cancela). El texto fijo se hornea en la capa de trazo con su
  transformación.
- **📐 Ajustar resolución:** elige de la lista la resolución con la proporción
  más parecida a la fuente (el **calco** o la **imagen cargada en el trazo**,
  según el selector, con reserva a la otra; desempata por área), para no
  deformarla. El tamaño de la imagen del trazo se recuerda en `contentSize`.
- **▚ Selección a mano alzada (lazo):** con esa herramienta, dibujar un lazo
  libre delimita un área sobre el trazo o el calco (según el selector), que se
  recorta con esa forma (clip) y se convierte en
  una **pieza flotante** (base con el hueco + recorte movible) que se puede
  **mover, escalar, rotar y espejar** con el mismo marco; **Enter la fija**
  (se hornea en la capa) y **Escape la cancela**. Al fijarla, el trazo se
  rasteriza a identidad; el calco pasa a ser una imagen del tamaño del lienzo.
- **Nombre de archivo:** al cargar una imagen (📂, 🖼️, arrastre o URL) se
  guarda su nombre en el widget oculto `archivo`, que sale como
  **`nombre_archivo`** (STRING).
- **Reencaje al cambiar de resolución:** `resize` calcula la caja visible del
  trazo (`boundsOf`, o la del calco si el trazo está vacío) y reescala+centra
  el contenido con "contain" (nada se recorta); el calco se transforma con el
  mismo factor para no desalinearse. El trazo se rasteriza a identidad.
- **Navegación con el mouse:** sobre el nodo, la **rueda** reenvía a
  `app.canvas.processMouseWheel` (zoom) y el **botón central** o **Alt +
  arrastrar** panea moviendo `app.canvas.ds.offset`. Se engancha en captura
  para no iniciar un trazo.
- **📄 Copiar al portapapeles:** copia la imagen resultado (fondo del modo +
  trazos) como PNG, igual que la salida del nodo.
- **Cursor en coordenadas locales:** el DOM del nodo se escala con CSS según
  el zoom del canvas, así que el círculo y su diámetro se calculan con el
  ratio `offsetWidth / rect.width`; sin eso el círculo se desplaza al hacer
  zoom (la línea igual se dibuja bien porque el mapeo usa el ratio del rect).
  El diámetro refleja el grosor real de la herramienta activa (incluido 1 px);
  sin un mínimo alto para que no quede clavado en un tamaño grande.
- **Persistencia:** el PNG base64 del dibujo se escribe en un widget STRING
  oculto (`dibujo`) al soltar el trazo; ComfyUI lo serializa con el workflow.
- **Al cambiar la resolución:** el lienzo se redimensiona y los trazos se
  anclan arriba-izquierda sin reescalar (lineart pixel-true); el área nueva
  queda blanca y lo que sobra se recorta.
- **Python:** decodifica el base64 → PIL → tensor `IMAGE` `[1,H,W,3]` en 0..1;
  si no hay dibujo devuelve una imagen blanca de la resolución para no romper
  el flujo.
- **Salidas:** `IMAGE`, `width` (INT), `height` (INT).

## Queda a criterio del implementador

- Estética exacta de la barra de herramientas y de los botones.
- Límite de la pila de deshacer.
- Tamaño mínimo del nodo y detalles de layout.
