import { app } from "/scripts/app.js";

console.log("[Mika] Text Box Editor-Mika cargado — v11.1 (botones en header + link estático)");

const ICON_CHECK = ["M20 6L9 17l-5-5"];
const ICON_CROSS = ["M18 6L6 18", "M6 6l12 12"];
const ICONS = [
  { key: "copy", title: "Copiar al portapapeles (o la selección)",
    paths: ["M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
            "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"] },
  { key: "selectAll", title: "Seleccionar todo",
    paths: ["M9 11l3 3L22 4", "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"] },
  { key: "paste", title: "Pegar del portapapeles",
    paths: ["M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
            "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"] },
];

const ICON_SIZE = 16;
const ICON_GAP = 3;
const FEEDBACK_MS = 1200;
const NEUTRAL_BG = "rgba(128,128,128,0.18)";

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
    const current = (widget.value ?? "").replace(/\n+$/, "");
    const newText = text.replace(/^\n+/, "");
    if (!current && !newText) newValue = "";
    else if (!current) newValue = newText;
    else if (!newText) newValue = current;
    else if (!current.endsWith("\n") && !newText.startsWith("\n")) newValue = `${current}\n${newText}`;
    else newValue = current + newText;
  }

  widget.value = newValue;
  if (typeof widget.callback === "function") widget.callback(newValue, node.graph?.canvas, node);
  node.setDirtyCanvas(true, true);
  if (typeof node.onResize === "function") node.onResize(node.size);
  try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* no-op */ }
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

function bindPaste(node, widget) {
  const anchor = getWidgetTextarea(widget);
  if (!anchor || anchor.tagName !== "TEXTAREA" || anchor._mikaPasteBound) return;
  anchor._mikaPasteBound = true;
  anchor.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text == null || text === "") return;
    e.preventDefault();
    insertTextIntoWidget(node, widget, text);
  });
}

function flashIcon(node, key, ok) {
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
      .catch((err) => { console.error("Mika: no se pudo pegar (usá Ctrl+V).", err); onFeedback?.(false); });
  }
}

// -----------------------------------------------------------------------
// Tooltip flotante
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

function hitTestRects(rects, localX, localY) {
  for (const rect of rects) {
    if (localX >= rect.x && localX <= rect.x + rect.w && localY >= rect.y && localY <= rect.y + rect.h) {
      return rect;
    }
  }
  return null;
}

// -----------------------------------------------------------------------
// Dibuja los iconos a la derecha del header (título) y guarda sus rects.
// -----------------------------------------------------------------------
function drawHeaderIcons(node, ctx) {
  const LG = window.LiteGraph ?? {};
  const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
  const iconsWidth = ICONS.length * (ICON_SIZE + ICON_GAP) + ICON_GAP;
  const width = node.flags?.collapsed
    ? (node._mikaCollapsedWidth ?? node._collapsed_width ?? node.size?.[0] ?? 200)
    : (node.size?.[0] ?? 200);
  let x = width - iconsWidth - 4;
  const cy = -titleHeight * 0.5;
  const feedbackMap = node._mikaCollapsedFeedback ?? {};
  const titleColor = LG.NODE_TITLE_COLOR ?? "#999";
  const rects = [];
  const iconRadius = nodeShape(node) === "box" ? 0 : 4;
  
  for (const icon of ICONS) {
    const feedback = feedbackMap[icon.key];
    const showFeedback = feedback && feedback.until > Date.now();

    ctx.fillStyle = NEUTRAL_BG;
    ctx.beginPath();
    if (iconRadius > 0 && ctx.roundRect) ctx.roundRect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE, iconRadius);
    else ctx.rect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
    ctx.fill();

    if (showFeedback) {
      drawIconCanvas(ctx, feedback.ok ? ICON_CHECK : ICON_CROSS, x, cy - ICON_SIZE / 2, ICON_SIZE, feedback.ok ? "#8f8" : "#f88");
    } else {
      drawIconCanvas(ctx, icon.paths, x, cy - ICON_SIZE / 2, ICON_SIZE, titleColor);
    }

    rects.push({ key: icon.key, x, y: cy - ICON_SIZE / 2, w: ICON_SIZE, h: ICON_SIZE });
    x += ICON_SIZE + ICON_GAP;
  }

  if (node.flags?.collapsed) node._mikaCollapsedIconRects = rects;
  else node._mikaExpandedIconRects = rects;
}

// Detecta la forma configurada (box/round/circle/card) igual que ComfyUI.
function nodeShape(node) {
  const LG = window.LiteGraph ?? {};
  let s = node.shape ?? LG.NODE_DEFAULT_SHAPE;
  if (typeof s === "number") {
    if (s === LG.BOX_SHAPE) return "box";
    if (s === LG.CIRCLE_SHAPE) return "circle";
    if (s === LG.CARD_SHAPE) return "card";
    return "round";
  }
  s = String(s ?? "").toLowerCase();
  if (s.includes("box") || s.includes("square")) return "box";
  if (s.includes("circle") || s.includes("capsule")) return "circle";
  if (s.includes("card")) return "card";
  return "round";
}

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
  } catch (e2) { /* no-op */ }
  return null;
}

// Busca un icono (colapsado o expandido) bajo el cursor.
function findIconAt(e, flagName) {
  const graph = app.graph;
  const pt = eventToCanvasCoords(e);
  if (!graph || !pt || pt[0] == null) return null;
  const nodes = graph._nodes ?? [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node[flagName]) continue;
    const rects = node.flags?.collapsed ? node._mikaCollapsedIconRects : node._mikaExpandedIconRects;
    if (!rects?.length) continue;
    const rect = hitTestRects(rects, pt[0] - node.pos[0], pt[1] - node.pos[1]);
    if (rect) return { node, rect };
  }
  return null;
}

