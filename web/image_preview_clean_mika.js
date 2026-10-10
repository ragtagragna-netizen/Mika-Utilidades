import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const ICON_CHECK = ["M20 6L9 17l-5-5"];
const ICON_CROSS = ["M18 6L6 18", "M6 6l12 12"];
const ICON_COPY = [
  "M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
  "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
];

const ICON_SIZE = 16;
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

function flashIcon(node, ok) {
  node._mikaCopyFeedback = { ok, until: Date.now() + FEEDBACK_MS };
  node.setDirtyCanvas(true, true);
  setTimeout(() => {
    if (node._mikaCopyFeedback) {
      delete node._mikaCopyFeedback;
      node.setDirtyCanvas(true, true);
    }
  }, FEEDBACK_MS);
}

// Copia la imagen visible del preview al portapapeles SIN metadata
async function copyImageToClipboard(node) {
  try {
    // Índice de la imagen visible en el preview (null = mosaico de batch)
    let idx = node.imageIndex;
    if (typeof idx !== "number" || idx == null || idx < 0) idx = 0;

    // Método 1: node.imgs contiene los HTMLImageElement de todo el batch;
    // imageIndex indica cuál se está mostrando
    let imgElement = null;
    if (node.imgs && node.imgs.length > 0) {
      imgElement = node.imgs[Math.min(idx, node.imgs.length - 1)];
    }

    // Método 2: Si no hay imgs cargadas, obtener desde la URL guardada
    if ((!imgElement || !imgElement.complete) && node._mikaImageUrls?.length) {
      const url = node._mikaImageUrls[Math.min(idx, node._mikaImageUrls.length - 1)];
      imgElement = new Image();
      imgElement.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        imgElement.onload = resolve;
        imgElement.onerror = reject;
        imgElement.src = url;
      });
    }
    
    if (!imgElement) {
      console.error("[Mika] No se encontró la imagen de preview");
      flashIcon(node, false);
      return;
    }

    // Dibujar la imagen en un canvas offscreen (esto elimina cualquier metadata)
    const canvas = document.createElement("canvas");
    canvas.width = imgElement.naturalWidth || imgElement.width;
    canvas.height = imgElement.naturalHeight || imgElement.height;
    
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgElement, 0, 0);

    // Convertir a blob PNG limpio (sin metadata)
    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, 'image/png', 1.0);
    });

    if (!blob) {
      console.error("[Mika] Error generando blob de imagen");
      flashIcon(node, false);
      return;
    }

    // Copiar al portapapeles
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blob
      })
    ]);

    flashIcon(node, true);
    console.log("[Mika] Imagen copiada al portapapeles (sin metadata)");
  } catch (err) {
    console.error("[Mika] Error copiando imagen:", err);
    flashIcon(node, false);
  }
}

// Dibuja el botón de copiar en el header
function drawHeaderIcon(node, ctx) {
  const LG = window.LiteGraph ?? {};
  const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
  const width = node.size?.[0] ?? 200;
  const x = width - ICON_SIZE - 8;
  const cy = -titleHeight * 0.5;
  const titleColor = LG.NODE_TITLE_COLOR ?? "#999";

  const feedback = node._mikaCopyFeedback;
  const showFeedback = feedback && feedback.until > Date.now();

  // Fondo del botón
  ctx.fillStyle = NEUTRAL_BG;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE, 4);
  } else {
    ctx.rect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
  }
  ctx.fill();

  // Icono o feedback
  if (showFeedback) {
    drawIconCanvas(ctx, feedback.ok ? ICON_CHECK : ICON_CROSS, x, cy - ICON_SIZE / 2, ICON_SIZE, feedback.ok ? "#8f8" : "#f88");
  } else {
    drawIconCanvas(ctx, ICON_COPY, x, cy - ICON_SIZE / 2, ICON_SIZE, titleColor);
  }

  // Guardar rect para click detection
  node._mikaCopyIconRect = { x, y: cy - ICON_SIZE / 2, w: ICON_SIZE, h: ICON_SIZE };
}

function eventToCanvasCoords(e) {
  const canvas = app.canvas;
  if (!canvas) return null;
  try {
    if (typeof canvas.convertEventToCanvasOffset === "function") {
      const p = canvas.convertEventToCanvasOffset(e);
      return Array.isArray(p) ? p : [p?.x, p?.y];
    }
  } catch (e2) { /* no-op */ }
  return null;
}

function findIconAt(e, flagName) {
  const graph = app.canvas?.graph ?? app.graph;
  const pt = eventToCanvasCoords(e);
  if (!graph || !pt || pt[0] == null) return null;
  const nodes = graph._nodes ?? [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node[flagName]) continue;
    const rect = node._mikaCopyIconRect;
    if (!rect) continue;
    const localX = pt[0] - node.pos[0];
    const localY = pt[1] - node.pos[1];
    if (localX >= rect.x && localX <= rect.x + rect.w && 
        localY >= rect.y && localY <= rect.y + rect.h) {
      return { node, rect };
    }
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
    copyImageToClipboard(hit.node);
  }, true);
}

