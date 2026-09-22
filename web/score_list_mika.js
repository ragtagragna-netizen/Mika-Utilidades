import { app } from "/scripts/app.js";

const MAX_ROWS = 50;
const ROW_HEIGHT = 22; // alto fijo de cada fila (compacto)

app.registerExtension({
	name: "Mika.ScoreListLayout",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "ScoreListExtendable") return;

		const cleanName = (v) => String(v ?? "").trim();
		let buildCounter = 0;

		function getRowsCount(node) {
			const w = node.widgets?.find((w) => cleanName(w.name) === "num_rows");
			let n = parseInt(w?.value, 10);
			if (Number.isNaN(n)) n = 5;
			return Math.max(1, Math.min(MAX_ROWS, n));
		}

		function refreshSize(node) {
			requestAnimationFrame(() => {
				try {
					node.onResize?.(node.size);
				} catch (e) { /* no-op */ }
				try {
					const size = node.computeSize();
					node.setSize([
						Math.max(220, size?.[0] || 220),
						Math.max(50, size?.[1] || 50),
					]);
				} catch (e) { /* no-op */ }
				node.setDirtyCanvas(true, true);
			});
		}

		function clearRowWidgets(node) {
			// 1) Eliminar los elementos DOM de las filas anteriores.
			for (const el of node._mikaRowElements || []) {
				try { el.remove(); } catch (e) { /* no-op */ }
			}
			node._mikaRowElements = [];

			// 2) Eliminar los DOM widgets del array de widgets.
			for (const w of node._mikaRowWidgets || []) {
				try { w.onRemove?.(); } catch (e) { /* no-op */ }
				const idx = node.widgets.indexOf(w);
				if (idx >= 0) node.widgets.splice(idx, 1);
			}
			node._mikaRowWidgets = [];
		}

		function styleInput(el) {
			el.style.minWidth = "0";
			el.style.boxSizing = "border-box";
			el.style.background = "var(--comfy-input-bg, #222)";
			el.style.border = "1px solid var(--border-color, #444)";
			el.style.borderRadius = "3px";
			el.style.color = "var(--input-text, #eee)";
			el.style.padding = "1px 4px";
			el.style.height = "18px";
			el.style.fontSize = "11px";
		}

		function buildRows(node) {
			if (typeof node.addDOMWidget !== "function") return;

			clearRowWidgets(node);
			buildCounter++;

			// Ocultar los widgets originales (siguen serializando su valor).
			for (let i = 1; i <= MAX_ROWS; i++) {
				const nameW = node.widgets?.find((w) => cleanName(w.name) === `nombre_${i}`);
				const valW = node.widgets?.find((w) => cleanName(w.name) === String(i));
				if (nameW) nameW.hidden = true;
				if (valW) valW.hidden = true;
			}

			const rows = getRowsCount(node);

			// Un único DOM widget que contiene TODAS las filas, para evitar que
			// los DOM widgets individuales se solapen / colapsen al cambiar de
			// pestaña en ComfyUI.
			const root = document.createElement("div");
			root.style.display = "flex";
			root.style.flexDirection = "column";
			root.style.gap = "4px";
			root.style.width = "100%";
			root.style.boxSizing = "border-box";

			for (let i = 1; i <= rows; i++) {
				const nameW = node.widgets?.find((w) => cleanName(w.name) === `nombre_${i}`);
				const valW = node.widgets?.find((w) => cleanName(w.name) === String(i));

				const container = document.createElement("div");
				container.style.display = "flex";
				container.style.gap = "4px";
				container.style.width = "100%";
				container.style.height = ROW_HEIGHT + "px";
				container.style.alignItems = "center";
				container.style.margin = "0";
				container.style.padding = "0";

				// Nombre: 2/3 del ancho (vacío por defecto).
				const nameInput = document.createElement("input");
				nameInput.type = "text";
				nameInput.style.flex = "2 1 0%";
				styleInput(nameInput);
				nameInput.value = String(nameW?.value ?? "");

				// Valor: 1/3 del ancho.
				const valInput = document.createElement("input");
				valInput.type = "number";
				valInput.style.flex = "1 1 0%";
				styleInput(valInput);
				valInput.value = String(valW?.value ?? 0);

				// La rueda del ratón NO debe cambiar el valor (solo flechas).
				valInput.addEventListener("wheel", (e) => {
					e.preventDefault();
					e.stopPropagation();
				}, { passive: false });

				nameInput.addEventListener("input", () => {
					if (nameW) {
						nameW.value = nameInput.value;
						nameW.callback?.(nameW.value);
					}
				});

				valInput.addEventListener("input", () => {
					if (valW) {
						valW.value = parseInt(valInput.value || "0", 10) || 0;
						valW.callback?.(valW.value);
					}
				});

				container.appendChild(nameInput);
				container.appendChild(valInput);
				root.appendChild(container);
			}

			const domWidget = node.addDOMWidget(
				`mika_rows_${buildCounter}`,
				"mika_score_rows",
				root
			);
			domWidget.serialize = false;

			// Alto fijo = filas apiladas (22px cada una + 4px de gap).
			const totalH = rows * ROW_HEIGHT + (rows - 1) * 4;
			root.style.height = Math.max(ROW_HEIGHT, totalH) + "px";
			try {
				domWidget.computeSize = function () {
					return [node.size?.[0] ?? 200, Math.max(ROW_HEIGHT, totalH)];
				};
			} catch (e) { /* no-op */ }

			node._mikaRowWidgets.push(domWidget);
			node._mikaRowElements.push(root);

			// Widget num_rows al principio + hook para reconstruir.
			const rowsW = node.widgets?.find((w) => cleanName(w.name) === "num_rows");
			if (rowsW) {
				const idx = node.widgets.indexOf(rowsW);
				if (idx > 0) {
					node.widgets.splice(idx, 1);
					node.widgets.unshift(rowsW);
				}

				if (!rowsW._mikaHooked) {
					rowsW._mikaHooked = true;
					const oldCb = rowsW.callback;
					rowsW.callback = (v) => {
						oldCb?.(v);
						setTimeout(() => buildRows(node), 0);
					};
				}
			}

			node._mikaPrevRows = rows;
			refreshSize(node);
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
			this._mikaRowWidgets = [];
			this._mikaRowElements = [];
			this._mikaPrevRows = getRowsCount(this);
			setTimeout(() => buildRows(this), 100);
			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (info) {
			const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
			this._mikaRowWidgets = [];
			this._mikaRowElements = [];
			this._mikaPrevRows = getRowsCount(this);
			setTimeout(() => buildRows(this), 100);
			return r;
		};

		// Polling: detecta cambios de num_rows (flechas del widget).
		const onDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (ctx) {
			const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;

			const now = Date.now();
			if (!this._mikaLastLayout || now - this._mikaLastLayout > 200) {
				this._mikaLastLayout = now;
				const rows = getRowsCount(this);
				if (rows !== this._mikaPrevRows) {
					this._mikaPrevRows = rows;
					buildRows(this);
				}
			}

			return r;
		};
	},
});