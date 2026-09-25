import { app } from "/scripts/app.js";

const ROW_HEIGHT = 22; // alto fijo de cada fila (compacto)
const ROW_GAP = 4;

// Score List: los datos viven en un único widget STRING ("datos", JSON)
// que serializa ComfyUI de forma estándar. El DOM solo es la vista de ese
// valor, así los datos sobreviven al cambiar de pestaña/workflow.
app.registerExtension({
	name: "Mika.ScoreListLayout",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "ScoreListExtendable") return;

		const datosWidget = (node) =>
			node.widgets?.find((w) => String(w?.name ?? "").trim() === "datos");

		function readRows(node) {
			const w = datosWidget(node);
			try {
				const rows = JSON.parse(String(w?.value ?? "[]"));
				return Array.isArray(rows) ? rows : [];
			} catch (e) {
				return [];
			}
		}

		function writeRows(node, rows) {
			const w = datosWidget(node);
			if (!w) return;
			w.value = JSON.stringify(rows);
			w.callback?.(w.value);
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
			const w = datosWidget(node);
			if (!w) return;
			w.hidden = true;

			// Eliminar la vista anterior.
			const prev = node._mikaDomWidget;
			if (prev) {
				try { prev.element?.remove(); } catch (e) { /* no-op */ }
				try { prev.onRemove?.(); } catch (e) { /* no-op */ }
				const idx = node.widgets.indexOf(prev);
				if (idx >= 0) node.widgets.splice(idx, 1);
				node._mikaDomWidget = null;
			}

			const rows = readRows(node);

			const root = document.createElement("div");
			root.style.display = "flex";
			root.style.flexDirection = "column";
			root.style.gap = ROW_GAP + "px";
			root.style.width = "100%";
			root.style.boxSizing = "border-box";

			rows.forEach((row, i) => {
				const container = document.createElement("div");
				container.style.display = "flex";
				container.style.gap = "4px";
				container.style.width = "100%";
				container.style.height = ROW_HEIGHT + "px";
				container.style.alignItems = "center";

				// Nombre: 2/3 del ancho.
				const nameInput = document.createElement("input");
				nameInput.type = "text";
				nameInput.style.flex = "2 1 0%";
				styleInput(nameInput);
				nameInput.value = String(row?.nombre ?? "");

				// Valor: 1/3 del ancho.
				const valInput = document.createElement("input");
				valInput.type = "number";
				valInput.style.flex = "1 1 0%";
				styleInput(valInput);
				valInput.value = String(parseInt(row?.valor, 10) || 0);

				// La rueda del ratón NO debe cambiar el valor (solo flechas).
				valInput.addEventListener("wheel", (e) => {
					e.preventDefault();
					e.stopPropagation();
				}, { passive: false });

				nameInput.addEventListener("input", () => {
					rows[i] = { ...row, nombre: nameInput.value };
					row.nombre = nameInput.value;
					writeRows(node, rows);
				});

				valInput.addEventListener("input", () => {
					rows[i] = { ...row, valor: parseInt(valInput.value || "0", 10) || 0 };
					row.valor = rows[i].valor;
					writeRows(node, rows);
				});

				container.appendChild(nameInput);
				container.appendChild(valInput);
				root.appendChild(container);
			});

			// Botones para añadir / quitar filas.
			const footer = document.createElement("div");
			footer.style.display = "flex";
			footer.style.gap = "4px";
			footer.style.height = ROW_HEIGHT + "px";

			for (const [text, action] of [
				["+", () => { rows.push({ nombre: "", valor: 0 }); }],
				["–", () => { if (rows.length > 1) rows.pop(); }],
			]) {
				const btn = document.createElement("button");
				btn.textContent = text;
				btn.style.flex = "1 1 0%";
				btn.style.height = ROW_HEIGHT + "px";
				btn.style.border = "1px solid var(--border-color, #444)";
				btn.style.borderRadius = "3px";
				btn.style.background = "var(--comfy-input-bg, #222)";
				btn.style.color = "var(--input-text, #eee)";
				btn.style.cursor = "pointer";
				btn.addEventListener("click", () => {
					action();
					writeRows(node, rows);
					buildRows(node);
				});
				footer.appendChild(btn);
			}
			root.appendChild(footer);

			const domWidget = node.addDOMWidget("mika_score_rows", "div", root);
			domWidget.serialize = false;

			const totalH =
				rows.length * ROW_HEIGHT +
				rows.length * ROW_GAP +
				ROW_HEIGHT;
			try {
				domWidget.computeSize = function () {
					return [node.size?.[0] ?? 200, totalH];
				};
			} catch (e) { /* no-op */ }

			node._mikaDomWidget = domWidget;

			requestAnimationFrame(() => {
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

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
			setTimeout(() => buildRows(this), 100);
			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (info) {
			const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
			// Reconstruir con los datos restaurados del workflow.
			setTimeout(() => buildRows(this), 100);
			return r;
		};
	},
});
