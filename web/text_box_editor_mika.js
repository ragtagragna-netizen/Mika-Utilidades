import { app } from "/scripts/app.js";

console.log("[Mika] Text Box Editor-Mika cargado — v10.1 (fix línea vacía en modo colapsado)");

// Iconos vectoriales (grilla 24x24, trazo 2, estilo "feather").
const ICON_CHECK = ["M20 6L9 17l-5-5"];
const ICON_CROSS = ["M18 6L6 18", "M6 6l12 12"];

const ICONS = [
  {
    key: "copy",
    title: "Copiar al portapapeles (o la selección)",
    paths: [
      "M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
      "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
    ],
  },
  {
    key: "selectAll",
    title: "Seleccionar todo",
    paths: [
      "M9 11l3 3L22 4",
      "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
    ],
  },
  {
    key: "paste",
    title: "Pegar del portapapeles",
    paths: [
      "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
      "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
    ],
  },
];

const ICON_SIZE = 16;
const DOM_ICON_PX = 14;
const ICON_GAP = 3;
const FEEDBACK_MS = 1200;

const NEUTRAL_BG = "rgba(128,128,128,0.18)";
const NEUTRAL_BG_HOVER = "rgba(128,128,128,0.35)";
const NEUTRAL_BORDER = "rgba(128,128,128,0.35)";

