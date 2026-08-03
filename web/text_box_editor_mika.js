import { app } from "/scripts/app.js";

// Log de diagnóstico: si no ves esta línea en la consola del navegador
// (F12 → Console) después de recargar ComfyUI, es que el navegador está
// sirviendo una copia en caché del archivo viejo — hacé un hard refresh
// (Ctrl+Shift+R / Cmd+Shift+R) o reiniciá el servidor de ComfyUI.
console.log("[Mika] Text Box Editor-Mika cargado — v6 (fix: los iconos ya no desaparecen al cambiar de pestaña de workflow)");


/**
 * Mika · Text Box Editor-Mika
 * ---------------------------------------------------------------------
 * Caja de texto con 3 funciones inspiradas en las de
 * ComfyUI_Text_Tools_SG (https://github.com/ShammiG/ComfyUI_Text_Tools_SG):
 *   📋 Copiar al portapapeles (si hay texto seleccionado copia solo eso).
 *   ☑ Seleccionar todo el texto.
 *   📄 Pegar el contenido del portapapeles en la posición del cursor.
 *
 * A diferencia de la versión anterior ("Text Box (Portapapeles)"), esta
 * versión soluciona los problemas de pegado:
 *   - Ya no reemplaza TODO el texto: inserta en la posición del cursor,
 *     como un paste normal (igual que Text Tools Editor-SG).
 *   - Después de pegar, dispara los eventos "input"/"change" sobre el
 *     textarea real, que es lo que hace que ComfyUI reconozca el cambio,
 *     re-calcule el tamaño del cuadro y guarde el nuevo valor.
 *   - Normaliza los saltos de línea (\r\n -> \n) para que el texto
 *     pegado desde Windows/portapapeles no se vea raro ni se pierda.
 *   - Si el navegador no permite leer el portapapeles por botón (pasa en
 *     Firefox, o si no se otorgó el permiso), se agrega además un
 *     listener nativo de "paste" directamente sobre el textarea: así
 *     pegar con Ctrl+V SIEMPRE funciona bien, tenga botón o no.
 *   - Los iconos en modo COLAPSADO son clickeables de verdad. En vez de
 *     depender de "node.onMouseDown" (un hook interno de LiteGraph que
 *     cada nodo reasigna como propiedad de instancia, y que puede quedar
 *     tapado o wrappeado distinto según la versión del frontend de
 *     ComfyUI), el click se detecta con un listener propio de
 *     "pointerdown" a nivel window, en fase de CAPTURA — se ejecuta antes
 *     de que el evento llegue al <canvas> de LiteGraph, así que es
 *     independiente de esos detalles internos y no se rompe entre
 *     versiones. Si el click cae sobre un ícono, se bloquea la
 *     propagación (para no arrastrar/seleccionar el nodo ni togglear el
 *     colapso) y se ejecuta la acción al toque.
 *
 * Estas 3 funciones están disponibles tanto expandido (botones reales,
 * con tooltip nativo del navegador al pasar el mouse) como colapsado
 * (iconos dibujados al lado del título, con su propio tooltip flotante
 * y detector de clicks). También quedan siempre en el menú del click
 * derecho, como respaldo.
 */

const ICONS = [
    { key: "copy", glyph: "📋", title: "Copiar al portapapeles (o la selección)" },
    { key: "selectAll", glyph: "☑", title: "Seleccionar todo" },
    { key: "paste", glyph: "📄", title: "Pegar del portapapeles" },
];

const ICON_SIZE = 20;
const ICON_GAP = 2;
const FEEDBACK_MS = 1200;

// -----------------------------------------------------------------------
// Portapapeles: lectura/escritura con manejo de errores + fallback.
// -----------------------------------------------------------------------

