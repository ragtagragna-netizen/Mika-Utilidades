import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const MAX_UNPACK_SLOTS = 50;
const NODE_NAME = "ListUnpackMika";
const EVENT_NAME = "mika-list-unpack";

app.registerExtension({
	name: "Mika.ListUnpack",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== NODE_NAME) return;

		// ------------------------------------------------------------
		// Helpers
		// ------------------------------------------------------------

		const cleanName = (v) => String(v ?? "").trim();

		function clampCount(value) {
			let count = parseInt(value, 10);

			if (Number.isNaN(count)) {
				count = 2;
			}

			return Math.max(1, Math.min(MAX_UNPACK_SLOTS, count));
		}

		function getInnerGraph(n) {
			if (!n) return null;

			if (n.subgraph) return n.subgraph;
			if (n._subgraph) return n._subgraph;

			if (typeof n.getInnerGraph === "function") {
				try {
					return n.getInnerGraph();
				} catch (e) {
					return null;
				}
			}

			return null;
		}

		function findNodeByAnyId(id) {
			if (id == null) return null;

			const wanted = String(id);
			const numeric = Number(id);

			function search(graph, depth = 0) {
				if (!graph || depth > 8) return null;

				const nodes = graph._nodes || graph.nodes || [];

				for (const n of nodes) {
					if (n?.type === NODE_NAME) {
						if (String(n.id) === wanted) return n;

						if (!Number.isNaN(numeric) && n.id === numeric) {
							return n;
						}

						if (
							n.properties &&
							String(n.properties.unique_id) === wanted
						) {
							return n;
						}

						if (String(n._mikaUniqueId || "") === wanted) {
							return n;
						}
					}

					const inner = getInnerGraph(n);

					if (inner) {
						const found = search(inner, depth + 1);
						if (found) return found;
					}
				}

				return null;
			}

			return search(app.graph);
		}

		function getOutputCount(node) {
			const widget = node.widgets?.find(
				(w) => cleanName(w.name) === "output_count"
			);

			let raw;

			if (widget && widget.value != null) {
				raw = widget.value;
			} else if (node._mikaDesiredOutputCount != null) {
				raw = node._mikaDesiredOutputCount;
			} else {
				raw = node.outputs?.length ?? 2;
			}

			return clampCount(raw);
		}

		function syncOutputs(node) {
			if (!node.outputs) return;

			const desired = getOutputCount(node);

			// Eliminar salidas sobrantes desde el final.
			while (node.outputs.length > desired) {
				node.removeOutput(node.outputs.length - 1);
			}

			// Agregar salidas faltantes.
			while (
				node.outputs.length < desired &&
				node.outputs.length < MAX_UNPACK_SLOTS
			) {
				const idx = node.outputs.length;
				node.addOutput(`output_${idx}`, "*");
			}

			// Normalizar nombres y tipos.
			for (let i = 0; i < node.outputs.length; i++) {
				node.outputs[i].name = `output_${i}`;
				node.outputs[i].type = "*";
			}

			node._mikaDesiredOutputCount = desired;

			// Ajustar tamaño del nodo (permitir achicar y agrandar).
			try {
				const size = node.computeSize();

				node.setSize([
					Math.max(180, Math.ceil(size?.[0] || 180)),
					Math.max(40, Math.ceil(size?.[1] || 40)),
				]);
			} catch (e) {
				// Fallback si computeSize no existe en tu build:
				// altura estimada según cantidad de salidas visibles.
				const h = Math.max(
					40,
					(node.outputs?.length || 2) * 18 + 50
				);

				node.setSize([Math.max(180, node.size?.[0] || 180), h]);
			}
		}

		// ------------------------------------------------------------
		// Listener WebSocket opcional
		// Útil cuando output_count viene linkeado desde otro nodo
		// o desde un subgrafo.
		// ------------------------------------------------------------

		if (!window.__mikaListUnpackListenerRegistered) {
			window.__mikaListUnpackListenerRegistered = true;

			if (api?.addEventListener) {
				api.addEventListener(EVENT_NAME, (event) => {
					const data = event?.detail || event?.data || event;
					if (!data) return;

					const node = findNodeByAnyId(data.node_id);
					if (!node) return;

					const count = clampCount(data.output_count);

					node._mikaDesiredOutputCount = count;

					const widget = node.widgets?.find(
						(w) => cleanName(w.name) === "output_count"
					);

					if (widget) {
						widget.value = count;
					}

					syncOutputs(node);
					node.setDirtyCanvas(true, true);
				});
			}
		}

		// ------------------------------------------------------------
		// Ciclo de vida del nodo
		// ------------------------------------------------------------

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated
				? onNodeCreated.apply(this, arguments)
				: undefined;

			this._mikaPrevOutputCount = getOutputCount(this);
			this._mikaLastSync = 0;

			setTimeout(() => {
				syncOutputs(this);
				this.setDirtyCanvas(true, true);
			}, 100);

			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (info) {
			const r = onConfigure
				? onConfigure.apply(this, arguments)
				: undefined;

			setTimeout(() => {
				syncOutputs(this);
				this.setDirtyCanvas(true, true);
			}, 100);

			return r;
		};

		const onConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (
			type,
			slot,
			isConnect,
			linkInfo
		) {
			const r = onConnectionsChange
				? onConnectionsChange.apply(this, arguments)
				: undefined;

			// Si cambia algo, forzamos una sincronización suave.
			setTimeout(() => {
				syncOutputs(this);
			}, 50);

			return r;
		};

		// ------------------------------------------------------------
		// Polling para detectar cambios manuales del widget output_count
		// ------------------------------------------------------------

		const onDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (ctx) {
			const r = onDrawForeground
				? onDrawForeground.apply(this, arguments)
				: undefined;

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