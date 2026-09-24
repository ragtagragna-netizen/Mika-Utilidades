import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Text Box Paste-Mika
// -----------------------------------------------------------------------
// Caja de texto con un único botón de pegar en el header: al pulsarlo
// REEMPLAZA todo el texto del nodo por el contenido del portapapeles.
// -----------------------------------------------------------------------

const ICON_PASTE = [
  "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
  "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
];
const ICON_CHECK = ["M20 6L9 17l-5-5"];
const ICON_CROSS = ["M18 6L6 18", "M6 6l12 12"];

const ICON_SIZE = 16;
const ICON_GAP = 3;
const NEUTRAL_BG = "rgba(128,128,128,0.18)";
const FEEDBACK_MS = 1200;

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

async function readClipboardText() {
  if (navigator.clipboard && navigator.clipboard.readText) {
    return await navigator.clipboard.readText();
  }
  throw new Error("Este navegador no permite leer el portapapeles. Usá Ctrl+V.");
}

function replaceWidgetText(node, widget, text) {
  if (!widget) return;
  const value = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "");
  const inputEl = widget.inputEl ?? widget.element;
  const el =
    inputEl instanceof HTMLTextAreaElement
      ? inputEl
      : inputEl instanceof HTMLElement
      ? inputEl.querySelector("textarea")
      : null;
  if (el && el.isConnected) {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  widget.value = value;
  if (typeof widget.callback === "function") widget.callback(value, node.graph);
  node.graph?.setDirtyCanvas?.(true, true);
}

function flashIcon(node, key, ok) {
  node._mikaFeedback = { key, ok, until: Date.now() + FEEDBACK_MS };
  node.graph?.setDirtyCanvas?.(true, true);
}

function runPaste(node) {
  const widget =
    node.mikaTextWidget ??
    (node.widgets ?? []).find((w) => w.name === "text");
  readClipboardText()
    .then((t) => {
      replaceWidgetText(node, widget, t);
      flashIcon(node, "paste", true);
    })
    .catch((err) => {
      console.error("Mika: no se pudo pegar (usá Ctrl+V).", err);
      flashIcon(node, "paste", false);
    });
}

// --- Tooltip flotante ---------------------------------------------------
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

// --- Dibujo del icono en el header --------------------------------------
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

function drawHeaderIcon(node, ctx) {
  const LG = window.LiteGraph ?? {};
  const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
  const iconsWidth = ICON_SIZE + ICON_GAP;
  const width = node.flags?.collapsed
    ? (node._mikaCollapsedWidth ?? node._collapsed_width ?? node.size?.[0] ?? 200)
    : (node.size?.[0] ?? 200);
  let x = width - iconsWidth - 4;
  const cy = -titleHeight * 0.5;
  const titleColor = LG.NODE_TITLE_COLOR ?? "#999";
  const iconRadius = nodeShape(node) === "box" ? 0 : 4;

  const fb = node._mikaFeedback;
  const showFeedback = fb && fb.until > Date.now();

  ctx.fillStyle = NEUTRAL_BG;
  ctx.beginPath();
  if (iconRadius > 0 && ctx.roundRect) ctx.roundRect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE, iconRadius);
  else ctx.rect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
  ctx.fill();

  if (showFeedback) {
    drawIconCanvas(ctx, fb.ok ? ICON_CHECK : ICON_CROSS,
      x, cy - ICON_SIZE / 2, ICON_SIZE, fb.ok ? "#8f8" : "#f88");
  } else {
    drawIconCanvas(ctx, ICON_PASTE, x, cy - ICON_SIZE / 2, ICON_SIZE, titleColor);
  }

  const rect = { key: "paste", x, y: cy - ICON_SIZE / 2, w: ICON_SIZE, h: ICON_SIZE };
  if (node.flags?.collapsed) node._mikaCollapsedRect = rect;
  else node._mikaExpandedRect = rect;
}

function eventToCanvasCoords(e) {
  const canvas = app.canvas;
  if (!canvas) return null;
  try {
    const p =
      typeof canvas.convertEventToCanvasOffset === "function"
        ? canvas.convertEventToCanvasOffset(e)
        : canvas.convertEventToCanvas(e);
    return Array.isArray(p) ? p : [p?.x, p?.y];
  } catch (e2) { return null; }
}

