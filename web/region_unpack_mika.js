import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Region Unpack-Mika
// -----------------------------------------------------------------------
// Ajusta las salidas imagen_1..N (IMAGE) según el widget "salidas". Cada
// salida recibe una zona del nodo Image Region Select-Mika, a su tamaño
// exacto. El nodo Python siempre declara MAX_UNPACK_SLOTS salidas; acá se
// muestran solo las que el usuario pide.
// -----------------------------------------------------------------------

const MAX_UNPACK_SLOTS = 50;
const NODE_NAME = "RegionUnpackMika";

app.registerExtension({
	name: "Mika.RegionUnpack",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== NODE_NAME) return;

		const salidasWidget = (node) =>
			node.widgets?.find((w) => String(w?.name) === "salidas");

		function clampCount(value) {
			let count = parseInt(value, 10);
			if (Number.isNaN(count)) count = 3;
			return Math.max(1, Math.min(MAX_UNPACK_SLOTS, count));
		}

		function getOutputCount(node) {
			const w = salidasWidget(node);
			const raw = w && w.value != null ? w.value : node._mikaDesiredOutputCount ?? 3;
			return clampCount(raw);
		}

		function syncOutputs(node) {
			if (!node.outputs) return;

			const desired = getOutputCount(node);

			while (node.outputs.length > desired) {
				node.removeOutput(node.outputs.length - 1);
			}
			while (node.outputs.length < desired && node.outputs.length < MAX_UNPACK_SLOTS) {
				node.addOutput(`imagen_${node.outputs.length + 1}`, "IMAGE");
			}
			for (let i = 0; i < node.outputs.length; i++) {
				node.outputs[i].name = `imagen_${i + 1}`;
				node.outputs[i].type = "IMAGE";
			}

			node._mikaDesiredOutputCount = desired;

			try {
				const size = node.computeSize();
				node.setSize([
					Math.max(180, Math.ceil(size?.[0] || 180)),
					Math.max(40, Math.ceil(size?.[1] || 40)),
				]);
			} catch (e) {
				node.setSize([
					Math.max(180, node.size?.[0] || 180),
					Math.max(40, (node.outputs?.length || 3) * 18 + 50),
				]);
			}
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
			this._mikaPrevOutputCount = getOutputCount(this);
			this._mikaLastSync = 0;
			setTimeout(() => {
				syncOutputs(this);
				this.setDirtyCanvas(true, true);
			}, 100);
			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
			setTimeout(() => {
				syncOutputs(this);
				this.setDirtyCanvas(true, true);
			}, 100);
			return r;
		};

		// Detecta cambios manuales del widget "salidas" (polling suave).
		const onDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (ctx) {
			const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;

			const now = Date.now();
			if (!this._mikaLastSync || now - this._mikaLastSync > 300) {
				this._mikaLastSync = now;
				const current = getOutputCount(this);
				if (current !== this._mikaPrevOutputCount) {
					this._mikaPrevOutputCount = current;
					syncOutputs(this);
					this.setDirtyCanvas(true, true);
				}
			}
			return r;
		};
	},
});