function iconSVG(paths, size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">${paths
    .map((d) => `<path d="${d}"/>`)
    .join("")}</svg>`;
}

function drawIconCanvas(ctx, paths, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  const s = size / 24;
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const d of paths) ctx.stroke(new Path2D(d));
  ctx.restore();
}

// -----------------------------------------------------------------------
// Portapapeles
// -----------------------------------------------------------------------
function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("execCommand('copy') no disponible.");
}

async function readClipboardText() {
  if (navigator.clipboard && navigator.clipboard.readText) {
    return await navigator.clipboard.readText();
  }
  throw new Error("Este navegador no permite leer el portapapeles con el botón. Pegá con Ctrl+V directo en el cuadro.");
}

// -----------------------------------------------------------------------
// Inserción en el cursor + sync con ComfyUI
// -----------------------------------------------------------------------
function insertTextIntoWidget(node, widget, rawText) {
  if (!widget) return;
  const text = normalizeNewlines(rawText);
  const inputEl = getWidgetTextarea(widget);

  let newValue;
  if (inputEl && inputEl.isConnected && inputEl.tagName === "TEXTAREA") {
    const start = inputEl.selectionStart ?? inputEl.value.length;
    const end = inputEl.selectionEnd ?? inputEl.value.length;
    const current = inputEl.value ?? "";
    newValue = current.slice(0, start) + text + current.slice(end);

    inputEl.value = newValue;
    const newPos = start + text.length;
    inputEl.focus();
    inputEl.setSelectionRange(newPos, newPos);

    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // Nodo colapsado o textarea todavía no montado: no hay cursor,
    // así que agregamos el texto al final sin perder lo que ya había.
    // FIX: eliminar saltos de línea al final del contenido actual para
    // evitar líneas vacías al concatenar.
    const current = (widget.value ?? "").replace(/\n+$/, "");
    const newText = text.replace(/^\n+/, "");
    
    if (!current && !newText) {
      newValue = "";
    } else if (!current) {
      newValue = newText;
    } else if (!newText) {
      newValue = current;
    } else {
      // Si current no termina con \n y newText no empieza con \n, agregar uno
      if (!current.endsWith("\n") && !newText.startsWith("\n")) {
        newValue = `${current}\n${newText}`;
      } else {
        newValue = current + newText;
      }
    }
  }

  widget.value = newValue;
  if (typeof widget.callback === "function") {
    widget.callback(newValue, node.graph?.canvas, node);
  }
  node.setDirtyCanvas(true, true);
  if (typeof node.onResize === "function") node.onResize(node.size);
  try {
    app.graph.setDirtyCanvas(true, true);
  } catch (err) { /* no-op */ }
}

function selectAllInWidget(widget) {
  const ta = getWidgetTextarea(widget);
  if (!ta || ta.tagName !== "TEXTAREA") return;
  ta.focus();
  ta.select();
}

function textToCopyFrom(widget) {
  const ta = getWidgetTextarea(widget);
  if (ta && ta.tagName === "TEXTAREA" && ta.selectionStart !== ta.selectionEnd) {
    return ta.value.substring(ta.selectionStart, ta.selectionEnd);
  }
  return widget?.value ?? "";
}

// -----------------------------------------------------------------------
// FIX CLAVE: en versiones nuevas de ComfyUI el textarea vive en
// widget.element (o dentro de él); en versiones viejas en widget.inputEl.
// -----------------------------------------------------------------------
function getWidgetTextarea(widget) {
  if (!widget) return null;
  if (widget.inputEl instanceof HTMLElement) return widget.inputEl;
  if (widget.element instanceof HTMLElement) {
    if (widget.element.tagName === "TEXTAREA") return widget.element;
    const ta = widget.element.querySelector("textarea");
    if (ta) return ta;
    return widget.element;
  }
  return null;
}

// -----------------------------------------------------------------------
// Feedback visual
// -----------------------------------------------------------------------
function flashButton(btn, icon, ok) {
  if (!btn) return;
  btn.innerHTML = iconSVG(ok ? ICON_CHECK : ICON_CROSS, DOM_ICON_PX);
  btn.style.color = ok ? "#8f8" : "#f88";
  setTimeout(() => {
    btn.innerHTML = btn._mikaOriginalHTML;
    btn.style.color = "";
  }, FEEDBACK_MS);
}

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

function runAction(node, widget, key, onFeedback) {
  if (!widget) return;
  if (key === "copy") {
    writeClipboard(textToCopyFrom(widget))
      .then(() => onFeedback?.(true))
      .catch((err) => { console.error("Mika: no se pudo copiar.", err); onFeedback?.(false); });
  } else if (key === "selectAll") {
    selectAllInWidget(widget);
    onFeedback?.(true);
  } else if (key === "paste") {
    readClipboardText()
      .then((text) => { insertTextIntoWidget(node, widget, text); onFeedback?.(true); })
      .catch((err) => {
        console.error("Mika: no se pudo pegar con el botón (usá Ctrl+V).", err);
        onFeedback?.(false);
      });
  }
}

// -----------------------------------------------------------------------
// Tooltip flotante (modo colapsado)
// -----------------------------------------------------------------------
let tooltipEl = null;
function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  Object.assign(tooltipEl.style, {
    position: "fixed", pointerEvents: "none",
    background: "rgba(20,20,24,0.95)", color: "#eee",
    font: "11px/1.4 sans-serif", padding: "3px 6px",
    borderRadius: "4px", border: "1px solid #555",
    zIndex: 100000, display: "none", whiteSpace: "nowrap",
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
function hideTooltip() { if (tooltipEl) tooltipEl.style.display = "none"; }

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
// MODO EXPANDIDO: barra de botones DOM (SVG currentColor = neutral).
// -----------------------------------------------------------------------
function ensureExpandedButtons(node, widget) {
  const anchor = getWidgetTextarea(widget);
  if (!anchor || !anchor.isConnected) return false;
  const host = anchor.parentElement ?? anchor;
  if (!host) return false;

  // Paste nativo Ctrl+V (una sola vez por textarea).
  if (anchor.tagName === "TEXTAREA" && !anchor._mikaPasteBound) {
    anchor._mikaPasteBound = true;
    anchor.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text == null || text === "") return;
      e.preventDefault();
      insertTextIntoWidget(node, widget, text);
    });
  }

  if (node._mikaBar && node._mikaBar.isConnected && node._mikaBarHost === host) return true;
  if (node._mikaBar) { node._mikaBar.remove(); node._mikaBar = null; }

  const cs = getComputedStyle(host);
  if (cs.position === "static") host.style.position = "relative";

  const bar = document.createElement("div");
  Object.assign(bar.style, {
    position: "absolute", top: "3px", right: "4px",
    display: "flex", gap: "3px", zIndex: "10", pointerEvents: "auto",
  });

  for (const icon of ICONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = icon.title;
    btn.innerHTML = iconSVG(icon.paths, DOM_ICON_PX);
    btn._mikaOriginalHTML = btn.innerHTML;
    Object.assign(btn.style, {
      width: "22px", height: "22px", padding: "0",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: NEUTRAL_BG, border: `1px solid ${NEUTRAL_BORDER}`,
      borderRadius: "4px", color: "inherit", cursor: "pointer", opacity: "0.9",
    });
    btn.onmouseenter = () => { btn.style.background = NEUTRAL_BG_HOVER; };
    btn.onmouseleave = () => { btn.style.background = NEUTRAL_BG; };
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      runAction(node, widget, icon.key, (ok) => flashButton(btn, icon, ok));
    });
    bar.appendChild(btn);
  }

  host.appendChild(bar);
  node._mikaBar = bar;
  node._mikaBarHost = host;
  return true;
}

function mikaExpandedTick(node) {
  try {
    if (node.flags?.collapsed) return;
    const now = performance.now();
    if (!node._mikaLastButtonCheck || now - node._mikaLastButtonCheck > 400) {
      node._mikaLastButtonCheck = now;
      ensureExpandedButtons(node, node.mikaTextWidget);
    }
  } catch (err) {
    console.error("Mika: error revisando botones expandidos.", err);
  }
}

// -----------------------------------------------------------------------
// MODO COLAPSADO: listeners globales (captura) para clicks/tooltips.
// -----------------------------------------------------------------------
function eventToCanvasCoords(e) {
  const canvas = app.canvas;
  if (!canvas) return null;
  try {
    if (typeof canvas.convertEventToCanvasOffset === "function") {
      const p = canvas.convertEventToCanvasOffset(e);
      return Array.isArray(p) ? p : [p?.x, p?.y];
    }
    if (typeof canvas.convertEventToCanvas === "function") {
      const p = canvas.convertEventToCanvas(e);
      return Array.isArray(p) ? p : [p?.x, p?.y];
    }
  } catch (err) { /* no-op */ }
  return null;
}

function findCollapsedIconAt(e) {
  const graph = app.graph;
  const pt = eventToCanvasCoords(e);
  if (!graph || !pt || pt[0] == null) return null;
  const nodes = graph._nodes ?? [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node._mikaIsTextBoxEditor || !node.flags?.collapsed) continue;
    if (!node._mikaCollapsedIconRects?.length) continue;
    const rect = hitTestCollapsedIcons(node, pt[0] - node.pos[0], pt[1] - node.pos[1]);
    if (rect) return { node, rect };
  }
  return null;
}

let globalListenersReady = false;
function ensureGlobalListeners() {
  if (globalListenersReady) return;
  globalListenersReady = true;

  window.addEventListener("pointerdown", (e) => {
    const hit = findCollapsedIconAt(e);
    if (!hit) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
    hideTooltip();
    runAction(hit.node, hit.node.mikaTextWidget, hit.rect.key, (ok) =>
      flashCollapsedIcon(hit.node, hit.rect.key, ok)
    );
  }, true);

  window.addEventListener("pointermove", (e) => {
    const hit = findCollapsedIconAt(e);
    if (hit) {
      const icon = ICONS.find((i) => i.key === hit.rect.key);
      showTooltip(icon?.title ?? "", e.clientX, e.clientY);
    } else {
      hideTooltip();
    }
  }, true);
}

// -----------------------------------------------------------------------
// Registro de la extensión
// -----------------------------------------------------------------------
app.registerExtension({
  name: "Mika.TextBoxEditorMika",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "TextBoxClipboard") return;

    // --- onNodeCreated: sin overrides de color (nodo 100% default/tema).
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this._mikaIsTextBoxEditor = true;
      ensureGlobalListeners();
      this.mikaTextWidget =
        (this.widgets ?? []).find(
          (w) => w.name === "text" || w.type === "customtext" || w.type === "STRING"
        ) ?? null;
      ensureExpandedButtons(this, this.mikaTextWidget);
      return r;
    };

    // --- Expandido: tick en onDrawForeground (estándar) y onDraw (fallback).
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx, canvas) {
      const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
      mikaExpandedTick(this);
      return r;
    };
    const onDraw = nodeType.prototype.onDraw;
    nodeType.prototype.onDraw = function (ctx, canvas) {
      const r = onDraw ? onDraw.apply(this, arguments) : undefined;
      mikaExpandedTick(this);
      return r;
    };

    // --- Colapsado: barra con colores del tema + iconos SVG uniformes.
    nodeType.prototype.onDrawCollapsed = function (ctx) {
      try {
        const LG = window.LiteGraph ?? {};
        const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
        const titleText =
          (typeof this.getTitle === "function" ? this.getTitle() : this.title) ||
          "Text Box Editor-Mika";

        const iconsWidth = ICONS.length * (ICON_SIZE + ICON_GAP) + ICON_GAP;
        const titleWidth = ctx.measureText(titleText).width;
        const width = Math.max(80, titleHeight + titleWidth + 14 + iconsWidth);
        this._collapsed_width = width;

        ctx.save();

        ctx.fillStyle = this.bgcolor ?? LG.NODE_DEFAULT_BGCOLOR ?? "#353535";
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(0, -titleHeight, width, titleHeight, titleHeight * 0.4);
        else ctx.rect(0, -titleHeight, width, titleHeight);
        ctx.fill();

        ctx.fillStyle = this.boxcolor ?? LG.NODE_DEFAULT_BOXCOLOR ?? "#888";
        ctx.beginPath();
        ctx.arc(titleHeight * 0.5, -titleHeight * 0.5, titleHeight * 0.28, 0, Math.PI * 2);
        ctx.fill();

        const titleColor = LG.NODE_TITLE_COLOR ?? "#999";
        ctx.fillStyle = titleColor;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(titleText, titleHeight + 8, -titleHeight * 0.5 + 1);

        this._mikaCollapsedIconRects = [];
        let x = width - iconsWidth + ICON_GAP;
        const cy = -titleHeight * 0.5;
        const feedbackMap = this._mikaCollapsedFeedback ?? {};

        for (const icon of ICONS) {
          const feedback = feedbackMap[icon.key];
          const showFeedback = feedback && feedback.until > Date.now();

          // Fondo sutil uniforme
          ctx.fillStyle = NEUTRAL_BG;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE, 4);
          else ctx.rect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
          ctx.fill();

          if (showFeedback) {
            drawIconCanvas(ctx, feedback.ok ? ICON_CHECK : ICON_CROSS, x, cy - ICON_SIZE / 2, ICON_SIZE, feedback.ok ? "#8f8" : "#f88");
          } else {
            drawIconCanvas(ctx, icon.paths, x, cy - ICON_SIZE / 2, ICON_SIZE, titleColor);
          }

          this._mikaCollapsedIconRects.push({
            key: icon.key, x, y: cy - ICON_SIZE / 2, w: ICON_SIZE, h: ICON_SIZE,
          });
          x += ICON_SIZE + ICON_GAP;
        }

        ctx.restore();
        return true;
      } catch (err) {
        console.error("Mika: fallo dibujando colapsado; uso default.", err);
        return false;
      }
    };

    // --- Menú click derecho (respaldo).
    const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_graph, options) {
      const r = origGetExtraMenuOptions ? origGetExtraMenuOptions.apply(this, arguments) : undefined;
      if (Array.isArray(options)) {
        options.push(null);
        for (const icon of ICONS) {
          options.push({
            content: icon.title,
            callback: () =>
              runAction(this, this.mikaTextWidget, icon.key, (ok) =>
                flashCollapsedIcon(this, icon.key, ok)
              ),
          });
        }
      }
      return r;
    };

    // --- Limpieza al borrar el nodo.
    const origOnRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this._mikaBar?.isConnected) this._mikaBar.remove();
      this._mikaBar = null;
      return origOnRemoved ? origOnRemoved.apply(this, arguments) : undefined;
    };
  },
});