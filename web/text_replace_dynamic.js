import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const DEFAULT_VISIBLE = 3;
const MAX_PAIRS = 30;

let listenerRegistered = false;

app.registerExtension({
  name: "Comfy.TextReplaceDynamic",

  async setup() {
    if (listenerRegistered) return;
    listenerRegistered = true;

    try {
      api.addEventListener("mika-text-replace-count", (event) => {
        const data = event.detail;

        if (!data || !data.id) return;

        let node = app.graph.getNodeById(data.id);

        if (!node && !Number.isNaN(Number(data.id))) {
          node = app.graph.getNodeById(Number(data.id));
        }

        if (!node || typeof node._mikaSetPairCount !== "function") return;

        node._mikaSetPairCount(data.count);
      });
    } catch (e) {
      console.warn(
        "TextReplaceDynamic: no se pudo registrar el listener de websocket.",
        e
      );
    }
  },

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "TextReplaceDynamic") return;

    function clampCount(value) {
      if (Array.isArray(value)) {
        value = value.length ? value[0] : DEFAULT_VISIBLE;
      }

      let n = parseInt(value, 10);

      if (Number.isNaN(n)) {
        n = DEFAULT_VISIBLE;
      }

      return Math.max(1, Math.min(MAX_PAIRS, n));
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
      node.hiddenReplacePairs.sort((a, b) => a.index - b.index);
    }

    function anchorIndex(node) {
      if (node.visibleReplacePairs.length) {
        const last =
          node.visibleReplacePairs[node.visibleReplacePairs.length - 1].replace;

        const idx = node.widgets.indexOf(last);

        if (idx !== -1) return idx + 1;
      }

      const regexIdx = node.widgets.indexOf(node.useRegexWidget);

      if (regexIdx !== -1) return regexIdx;

      const countIdx = node.widgets.indexOf(node.pairCountWidget);

      if (countIdx !== -1) return countIdx;

      return node.widgets.length;
    }

    function setVisibleCount(node, target, syncWidget = true) {
      target = clampCount(target);

      sortPool(node);

      while (
        node.visibleReplacePairs.length < target &&
        node.hiddenReplacePairs.length > 0
      ) {
        const pair = node.hiddenReplacePairs.shift();

        node.widgets.splice(anchorIndex(node), 0, pair.find, pair.replace);
        node.visibleReplacePairs.push(pair);
      }

      while (
        node.visibleReplacePairs.length > target &&
        node.visibleReplacePairs.length > 1
      ) {
        const pair = node.visibleReplacePairs.pop();

        for (const w of [pair.find, pair.replace]) {
          const idx = node.widgets.indexOf(w);

          if (idx !== -1) {
            node.widgets.splice(idx, 1);
          }
        }

        node.hiddenReplacePairs.push(pair);
      }

      sortPool(node);

      if (syncWidget && node.pairCountWidget) {
        node.pairCountWidget.value = node.visibleReplacePairs.length;
      }

      pruneWidgetInputs(node);

      relayout(node);
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;

    // Sincroniza slots con widgets presentes: los pares ocultos (sacados
    // de node.widgets) conservarían slots fantasma apilados junto al
    // header que aceptan conexiones por error. Queda "text" (forceInput,
    // sin widget) + un slot por widget visible.
    function pruneWidgetInputs(node) {
      if (!Array.isArray(node.inputs)) node.inputs = [];
      const present = new Set((node.widgets || []).map((w) => w && w.name));
      for (let i = node.inputs.length - 1; i >= 0; i--) {
        const inp = node.inputs[i];
        if (!inp || inp.name === "text") continue;
        if (inp.widget && !present.has(inp.name)) {
          node.removeInput(i);
        }
      }
      // Al mostrar de nuevo un par, su widget vuelve a node.widgets sin
      // slot: se reintroduce para que siga siendo linkeable.
      for (const w of node.widgets || []) {
        if (!w || !w.name || w.name === "pair_count") continue;
        if (node.inputs.some((i) => i && i.name === w.name)) continue;
        const type = w.type === "toggle" ? "BOOLEAN" : "STRING";
        node.addInput(w.name, type, { widget: { name: w.name } });
      }
    }

    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated
        ? onNodeCreated.apply(this, arguments)
        : undefined;

      this.useRegexWidget =
        this.widgets.find((w) => w.name === "use_regex") ?? null;

      this.pairCountWidget =
        this.widgets.find((w) => w.name === "pair_count") ?? null;

      if (!this.pairCountWidget) {
        this.pairCountWidget = this.addWidget(
          "number",
          "pair_count",
          DEFAULT_VISIBLE,
          null,
          {
            min: 1,
            max: MAX_PAIRS,
            step: 1,
          }
        );
      }

      this.pairCountWidget.label = "pair_count";

      this.pairCountWidget.options = Object.assign(
        {},
        this.pairCountWidget.options,
        {
          min: 1,
          max: MAX_PAIRS,
          step: 1,
        }
      );

      const findWidgets = this.widgets.filter(
        (w) => w.name && /^find_\d+$/.test(w.name)
      );

      const pairs = findWidgets
        .map((findWidget) => {
          const index = parseInt(findWidget.name.split("_")[1], 10);

          const replaceWidget = this.widgets.find(
            (w) => w.name === `replace_${index}`
          );

          return replaceWidget
            ? {
                index,
                find: findWidget,
                replace: replaceWidget,
              }
            : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index);

      const initial = clampCount(
        this.pairCountWidget.value ?? DEFAULT_VISIBLE
      );

      this.visibleReplacePairs = pairs.slice(0, initial);
      this.hiddenReplacePairs = pairs.slice(initial);

      for (const pair of this.hiddenReplacePairs) {
        for (const w of [pair.find, pair.replace]) {
          const idx = this.widgets.indexOf(w);

          if (idx !== -1) {
            this.widgets.splice(idx, 1);
          }
        }
      }

      const oldCallback = this.pairCountWidget.callback;

      this._mikaPairChanging = false;

      this.pairCountWidget.callback = (value) => {
        if (oldCallback) {
          try {
            oldCallback(value);
          } catch (e) {
            /* no-op */
          }
        }

        if (this._mikaPairChanging) return;

        this._mikaPairChanging = true;

        try {
          const count = clampCount(value);

          if (this.pairCountWidget.value !== count) {
            this.pairCountWidget.value = count;
          }

          setVisibleCount(this, count, false);
        } finally {
          this._mikaPairChanging = false;
        }
      };

      nodeType.prototype._mikaSetPairCount = function (count) {
        const c = clampCount(count);

        this._mikaPairChanging = true;

        try {
          if (this.pairCountWidget && this.pairCountWidget.value !== c) {
            this.pairCountWidget.value = c;
          }

          setVisibleCount(this, c, false);
        } finally {
          this._mikaPairChanging = false;
        }
      };

      pruneWidgetInputs(this);

      setVisibleCount(this, initial, true);

      return r;
    };

    const onSerialize = nodeType.prototype.onSerialize;

    nodeType.prototype.onSerialize = function (o) {
      const r = onSerialize
        ? onSerialize.apply(this, arguments)
        : undefined;

      sortPool(this);

      const count = this.pairCountWidget
        ? clampCount(this.pairCountWidget.value)
        : this.visibleReplacePairs.length;

      o.pair_count = count;
      o.visibleReplaceCount = count;

      const vals = {};

      const allPairs = [
        ...this.visibleReplacePairs,
        ...this.hiddenReplacePairs,
      ];

      for (const pair of allPairs) {
        vals[`find_${pair.index}`] = pair.find.value;
        vals[`replace_${pair.index}`] = pair.replace.value;
      }

      o.mikaReplaceValues = vals;

      if (this.useRegexWidget) {
        o.mikaUseRegex = this.useRegexWidget.value;
      }

      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;

    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure
        ? onConfigure.apply(this, arguments)
        : undefined;

      if (info.mikaReplaceValues) {
        const allPairs = [
          ...this.visibleReplacePairs,
          ...this.hiddenReplacePairs,
        ];

        for (const pair of allPairs) {
          const findKey = `find_${pair.index}`;
          const replaceKey = `replace_${pair.index}`;

          if (findKey in info.mikaReplaceValues) {
            pair.find.value = info.mikaReplaceValues[findKey];
          }

          if (replaceKey in info.mikaReplaceValues) {
            pair.replace.value = info.mikaReplaceValues[replaceKey];
          }
        }

        if (
          this.useRegexWidget &&
          info.mikaUseRegex !== undefined
        ) {
          this.useRegexWidget.value = info.mikaUseRegex;
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

      // Los workflows guardados re-crean los slots fantasma; se podan
      // de nuevo (los enlaces que apuntaban a un slot fantasma se sueltan).
      pruneWidgetInputs(this);

      const target =
        info.pair_count ??
        info.visibleReplaceCount ??
        this.pairCountWidget?.value ??
        DEFAULT_VISIBLE;

      setVisibleCount(this, target, true);

      return r;
    };
  },
});