function normalizeNewlines(text) {
    // El portapapeles de Windows suele traer "\r\n"; lo normalizamos a
    // "\n" para que el textarea y el valor guardado queden consistentes.
    return (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    // Fallback para contextos sin Clipboard API (o sin HTTPS/localhost).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (!ok) throw new Error("execCommand('copy') no disponible en este navegador.");
}

async function readClipboardText() {
    if (navigator.clipboard && navigator.clipboard.readText) {
        return await navigator.clipboard.readText();
    }
    // No hay forma confiable de forzar una lectura del portapapeles sin
    // la Clipboard API (Firefox no la expone por defecto). En ese caso
    // avisamos y el usuario puede pegar con Ctrl+V directo en el cuadro,
    // que sí funciona gracias al listener "paste" nativo de más abajo.
    throw new Error(
        "Este navegador no permite leer el portapapeles con el botón. Probá pegar con Ctrl+V directo en el cuadro de texto."
    );
}

// -----------------------------------------------------------------------
// Inserta texto en la posición del cursor del textarea real (si existe
// y está montado), o lo agrega al final si el nodo está colapsado / el
// textarea todavía no se creó. Sincroniza el widget, dispara "input" y
// "change" para que ComfyUI reconozca el cambio (tamaño, guardado, etc.)
// y fuerza un redibujo.
// -----------------------------------------------------------------------
function insertTextIntoWidget(node, widget, rawText) {
    if (!widget) return;
    const text = normalizeNewlines(rawText);
    const inputEl = widget.inputEl;

    let newValue;
    if (inputEl && inputEl.isConnected) {
        const start = inputEl.selectionStart ?? inputEl.value.length;
        const end = inputEl.selectionEnd ?? inputEl.value.length;
        const current = inputEl.value ?? "";
        newValue = current.slice(0, start) + text + current.slice(end);

        inputEl.value = newValue;
        const newPos = start + text.length;
        inputEl.focus();
        inputEl.setSelectionRange(newPos, newPos);

        // Esto es lo que hace que ComfyUI se entere del cambio: sin
        // disparar "input" el textarea se ve actualizado pero el widget
        // (y el auto-resize del nodo) puede quedar desincronizado,
        // sobre todo con texto multilínea.
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
        // Nodo colapsado o textarea todavía no montado: no hay cursor,
        // así que agregamos el texto al final sin perder lo que ya había.
        const current = widget.value ?? "";
        newValue = current && text ? `${current}\n${text}` : current || text;
    }

    widget.value = newValue;
    if (typeof widget.callback === "function") {
        widget.callback(newValue, node.graph?.canvas, node);
    }
    node.setDirtyCanvas(true, true);
    if (typeof node.onResize === "function") {
        node.onResize(node.size);
    }
    try {
        app.graph.setDirtyCanvas(true, true);
    } catch (err) {
        // no-op: por las dudas si 'app.graph' no está listo todavía.
    }
}

function selectAllInWidget(widget) {
    if (!widget?.inputEl) return;
    widget.inputEl.focus();
    widget.inputEl.select();
}

function textToCopyFrom(widget) {
    const inputEl = widget?.inputEl;
    if (inputEl && inputEl.selectionStart !== inputEl.selectionEnd) {
        // Si hay una selección activa, copiamos sólo eso (igual que
        // Text Tools Editor-SG), no toda la caja.
        return inputEl.value.substring(inputEl.selectionStart, inputEl.selectionEnd);
    }
    return widget?.value ?? "";
}

// -----------------------------------------------------------------------
// Feedback visual en un botón DOM: check ✓ / cruz ✗ y vuelta al glyph.
// -----------------------------------------------------------------------
function flashButton(btn, glyphOriginal, ok) {
    if (!btn) return;
    btn.textContent = ok ? "✓" : "✗";
    setTimeout(() => {
        btn.textContent = glyphOriginal;
    }, FEEDBACK_MS);
}

// -----------------------------------------------------------------------
// Feedback visual de un ícono en modo COLAPSADO (dibujado en canvas, no
// es un <button> DOM): guardamos, por nodo y por ícono, si hay que
// mostrar ✓/✗ en vez del glyph normal y hasta cuándo. onDrawCollapsed
// lee este estado en cada frame; acá sólo lo activamos y programamos su
// apagado, forzando un redibujo en ambos momentos.
// -----------------------------------------------------------------------
function flashCollapsedIcon(node, key, ok) {
    if (!node._mikaCollapsedFeedback) node._mikaCollapsedFeedback = {};
    node._mikaCollapsedFeedback[key] = { ok, until: Date.now() + FEEDBACK_MS };
    node.setDirtyCanvas(true, true);
    setTimeout(() => {
        if (node._mikaCollapsedFeedback?.[key]) {
            delete node._mikaCollapsedFeedback[key];
            node.setDirtyCanvas(true, true);
        }
    }, FEEDBACK_MS);
}

// "onFeedback" es un callback opcional (ok: boolean) => void, desacoplado
// de cómo se muestra la confirmación: el modo expandido lo usa para
// flashear el botón DOM real (flashButton), y el modo colapsado lo usa
// para flashear el ícono dibujado en canvas (flashCollapsedIcon). Así
// ambos modos comparten la misma lógica de acciones y sólo cambia cómo
// se pinta el ✓ / ✗ de confirmación.
function runAction(node, widget, key, onFeedback) {
    if (!widget) return;

    if (key === "copy") {
        const text = textToCopyFrom(widget);
        writeClipboard(text)
            .then(() => onFeedback?.(true))
            .catch((err) => {
                console.error("Mika Text Box Editor: no se pudo copiar.", err);
                onFeedback?.(false);
            });
    } else if (key === "selectAll") {
        selectAllInWidget(widget);
        onFeedback?.(true);
    } else if (key === "paste") {
        readClipboardText()
            .then((text) => {
                insertTextIntoWidget(node, widget, text);
                onFeedback?.(true);
            })
            .catch((err) => {
                console.error(
                    "Mika Text Box Editor: no se pudo pegar con el botón (revisá los permisos de portapapeles del navegador, o pegá directo con Ctrl+V en el cuadro).",
                    err
                );
                onFeedback?.(false);
            });
    }
}

// -----------------------------------------------------------------------
// Tooltip flotante compartido, para los iconos dibujados en canvas
// (modo colapsado) — un <button> normal ya tiene tooltip nativo via
// "title", pero un ícono dibujado a mano necesita el suyo propio.
// -----------------------------------------------------------------------
let tooltipEl = null;
function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    Object.assign(tooltipEl.style, {
        position: "fixed",
        pointerEvents: "none",
        background: "rgba(20,20,24,0.95)",
        color: "#eee",
        font: "11px/1.4 sans-serif",
        padding: "3px 6px",
        borderRadius: "4px",
        border: "1px solid #555",
        zIndex: 100000,
        display: "none",
        whiteSpace: "nowrap",
    });
    document.body.appendChild(tooltipEl);
    return tooltipEl;
}

