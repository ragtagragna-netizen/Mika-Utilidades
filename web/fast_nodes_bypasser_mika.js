import { app } from "/scripts/app.js";
import { enforceModes, releaseActive, forgetController } from "./mika_bypass_engine.js";

const MAX_SLOTS = 20;
const OFF_MODE = 4; // bypass
const TICK_MS = 400;

app.registerExtension({
	name: "Mika.FastNodesBypasser",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "FastNodesBypasserMika") return;

		// ------------------------------------------------------------
		// Helpers
		// ------------------------------------------------------------

		const cleanName = (v) => String(v ?? "").trim();
		const inputSlotName = (i) => `input_${i}`;
		const toggleSlotName = (i) => `toggle_${i}`;

		function getGraph(node) {
			return node?.graph || app.graph;
		}

		function isNodeTarget(n) {
			return n?.mode === 4;
		}

		// Construye los targets {n, active} a partir del mapping y aplica el motor.
		function syncApply(node, mapping) {
			const graph = getGraph(node);
			const targets = [];
			for (const entry of mapping) {
				const targetNode = graph.getNodeById(entry.nodeId);
				if (!targetNode) continue;
				targets.push({ n: targetNode, active: Boolean(entry._active) });
			}
			enforceModes(node, targets, OFF_MODE);
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

		function getLinkedToggleValue(node, slotName) {
			const idx = findInputIndex(node, slotName);
			if (idx < 0) return undefined;

			const input = node.inputs[idx];
			if (!input || input.link == null) return undefined;

			return resolveLinkedBoolean(getGraph(node), input.link);
		}

		function getToggleValue(node, slotName) {
			const promoted = getPromotedBoolean(node, slotName);
			if (promoted !== undefined) return promoted;

			const linked = getLinkedToggleValue(node, slotName);
			if (linked !== undefined) return linked;

			const w = node.widgets?.find(
				(w) => cleanName(w.name) === slotName
			);

			if (w && w.value != null) return toBool(w.value);

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

			// show_inputs ahora es una opción del menú contextual, no widget.
			const showInputs = node._mikaShowInputs !== false;

			node._mikaHideInputs = !showInputs;

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

			// Gestionar los slots toggle_i: mantenerlos solo cuando el target
			// está conectado, hay un link externo o el widget está visible.
			// El resto se elimina para no bloquear el hit-testing de los
			// sockets input_i.
			for (let i = 0; i < MAX_SLOTS; i++) {
				const targetConnected = isInputLinked(node, inputSlotName(i));
				const toggleLinked = isInputLinked(node, toggleSlotName(i));

				const widget = node.widgets?.find(
					(w) => cleanName(w.name) === toggleSlotName(i)
				);

				const widgetVisible = widget ? !widget.hidden : false;
				const keepSlot = targetConnected || toggleLinked || widgetVisible;
				const toggleIdx = findInputIndex(node, toggleSlotName(i));

				if (toggleIdx < 0 && keepSlot) {
					node.addInput(toggleSlotName(i), "BOOLEAN", {
						widget: { name: toggleSlotName(i) },
					});
				} else if (toggleIdx >= 0 && !keepSlot) {
					node.removeInput(toggleIdx);
				}

				if (widget) {
					widget.hidden = !targetConnected;
				}
			}
		}

		// ------------------------------------------------------------
		// Reconstruir mapping y toggles visibles
		// ------------------------------------------------------------

		function rebuild(node) {
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

				const newEntry = {
					toggleSlot: toggleName,
					nodeId: connectedNode.id,
					nodeName: displayName,
					_active: currentState,
				};
				node._mikaNodeMapping.push(newEntry);

				const widget = node.widgets?.find(
					(w) => cleanName(w.name) === toggleName
				);

				if (widget) {
					widget.hidden = false;
					widget.label = displayName;

					const toggleValue = getToggleValue(node, toggleName);
					widget.value = toggleValue !== undefined ? toggleValue : currentState;

					widget.callback = (value) => {
						const entry = node._mikaNodeMapping?.find(
							(m) => m.toggleSlot === toggleName
						);
						const boolValue = toBool(value);

						if (entry) {
							entry._active = boolValue;
							entry._lastApplied = boolValue;
						}

						// Write-through al promovido: es la misma perilla.
						const container = getSubgraphContainer(node);
						const pw = container?.widgets?.find((w) =>
							nameMatchesSlot(cleanName(w?.name), toggleName)
						);
						if (pw) pw.value = boolValue;

						syncApply(node, node._mikaNodeMapping || []);

						if (!boolValue && entry) {
							// OFF explícito: sale del bypass aunque lo hubiera
							// impuesto un actor externo (p.ej. rgthree).
							const target = getGraph(node).getNodeById(entry.nodeId);
							if (target) releaseActive(node, [target]);
						}
					};
				}
			}

			syncApply(node, node._mikaNodeMapping);

			const visibleWidgets = (node.widgets || []).filter((w) => !w.hidden);
			const h = Math.max(visibleWidgets.length * 20 + 6, 36);
			const w = Math.max(node.size?.[0] || 200, 200);

			node.setSize([w, h]);
			node.setDirtyCanvas(true, true);

			// ensureInputs después de ocultar/mostrar widgets, para que la
			// decisión keepSlot use el estado final de los widgets.
			ensureInputs(node);
		}

		// ------------------------------------------------------------
		// Ocultar sockets de entrada cuando show_inputs está apagado
		// ------------------------------------------------------------

		const baseDrawSlots = nodeType.prototype.drawSlots;
		if (typeof baseDrawSlots === "function") {
			nodeType.prototype.drawSlots = function (ctx, opts) {
				if (!this._mikaHideInputs) {
					return baseDrawSlots.call(this, ctx, opts);
				}

				const inputSlots = this._concreteInputs;

				if (Array.isArray(inputSlots) && inputSlots.length) {
					this._concreteInputs = [];

					try {
						return baseDrawSlots.call(this, ctx, opts);
					} finally {
						this._concreteInputs = inputSlots;
					}
				}

				return baseDrawSlots.call(this, ctx, opts);
			};
		}

		// ------------------------------------------------------------
		// Tick periódico estilo TrixNodes: concilia display y mantenimiento,
		// pero NUNCA escribe modos por sí solo. La escritura es por click o
		// por cambio en un control externo (promovido/linkeado). Funciona en
		// frontend clásico y Vue.
		// ------------------------------------------------------------

		function tick(node) {
			let dirty = false;

			const currentShow = node._mikaShowInputs !== false;

			if (currentShow !== node._mikaPrevShowInputs) {
				node._mikaPrevShowInputs = currentShow;
				ensureInputs(node);
				dirty = true;
			}

			const graph = getGraph(node);
			const mapping = node._mikaNodeMapping || [];

			let needEnforce = false;

			for (const entry of mapping) {
				const targetNode = graph.getNodeById(entry.nodeId);
				if (!targetNode) continue;

				const actualState = isNodeTarget(targetNode);

				// Refrescar label ante renombres del target.
				const liveName = getNodeDisplayName(targetNode);
				if (entry.nodeName !== liveName) entry.nodeName = liveName;
				const w = node.widgets?.find(
					(w) => cleanName(w.name) === entry.toggleSlot
				);
				if (w && w.label !== liveName) {
					w.label = liveName;
					dirty = true;
				}

				const promotedValue = getPromotedBoolean(node, entry.toggleSlot);
				const linkedValue =
					promotedValue === undefined
						? getLinkedToggleValue(node, entry.toggleSlot)
						: undefined;
				const externalValue = promotedValue ?? linkedValue;

				if (externalValue !== undefined) {
					// Control externo: manda y se aplica por flanco.
					const ev = toBool(externalValue);
					if (w && w.value !== ev) {
						w.value = ev;
						dirty = true;
					}
					entry._active = ev;
					if (entry._lastApplied !== ev) {
						entry._lastApplied = ev;
						needEnforce = true;
					}
					continue;
				}

				if (!w || w.value == null) {
					entry._active = false;
					continue;
				}

				// Toggle propio: el display sigue a la realidad (adopt).
				const wValue = toBool(w.value);
				entry._active = wValue;
				if (wValue !== actualState) {
					w.value = actualState;
					entry._active = actualState;
					dirty = true;
				}

				continue;
			}

			if (needEnforce) syncApply(node, mapping);

			if (dirty) {
				node.setDirtyCanvas(true, true);
			}
		}

		function startTick(node) {
			if (node._mikaInterval) return;
			node._mikaInterval = setInterval(() => {
				try {
					tick(node);
				} catch (e) {}
			}, TICK_MS);
		}

		function stopTick(node) {
			if (node._mikaInterval) {
				clearInterval(node._mikaInterval);
				node._mikaInterval = null;
			}
		}

		// ------------------------------------------------------------
		// Ciclo de vida del nodo
		// ------------------------------------------------------------

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

			this._mikaNodeMapping = [];
			this._mikaPrevShowInputs = true;

			// show_inputs vive en properties (menú contextual); se elimina el
			// widget viejo si el nodo cargaba uno guardado.
			if (this.properties && this.properties._mikaShowInputs !== undefined) {
				this._mikaShowInputs = Boolean(this.properties._mikaShowInputs);
			} else if (this._mikaShowInputs === undefined) {
				this._mikaShowInputs = true;
			}
			const legacyShow = this.widgets?.findIndex(
				(w) => cleanName(w.name) === "show_inputs"
			) ?? -1;
			if (legacyShow >= 0) {
				this._mikaShowInputs = Boolean(this.widgets[legacyShow].value);
				this.widgets.splice(legacyShow, 1);
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

			startTick(this);
			hookRemove(this);
			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (info) {
			const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;

			// Restaurar show_inputs guardado en el workflow.
			const props = info?.properties ?? this.properties ?? {};
			const savedShow = props._mikaShowInputs;
			if (savedShow !== undefined) {
				this._mikaShowInputs = Boolean(savedShow);
			} else {
				const legacyIdx = (this.widgets ?? []).findIndex(
					(w) => cleanName(w.name) === "show_inputs"
				);
				if (legacyIdx >= 0) {
					this._mikaShowInputs = toBool(this.widgets[legacyIdx].value);
					this.widgets.splice(legacyIdx, 1);
				}
			}
			this._mikaPrevShowInputs = this._mikaShowInputs !== false;

			setTimeout(() => {
				ensureInputs(this);
				rebuild(this);
			}, 100);

			startTick(this);
			hookRemove(this);
			return r;
		};

		// Opción de menú contextual (click derecho sobre el nodo).
		const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
		nodeType.prototype.getExtraMenuOptions = function (_graph, options) {
			const r = origGetExtraMenuOptions
				? origGetExtraMenuOptions.apply(this, arguments)
				: undefined;

			if (Array.isArray(options)) {
				options.push(null);
				options.push({
					content:
						(this._mikaShowInputs !== false
							? "◉ Mostrar slots de entrada (activo)"
							: "◌ Mostrar slots de entrada (desactivado)"),
					callback: () => {
						this._mikaShowInputs = !(this._mikaShowInputs !== false);
						if (!this.properties) this.properties = {};
						this.properties._mikaShowInputs = this._mikaShowInputs;
						ensureInputs(this);
						this.setDirtyCanvas(true, true);
					},
				});
			}

			return r;
		};

		function hookRemove(node) {
			if (!node || node._mikaRemoveHooked) return;
			node._mikaRemoveHooked = true;
			const prevRemove = node.onRemoved;
			node.onRemoved = function () {
				try {
					stopTick(node);
					forgetController(node);
				} catch (e) {}
				if (typeof prevRemove === "function") prevRemove.apply(this, arguments);
			};
		}

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
	},
});