function findNodeAtIcon(e) {
  const graph = app.canvas?.graph ?? app.graph;
  const pt = eventToCanvasCoords(e);
  if (!graph || !pt || pt[0] == null) return null;
  const nodes = graph._nodes ?? [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node._mikaIsPasteBox) continue;
    const rect = node.flags?.collapsed ? node._mikaCollapsedRect : node._mikaExpandedRect;
    if (!rect) continue;
    const lx = pt[0] - node.pos[0];
    const ly = pt[1] - node.pos[1];
    if (lx >= rect.x && lx <= rect.x + rect.w && ly >= rect.y && ly <= rect.y + rect.h) {
      return node;
    }
  }
  return null;
}

let listenersReady = false;
function ensureListeners() {
  if (listenersReady) return;
  listenersReady = true;

  window.addEventListener("pointerdown", (e) => {
    const node = findNodeAtIcon(e);
    if (!node) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
    hideTooltip();
    runPaste(node);
  }, true);

  window.addEventListener("pointermove", (e) => {
    const node = findNodeAtIcon(e);
    if (node) {
      showTooltip("Pegar (reemplaza todo el texto)", e.clientX, e.clientY);
    } else {
      hideTooltip();
    }
  }, true);
}

// --- Registro de la extensión -------------------------------------------
app.registerExtension({
  name: "Mika.TextBoxPasteMika",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "TextBoxPasteMika") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this._mikaIsPasteBox = true;
      this.mikaTextWidget =
        (this.widgets ?? []).find((w) => w.name === "text" || w.type === "customtext") ?? null;
      if (this.mikaTextWidget?.options) this.mikaTextWidget.options.minNodeSize = [200, 60];
      this.size = [200, 60];
      if (typeof this.onResize === "function") this.onResize(this.size);
      ensureListeners();
      return r;
    };

    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
      if (this.flags?.collapsed) return r;
      try { drawHeaderIcon(this, ctx); } catch (e) { /* no-op */ }
      return r;
    };

    nodeType.prototype.onDrawCollapsed = function (ctx) {
      try {
        const LG = window.LiteGraph ?? {};
        const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
        const titleText =
          (typeof this.getTitle === "function" ? this.getTitle() : this.title) ||
          "Mika";
        const titleFont = `${Math.round(titleHeight * 0.42)}px sans-serif`;
        ctx.save();
        ctx.font = titleFont;
        const iconsWidth = ICON_SIZE + ICON_GAP;
        const titleWidth = ctx.measureText(titleText).width;
        const expandedWidth = this.size?.[0] ?? 200;
        const width = Math.max(
          LG.NODE_COLLAPSED_WIDTH ?? 80,
          Math.min(expandedWidth, titleHeight + titleWidth + 14 + iconsWidth)
        );
        this._mikaCollapsedWidth = width;

        const maxTitleWidth = width - titleHeight - iconsWidth - 22;
        let displayTitle = titleText;
        if (ctx.measureText(displayTitle).width > maxTitleWidth) {
          while (displayTitle.length && ctx.measureText(displayTitle + "…").width > maxTitleWidth) {
            displayTitle = displayTitle.slice(0, -1);
          }
          displayTitle += "…";
        }

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

        ctx.fillStyle = this.boxcolor ?? LG.NODE_DEFAULT_BOXCOLOR ?? "#888";
        ctx.beginPath();
        ctx.arc(titleHeight * 0.5, -titleHeight * 0.5, titleHeight * 0.28, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = LG.NODE_TITLE_COLOR ?? "#999";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(displayTitle, titleHeight + 8, -titleHeight * 0.5 + 1);
        ctx.restore();

        drawHeaderIcon(this, ctx);

        if (this.is_selected) {
          ctx.save();
          ctx.globalAlpha = 0.8;
          ctx.strokeStyle = LG.NODE_BOX_OUTLINE_COLOR ?? "#FFF";
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (shape === "box") {
            ctx.rect(-6, -titleHeight - 6, width + 13, titleHeight + 12);
          } else {
            ctx.roundRect(-6, -titleHeight - 6, width + 13, titleHeight + 12, [radius * 2]);
          }
          ctx.stroke();
          ctx.restore();
        }
      } catch (e) { /* no-op */ }
      return true;
    };

    const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_graph, options) {
      const r = origGetExtraMenuOptions ? origGetExtraMenuOptions.apply(this, arguments) : undefined;
      if (Array.isArray(options)) {
        options.push(null);
        options.push({
          content: "Pegar (reemplaza todo el texto)",
          callback: () => runPaste(this),
        });
      }
      return r;
    };
  },
});