function showTooltip(text, clientX, clientY) {
    const el = ensureTooltip();
    el.textContent = text;
    el.style.left = `${clientX + 14}px`;
    el.style.top = `${clientY + 14}px`;
    el.style.display = "block";
}

function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
}

// Dado un nodo colapsado con _mikaCollapsedIconRects (en coordenadas
// LOCALES al nodo: 0,0 = node.pos, igual que las que recibe onMouseDown),
// busca si [localX, localY] cae sobre alguno. Devuelve el ícono o null.
function hitTestCollapsedIcons(node, localX, localY) {
    if (!node._mikaCollapsedIconRects) return null;
    for (const rect of node._mikaCollapsedIconRects) {
        if (localX >= rect.x && localX <= rect.x + rect.w && localY >= rect.y && localY <= rect.y + rect.h) {
            return rect;
        }
    }
    return null;
}

// -----------------------------------------------------------------------
// Adjuntar los botones DOM del modo expandido cuando el textarea ya
// esté realmente insertado en el documento (puede no estarlo todavía
// en el momento de onNodeCreated). También enganchamos aquí el listener
// nativo de "paste": garantiza que Ctrl+V funcione bien (normalizado,
// sincronizado con el widget y re-dibujado) incluso si el navegador no
// deja usar el botón 📄 por permisos.
//
// IMPORTANTE (fix "los iconos desaparecen al cambiar de pestaña"): antes
// se usaba una bandera "node.mikaButtonsAttached" que, una vez en true,
// nunca se volvía a poner en false. Esa bandera vive en el NODO, pero los
// botones están enganchados a un <textarea> (widget.inputEl) puntual. Al
// cambiar de pestaña de workflow dentro del mismo ComfyUI y volver, el
// frontend remonta el widget DOM del textarea (el nodo "sigue siendo el
// mismo" pero el <textarea> es un elemento nuevo). Con la bandera vieja,
// attachExpandedButtons cortaba en la primera línea y nunca reinsertaba
// el wrapper/toolbar en el textarea nuevo → los iconos quedaban perdidos
// para siempre en esa pestaña, sin ningún error en consola.
//
// Ahora, en vez de una bandera de una sola vez por nodo, marcamos el
// wrapper directamente en el propio <textarea> (inputEl._mikaWrapper) y
// chequeamos, en cada intento, si ESE textarea puntual todavía tiene su
// wrapper conectado al documento. Si el textarea es nuevo (o el wrapper
// viejo quedó huérfano), se reconstruye. Esta función se llama tanto al
// crear el nodo como, de forma continua, desde onDrawForeground más
// abajo — así se "auto-cura" sola sin importar cuándo ni por qué
// ComfyUI recreó el DOM.
// -----------------------------------------------------------------------
function ensureExpandedButtons(node, widget) {
    if (!widget || !widget.inputEl) return;
    const inputEl = widget.inputEl;

    if (
        inputEl._mikaWrapper &&
        inputEl._mikaWrapper.isConnected &&
        inputEl.parentElement === inputEl._mikaWrapper
    ) {
        return; // Ya están los botones puestos en este textarea y siguen siendo válidos.
    }
    if (!inputEl.parentElement || !inputEl.isConnected) {
        return; // Todavía no está montado; se vuelve a intentar en el próximo frame (onDrawForeground).
    }

    attachExpandedButtons(node, widget);
}

