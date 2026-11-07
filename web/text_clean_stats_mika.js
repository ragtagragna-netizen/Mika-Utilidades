import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Estadísticas (in/quitados/out) para los nodos Text Clean
// -----------------------------------------------------------------------
// El frontend nuevo no dibuja el clásico "ui.text", así que las líneas de
// estadísticas se dibujan manualmente debajo de los widgets del nodo.
// -----------------------------------------------------------------------

const NODE_NAMES = new Set([
  "TextCleanOrganizeMika",
  "TextCleanOrganizeConcatMika",
  "TextCleanerCompareMika",
]);

const LINE_H = 16;
const PAD_BOTTOM = 6;
const PAD_SIDE = 10;

app.registerExtension({
  name: "Mika.TextCleanStats",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.has(nodeData.name)) return;

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const lines = message?.ui?.text;
      this._mikaStats = Array.isArray(lines)
        ? lines.map((l) => String(l ?? ""))
        : [];
      this._mikaStatsResized = false;
      this.graph?.setDirtyCanvas?.(true, true);
    };

    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
      const lines = this._mikaStats;
      if (!lines?.length || this.flags?.collapsed) return r;

      try {
        // Asegura alto suficiente para las líneas (una sola vez por cambio).
        if (!this._mikaStatsResized) {
          this._mikaStatsResized = true;
          const content = this.computeSize?.() ?? this.size;
          const needed = [content[0], content[1] + lines.length * LINE_H + PAD_BOTTOM];
          const newHeight = Math.max(this.size[1], needed[1]);
          if (newHeight > this.size[1] + 1) {
            this.setSize([this.size[0], newHeight]);
          }
        }

        const baseY = this.size[1] - PAD_BOTTOM - lines.length * LINE_H;
        ctx.save();
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        for (let i = 0; i < lines.length; i++) {
          ctx.fillStyle = lines[i].includes("QUITADOS") || lines[i].startsWith("OUT") || lines[i].startsWith("IN")
            ? "#9ecbff"
            : "#cccccc";
          ctx.fillText(lines[i], PAD_SIDE, baseY + i * LINE_H);
        }
        ctx.restore();
      } catch (e) { /* no-op */ }

      return r;
    };
  },
});
