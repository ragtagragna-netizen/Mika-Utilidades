import { app } from "/scripts/app.js";

const DEFAULT_VISIBLE = 3;
const MAX_SLOTS = 30;

app.registerExtension({
  name: "Comfy.TextConcatenateDynamic",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (
      nodeData.name !== "TextConcatenateDynamic" &&
      nodeData.name !== "TextCleanOrganizeConcatMika"
    ) return;

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

    function isTextSlotName(name) {
      return !!name && /^text_\d+$/.test(name);
    }

    // En frontends nuevos los inputs forceInput ya no generan widgets
    // ocultos: existen solo como sockets. Consideramos el slot visible si su
    // widget no está oculto o si su input existe. Un input con link nunca se
    // elimina aunque el slot quede fuera del conteo visible.
    function getSlotInfo(node) {
      const widgets = new Map();
      const inputs = new Map();

      if (Array.isArray(node.widgets)) {
        for (const w of node.widgets) {
          if (w && isTextSlotName(w.name)) widgets.set(w.name, w);
        }
      }

      if (Array.isArray(node.inputs)) {
        for (const inp of node.inputs) {
          if (inp && isTextSlotName(inp.name)) inputs.set(inp.name, inp);
        }
      }

      const names = new Set([...widgets.keys(), ...inputs.keys()]);
      const slots = [];

      for (const name of names) {
        const index = parseInt(name.split("_")[1], 10);

        if (Number.isNaN(index)) continue;

        slots.push({
          index,
          name,
          widget: widgets.get(name) ?? null,
          input: inputs.get(name) ?? null,
        });
      }

      return slots.sort((a, b) => a.index - b.index);
    }

    function syncInputs(node, target, extraVisible) {
      if (!Array.isArray(node.inputs)) node.inputs = [];

      const slots = new Map(
        getSlotInfo(node).map((slot) => [slot.index, slot])
      );

      for (let n = 1; n <= MAX_SLOTS; n++) {
        const name = `text_${n}`;
        const slot = slots.get(n) ?? {
          index: n,
          name,
          widget: null,
          input: null,
        };

        // Un socket con link nunca se elimina: queda visible para no
        // perder la conexión aunque el conteo sea menor.
        const hasLink =
          (!!slot.input && slot.input.link != null) ||
          (!!extraVisible && extraVisible.has(name));
        const visible = n <= target || hasLink;

        if (slot.widget) {
          slot.widget.hidden = !visible;
        }

        if (visible) {
          if (!slot.input) {
            const config = slot.widget
              ? { widget: { name: slot.widget.name } }
              : {};

            node.addInput(name, "STRING", config);
          }
        } else if (slot.input) {
          const i = node.inputs.indexOf(slot.input);

          if (i !== -1) {
            node.removeInput(i);
          }
        }
      }
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

    function setVisibleCount(node, target, syncWidget = true, extraVisible) {
      target = clampCount(target);

      // Si el backend no tiene text_count, limpiamos los slots ocultos
      // para que el backend original no los concatene.
      const clearHidden = !hasBackendCount(node);

      for (const slot of getSlotInfo(node)) {
        if (
          clearHidden &&
          slot.widget &&
          slot.index > target &&
          (!slot.input || slot.input.link == null)
        ) {
          slot.widget.value = "";
        }
      }

      syncInputs(node, target, extraVisible);

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

      // Diferir el ajuste inicial para no eliminar sockets antes de que
      // configure() restaure los links del workflow. Se lee el valor del
      // widget en el momento de ejecutar, por si configure() ya restauró
      // el conteo guardado.
      setTimeout(() => {
        try {
          const current = getCountWidget(this);
          setVisibleCount(
            this,
            clampCount(current?.value ?? DEFAULT_VISIBLE),
            false
          );
        } catch (e) {
          /* no-op */
        }
      }, 0);

      return r;
    };

    const onSerialize = nodeType.prototype.onSerialize;

    nodeType.prototype.onSerialize = function (o) {
      const r = onSerialize
        ? onSerialize.apply(this, arguments)
        : undefined;

      const countWidget = getCountWidget(this);
      const slots = getSlotInfo(this);

      let count = DEFAULT_VISIBLE;

      if (countWidget) {
        count = clampCount(countWidget.value);
      } else {
        const visibleCount = slots.filter(
          (slot) => !slot.widget || !slot.widget.hidden
        ).length;

        count = clampCount(visibleCount || DEFAULT_VISIBLE);
      }

      o.visibleTextCount = count;
      o.mikaVisibleCount = count;
      o.text_count = count;

      const vals = {};

      for (const slot of slots) {
        if (slot.widget) {
          vals[slot.name] = slot.widget.value;
        }
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
        for (const slot of getSlotInfo(this)) {
          if (slot.widget && slot.name in info.mikaTextValues) {
            slot.widget.value = info.mikaTextValues[slot.name];
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

      // Los links del grafo se reconectan después de configure(); se miran
      // los ids serializados en info.inputs para no eliminar sockets cuyo
      // link aún no ha sido re-adjuntado al nodo.
      const linkedNames = new Set();

      if (Array.isArray(info.inputs)) {
        for (const inp of info.inputs) {
          if (
            inp &&
            isTextSlotName(inp.name) &&
            (inp.link != null ||
              (Array.isArray(inp._widgetLinkIds) &&
                inp._widgetLinkIds.length))
          ) {
            linkedNames.add(inp.name);
          }
        }
      }

      setVisibleCount(this, target, false, linkedNames);

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