function attachExpandedButtons(node, widget) {
    const inputEl = widget.inputEl;

    try {
        const wrapper = document.createElement("div");
        wrapper.style.position = "relative";
        wrapper.style.width = "100%";
        wrapper.style.height = "100%";

        inputEl.parentElement.insertBefore(wrapper, inputEl);
        wrapper.appendChild(inputEl);

        const toolbar = document.createElement("div");
        Object.assign(toolbar.style, {
            position: "absolute",
            top: "2px",
            right: "2px",
            display: "flex",
            gap: "2px",
            zIndex: "5",
        });

        for (const icon of ICONS) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = icon.glyph;
            btn.title = icon.title;
            Object.assign(btn.style, {
                width: "22px",
                height: "22px",
                lineHeight: "18px",
                padding: "0",
                fontSize: "13px",
                background: "rgba(0,0,0,0.6)",
                color: "#ddd",
                border: "1px solid #555",
                borderRadius: "3px",
                cursor: "pointer",
            });
            btn.addEventListener("mouseenter", () => {
                btn.style.background = "rgba(90,140,255,0.55)";
            });
            btn.addEventListener("mouseleave", () => {
                btn.style.background = "rgba(0,0,0,0.6)";
            });
            // Evita que el click "arrastre" el nodo o le saque el foco al
            // textarea antes de ejecutar la acción.
            btn.addEventListener("pointerdown", (e) => e.stopPropagation());
            btn.addEventListener("mousedown", (e) => e.stopPropagation());
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                runAction(node, widget, icon.key, (ok) => flashButton(btn, icon.glyph, ok));
            });
            toolbar.appendChild(btn);
        }

        wrapper.appendChild(toolbar);
        // Marcamos el wrapper en el propio textarea (no en el nodo): así,
        // si ComfyUI recrea el <textarea> más adelante (p. ej. al volver
        // de otra pestaña de workflow), ensureExpandedButtons detecta que
        // ESTE textarea nuevo no tiene wrapper todavía y reconstruye los
        // botones, en vez de quedar bloqueado por una bandera vieja.
        inputEl._mikaWrapper = wrapper;

        // Respaldo nativo: Ctrl+V (o click derecho > Pegar) directo sobre
        // el textarea siempre dispara un evento "paste" real del
        // navegador, con el contenido del portapapeles en
        // event.clipboardData — esto NO depende de la Clipboard API
        // asíncrona ni de sus permisos, así que funciona incluso cuando
        // el botón 📄 no puede leer el portapapeles (p. ej. Firefox).
        // Dejamos que el navegador pegue como siempre y, un instante
        // después, normalizamos saltos de línea y sincronizamos todo.
        if (!inputEl._mikaPasteBound) {
            inputEl.addEventListener("paste", () => {
                requestAnimationFrame(() => {
                    const normalized = normalizeNewlines(inputEl.value);
                    if (normalized !== inputEl.value) inputEl.value = normalized;
                    widget.value = normalized;
                    if (typeof widget.callback === "function") {
                        widget.callback(normalized, node.graph?.canvas, node);
                    }
                    node.setDirtyCanvas(true, true);
                    if (typeof node.onResize === "function") node.onResize(node.size);
                });
            });
            inputEl._mikaPasteBound = true;
        }
    } catch (err) {
        console.error("Mika Text Box Editor: no se pudieron crear los botones flotantes.", err);
    }
}

