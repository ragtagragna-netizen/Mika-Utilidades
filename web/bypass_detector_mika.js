import { app } from "/scripts/app.js";

const BYPASS_MODE = 4;
const TICK_MS = 400;

app.registerExtension({
	name: "Mika.BypassDetector",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "BypassDetectorMika") return;

		const cleanName = (v) => String(v ?? "").trim();

		function getGraph(node) {
			return node?.graph || app.graph;
		}

		function getInnerGraph(n) {
			if (!n) return null;
			if (n.subgraph) return n.subgraph;
			if (n._subgraph) return n._subgraph;
			if (typeof n.getInnerGraph === "function") {
				try {
					return n.getInnerGraph();
				} catch (e) {}
			}
			return null;
		}

		function findInputIndex(node, name) {
			if (!node?.inputs) return -1;
			const target = cleanName(name);
			return node.inputs.findIndex((inp) => cleanName(inp?.name) === target);
		}

		// Si el input "target" está conectado, seguir el link (atravesando
		// reroutes) hasta el nodo fuente: ese es el objetivo.
		function getLinkedTargetNode(node) {
			if (!node?.inputs) return null;
			const idx = findInputIndex(node, "target");
			if (idx < 0) return null;
			const input = node.inputs[idx];
			if (!input || input.link == null) return null;

			const graph = getGraph(node);
			if (!graph) return null;

			let linkId = input.link;
			let depth = 0;
			while (linkId != null && depth < 8) {
				const link = graph.links?.[linkId];
				if (!link) return null;
				let src = graph.getNodeById(link.origin_id);
				if (!src) return null;
				if (src.type === "Reroute") {
					linkId = src.inputs?.[0]?.link;
					depth++;
					continue;
				}
				return src;
			}
			return null;
		}

		function getNodeByIdIn(graph, id) {
			if (!graph || id == null) return null;
			if (graph.getNodeById) {
				try {
					const n = graph.getNodeById(Number(id));
					if (n) return n;
				} catch (e) {}
			}
			const nodes = graph._nodes || graph.nodes || [];
			return nodes.find((n) => String(n?.id) === String(id)) || null;
		}

		// Todos los grafos alcanzables desde la raíz (subgrafos incluidos).
		function allGraphsRecursive() {
			const out = [];
			const seen = new Set();
			const walk = (g) => {
				if (!g || seen.has(g)) return;
				seen.add(g);
				out.push(g);
				for (const n of g._nodes || g.nodes || []) {
					walk(getInnerGraph(n));
				}
			};
			walk(app.graph);
			return out;
		}

		// Nombre tal como se VE en el canvas: en el frontend moderno
		// node.title suele estar vacío y lo mostrado sale de getTitle().
		function displayName(n) {
			if (!n) return "";
			try {
				if (typeof n.getTitle === "function") {
					const t = n.getTitle();
					if (t) return String(t);
				}
			} catch (e) {}
			return n.title || n.type || `Node ${n.id}`;
		}

		// Resuelve "5" (id) o "5:3" (cadena bajando subgrafos, estilo
		// trixnodes). Solo si el ref es id/cadena pura.
		function resolveChain(rootGraph, ref) {
			const parts = ref.split(":");
			let g = rootGraph;
			let node = null;
			for (let i = 0; i < parts.length; i++) {
				node = getNodeByIdIn(g, parts[i]);
				if (!node) return null;
				if (i < parts.length - 1) {
					g = getInnerGraph(node);
					if (!g) return null;
				}
			}
			return node;
		}

		function findInGraph(graph, ref) {
			if (!graph) return null;
			const nodes = graph._nodes || graph.nodes || [];
			const lower = ref.toLowerCase();
			return (
				nodes.find((n) => displayName(n).toLowerCase() === lower) ||
				nodes.find((n) => (n.title || "").toLowerCase() === lower) ||
				nodes.find((n) => displayName(n).toLowerCase().includes(lower)) ||
				nodes.find((n) => (n.type || "").toLowerCase().includes(lower)) ||
				null
			);
		}

		function findTarget(node, ref) {
			ref = cleanName(ref);
			if (!ref) return null;

			const own = getGraph(node);
			const roots = [];
			if (own) roots.push(own);
			if (app.graph && app.graph !== own) roots.push(app.graph);

			// 1. ID numérico o cadena jerárquica.
			if (/^\d+(:\d+)*$/.test(ref)) {
				for (const g of roots) {
					const n = resolveChain(g, ref);
					if (n) return n;
				}
				for (const g of allGraphsRecursive()) {
					const n = resolveChain(g, ref);
					if (n) return n;
				}
				return null;
			}

			// 2. Por nombre visto en canvas (exacto antes que parcial),
			// primero en el grafo propio y la raíz, luego en todo el árbol.
			for (const g of roots) {
				const n = findInGraph(g, ref);
				if (n) return n;
			}
			for (const g of allGraphsRecursive()) {
				const n = findInGraph(g, ref);
				if (n) return n;
			}
			return null;
		}

		// Contenedor cuyo grafo interior es targetGraph (búsqueda recursiva).
		function findContainerOf(targetGraph) {
			function search(graph, depth = 0) {
				if (!graph || depth > 8) return null;
				for (const n of graph._nodes || graph.nodes || []) {
					if (getInnerGraph(n) === targetGraph) return n;
					const inner = getInnerGraph(n);
					if (inner) {
						const found = search(inner, depth + 1);
						if (found) return found;
					}
				}
				return null;
			}
			return search(app.graph, 0);
		}

		// Un nodo está en bypass si su modo es bypass (4) o si cualquier
		// subgrafo ancestro lo está (un bypass manual de un subgrafo no
		// propaga el modo a sus nodos interiores).
		function isBypassed(n) {
			if (!n) return false;
			if (n.mode === BYPASS_MODE) return true;

			const visited = new Set();
			let g = n.graph || n._graph || null;
			while (g && !visited.has(g)) {
				visited.add(g);
				if (g === app.graph) break;
				const container = findContainerOf(g);
				if (!container) break;
				if (container.mode === BYPASS_MODE) return true;
				g = container.graph || container._graph || null;
			}

			return false;
		}

		// "target" es dual: si tiene link externo, el input manda; si no, el
		// texto del widget manda. No hay conversión widget↔input.
		function syncState(node) {
			// 1. LINK: si "target" está conectado, manda el nodo linkeado.
			let target = getLinkedTargetNode(node);
			const fromLink = target != null;

			// 2. REF del widget (si no hay link): texto → id / nombre.
			let ref = "";
			if (!target) {
				const targetW = node.widgets?.find(
					(w) => cleanName(w.name) === "target"
				);
				ref = targetW ? cleanName(targetW.value) : "";
				target = ref ? findTarget(node, ref) : null;
			}

			const bypassed = target ? isBypassed(target) : null;

			// Display con diagnóstico: origen + nombre resuelto o
			// "NO ENCONTRADO" para distinguir fallos de resolución.
			const linkTag = fromLink ? " (LINK)" : "";
			const stateText =
				bypassed === null
					? "NO ENCONTRADO"
					: `${bypassed ? "BYPASS" : "ACTIVE"} · ${displayName(target).slice(0, 24)}${linkTag}`;

			if (stateText !== node._mikaPrevState) {
				node._mikaPrevState = stateText;
				const stateW = node.widgets?.find(
					(w) => cleanName(w.name) === "mika_state"
				);
				if (stateW) stateW.value = stateText;
				node.setDirtyCanvas?.(true, true);
			}

			if (bypassed === null) return;

			const bypassW = node.widgets?.find(
				(w) => cleanName(w.name) === "is_bypassed"
			);

			if (bypassW && bypassW.value !== bypassed) {
				bypassW.value = bypassed;
				// Disparar el callback para que ComfyUI re-ejecute el
				// nodo y el backend lea el nuevo estado; sin esto el
				// resultado se queda cacheado.
				if (typeof bypassW.callback === "function") {
					bypassW.callback(bypassed);
				}
			}
		}

		function startTick(node) {
			if (node._mikaInterval) return;
			node._mikaInterval = setInterval(() => {
				try {
					syncState(node);
				} catch (e) {}
			}, TICK_MS);
		}

		function stopTick(node) {
			if (node._mikaInterval) {
				clearInterval(node._mikaInterval);
				node._mikaInterval = null;
			}
		}

		function hookRemove(node) {
			if (!node || node._mikaRemoveHooked) return;
			node._mikaRemoveHooked = true;
			const prevRemove = node.onRemoved;
			node.onRemoved = function () {
				try {
					stopTick(node);
				} catch (e) {}
				if (typeof prevRemove === "function") prevRemove.apply(this, arguments);
			};
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

			this._mikaPrevState = null;

			const bypassW = this.widgets?.find(
				(w) => cleanName(w.name) === "is_bypassed"
			);

			if (bypassW) bypassW.hidden = true;

			if (!this.widgets?.some((w) => cleanName(w.name) === "mika_state")) {
				this.addWidget("text", "mika_state", "?", () => {}, { serialize: false });
			}

			startTick(this);
			hookRemove(this);
			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (info) {
			const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
			this._mikaPrevState = null;
			startTick(this);
			hookRemove(this);
			return r;
		};
	},
});
