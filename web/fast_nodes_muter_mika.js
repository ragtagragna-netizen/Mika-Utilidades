import { app } from "/scripts/app.js";

const MAX_SLOTS = 20;

app.registerExtension({
	name: "Mika.FastNodesMuter",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "FastNodesMuterMika") return;

		// ------------------------------------------------------------
		// Helpers
		// ------------------------------------------------------------

		const cleanName = (v) => String(v ?? "").trim();
		const inputSlotName = (i) => `input_${i}`;
		const toggleSlotName = (i) => `toggle_${i}`;

		const optionalDefs = nodeData?.input?.optional || {};
		const toggle0Entry = Object.entries(optionalDefs).find(
			([k]) => cleanName(k) === "toggle_0"
		);

		const TOGGLE_IS_INPUT = Boolean(
			toggle0Entry?.[1]?.[1]?.forceInput ||
			toggle0Entry?.[1]?.[1]?.defaultInput
		);

		function getGraph(node) {
			return node?.graph || app.graph;
		}

		function isNodeTarget(n) {
			return n?.mode === 2;
		}

		function setNodeTarget(n, value) {
			if (!n) return;

			n.mode = value ? 2 : 0;

			const graph = n.graph || app.graph;
			graph?.setDirtyCanvas(true, true);
		}

		function toBool(value) {
			if (typeof value === "boolean") return value;
			if (value == null) return false;

			if (typeof value === "number") return value !== 0;

			if (typeof value === "string") {
				return ["true", "1", "yes", "on", "si", "sí", "enabled"].includes(
					value.trim().toLowerCase()
				);
			}

			return Boolean(value);
		}

		function findInputIndex(node, name) {
			if (!node?.inputs) return -1;

			const target = cleanName(name);

			return node.inputs.findIndex(
				(inp) => cleanName(inp?.name) === target
			);
		}

		function isInputLinked(node, name) {
			const idx = findInputIndex(node, name);
			if (idx < 0) return false;

			return node.inputs[idx].link != null;
		}

		function removeUnlinkedInput(node, name) {
			const idx = findInputIndex(node, name);

			if (idx >= 0 && node.inputs[idx].link == null) {
				node.removeInput(idx);
			}
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

		function getSubgraphContainer(node) {
			const targetGraph = node?.graph;
			if (!targetGraph || targetGraph === app.graph) return null;

			function search(graph, depth = 0) {
				if (!graph || depth > 8) return null;

				const nodes = graph._nodes || graph.nodes || [];

				for (const n of nodes) {
					const inner = getInnerGraph(n);

					if (inner === targetGraph) {
						return n;
					}

					if (inner) {
						const found = search(inner, depth + 1);
						if (found) return found;
					}
				}

				return null;
			}

			return search(app.graph);
		}

		function nameMatchesSlot(name, slotName) {
			if (!name || !slotName) return false;
			if (name === slotName) return true;

			const delimiters = [":", ".", "/", " ", "_", "-"];

			for (const d of delimiters) {
				if (name.endsWith(d + slotName)) return true;
			}

			return false;
		}

		function resolveLinkedBoolean(graph, linkId, depth = 0) {
			if (!graph || linkId == null || depth > 8) return undefined;

			const link = graph.links?.[linkId];
			if (!link) return undefined;

			let src = graph.getNodeById(link.origin_id);
			if (!src) return undefined;

			if (src.type === "Reroute") {
				return resolveLinkedBoolean(graph, src.inputs?.[0]?.link, depth + 1);
			}

			const widgets = src.widgets || [];

			const boolWidget =
				widgets.find((w) => typeof w.value === "boolean") ||
				widgets.find((w) => w.type === "toggle" || w.type === "BOOLEAN") ||
				widgets[0];

			if (boolWidget && boolWidget.value != null) {
				return toBool(boolWidget.value);
			}

			if (src.value != null) {
				return toBool(src.value);
			}

			return undefined;
		}

		function getPromotedBoolean(node, slotName) {
			const container = getSubgraphContainer(node);
			if (!container) return undefined;

			const containerGraph = container.graph || app.graph;

			const widget = (container.widgets || []).find((w) =>
				nameMatchesSlot(cleanName(w?.name), slotName)
			);

			if (widget && widget.value != null) {
				return toBool(widget.value);
			}

			const inputIdx = (container.inputs || []).findIndex((inp) =>
				nameMatchesSlot(cleanName(inp?.name), slotName)
			);

			if (inputIdx >= 0) {
				const input = container.inputs[inputIdx];

				if (input?.widget && input.widget.value != null) {
					return toBool(input.widget.value);
				}

				if (input?.value != null) {
					return toBool(input.value);
				}

				if (input?.link != null) {
					const linkedValue = resolveLinkedBoolean(containerGraph, input.link);
					if (linkedValue !== undefined) return linkedValue;
				}
			}

			return undefined;
		}

		function getNodeConnectedAtInput(node, slotIdx) {
			const graph = getGraph(node);
			if (!node?.inputs || !graph) return null;

			const idx = findInputIndex(node, inputSlotName(slotIdx));
			if (idx < 0) return null;

			const input = node.inputs[idx];
			if (!input || input.link == null) return null;

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

		function getNodeDisplayName(node) {
			if (!node) return "???";
			return node.title || node.type || `Node ${node.id}`;
		}

		// ------------------------------------------------------------
		// Gestión dinámica de inputs
		// ------------------------------------------------------------

		function ensureInputs(node) {
			if (!node?.inputs) return;

			const showW = node.widgets?.find(
				(w) => cleanName(w.name) === "show_inputs"
			);

			const showInputs = showW ? Boolean(showW.value) : true;

			let lastConnected = -1;

			for (let i = 0; i < MAX_SLOTS; i++) {
				if (isInputLinked(node, inputSlotName(i))) {
					lastConnected = i;
				}
			}

			const desired = showInputs
				? Math.max(lastConnected + 2, 1)
				: Math.max(lastConnected + 1, 0);

			// Eliminar inputs input_i sobrantes.
			for (let i = MAX_SLOTS - 1; i >= desired; i--) {
				removeUnlinkedInput(node, inputSlotName(i));
			}

			// Garantizar inputs input_i necesarios.
			for (let i = 0; i < desired && i < MAX_SLOTS; i++) {
				if (findInputIndex(node, inputSlotName(i)) < 0) {
					node.addInput(inputSlotName(i), "*");
				}
			}

			// Limpiar toggles inputs sobrantes y ocultar widgets no usados.
			for (let i = 0; i < MAX_SLOTS; i++) {
				const targetConnected = isInputLinked(node, inputSlotName(i));

				const toggleIdx = findInputIndex(node, toggleSlotName(i));

				if (toggleIdx >= 0) {
					const toggleLinked = node.inputs[toggleIdx].link != null;

					if (!targetConnected && !toggleLinked) {
						node.removeInput(toggleIdx);
					}
				} else if (targetConnected && TOGGLE_IS_INPUT) {
					node.addInput(toggleSlotName(i), "BOOLEAN");
				}

				const widget = node.widgets?.find(
					(w) => cleanName(w.name) === toggleSlotName(i)
				);

				if (widget) {
					widget.hidden = !targetConnected;
				}
			}
		}

		// ------------------------------------------------------------
		// Reconstruir mapping y toggles visibles
		// ------------------------------------------------------------

		function rebuild(node) {
			ensureInputs(node);

			node._mikaNodeMapping = [];

			// Ocultar todos los widgets toggle.
			for (let i = 0; i < MAX_SLOTS; i++) {
				const w = node.widgets?.find(
					(w) => cleanName(w.name) === toggleSlotName(i)
				);

				if (w) w.hidden = true;
			}

			// Mostrar solo toggles correspondientes a nodos conectados.
			for (let i = 0; i < MAX_SLOTS; i++) {
				const connectedNode = getNodeConnectedAtInput(node, i);
				if (!connectedNode) continue;

				const toggleName = toggleSlotName(i);
				const displayName = getNodeDisplayName(connectedNode);
				const currentState = isNodeTarget(connectedNode);

				node._mikaNodeMapping.push({
					toggleSlot: toggleName,
					nodeId: connectedNode.id,
					nodeName: displayName,
					_lastValue: currentState,
				});

				const widget = node.widgets?.find(
					(w) => cleanName(w.name) === toggleName
				);

				if (widget) {
					widget.hidden = false;
					widget.label = displayName;
					widget.value = currentState;

					widget.callback = (value) => {
						const graph = getGraph(node);
						const target = graph.getNodeById(connectedNode.id);

						if (target) {
							setNodeTarget(target, toBool(value));

							const entry = node._mikaNodeMapping?.find(
								(m) => m.toggleSlot === toggleName
							);

							if (entry) entry._lastValue = toBool(value);
						}
					};
				}
			}

			const visibleWidgets = (node.widgets || []).filter((w) => !w.hidden);
			const h = Math.max(visibleWidgets.length * 20 + 6, 36);
			const w = Math.max(node.size?.[0] || 200, 200);

			node.setSize([w, h]);
			node.setDirtyCanvas(true, true);

			node._mikaLastSync = 0;
		}

		function applyToggleState(node, toggleState) {
			if (!node || !toggleState || typeof toggleState !== "object") return;

			const graph = getGraph(node);
			const mapping = node._mikaNodeMapping || [];

			if (!mapping.length) {
				rebuild(node);
			}

			for (const [slotName, rawValue] of Object.entries(toggleState)) {
				const entry = (node._mikaNodeMapping || []).find(
					(m) => m.toggleSlot === slotName
				);

				if (!entry) continue;

				const targetNode = graph.getNodeById(entry.nodeId);
				if (!targetNode) continue;

				const targetState = toBool(rawValue);

				if (isNodeTarget(targetNode) !== targetState) {
					setNodeTarget(targetNode, targetState);
				}

				entry._lastValue = targetState;

				const widget = node.widgets?.find(
					(w) => cleanName(w.name) === slotName
				);

				if (widget) widget.value = targetState;
			}
		}

		// ------------------------------------------------------------
		// Ciclo de vida del nodo
		// ------------------------------------------------------------

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

			this._mikaNodeMapping = [];
			this._mikaLastSync = 0;
			this._mikaPrevShowInputs = true;

			if (!this.widgets?.some((w) => cleanName(w.name) === "show_inputs")) {
				const showWidget = this.addWidget("toggle", "show_inputs", true, () => {});

				const idx = this.widgets.indexOf(showWidget);

				if (idx > 0) {
					this.widgets.splice(idx, 1);
					this.widgets.unshift(showWidget);
				}
			}

			for (let i = 0; i < MAX_SLOTS; i++) {
				const w = this.widgets?.find(
					(w) => cleanName(w.name) === toggleSlotName(i)
				);

				if (w) w.hidden = true;
			}

			this.setSize([200, 40]);

			setTimeout(() => {
				ensureInputs(this);
				rebuild(this);
			}, 100);

			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (info) {
			const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;

			setTimeout(() => {
				ensureInputs(this);
				rebuild(this);
			}, 100);

			return r;
		};

		const onConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (type, slot, isConnect, linkInfo) {
			const r = onConnectionsChange
				? onConnectionsChange.apply(this, arguments)
				: undefined;

			if (type === 1 || type === "input") {
				setTimeout(() => {
					rebuild(this);
				}, 50);
			}

			return r;
		};

		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);

			const toggleState = message?.toggle_state?.[0];
			if (!toggleState || typeof toggleState !== "object") return;

			applyToggleState(this, toggleState);
		};

		// ------------------------------------------------------------
		// Polling: Show Inputs + toggles + mute + promovidos
		// ------------------------------------------------------------

		const onDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (ctx) {
			const r = onDrawForeground
				? onDrawForeground.apply(this, arguments)
				: undefined;

			const now = Date.now();

			if (!this._mikaLastSync || now - this._mikaLastSync > 400) {
				this._mikaLastSync = now;

				let dirty = false;

				const showW = this.widgets?.find(
					(w) => cleanName(w.name) === "show_inputs"
				);

				const currentShow = showW ? Boolean(showW.value) : true;

				if (currentShow !== this._mikaPrevShowInputs) {
					this._mikaPrevShowInputs = currentShow;
					ensureInputs(this);
					dirty = true;
				}

				const graph = getGraph(this);
				const mapping = this._mikaNodeMapping || [];

				for (const entry of mapping) {
					const targetNode = graph.getNodeById(entry.nodeId);
					if (!targetNode) continue;

					const actualState = isNodeTarget(targetNode);
					const promotedValue = getPromotedBoolean(this, entry.toggleSlot);

					if (promotedValue !== undefined) {
						if (promotedValue !== actualState) {
							setNodeTarget(targetNode, promotedValue);
							dirty = true;
						}

						entry._lastValue = promotedValue;

						const w = this.widgets?.find(
							(w) => cleanName(w.name) === entry.toggleSlot
						);

						if (w && w.value !== promotedValue) {
							w.value = promotedValue;
							dirty = true;
						}

						continue;
					}

					const w = this.widgets?.find(
						(w) => cleanName(w.name) === entry.toggleSlot
					);

					if (!w) {
						entry._lastValue = actualState;
						continue;
					}

					if (
						entry._lastValue !== undefined &&
						w.value !== entry._lastValue &&
						w.value !== actualState
					) {
						setNodeTarget(targetNode, toBool(w.value));
						entry._lastValue = toBool(w.value);
						dirty = true;
					} else if (w.value !== actualState) {
						w.value = actualState;
						entry._lastValue = actualState;
						dirty = true;
					}
				}

				if (dirty) {
					this.setDirtyCanvas(true, true);
				}
			}

			return r;
		};
	},
});