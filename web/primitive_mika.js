import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Primitive-Mika
// -----------------------------------------------------------------------
// Nodo primitivo genérico: al conectarlo a un slot widget de otro nodo,
// REEMPLAZA su widget "value" por una copia del widget destino (si es un
// combo muestra sus opciones, si es número usa sus min/max/step).
// No agrega controles de seed (fixed/randomize).
// -----------------------------------------------------------------------

function getTargetWidget(node) {
  const linkId = node.outputs?.[0]?.links?.[0];
  const links = app.graph?.links;
  const link = linkId != null ? (links?.get?.(linkId) ?? links?.[linkId] ?? null) : null;
  if (!link) return null;

  const targetNode = app.graph.getNodeById(link.target_id);
  const input = targetNode?.inputs?.[link.target_slot];
  const widgetName = input?.widget?.name;
  if (!targetNode || !widgetName) return null;

  const widget = targetNode.widgets?.find((w) => w.name === widgetName);
  return widget ?? null;
}

function replaceValueWidget(node, targetWidget) {
  const idx = node.widgets?.findIndex((w) => w.name === "value") ?? -1;
  if (idx < 0) return;

  const old = node.widgets[idx];
  const callback = old.callback ?? function () {};

  node.widgets.splice(idx, 1);

  if (targetWidget?.type === "combo" && Array.isArray(targetWidget.options?.values)) {
    const values = targetWidget.options.values;
    node.widgets.splice(idx, 0, node.addWidget(
      "combo",
      "value",
      values.includes(old.value) ? old.value : values[0],
      callback,
      { values }
    ) || node.widgets[idx]);
  } else if (targetWidget?.type === "number" || targetWidget?.type === "slider") {
    const o = targetWidget.options ?? {};
    node.widgets.splice(idx, 0, node.addWidget(
      targetWidget.type,
      "value",
      Number.isFinite(+old.value) ? +old.value : (o.min ?? 0),
      callback,
      {
        min: o.min ?? 0,
        max: o.max ?? 2 ** 64,
        step: o.step ?? 1,
        precision: o.precision ?? 0,
      }
    ) || node.widgets[idx]);
  } else {
    // Sin destino válido o widget de texto: vuelve al widget original.
    const multiline = targetWidget?.type === "textarea" || targetWidget?.type === "customtext";
    node.widgets.splice(idx, 0, node.addWidget(
      multiline ? "customtext" : "text",
      "value",
      String(old.value ?? ""),
      callback,
      { multiline }
    ) || node.widgets[idx]);
  }

  // addWidget puede haber añadido al final; garantizamos un único "value".
  const found = [];
  for (let i = node.widgets.length - 1; i >= 0; i--) {
    if (node.widgets[i].name === "value") found.unshift(i);
  }
  if (found.length > 1) {
    for (const i of found.slice(1)) node.widgets.splice(i, 1);
  }
  const finalIdx = node.widgets.findIndex((w) => w.name === "value");
  if (finalIdx >= 0 && finalIdx !== idx) {
    const w = node.widgets.splice(finalIdx, 1)[0];
    node.widgets.splice(idx, 0, w);
  }

  node.setSize?.(node.computeSize?.() ?? node.size);
  node.graph?.setDirtyCanvas?.(true, true);
}

function syncPrimitive(node) {
  replaceValueWidget(node, getTargetWidget(node));
}

app.registerExtension({
  name: "Mika.Primitive",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PrimitiveMika") return;

    const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, index, connected, linkInfo, ioSlot) {
      origOnConnectionsChange?.apply(this, arguments);
      if (type === LiteGraph.OUTPUT && index === 0 && connected) {
        syncPrimitive(this);
      }
    };

    // Al cargar un workflow las conexiones llegan después del configure;
    // reintenta un par de veces por si el grafo aún no está listo.
    const origOnNodeConfigured = nodeType.prototype.onNodeConfigured;
    nodeType.prototype.onNodeConfigured = function () {
      origOnNodeConfigured?.apply(this, arguments);
      let tries = 0;
      const timer = setInterval(() => {
        if (this.outputs?.[0]?.links?.length || ++tries >= 5) {
          clearInterval(timer);
          if (this.outputs?.[0]?.links?.length) syncPrimitive(this);
        }
      }, 300);
    };
  },
});
