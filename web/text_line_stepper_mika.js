import { app } from "/scripts/app.js";

// Después de cada ejecución, actualiza la caja de texto y los índices
// start/end para reflejar el próximo bloque del recorrido escalonado.
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
      setWidget("end_index", message?.end_index?.[0]);
    };
  },
});