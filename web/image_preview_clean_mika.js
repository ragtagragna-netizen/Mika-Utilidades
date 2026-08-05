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

// Copia la imagen al portapapeles SIN metadata
async function copyImageToClipboard(node) {
  try {
    // Método 1: Buscar el img element renderizado por ComfyUI
    let imgElement = null;
    
    // ComfyUI guarda las imágenes en node.imgs (array de objetos con info)
    // y las renderiza como <img> dentro del contenedor del nodo
    if (node.imgs && node.imgs.length > 0) {
      // Buscar el elemento img en el DOM del nodo
      const nodeEl = document.querySelector(`[data-node-id="${node.id}"]`);
      if (nodeEl) {
        imgElement = nodeEl.querySelector("img");
      }
    }
    
    // Método 2: Si no se encontró en el DOM, intentar obtener desde la URL
    if (!imgElement && node._mikaImageUrl) {
      imgElement = new Image();
      imgElement.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        imgElement.onload = resolve;
        imgElement.onerror = reject;
        imgElement.src = node._mikaImageUrl;
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
  const graph = app.graph;
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

    // Dibujar icono en el header (modo expandido)
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
      if (!this.flags?.collapsed) {
        try {
          drawHeaderIcon(this, ctx);
        } catch (e) { /* no-op */ }
      }
      return r;
    };

    // Dibujar icono en modo colapsado
    nodeType.prototype.onDrawCollapsed = function (ctx) {
      try {
        const LG = window.LiteGraph ?? {};
        const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
        drawHeaderIcon(this, ctx);
      } catch (e) { /* no-op */ }
      return false; // retornar false para que LiteGraph dibuje su barra default
    };

    // Capturar la URL de la imagen cuando se ejecuta
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      
      // Guardar la URL de la imagen para poder acceder después
      if (message?.images && message.images.length > 0) {
        const imgInfo = message.images[0];
        const url = `/view?filename=${imgInfo.filename}&type=${imgInfo.type}&subfolder=${imgInfo.subfolder || ""}`;
        this._mikaImageUrl = url;
      }
    };
  },
});