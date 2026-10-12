import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Option List-Mika
// -----------------------------------------------------------------------
// Una sola salida: se conecta a cualquier slot, lee SUS opciones (como
// Primitive-Mika: del widget vivo del destino) y las deja en la caja
// `text` del propio nodo, una por línea. El cable es solo el gesto de
// inspección y se quita solo. Botón del header: copiar.
// -----------------------------------------------------------------------

const ICONS = [
  { key: "copy", title: "Copiar al portapapeles (o la selección)",
    paths: ["M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
            "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"] },
];
const ICON_SIZE = 16;
const ICON_GAP = 3;

function textWidget(node) {
  return node.widgets?.find((w) => w.name === "text") ?? null;
}

function boxTextarea(node) {
  const box = textWidget(node);
  if (box?.inputEl instanceof HTMLElement) return box.inputEl;
  const el = box?.element;
  if (el instanceof HTMLElement) return el.tagName === "TEXTAREA" ? el : el.querySelector("textarea");
  return null;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

function runHeaderAction(node, key, onFeedback) {
  const box = textWidget(node);
  if (!box || key !== "copy") return;
  const ta = boxTextarea(node);
  const text = ta && ta.selectionStart !== ta.selectionEnd
    ? ta.value.substring(ta.selectionStart, ta.selectionEnd)
    : (box.value ?? "");
  copyText(text)
    .then(() => onFeedback?.(true))
    .catch((e) => { console.error("Mika.OptionList copiar: " + e); onFeedback?.(false); });
}

const FEEDBACK_MS = 1200;

function flashIcon(node, ok) {
  node._mikaOptionListFeedback = { ok, until: Date.now() + FEEDBACK_MS };
  node.setDirtyCanvas(true, true);
  setTimeout(() => {
    if (node._mikaOptionListFeedback) {
      node._mikaOptionListFeedback = null;
      node.setDirtyCanvas(true, true);
    }
  }, FEEDBACK_MS);
}

function drawHeaderIcons(node, ctx) {
  const LG = window.LiteGraph ?? {};
  const titleHeight = LG.NODE_TITLE_HEIGHT ?? 20;
  const width = node.size?.[0] ?? 200;
  let x = width - (ICONS.length * (ICON_SIZE + ICON_GAP) + ICON_GAP) - 4;
  const cy = -titleHeight * 0.5;
  const feedback = node._mikaOptionListFeedback;
  const showFeedback = feedback && feedback.until > Date.now();
  const rects = [];
  for (const icon of ICONS) {
    ctx.fillStyle = "rgba(128,128,128,0.18)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE, 4);
    else ctx.rect(x, cy - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
    ctx.fill();
    ctx.save();
    ctx.translate(x, cy - ICON_SIZE / 2);
    ctx.scale(ICON_SIZE / 24, ICON_SIZE / 24);
    if (showFeedback) {
      const d = feedback.ok ? ["M20 6L9 17l-5-5"] : ["M18 6L6 18", "M6 6l12 12"];
      ctx.strokeStyle = feedback.ok ? "#8f8" : "#f88";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const p of d) ctx.stroke(new Path2D(p));
    } else {
      ctx.strokeStyle = LG.NODE_TITLE_COLOR ?? "#999";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const d of icon.paths) ctx.stroke(new Path2D(d));
    }
    ctx.restore();
    rects.push({ key: icon.key, x, y: cy - ICON_SIZE / 2, w: ICON_SIZE, h: ICON_SIZE });
    x += ICON_SIZE + ICON_GAP;
  }
  node._mikaOptionListIconRects = rects;
}

function hitHeaderIcon(node, pos) {
  for (const r of node._mikaOptionListIconRects ?? []) {
    if (pos[0] >= r.x && pos[0] <= r.x + r.w && pos[1] >= r.y && pos[1] <= r.y + r.h) {
      return r;
    }
  }
  return null;
}

app.registerExtension({
  name: "Mika.OptionList",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "OptionListMika") return;

    // Gesto de inspección: al conectar la salida a un slot, lee el
    // widget vivo del destino (combo → sus opciones) y lo vuelca a la
    // caja `text`. Devuelve false: cancela el cable, solo era inspeccionar.
    const origOnConnectOutput = nodeType.prototype.onConnectOutput;
    nodeType.prototype.onConnectOutput = function (outputIndex, inputType, inputSlot, inputNode, inputIndex) {
      origOnConnectOutput?.apply(this, arguments);
      try {
        const widgetName = inputSlot?.widget?.name;
        const widget = widgetName
          ? inputNode?.widgets?.find((w) => w.name === widgetName)
          : null;
        let values = [];
        if (widget?.type === "combo" && Array.isArray(widget.options?.values)) {
          values = widget.options.values.map(String);
        } else if (widget?.value != null && widget.value !== "") {
          values = [String(widget.value)];
        }
        const box = textWidget(this);
        if (box && values.length) {
          box.value = values.join("\n");
          try { box.callback?.(box.value); } catch (_) { /* noop */ }
        }
      } catch (e) {
        console.error("Mika.OptionList inspect: " + e);
      }
      requestAnimationFrame(() => {
        const links = this.outputs?.[outputIndex]?.links ?? [];
        for (const id of [...links]) app.graph?.removeLink?.(id);
        this.graph?.setDirtyCanvas?.(true, true);
      });
      return false;
    };

    // Click en el botón del header: coordenadas locales del nodo,
    // sin listeners globales. Devuelve true para consumir el evento.
    const origOnMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (e, pos) {
      if (!this.flags?.collapsed) {
        const hit = hitHeaderIcon(this, pos ?? []);
        if (hit) {
          runHeaderAction(this, hit.key, (ok) => flashIcon(this, ok));
          return true;
        }
      }
      return origOnMouseDown?.apply(this, arguments);
    };

    const origOnDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = origOnDrawForeground ? origOnDrawForeground.apply(this, arguments) : undefined;
      if (!this.flags?.collapsed) {
        try { drawHeaderIcons(this, ctx); } catch (_) { /* noop */ }
      }
      return r;
    };

    const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_graph, options) {
      const r = origGetExtraMenuOptions ? origGetExtraMenuOptions.apply(this, arguments) : undefined;
      if (Array.isArray(options)) {
        options.push(null);
        for (const icon of ICONS) {
          options.push({ content: icon.title, callback: () => runHeaderAction(this, icon.key, (ok) => flashIcon(this, ok)) });
        }
      }
      return r;
    };
  },
});
