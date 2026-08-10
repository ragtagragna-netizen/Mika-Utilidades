import { app } from "/scripts/app.js";

const DEFAULT_VISIBLE = 3;
const MAX_SLOTS = 30;

app.registerExtension({
  name: "Comfy.TextConcatenateDynamic",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "TextConcatenateDynamic") return;

    function clampCount(value) {
      if (Array.isArray(value)) {
        value = value.length ? value[0] : DEFAULT_VISIBLE;
      }

      let n = parseInt(value, 10);

      if (Number.isNaN(n)) {
        n = DEFAULT_VISIBLE;
      }

      return Math.max(1, Math.min(MAX_SLOTS, n));
    }

    function relayout(node) {
      try {
        const size = node.computeSize();
        node.setSize([node.size[0], size[1]]);
      } catch (e) {
        /* no-op */
      }

      try {
        if (typeof node.onResize === "function") node.onResize(node.size);
      } catch (e) {
        /* no-op */
      }

      try {
        node.setDirtyCanvas(true, true);
      } catch (e) {
        /* no-op */
      }

      try {
        app.graph?.setDirtyCanvas?.(true, true);
      } catch (e) {
        /* no-op */
      }

      try {
        app.canvas?.setDirty?.(true, true);
      } catch (e) {
        /* no-op */
      }

      try {
        node.graph?.change?.();
      } catch (e) {
        /* no-op */
      }
    }

    function sortPool(node) {
      if (!Array.isArray(node.hiddenTextSlots)) return;
      node.hiddenTextSlots.sort((a, b) => a.index - b.index);
    }

    function anchorIndex(node) {
      if (node.visibleTextSlots.length) {
        const last =
          node.visibleTextSlots[node.visibleTextSlots.length - 1].widget;

        const idx = node.widgets.indexOf(last);

        if (idx !== -1) return idx + 1;
      }

      const sepIdx = node.widgets.indexOf(node.separatorWidget);

      if (sepIdx !== -1) return sepIdx;

      return node.widgets.length;
    }

    function setVisibleCount(node, target, syncWidget = true) {
      target = clampCount(target);

      if (!Array.isArray(node.visibleTextSlots)) node.visibleTextSlots = [];
      if (!Array.isArray(node.hiddenTextSlots)) node.hiddenTextSlots = [];

      sortPool(node);

      // Mostrar slots.
      while (
        node.visibleTextSlots.length < target &&
        node.hiddenTextSlots.length > 0
      ) {
        const slot = node.hiddenTextSlots.shift();

        node.widgets.splice(anchorIndex(node), 0, slot.widget);
        node.visibleTextSlots.push(slot);
      }

      // Ocultar slots.
      while (
        node.visibleTextSlots.length > target &&
        node.visibleTextSlots.length > 1
      ) {
        const slot = node.visibleTextSlots.pop();

        const idx = node.widgets.indexOf(slot.widget);

        if (idx !== -1) {
          node.widgets.splice(idx, 1);
        }

        node.hiddenTextSlots.push(slot);
      }

      sortPool(node);

      if (syncWidget && node.countWidget) {
        node._mikaCountChanging = true;

        try {
          if (node.countWidget.value !== target) {
            node.countWidget.value = target;
          }
        } finally {
          node._mikaCountChanging = false;
        }
      }

      relayout(node);
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;

    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated
        ? onNodeCreated.apply(this, arguments)
        : undefined;

      this.separatorWidget =
        this.widgets.find((w) => w.name === "separator") ?? null;

      this.countWidget =
        this.widgets.find((w) => w.name === "text_count") ?? null;

      if (!this.countWidget) {
        this.countWidget = this.addWidget(
          "number",
          "text_count",
          DEFAULT_VISIBLE,
          null,
          {
            min: 1,
            max: MAX_SLOTS,
            step: 1,
          }
        );
      }

      this.countWidget.label = "text_count";

      this.countWidget.options = Object.assign(
        {},
        this.countWidget.options,
        {
          min: 1,
          max: MAX_SLOTS,
          step: 1,
        }
      );

      const textWidgets = this.widgets.filter(
        (w) => w.name && /^text_\d+$/.test(w.name)
      );

      const slots = textWidgets
        .map((widget) => ({
          index: parseInt(widget.name.split("_")[1], 10),
          widget,
        }))
        .filter((slot) => !Number.isNaN(slot.index))
        .sort((a, b) => a.index - b.index);

      const initial = clampCount(
        this.countWidget ? this.countWidget.value : DEFAULT_VISIBLE
      );

      this.visibleTextSlots = slots.slice(0, initial);
      this.hiddenTextSlots = slots.slice(initial);

      for (const slot of this.hiddenTextSlots) {
        const idx = this.widgets.indexOf(slot.widget);

        if (idx !== -1) {
          this.widgets.splice(idx, 1);
        }
      }

      const oldCallback = this.countWidget.callback;

      this._mikaCountChanging = false;

      this.countWidget.callback = (value) => {
        if (oldCallback) {
          try {
            oldCallback(value);
          } catch (e) {
            /* no-op */
          }
        }

        if (this._mikaCountChanging) return;

        this._mikaCountChanging = true;

        try {
          const count = clampCount(value);

          if (this.countWidget.value !== count) {
            this.countWidget.value = count;
          }

          setVisibleCount(this, count, false);
        } finally {
          this._mikaCountChanging = false;
        }
      };

      setVisibleCount(this, initial, true);

      return r;
    };

    const onSerialize = nodeType.prototype.onSerialize;

    nodeType.prototype.onSerialize = function (o) {
      const r = onSerialize
        ? onSerialize.apply(this, arguments)
        : undefined;

      const count = this.countWidget
        ? clampCount(this.countWidget.value)
        : this.visibleTextSlots.length;

      o.text_count = count;
      o.visibleTextCount = count;

      const vals = {};

      const allSlots = [...this.visibleTextSlots, ...this.hiddenTextSlots];

      for (const slot of allSlots) {
        vals[`text_${slot.index}`] = slot.widget.value;
      }

      o.mikaTextValues = vals;

      if (this.separatorWidget) {
        o.mikaSeparator = this.separatorWidget.value;
      }

      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;

    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure
        ? onConfigure.apply(this, arguments)
        : undefined;

      const allSlots = [...this.visibleTextSlots, ...this.hiddenTextSlots];

      if (info.mikaTextValues) {
        for (const slot of allSlots) {
          const key = `text_${slot.index}`;
          const oldKey = `text_${slot.index}_text`;

          if (key in info.mikaTextValues) {
            slot.widget.value = info.mikaTextValues[key];
          } else if (oldKey in info.mikaTextValues) {
            slot.widget.value = info.mikaTextValues[oldKey];
          }
        }

        if (
          this.separatorWidget &&
          info.mikaSeparator !== undefined
        ) {
          this.separatorWidget.value = info.mikaSeparator;
        }
      } else {
        const sv = info.widgets_values || [];

        for (
          let i = 0;
          i < this.widgets.length && i < sv.length;
          i++
        ) {
          this.widgets[i].value = sv[i];
        }
      }

      const target =
        info.text_count ??
        info.visibleTextCount ??
        (this.countWidget ? this.countWidget.value : DEFAULT_VISIBLE);

      setVisibleCount(this, target, true);

      setTimeout(() => {
        try {
          setVisibleCount(this, target, true);
        } catch (e) {
          /* no-op */
        }
      }, 0);

      return r;
    };
  },
});