app.registerExtension({
  name: "Mika.ImagePreviewClean",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "ImagePreviewCleanMika") return;
    const FLAG = "_mikaIsImagePreviewClean";

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this[FLAG] = true;
      ensureGlobalListeners(FLAG);
      return r;
    };

    // El widget de preview del frontend fija minHeight=220 (no deja
    // encoger el nodo por debajo de la imagen). Se relaja ese mínimo.
    const relaxPreviewMinSize = (node) => {
      const w = node.widgets?.find(
        (x) => x && x.name === "$$canvas-image-preview" && !x._mikaRelaxed
      );
      if (!w) return;
      w._mikaRelaxed = true;
      w.computeLayoutSize = () => ({ minHeight: 60, minWidth: 1 });
    };

    // Dibujar icono en el header (modo expandido)
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
      if (!this.flags?.collapsed) {
        try {
          relaxPreviewMinSize(this);
          drawHeaderIcon(this, ctx);
          // La imagen opaca del preview cubre el tinte púrpura que el
          // canvas da al cuerpo en bypass; se vuelve a pintar encima.
          if (this.mode === 4) {
            const LG = window.LiteGraph ?? {};
            const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
            ctx.save();
            // drawNode aplica alpha~0.2 en bypass; se compensa.
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = "rgba(190, 60, 220, 0.25)";
            ctx.beginPath();
            ctx.roundRect(0, -titleHeight, this.size[0], this.size[1] + titleHeight, 8);
            ctx.fill();
            ctx.restore();
            drawHeaderIcon(this, ctx);
          }
        } catch (e) { /* no-op */ }
      }
      return r;
    };

    // Dibujar barra colapsada completa (igual que nativa: se ajusta al
    // título sin superar el ancho expandido) + icono dentro del header.
    nodeType.prototype.onDrawCollapsed = function (ctx) {
      try {
        const LG = window.LiteGraph ?? {};
        const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
        const titleText =
          (typeof this.getTitle === "function" ? this.getTitle() : this.title) ||
          "Image Preview Clean-Mika";

        const titleFont = `${Math.round(titleHeight * 0.42)}px sans-serif`;
        ctx.save();
        ctx.font = titleFont;

        const titleWidth = ctx.measureText(titleText).width;
        const expandedWidth = this.size?.[0] ?? 200;
        const width = Math.max(
          LG.NODE_COLLAPSED_WIDTH ?? 80,
          Math.min(expandedWidth, titleHeight + titleWidth + 14 + ICON_SIZE + 6)
        );

        const maxTitleWidth = width - titleHeight - ICON_SIZE - 28;
        let displayTitle = titleText;
        if (ctx.measureText(displayTitle).width > maxTitleWidth) {
          while (displayTitle.length && ctx.measureText(displayTitle + "…").width > maxTitleWidth) {
            displayTitle = displayTitle.slice(0, -1);
          }
          displayTitle += "…";
        }

        const radius = LG.ROUND_RADIUS ?? 8;
        // renderingBgColor aplica el tinte púrpura en bypass (mode 4).
        ctx.fillStyle = this.renderingBgColor ?? this.bgcolor ?? LG.NODE_DEFAULT_BGCOLOR ?? "#353535";
        ctx.beginPath();
        if (!ctx.roundRect) {
          ctx.rect(0, -titleHeight, width, titleHeight);
        } else {
          ctx.roundRect(0, -titleHeight, width, titleHeight, [radius, radius, 0, 0]);
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

        // El icono usa el ancho colapsado real, no el expandido.
        const cx = width - ICON_SIZE - 8;
        const cy = -titleHeight * 0.5;
        const feedback = this._mikaCopyFeedback;
        const showFeedback = feedback && feedback.until > Date.now();

        ctx.fillStyle = NEUTRAL_BG;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(cx, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE, 4);
        else ctx.rect(cx, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
        ctx.fill();

        if (showFeedback) {
          drawIconCanvas(ctx, feedback.ok ? ICON_CHECK : ICON_CROSS, cx, cy - ICON_SIZE / 2, ICON_SIZE, feedback.ok ? "#8f8" : "#f88");
        } else {
          drawIconCanvas(ctx, ICON_COPY, cx, cy - ICON_SIZE / 2, ICON_SIZE, LG.NODE_TITLE_COLOR ?? "#999");
        }
        this._mikaCopyIconRect = { x: cx, y: cy - ICON_SIZE / 2, w: ICON_SIZE, h: ICON_SIZE };

        if (this.is_selected) {
          ctx.save();
          ctx.globalAlpha = 0.8;
          ctx.strokeStyle = LG.NODE_BOX_OUTLINE_COLOR ?? "#FFF";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(-6, -titleHeight - 6, width + 13, titleHeight + 12, [radius * 2]);
          ctx.stroke();
          ctx.restore();
        }
      } catch (e) { /* no-op */ }
      return true;
    };

    // Capturar la URL de la imagen cuando se ejecuta
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      
      // Guardar las URLs de todas las imágenes del batch
      if (message?.images && message.images.length > 0) {
        this._mikaImageUrls = message.images.map((imgInfo) =>
          `/view?filename=${imgInfo.filename}&type=${imgInfo.type}&subfolder=${imgInfo.subfolder || ""}`
        );
        this._mikaImageUrl = this._mikaImageUrls[0];
      }
    };
  },
});