import { app } from "/scripts/app.js";

const BYPASS_MODE = 4;

app.registerExtension({
	name: "Mika.BypassDetector",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "BypassDetectorMika") return;

		const cleanName = (v) => String(v ?? "").trim();

		function getGraph(node) {
			return node?.graph || app.graph;
		}

		function searchInGraph(graph, ref, numericId) {
			if (!graph) return null;

			const nodes = graph._nodes || graph.nodes || [];

			if (numericId) {
				const byId = graph.getNodeById(numericId);
				if (byId) return byId;
			}

			const lower = ref.toLowerCase();

			return (
				nodes.find((n) => cleanName(n.title).toLowerCase() === lower) ||
				nodes.find((n) => (n.title || "").toLowerCase().includes(lower)) ||
				nodes.find((n) => (n.type || "").toLowerCase().includes(lower)) ||
				null
			);
		}

		function findTarget(node, ref) {
			ref = cleanName(ref);
			if (!ref) return null;

			const numericId = /^\d+$/.test(ref) ? parseInt(ref, 10) : null;

			const graph = getGraph(node);
			const found = searchInGraph(graph, ref, numericId);
			if (found) return found;

			if (graph && graph !== app.graph) {
				return searchInGraph(app.graph, ref, numericId);
			}

			return null;
		}

		function isBypassed(n) {
			return Boolean(n && n.mode === BYPASS_MODE);
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

			this._mikaLastSync = 0;
			this._mikaPrevBypassed = null;

			const bypassW = this.widgets?.find(
				(w) => cleanName(w.name) === "is_bypassed"
			);

			if (bypassW) bypassW.hidden = true;

			if (!this.widgets?.some((w) => cleanName(w.name) === "mika_state")) {
				this.addWidget("text", "mika_state", "?", () => {}, { serialize: false });
			}

			return r;
		};

		const onDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (ctx) {
			const r = onDrawForeground
				? onDrawForeground.apply(this, arguments)
				: undefined;

			const now = Date.now();

			if (!this._mikaLastSync || now - this._mikaLastSync > 400) {
				this._mikaLastSync = now;

				const targetW = this.widgets?.find(
					(w) => cleanName(w.name) === "target"
				);

				const ref = targetW ? cleanName(targetW.value) : "";

				const target = findTarget(this, ref);
				const bypassed = isBypassed(target);

				if (bypassed !== this._mikaPrevBypassed) {
					this._mikaPrevBypassed = bypassed;

					const bypassW = this.widgets?.find(
						(w) => cleanName(w.name) === "is_bypassed"
					);

					if (bypassW && bypassW.value !== bypassed) {
						bypassW.value = bypassed;
					}

					const stateW = this.widgets?.find(
						(w) => cleanName(w.name) === "mika_state"
					);

					if (stateW) stateW.value = bypassed ? "BYPASS" : "ACTIVE";

					this.setDirtyCanvas(true, true);
				}
			}

			return r;
		};
	},
});
