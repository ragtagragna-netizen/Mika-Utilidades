import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const DEFAULT_VISIBLE = 3;
const MAX_SLOTS = 30;

let listenerRegistered = false;

app.registerExtension({
  name: "Comfy.TextConcatenateDynamic",

  async setup() {
    if (listenerRegistered) return;
    listenerRegistered = true;

    try {
      api.addEventListener("mika-text-concat-count", (event) => {
        const data = event.detail;

        if (!data || !data.id) return;

        let node = app.graph.getNodeById(data.id);

        if (!node && !Number.isNaN(Number(data.id))) {
          node = app.graph.getNodeById(Number(data.id));
        }

        if (!node || typeof node._mikaSetTextCount !== "function") return;

        node._mikaSetTextCount(data.count);
      });
    } catch (e) {
      console.warn(
        "TextConcatenateDynamic: no se pudo registrar el listener de websocket.",
        e
      );
    }
  },

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

    function isTextInput(input) {
      return Boolean(input && /^text_\d+$/.test(input.name || ""));
    }

    function textInputIndex(node, i) {
      if (!Array.isArray(node.inputs)) return -1;

      return node.inputs.findIndex(
        (input) => input && input.name === `text_${i}`
      );
    }

    function sortTextInputs(node) {
      if (!Array.isArray(node.inputs) || node.inputs.length <= 1) return;

      const textInputs = node.inputs.filter((input) => isTextInput(input));

      if (textInputs.length <= 1) return;

      textInputs.sort((a, b) => {
        const ai = parseInt((a.name || "").split("_")[1], 10);
        const bi = parseInt((b.name || "").split("_")[1], 10);
        return ai - bi;
      });

      const firstTextIndex = node.inputs.findIndex((input) =>
        isTextInput(input)
      );

      const before = [];
      const after = [];

      node.inputs.forEach((input, idx) => {
        if (isTextInput(input)) return;

        if (firstTextIndex === -1 || idx < firstTextIndex) {
          before.push(input);
        } else {
          after.push(input);
        }
      });

      const newInputs = [...before, ...textInputs, ...after];

      node.inputs = newInputs;

      newInputs.forEach((input, slot) => {
        if (
          input &&
          input.link != null &&
          node.graph &&
          node.graph.links
        ) {
          const link = node.graph.links[input.link];

          if (link) {
            link.target_slot = slot;
          }
        }
      });
    }

    function saveInputLink(node, name) {
      if (!Array.isArray(node.inputs)) return;

      const idx = node.inputs.findIndex(
        (input) => input && input.name === name
      );

      if (idx === -1) return;

      const input = node.inputs[idx];

      if (!input || input.link == null) return;

      const link = node.graph?.links?.[input.link];

      if (!link) return;

      node._mikaSavedLinks = node._mikaSavedLinks || {};

      node._mikaSavedLinks[name] = {
        origin_id: link.origin_id,
        origin_slot: link.origin_slot,
      };
    }

    function restoreInputLink(node, name) {
      const saved = node._mikaSavedLinks?.[name];

      if (!saved) return;

      if (!Array.isArray(node.inputs)) return;

      const idx = node.inputs.findIndex(
        (input) => input && input.name === name
      );

      if (idx === -1) return;

      const input = node.inputs[idx];

      if (!input) return;

      if (input.link != null) {
        delete node._mikaSavedLinks[name];
        return;
      }

      const origin = node.graph?.getNodeById(saved.origin_id);

      if (!origin) return;

      try {
        origin.connect(saved.origin_slot, node, idx);
        delete node._mikaSavedLinks[name];
      } catch (e) {
        /* no-op */
      }
    }

    function removeLegacyTextWidgets(node) {
      if (!Array.isArray(node.widgets)) return;

      for (let i = node.widgets.length - 1; i >= 0; i--) {
        const w = node.widgets[i];

        if (w && /^text_\d+$/.test(w.name || "")) {
          node.widgets.splice(i, 1);
        }
      }
    }

    function setVisibleCount(node, target, syncWidget = true) {
      target = clampCount(target);

      if (!Array.isArray(node.inputs)) {
        node.inputs = [];
      }

      removeLegacyTextWidgets(node);

      // Quito inputs por encima del índice deseado.
      for (let i = MAX_SLOTS; i > target; i--) {
        const name = `text_${i}`;
        const idx = node.inputs.findIndex(
          (input) => input && input.name === name
        );

        if (idx !== -1) {
          saveInputLink(node, name);

          try {
            node.removeInput(idx);
          } catch (e) {
            /* no-op */
          }
        }
      }

      // Creo los inputs faltantes hasta el índice deseado.
      for (let i = 1; i <= target; i++) {
        const name = `text_${i}`;
        const idx = node.inputs.findIndex(
          (input) => input && input.name === name
        );

        if (idx === -1) {
          try {
            node.addInput(name, "STRING");
          } catch (e) {
            /* no-op */
          }
        }
      }

      sortTextInputs(node);

      // Restauro conexiones guardadas si corresponde.
      for (let i = 1; i <= target; i++) {
        restoreInputLink(node, `text_${i}`);
      }

      if (syncWidget && node.countWidget) {
        node.countWidget.value = target;
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

      const initial = clampCount(this.countWidget.value ?? DEFAULT_VISIBLE);

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

      nodeType.prototype._mikaSetTextCount = function (count) {
        const c = clampCount(count);

        this._mikaCountChanging = true;

        try {
          if (this.countWidget && this.countWidget.value !== c) {
            this.countWidget.value = c;
          }

          setVisibleCount(this, c, false);
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

      const visibleInputs = Array.isArray(this.inputs)
        ? this.inputs.filter((input) => isTextInput(input)).length
        : 0;

      const count = this.countWidget
        ? clampCount(this.countWidget.value)
        : clampCount(visibleInputs);

      o.text_count = count;
      o.visibleTextCount = count;

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

      if (this.separatorWidget && info.mikaSeparator !== undefined) {
        this.separatorWidget.value = info.mikaSeparator;
      }

      const target =
        info.text_count ??
        info.visibleTextCount ??
        this.countWidget?.value ??
        DEFAULT_VISIBLE;

      setVisibleCount(this, target, true);

      return r;
    };
  },
});