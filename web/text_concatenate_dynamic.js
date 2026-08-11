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

    function isTextSlotWidget(widget) {
      return (
        widget &&
        widget.name &&
        /^text_\d+$/.test(widget.name)
      );
    }

    function getTextSlots(node) {
      if (!Array.isArray(node.widgets)) return [];

      return node.widgets
        .filter((w) => isTextSlotWidget(w))
        .map((widget) => ({
          index: parseInt(widget.name.split("_")[1], 10),
          widget,
        }))
        .filter((slot) => !Number.isNaN(slot.index))
        .sort((a, b) => a.index - b.index);
    }

    function hasBackendCount(node) {
      const hasWidget =
        Array.isArray(node.widgets) &&
        node.widgets.some((w) => w && w.name === "text_count");

      const hasInput =
        Array.isArray(node.inputs) &&
        node.inputs.some((inp) => inp && inp.name === "text_count");

      return hasWidget || hasInput;
    }

    function getCountWidget(node) {
      if (!Array.isArray(node.widgets)) return null;

      return (
        node.widgets.find((w) => w && w.name === "text_count") ??
        node.widgets.find((w) => w && w.name === "visible_count") ??
        null
      );
    }

    function ensureCountWidget(node) {
      let countWidget = getCountWidget(node);

      if (!countWidget) {
        countWidget = node.addWidget(
          "number",
          "visible_count",
          DEFAULT_VISIBLE,
          null,
          {
            min: 1,
            max: MAX_SLOTS,
            step: 1,
          }
        );
      }

      countWidget.label = countWidget.name;

      countWidget.options = Object.assign(
        {},
        countWidget.options,
        {
          min: 1,
          max: MAX_SLOTS,
          step: 1,
        }
      );

      return countWidget;
    }

    function setVisibleCount(node, target, syncWidget = true) {
      target = clampCount(target);

      const slots = getTextSlots(node);

      // Si el backend no tiene text_count, limpiamos los slots ocultos
      // para que el backend original no los concatene.
      const clearHidden = !hasBackendCount(node);

      for (const slot of slots) {
        const visible = slot.index <= target;

        slot.widget.hidden = !visible;

        if (!visible && clearHidden) {
          slot.widget.value = "";
        }
      }

      if (syncWidget) {
        const countWidget = getCountWidget(node);

        if (countWidget) {
          node._mikaCountChanging = true;

          try {
            if (countWidget.value !== target) {
              countWidget.value = target;
            }
          } finally {
            node._mikaCountChanging = false;
          }
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

      const countWidget = ensureCountWidget(this);

      const oldCallback = countWidget.callback;

      this._mikaCountChanging = false;

      countWidget.callback = (value) => {
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

          if (countWidget.value !== count) {
            countWidget.value = count;
          }

          setVisibleCount(this, count, false);
        } finally {
          this._mikaCountChanging = false;
        }
      };

      const initial = clampCount(countWidget.value ?? DEFAULT_VISIBLE);

      setVisibleCount(this, initial, true);

      return r;
    };

    const onSerialize = nodeType.prototype.onSerialize;

    nodeType.prototype.onSerialize = function (o) {
      const r = onSerialize
        ? onSerialize.apply(this, arguments)
        : undefined;

      const countWidget = getCountWidget(this);
      const slots = getTextSlots(this);

      let count = DEFAULT_VISIBLE;

      if (countWidget) {
        count = clampCount(countWidget.value);
      } else {
        const visibleCount = slots.filter(
          (slot) => !slot.widget.hidden
        ).length;

        count = clampCount(visibleCount || DEFAULT_VISIBLE);
      }

      o.visibleTextCount = count;
      o.mikaVisibleCount = count;
      o.text_count = count;

      const vals = {};

      for (const slot of slots) {
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

      this.separatorWidget =
        this.widgets.find((w) => w.name === "separator") ?? null;

      const countWidget = ensureCountWidget(this);

      // Restaurar valores guardados antes de aplicar visibilidad.
      if (info.mikaTextValues) {
        const slots = getTextSlots(this);

        for (const slot of slots) {
          const key = `text_${slot.index}`;

          if (key in info.mikaTextValues) {
            slot.widget.value = info.mikaTextValues[key];
          }
        }

        if (
          this.separatorWidget &&
          info.mikaSeparator !== undefined
        ) {
          this.separatorWidget.value = info.mikaSeparator;
        }
      } else if (
        Array.isArray(info.widgets_values) &&
        info.widgets_values.length === this.widgets.length
      ) {
        // Solo usar widgets_values si coincide exactamente con la cantidad
        // actual de widgets; evita desfases con versiones viejas con botones.
        for (
          let i = 0;
          i < this.widgets.length && i < info.widgets_values.length;
          i++
        ) {
          this.widgets[i].value = info.widgets_values[i];
        }
      }

      const target = clampCount(
        info.text_count ??
          info.mikaVisibleCount ??
          info.visibleTextCount ??
          countWidget.value ??
          DEFAULT_VISIBLE
      );

      this._mikaCountChanging = true;

      try {
        if (countWidget.value !== target) {
          countWidget.value = target;
        }
      } finally {
        this._mikaCountChanging = false;
      }

      setVisibleCount(this, target, false);

      // Refuerzo para subgrafos / cambio de pestaña.
      setTimeout(() => {
        try {
          setVisibleCount(this, target, false);
        } catch (e) {
          /* no-op */
        }
      }, 0);

      return r;
    };
  },
});