let globalListenersReady = false;
function ensureGlobalListeners() {
    if (globalListenersReady) return;
    globalListenersReady = true;

    // Tooltip + click de los iconos dibujados en modo colapsado.
    // Se escuchan a nivel documento porque no son elementos DOM propios,
    // sino dibujos dentro del canvas de LiteGraph.
    window.addEventListener(
        "pointermove",
        (e) => {
            try {
                const canvas = app.canvas;
                if (!canvas || !canvas.canvas) return;
                const rect = canvas.canvas.getBoundingClientRect();
                if (
                    e.clientX < rect.left ||
                    e.clientX > rect.right ||
                    e.clientY < rect.top ||
                    e.clientY > rect.bottom
                ) {
                    hideTooltip();
                    return;
                }

                const [gx, gy] = canvas.convertEventToCanvasOffset(e);
                let found = null;
                for (const node of app.graph._nodes) {
                    if (node.type !== "TextBoxClipboard" && node.comfyClass !== "TextBoxClipboard") continue;
                    if (!node.flags?.collapsed) continue;
                    const lx = gx - node.pos[0];
                    const ly = gy - node.pos[1];
                    const rectHit = hitTestCollapsedIcons(node, lx, ly);
                    if (rectHit) {
                        found = ICONS.find((i) => i.key === rectHit.key);
                        break;
                    }
                }

                if (found) {
                    showTooltip(found.title, e.clientX, e.clientY);
                } else {
                    hideTooltip();
                }
            } catch (err) {
                // No dejamos que un error acá interrumpa el resto de la UI.
            }
        },
        { passive: true }
    );

    // Click sobre un ícono colapsado: se detecta acá, a nivel window y en
    // fase de CAPTURA, en vez de depender de node.onMouseDown.
    //
    // Por qué: LiteGraph/ComfyUI reasigna "onMouseDown" como propiedad de
    // instancia de cada nodo (para sus botones de título nativos), y según
    // la versión del frontend puede haber wrappers adicionales entre medio.
    // Enganchar un listener propio, en fase de captura sobre "window" (que
    // se ejecuta ANTES que cualquier listener puesto directamente sobre el
    // <canvas>, sea cual sea su origen), es independiente de esos detalles
    // internos y no se rompe si cambian de versión.
    //
    // Al detectar el click sobre un ícono, llamamos preventDefault +
    // stopPropagation: así el evento nunca llega a LiteGraph, y no se
    // dispara ni un drag del nodo ni el toggle de colapsar.
    window.addEventListener(
        "pointerdown",
        (e) => {
            try {
                const canvas = app.canvas;
                if (!canvas || !canvas.canvas) return;
                const rect = canvas.canvas.getBoundingClientRect();
                if (
                    e.clientX < rect.left ||
                    e.clientX > rect.right ||
                    e.clientY < rect.top ||
                    e.clientY > rect.bottom
                ) {
                    return;
                }

                const [gx, gy] = canvas.convertEventToCanvasOffset(e);
                for (const node of app.graph._nodes) {
                    if (node.type !== "TextBoxClipboard" && node.comfyClass !== "TextBoxClipboard") continue;
                    if (!node.flags?.collapsed) continue;
                    const lx = gx - node.pos[0];
                    const ly = gy - node.pos[1];
                    const rectHit = hitTestCollapsedIcons(node, lx, ly);
                    if (rectHit) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
                        runAction(node, node.mikaTextWidget, rectHit.key, (ok) =>
                            flashCollapsedIcon(node, rectHit.key, ok)
                        );
                        hideTooltip();
                        return;
                    }
                }
            } catch (err) {
                console.error("Mika Text Box Editor: error detectando click en ícono colapsado.", err);
            }
            hideTooltip();
        },
        { capture: true, passive: false }
    );
}

