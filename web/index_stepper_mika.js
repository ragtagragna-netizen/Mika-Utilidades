import { app } from "/scripts/app.js";

// Después de cada ejecución, actualiza start_index / end_index con el
// próximo bloque del recorrido escalonado (o los mismos valores si
// auto_advance está apagado).
app.registerExtension({
	name: "Mika.IndexStepper",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "IndexStepperMika") return;

		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);

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

			setWidget("start_index", message?.start_index?.[0]);
			setWidget("end_index", message?.end_index?.[0]);
		};
	},
});