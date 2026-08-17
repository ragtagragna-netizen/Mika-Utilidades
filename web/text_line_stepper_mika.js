import { app } from "/scripts/app.js";

// Después de cada ejecución, actualiza la caja de texto y el índice
// start para reflejar el próximo bloque del recorrido escalonado.
// `steps` (cantidad de líneas por generación) no se toca.
// Sin esto, el avance automático no se refleja visualmente en el nodo.
app.registerExtension({
  name: "Mika.TextLineStepper",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "TextLineStepperMika") {
      return;
    }

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);

      // Helper para actualizar un widget por nombre
      const setWidget = (name, value) => {
        if (value === undefined) return;
        const widget = this.widgets?.find((w) => w.name === name);
        if (widget) {
          widget.value = value;
          if (widget.callback) {
            widget.callback(widget.value);
          }
        }
      };

      setWidget("text", message?.text?.[0]);
      setWidget("start_index", message?.start_index?.[0]);
    };
  },
});