app.registerExtension({
    name: "Mika.TextBoxEditorMika",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "TextBoxClipboard") return;

        // ------------------------------------------------------------
        // Modo expandido: 3 botones reales (DOM) en la esquina superior
        // derecha del textarea.
        // ------------------------------------------------------------
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            ensureGlobalListeners();

            const widget = this.widgets?.find((w) => w.name === "text");
            this.mikaTextWidget = widget;
            ensureExpandedButtons(this, widget);

            return r;
        };

        // ------------------------------------------------------------
        // Se llama en cada frame mientras el nodo está expandido y
        // visible. Además de dejar pasar el dibujo normal del nodo, acá
        // re-verificamos los botones del modo expandido (ver comentario
        // largo arriba de ensureExpandedButtons/attachExpandedButtons):
        // esto es lo que hace que los iconos vuelvan a aparecer solos
        // si ComfyUI recreó el <textarea> — por ejemplo al cambiar de
        // pestaña de workflow y volver — en vez de quedarse perdidos
        // hasta recargar la página.
        // ------------------------------------------------------------
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx, canvas) {
            const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
            try {
                // Throttle: no hace falta revisar 60 veces por segundo, con un
                // par de veces por segundo alcanza para que los botones
                // "vuelvan" casi al instante después de cambiar de pestaña,
                // y así el costo real es insignificante (unas pocas
                // comparaciones de propiedades, un par de veces por segundo,
                // solo para nodos de este tipo que estén expandidos).
                const now = performance.now();
                if (!this.flags?.collapsed && (!this._mikaLastButtonCheck || now - this._mikaLastButtonCheck > 400)) {
                    this._mikaLastButtonCheck = now;
                    ensureExpandedButtons(this, this.mikaTextWidget);
                }
            } catch (err) {
                console.error("Mika Text Box Editor: error re-verificando los botones del modo expandido.", err);
            }
            return r;
        };

        // ------------------------------------------------------------
        // Modo colapsado: los mismos 3 iconos, dibujados a la derecha
        // del título.
        // ------------------------------------------------------------
        nodeType.prototype.onDrawCollapsed = function (ctx, canvas) {
            try {
                const titleHeight = LiteGraph.NODE_TITLE_HEIGHT;

                ctx.save();
                ctx.font = `${Math.round(titleHeight * 0.6)}px sans-serif`;
                const titleText = (this.getTitle ? this.getTitle() : this.title) || "Text Box Editor-Mika";
                const titleWidth = ctx.measureText(titleText).width;

                // Ancho total del "pill" colapsado: círculo + título + iconos.
                const iconsWidth = ICONS.length * (ICON_SIZE + ICON_GAP) + ICON_GAP;
                const width = Math.max(
                    LiteGraph.NODE_COLLAPSED_WIDTH || 80,
                    titleHeight + titleWidth + 20 + iconsWidth
                );
                // LiteGraph usa este valor (calculado en el draw anterior)
                // tanto para dibujar como para el hit-test de los clicks.
                this._collapsed_width = width;

                // Caja de fondo del nodo colapsado.
                ctx.fillStyle = this.bgcolor || "#333";
                ctx.beginPath();
                if (ctx.roundRect) {
                    ctx.roundRect(0, -titleHeight, width, titleHeight, [titleHeight * 0.5]);
                } else {
                    ctx.rect(0, -titleHeight, width, titleHeight);
                }
                ctx.fill();

                // Círculo de colapsar + título.
                ctx.fillStyle = this.boxcolor || (LiteGraph.NODE_DEFAULT_BOXCOLOR ?? "#888");
                ctx.beginPath();
                ctx.arc(titleHeight * 0.5, -titleHeight * 0.5, titleHeight * 0.3, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = this.titleFontColor || "#ccc";
                ctx.textBaseline = "middle";
                ctx.textAlign = "left";
                ctx.fillText(titleText, titleHeight + 6, -titleHeight * 0.5 + 1);

                // Iconos, a la derecha del título.
                this._mikaCollapsedIconRects = [];
                let x = titleHeight + titleWidth + 14;
                const cy = -titleHeight * 0.5;
                const feedbackMap = this._mikaCollapsedFeedback || {};
                for (const icon of ICONS) {
                    // Si esta acción se ejecutó hace poco, mostramos ✓/✗ en
                    // vez del glyph normal, igual que hacen los botones del
                    // modo expandido (flashButton) — misma confirmación,
                    // pintada en canvas en vez de en un <button> DOM.
                    const feedback = feedbackMap[icon.key];
                    const showFeedback = !!feedback && feedback.until > Date.now();

                    ctx.fillStyle = showFeedback
                        ? feedback.ok
                            ? "rgba(70,180,90,0.35)"
                            : "rgba(200,70,70,0.35)"
                        : "rgba(255,255,255,0.10)";
                    if (ctx.roundRect) {
                        ctx.beginPath();
                        ctx.roundRect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE, 3);
                        ctx.fill();
                    }
                    ctx.fillStyle = showFeedback ? (feedback.ok ? "#9f9" : "#f99") : "#eee";
                    ctx.textAlign = "center";
                    ctx.fillText(showFeedback ? (feedback.ok ? "✓" : "✗") : icon.glyph, x + ICON_SIZE / 2, cy + 1);
                    ctx.textAlign = "left";

                    this._mikaCollapsedIconRects.push({
                        key: icon.key,
                        x,
                        y: cy - ICON_SIZE / 2,
                        w: ICON_SIZE,
                        h: ICON_SIZE,
                    });
                    x += ICON_SIZE + ICON_GAP;
                }

                ctx.restore();
                return true; // le decimos a LiteGraph que ya dibujamos todo
            } catch (err) {
                console.error("Mika Text Box Editor: fallo al dibujar el modo colapsado, uso el default.", err);
                return false;
            }
        };

        // ------------------------------------------------------------
        // Menú del click derecho: mismas 3 acciones, como respaldo
        // 100% confiable en cualquier estado del nodo.
        // ------------------------------------------------------------
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            const r = getExtraMenuOptions ? getExtraMenuOptions.apply(this, arguments) : undefined;
            const widget = this.mikaTextWidget;
            if (widget) {
                options.push(
                    { content: "📋 Copiar al portapapeles", callback: () => runAction(this, widget, "copy") },
                    { content: "☑ Seleccionar todo", callback: () => runAction(this, widget, "selectAll") },
                    { content: "📄 Pegar del portapapeles", callback: () => runAction(this, widget, "paste") }
                );
            }
            return r;
        };
    },
});
