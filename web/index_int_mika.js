import { app } from "/scripts/app.js";

// Después de cada ejecución, actualiza el widget 'value' con el próximo
// índice (increment) o el valor sorteado (random). Sin esto, el avance
// no se refleja visualmente ni se guarda en el workflow.
app.registerExtension({
	name: "Mika.IndexInt",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "IndexIntMika") return;

		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);

			const next = message?.value?.[0];
			if (next === undefined) return;

			const widget = this.widgets?.find((w) => w.name === "value");
			if (widget) {
				widget.value = next;
				if (widget.callback) {
					widget.callback(widget.value);
				}
			}
		};
	},
});