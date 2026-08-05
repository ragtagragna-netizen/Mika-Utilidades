import { app } from "/scripts/app.js";

// Después de cada ejecución, actualiza la caja de texto del nodo
// eliminando las líneas que fueron seleccionadas y procesadas.
// Sin esto, la retención del bucle no se refleja visualmente.
app.registerExtension({
  name: "Mika.TextLineSelector",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "TextLineSelectorMika") {
      return;
    }

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const newText = message?.text?.[0];
      if (newText === undefined) {
        return;
      }
      const widget = this.widgets?.find((w) => w.name === "text");
      if (widget) {
        widget.value = newText;
        if (widget.callback) {
          widget.callback(widget.value);
        }
      }
    };
  },
});