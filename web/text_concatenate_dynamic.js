import { app } from "/scripts/app.js";

const DEFAULT_VISIBLE = 3;
const MAX_SLOTS = 30;

app.registerExtension({
  name: "Comfy.TextConcatenateDynamic",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "TextConcatenateDynamic") return;

    // FIX: refresco agresivo del grafo. Con el nodo ya dibujado, solo
    // computeSize/setSize NO reposiciona los sockets de entrada.
    // graph.change() + canvas.setDirty() fuerzan el recálculo de sockets
    // en vivo (por eso al duplicar funcionaba: el primer draw los calculaba).
    function relayout(node) {
      try {
        const size = node.computeSize();
        node.setSize([node.size[0], size[1]]);
      } catch (e) { /* no-op */ }
      try { if (typeof node.onResize === "function") node.onResize(node.size); } catch (e) { /* no-op */ }
      try { node.setDirtyCanvas(true, true); } catch (e) { /* no-op */ }
      try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) { /* no-op */ }
      try { app.canvas?.setDirty?.(true, true); } catch (e) { /* no-op */ }
      try { node.graph?.change?.(); } catch (e) { /* no-op */ }
    }

    function sortPool(node) {
      node.hiddenTextSlots.sort((a, b) => a.index - b.index);
    }

    // FIX: insertar justo después del último texto visible (mantiene los
    // textos contiguos y el separator al final), evitando desfases de sockets.
    function anchorIndex(node) {
      if (node.visibleTextSlots.length) {
        const last = node.visibleTextSlots[node.visibleTextSlots.length - 1].widget;
        const idx = node.widgets.indexOf(last);
        if (idx !== -1) return idx + 1;
      }
      const sepIdx = node.widgets.indexOf(node.separatorWidget);
      if (sepIdx !== -1) return sepIdx;
      return node.widgets.length;
    }

    function showNext(node) {
      sortPool(node);
      const slot = node.hiddenTextSlots.shift();
      if (!slot) return null;
      node.widgets.splice(anchorIndex(node), 0, slot.widget);
      node.visibleTextSlots.push(slot);
      relayout(node);
      return slot;
    }

    function hideLast(node) {
      if (node.visibleTextSlots.length <= 1) return;
      const slot = node.visibleTextSlots.pop();
      const idx = node.widgets.indexOf(slot.widget);
      if (idx !== -1) node.widgets.splice(idx, 1);
      slot.widget.value = "";
      node.hiddenTextSlots.push(slot);
      relayout(node);
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      this.separatorWidget = this.widgets.find((w) => w.name === "separator") ?? null;

      const textWidgets = this.widgets.filter((w) => w.name.startsWith("text_"));
      const slots = textWidgets
        .map((widget) => ({ index: parseInt(widget.name.split("_")[1], 10), widget }))
        .sort((a, b) => a.index - b.index);

      this.visibleTextSlots = slots.slice(0, DEFAULT_VISIBLE);
      this.hiddenTextSlots = slots.slice(DEFAULT_VISIBLE);

      for (const slot of this.hiddenTextSlots) {
        const idx = this.widgets.indexOf(slot.widget);
        if (idx !== -1) this.widgets.splice(idx, 1);
      }

      this.addButtonWidget = this.addWidget("button", "+ Agregar texto", null, () => {
        if (this.visibleTextSlots.length >= MAX_SLOTS) return;
        showNext(this);
      });

      this.removeButtonWidget = this.addWidget("button", "− Quitar texto", null, () => {
        hideLast(this);
      });

      relayout(this);
      return r;
    };

    const onSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (o) {
      const r = onSerialize ? onSerialize.apply(this, arguments) : undefined;
      o.visibleTextCount = this.visibleTextSlots.length;
      const vals = {};
      for (const slot of this.visibleTextSlots) vals[`text_${slot.index}`] = slot.widget.value;
      o.mikaTextValues = vals;
      if (this.separatorWidget) o.mikaSeparator = this.separatorWidget.value;
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;

      const target = info.visibleTextCount ?? DEFAULT_VISIBLE;
      while (this.visibleTextSlots.length < target && this.hiddenTextSlots.length > 0) showNext(this);
      while (this.visibleTextSlots.length > target && this.visibleTextSlots.length > 1) hideLast(this);

      if (info.mikaTextValues) {
        for (const slot of this.visibleTextSlots) {
          if (`text_${slot.index}` in info.mikaTextValues) slot.widget.value = info.mikaTextValues[`text_${slot.index}`];
        }
        if (this.separatorWidget && info.mikaSeparator !== undefined) this.separatorWidget.value = info.mikaSeparator;
      } else {
        const sv = info.widgets_values || [];
        for (let i = 0; i < this.widgets.length && i < sv.length; i++) this.widgets[i].value = sv[i];
      }

      relayout(this);
      return r;
    };
  },
});