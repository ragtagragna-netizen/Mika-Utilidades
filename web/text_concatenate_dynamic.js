import { app } from "/scripts/app.js";

const DEFAULT_VISIBLE = 3;
const MAX_SLOTS = 30;

app.registerExtension({
  name: "Comfy.TextConcatenateDynamic",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "TextConcatenateDynamic") return;

    function resize(node) {
      const size = node.computeSize();
      node.setSize([node.size[0], size[1]]);
      node.setDirtyCanvas(true, true);
    }

    function sortPool(node) {
      node.hiddenTextSlots.sort((a, b) => a.index - b.index);
    }

    function anchorIndex(node) {
      const sepIdx = node.widgets.indexOf(node.separatorWidget);
      if (sepIdx !== -1) return sepIdx;
      const btnIdx = node.widgets.indexOf(node.addButtonWidget);
      return btnIdx === -1 ? node.widgets.length : btnIdx;
    }

    function showNext(node) {
      sortPool(node);
      const slot = node.hiddenTextSlots.shift();
      if (!slot) return null;
      
      const insertIdx = anchorIndex(node);
      node.widgets.splice(insertIdx, 0, slot.widget);
      node.visibleTextSlots.push(slot);
      
      // Forzar recálculo inmediato después de modificar widgets
      const size = node.computeSize();
      node.setSize([node.size[0], size[1]]);
      
      return slot;
    }

    function hideLast(node) {
      if (node.visibleTextSlots.length <= 1) return;
      const slot = node.visibleTextSlots.pop();
      const idx = node.widgets.indexOf(slot.widget);
      if (idx !== -1) node.widgets.splice(idx, 1);
      slot.widget.value = "";
      node.hiddenTextSlots.push(slot);
      
      // Forzar recálculo inmediato después de modificar widgets
      const size = node.computeSize();
      node.setSize([node.size[0], size[1]]);
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      this.separatorWidget = this.widgets.find((w) => w.name === "separator") ?? null;

      const textWidgets = this.widgets.filter((w) => w.name.startsWith("text_"));
      const slots = textWidgets
        .map((widget) => {
          const index = parseInt(widget.name.split("_")[1], 10);
          return { index, widget };
        })
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
        resize(this);
      });

      this.removeButtonWidget = this.addWidget("button", "− Quitar texto", null, () => {
        hideLast(this);
        resize(this);
      });

      // Forzar recálculo inicial
      resize(this);
      
      return r;
    };

    const onSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (o) {
      const r = onSerialize ? onSerialize.apply(this, arguments) : undefined;
      o.visibleTextCount = this.visibleTextSlots.length;
      const vals = {};
      for (const slot of this.visibleTextSlots) {
        vals[`text_${slot.index}`] = slot.widget.value;
      }
      o.mikaTextValues = vals;
      if (this.separatorWidget) o.mikaSeparator = this.separatorWidget.value;
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;

      const target = info.visibleTextCount ?? DEFAULT_VISIBLE;
      while (this.visibleTextSlots.length < target && this.hiddenTextSlots.length > 0) {
        showNext(this);
      }
      while (this.visibleTextSlots.length > target && this.visibleTextSlots.length > 1) {
        hideLast(this);
      }

      const sv = info.widgets_values || [];

      if (info.mikaTextValues) {
        for (const slot of this.visibleTextSlots) {
          if (`text_${slot.index}` in info.mikaTextValues) {
            slot.widget.value = info.mikaTextValues[`text_${slot.index}`];
          }
        }
        if (this.separatorWidget && info.mikaSeparator !== undefined) {
          this.separatorWidget.value = info.mikaSeparator;
        }
      } else if (sv.length) {
        for (let i = 0; i < this.widgets.length && i < sv.length; i++) {
          this.widgets[i].value = sv[i];
        }
      }

      resize(this);
      return r;
    };
  },
});