let globalListenersReady = false;
function ensureGlobalListeners(flagName) {
  if (globalListenersReady) return;
  globalListenersReady = true;

  window.addEventListener("pointerdown", (e) => {
    const hit = findIconAt(e, flagName);
    if (!hit) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
    hideTooltip();
    runAction(hit.node, hit.node.mikaTextWidget, hit.rect.key, (ok) => flashIcon(hit.node, hit.rect.key, ok));
  }, true);

  window.addEventListener("pointermove", (e) => {
    const hit = findIconAt(e, flagName);
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
    const FLAG = "_mikaIsTextBoxEditor";

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this[FLAG] = true;
      ensureGlobalListeners(FLAG);
      this.mikaTextWidget =
        (this.widgets ?? []).find((w) => w.name === "text" || w.type === "customtext" || w.type === "STRING") ?? null;
      bindPaste(this, this.mikaTextWidget);
      return r;
    };

    // Expandido: iconos en el header + engancha el paste nativo.
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
      if (this.flags?.collapsed) return r;
      try {
        bindPaste(this, this.mikaTextWidget);
        drawHeaderIcons(this, ctx);
      } catch (e) { /* no-op */ }
      return r;
    };

    // Colapsado: lo dibujamos COMPLETO nosotros (return true evita que
    // LiteGraph pinte su barra encima y tape los iconos). Replicamos la
    // estética default: barra de altura estándar, fuente chica, forma
    // según la configuración (box/round/circle/card) y círculo indicador.
    // Al ser los únicos que fijan _collapsed_width, el link queda estable.
    nodeType.prototype.onDrawCollapsed = function (ctx) {
      try {
        const LG = window.LiteGraph ?? {};
        const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
        const titleText =
          (typeof this.getTitle === "function" ? this.getTitle() : this.title) ||
          "Text Box Editor-Mika"; // ← en el visor: "Text Box Visor-Mika"

        // Fuente chica FIJA (misma estética del título colapsado default).
        const titleFont = "10px sans-serif";
        ctx.save();
        ctx.font = titleFont;
        const titleWidth = ctx.measureText(titleText).width;

        const iconsWidth = ICONS.length * (ICON_SIZE + ICON_GAP) + ICON_GAP;
        const width = Math.max(
          LG.NODE_COLLAPSED_WIDTH ?? 80,
          titleHeight + titleWidth + 14 + iconsWidth
        );
        this._mikaCollapsedWidth = width; // fuente de verdad propia (no pelea con LiteGraph)

    // FIX LINK definitivo: el cable usa NUESTRO ancho cacheado (constante),
    // así el ancla coincide con la barra dibujada y no oscila nunca.
    const origGetConnectionPos = nodeType.prototype.getConnectionPos;
    nodeType.prototype.getConnectionPos = function (is_input, slot_number, out) {
      const res = origGetConnectionPos
        ? origGetConnectionPos.apply(this, arguments)
        : (out || [0, 0]);
      if (this.flags?.collapsed && !is_input && this._mikaCollapsedWidth && res) {
        const LG = window.LiteGraph ?? {};
        const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
        res[0] = this.pos[0] + this._mikaCollapsedWidth;
        res[1] = this.pos[1] - titleHeight * 0.5;
      }
      return res;
    };
	
        // Barra con la forma configurada (igual que el resto de nodos).
        const radius = LG.ROUND_RADIUS ?? 8;
        const shape = nodeShape(this);
        ctx.fillStyle = this.bgcolor ?? LG.NODE_DEFAULT_BGCOLOR ?? "#353535";
        ctx.beginPath();
        if (!ctx.roundRect || shape === "box") {
          ctx.rect(0, -titleHeight, width, titleHeight);
        } else if (shape === "circle") {
          ctx.roundRect(0, -titleHeight, width, titleHeight, titleHeight / 2);
        } else if (shape === "card") {
          ctx.roundRect(0, -titleHeight, width, titleHeight, [radius, radius, 0, 0]);
        } else {
          ctx.roundRect(0, -titleHeight, width, titleHeight, radius);
        }
        ctx.fill();

        // Círculo indicador izquierdo (igual que default).
        ctx.fillStyle = this.boxcolor ?? LG.NODE_DEFAULT_BOXCOLOR ?? "#888";
        ctx.beginPath();
        ctx.arc(titleHeight * 0.5, -titleHeight * 0.5, titleHeight * 0.28, 0, Math.PI * 2);
        ctx.fill();

        // Título con fuente chica.
        ctx.fillStyle = LG.NODE_TITLE_COLOR ?? "#999";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(titleText, titleHeight + 8, -titleHeight * 0.5 + 1);
        ctx.restore();

        // Iconos a la derecha, sobre nuestra propia barra (quedan visibles).
        drawHeaderIcons(this, ctx);
      } catch (e) { /* no-op */ }
      return true; // nosotros dibujamos todo; LiteGraph no pisa nada.
    };

    const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_graph, options) {
      const r = origGetExtraMenuOptions ? origGetExtraMenuOptions.apply(this, arguments) : undefined;
      if (Array.isArray(options)) {
        options.push(null);
        for (const icon of ICONS) {
          options.push({
            content: icon.title,
            callback: () => runAction(this, this.mikaTextWidget, icon.key, (ok) => flashIcon(this, icon.key, ok)),
          });
        }
      }
      return r;
    };
  },
});