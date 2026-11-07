import { app } from "/scripts/app.js";

// Después de cada ejecución, actualiza el widget 'index' con el próximo
// índice (increment). Si el widget está conectado a otro nodo, el valor del
// nodo conectado manda y este avance queda guardado en el widget.
app.registerExtension({
	name: "Mika.IndexInt",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "IndexIntMika") return;

		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);

			const next = message?.value?.[0];
			if (next === undefined) return;

			const widget = this.widgets?.find((w) => w.name === "index");
			console.log(
				"[IndexIntMika] onExecuted message=",
				message,
				"widget found=",
				!!widget,
				"old value=",
				widget?.value,
				"next=",
				next
			);
			if (widget) {
				widget.value = next;
				if (widget.callback) {
					widget.callback(widget.value);
				}
			}
		};
	},
});