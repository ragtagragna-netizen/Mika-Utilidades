import { app } from "/scripts/app.js";

const DEFAULT_VISIBLE = 3;
const MAX_SLOTS = 30;

app.registerExtension({
  name: "Comfy.TextSlotMika",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "TextSlotMika") return;

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

    function isTextoName(name) {
      return !!name && /^texto_\d+$/.test(name);
    }

    function isValorName(name) {
      return !!name && /^valor_\d+$/.test(name);
    }

    // Cada parte tiene un widget `texto_i` (solo caja de texto) y un widget
    // `valor_i` que además lleva un socket atado. En frontends nuevos los
    // forceInput no generan widgets ocultos: miramos widgets e inputs por
    // separado, y juntamos todo por índice.
    function getSlotInfo(node) {
      const textos = new Map();
      const valores = new Map();
      const inputs = new Map();

      if (Array.isArray(node.widgets)) {
        for (const w of node.widgets) {
          if (!w) continue;
          if (isTextoName(w.name)) textos.set(w.name, w);
          else if (isValorName(w.name)) valores.set(w.name, w);
        }
      }

      if (Array.isArray(node.inputs)) {
        for (const inp of node.inputs) {
          if (inp && isValorName(inp.name)) inputs.set(inp.name, inp);
        }
      }

      const indices = new Set();

      for (const name of [...textos.keys(), ...valores.keys(), ...inputs.keys()]) {
        const index = parseInt(name.split("_")[1], 10);

        if (!Number.isNaN(index)) indices.add(index);
      }

      return [...indices].sort((a, b) => a - b).map((index) => ({
        index,
        textoWidget: textos.get(`texto_${index}`) ?? null,
        valorWidget: valores.get(`valor_${index}`) ?? null,
        valorInput: inputs.get(`valor_${index}`) ?? null,
      }));
    }

    function syncInputs(node, target, extraVisible) {
      if (!Array.isArray(node.inputs)) node.inputs = [];

      const slots = new Map(
        getSlotInfo(node).map((slot) => [slot.index, slot])
      );

      for (let n = 1; n <= MAX_SLOTS; n++) {
        const name = `valor_${n}`;
        const slot = slots.get(n) ?? {
          index: n,
          textoWidget: null,
          valorWidget: null,
          valorInput: null,
        };

        // Un socket con link nunca se elimina: queda visible para no perder
        // la conexión aunque el conteo sea menor.
        const hasLink =
          (!!slot.valorInput && slot.valorInput.link != null) ||
          (!!extraVisible && extraVisible.has(name));
        const visible = n <= target || hasLink;

        if (slot.textoWidget) {
          slot.textoWidget.hidden = !visible;
        }

        if (slot.valorWidget) {
          slot.valorWidget.hidden = !visible;
        }

        if (visible) {
          if (!slot.valorInput) {
            // El socket comparte el widget de `valor_i`: escribir o linkear.
            const config = slot.valorWidget
              ? { widget: { name } }
              : {};

            node.addInput(name, "STRING", config);
          }
        } else if (slot.valorInput) {
          const i = node.inputs.indexOf(slot.valorInput);

          if (i !== -1) {
            node.removeInput(i);
          }
        }
      }
    }

    function hasBackendCount(node) {
      return (
        Array.isArray(node.widgets) &&
        node.widgets.some((w) => w && w.name === "part_count")
      );
    }

    function getCountWidget(node) {
      if (!Array.isArray(node.widgets)) return null;

      return (
        node.widgets.find((w) => w && w.name === "part_count") ?? null
      );
    }

    function ensureCountWidget(node) {
      let countWidget = getCountWidget(node);

      if (!countWidget) {
        countWidget = node.addWidget(
          "number",
          "part_count",
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

      // Si el backend no tuviera part_count, limpiamos los valores ocultos
      // para no arrastrarlos. Con part_count el backend solo usa 1..count.
      const clearHidden = !hasBackendCount(node);

      for (const slot of getSlotInfo(node)) {
        if (clearHidden && slot.index > target) {
          const unlinkedValor =
            !slot.valorInput || slot.valorInput.link == null;

          if (slot.textoWidget && unlinkedValor) slot.textoWidget.value = "";
          if (slot.valorWidget && unlinkedValor) slot.valorWidget.value = "";
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
      // configure() restaure los links del workflow.
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
          (slot) =>
            (!slot.textoWidget || !slot.textoWidget.hidden) ||
            (!slot.valorWidget || !slot.valorWidget.hidden)
        ).length;

        count = clampCount(visibleCount || DEFAULT_VISIBLE);
      }

      o.mikaSlotCount = count;
      o.text_count = count;

      const vals = {};

      for (const slot of slots) {
        if (slot.textoWidget) vals[`texto_${slot.index}`] = slot.textoWidget.value;
        if (slot.valorWidget) vals[`valor_${slot.index}`] = slot.valorWidget.value;
      }

      o.mikaSlotValues = vals;

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
      const savedValues = info.mikaSlotValues;

      if (savedValues) {
        for (const slot of getSlotInfo(this)) {
          const textoKey = `texto_${slot.index}`;
          const valorKey = `valor_${slot.index}`;

          if (slot.textoWidget && textoKey in savedValues) {
            slot.textoWidget.value = savedValues[textoKey];
          }

          if (slot.valorWidget && valorKey in savedValues) {
            slot.valorWidget.value = savedValues[valorKey];
          }
        }

        if (this.separatorWidget && info.mikaSeparator !== undefined) {
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
        info.mikaSlotCount ??
          info.text_count ??
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

      // Los links se reconectan después de configure(); se miran los ids
      // serializados en info.inputs para no eliminar sockets cuyo link aún
      // no ha sido re-adjuntado al nodo.
      const linkedNames = new Set();

      if (Array.isArray(info.inputs)) {
        for (const inp of info.inputs) {
          if (
            inp &&
            isValorName(inp.name) &&
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
