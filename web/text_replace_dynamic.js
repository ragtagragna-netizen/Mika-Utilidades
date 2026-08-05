import { app } from "/scripts/app.js";

const DEFAULT_VISIBLE = 3;

app.registerExtension({
  name: "Comfy.TextReplaceDynamic",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "TextReplaceDynamic") return;

    function resize(node) {
      const size = node.computeSize();
      node.setSize([node.size[0], size[1]]);
      node.setDirtyCanvas(true, true);
    }

    function sortPool(node) {
      node.hiddenReplacePairs.sort((a, b) => a.index - b.index);
    }

    // FIX: los pares nuevos se insertan ANTES de use_regex, así el
    // checkbox queda siempre al final de los pares visibles y se
    // mueve con los botones +/-.
    function anchorIndex(node) {
      const regexIdx = node.widgets.indexOf(node.useRegexWidget);
      if (regexIdx !== -1) return regexIdx;
      const btnIdx = node.widgets.indexOf(node.addButtonWidget);
      return btnIdx === -1 ? node.widgets.length : btnIdx;
    }

    function showNext(node) {
      sortPool(node);
      const pair = node.hiddenReplacePairs.shift();
      if (!pair) return null;
      node.widgets.splice(anchorIndex(node), 0, pair.find, pair.replace);
      node.visibleReplacePairs.push(pair);
      return pair;
    }

    function hideLast(node) {
      if (node.visibleReplacePairs.length <= 1) return;
      const pair = node.visibleReplacePairs.pop();
      for (const w of [pair.find, pair.replace]) {
        const idx = node.widgets.indexOf(w);
        if (idx !== -1) node.widgets.splice(idx, 1);
      }
      pair.find.value = "";
      pair.replace.value = "";
      node.hiddenReplacePairs.push(pair);
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      this.useRegexWidget = this.widgets.find((w) => w.name === "use_regex") ?? null;

      const findWidgets = this.widgets.filter((w) => w.name.startsWith("find_"));
      const pairs = findWidgets
        .map((findWidget) => {
          const index = parseInt(findWidget.name.split("_")[1], 10);
          const replaceWidget = this.widgets.find((w) => w.name === `replace_${index}`);
          return replaceWidget ? { index, find: findWidget, replace: replaceWidget } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index);

      this.visibleReplacePairs = pairs.slice(0, DEFAULT_VISIBLE);
      this.hiddenReplacePairs = pairs.slice(DEFAULT_VISIBLE);

      for (const pair of this.hiddenReplacePairs) {
        for (const w of [pair.find, pair.replace]) {
          const idx = this.widgets.indexOf(w);
          if (idx !== -1) this.widgets.splice(idx, 1);
        }
      }

      this.addButtonWidget = this.addWidget("button", "+ Agregar reemplazo", null, () => {
        showNext(this);
        resize(this);
      });

      this.removeButtonWidget = this.addWidget("button", "− Quitar reemplazo", null, () => {
        hideLast(this);
        resize(this);
      });

      resize(this);
      return r;
    };

    const onSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (o) {
      const r = onSerialize ? onSerialize.apply(this, arguments) : undefined;
      o.visibleReplaceCount = this.visibleReplacePairs.length;
      // Guardado por nombre: red de seguridad para que los valores no
      // se desordenen al recargar (independiente del orden de widgets).
      const vals = {};
      for (const pair of this.visibleReplacePairs) {
        vals[`find_${pair.index}`] = pair.find.value;
        vals[`replace_${pair.index}`] = pair.replace.value;
      }
      o.mikaReplaceValues = vals;
      if (this.useRegexWidget) o.mikaUseRegex = this.useRegexWidget.value;
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;

      const target = info.visibleReplaceCount ?? DEFAULT_VISIBLE;
      while (this.visibleReplacePairs.length < target && this.hiddenReplacePairs.length > 0) {
        showNext(this);
      }
      while (this.visibleReplacePairs.length > target && this.visibleReplacePairs.length > 1) {
        hideLast(this);
      }

      const sv = info.widgets_values || [];

      if (info.mikaReplaceValues) {
        // Formato nuevo: restaurar por nombre.
        for (const pair of this.visibleReplacePairs) {
          if (`find_${pair.index}` in info.mikaReplaceValues) {
            pair.find.value = info.mikaReplaceValues[`find_${pair.index}`];
          }
          if (`replace_${pair.index}` in info.mikaReplaceValues) {
            pair.replace.value = info.mikaReplaceValues[`replace_${pair.index}`];
          }
        }
        if (this.useRegexWidget && info.mikaUseRegex !== undefined) {
          this.useRegexWidget.value = info.mikaUseRegex;
        }
      } else if (sv.length) {
        // Archivos guardados con la versión con bug: el checkbox quedaba
        // en el índice 7 ([text, p1..p3, use_regex, p4..]). Detectarlo y
        // reasignar bien para no perder valores.
        const oldLayout = sv.length > 7 && typeof sv[7] === "boolean";
        if (oldLayout) {
          this.widgets[0].value = sv[0];
          if (this.useRegexWidget) this.useRegexWidget.value = sv[7];
          let s = 1;
          for (const pair of this.visibleReplacePairs) {
            if (pair.index <= 3) {
              pair.find.value = sv[s++] ?? "";
              pair.replace.value = sv[s++] ?? "";
            }
          }
          s = 8;
          for (const pair of this.visibleReplacePairs) {
            if (pair.index > 3) {
              pair.find.value = sv[s++] ?? "";
              pair.replace.value = sv[s++] ?? "";
            }
          }
        } else {
          // Layout nuevo: [text, pares..., use_regex]
          for (let i = 0; i < this.widgets.length && i < sv.length; i++) {
            this.widgets[i].value = sv[i];
          }
        }
      }

      resize(this);
      return r;
    };
  },
});