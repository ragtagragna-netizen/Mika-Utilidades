import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Excel-Mika
// -----------------------------------------------------------------------
// Tabla editable estilo Excel para anotar scores/pruebas. Los datos
// viven en el widget STRING oculto ("datos", JSON {rows, cols, cells})
// que serializa ComfyUI de forma estándar.
//
// Tamaño: igual que ScoreList-Mika. Altura por fórmula (filas de alto
// fijo), sin medir el DOM ni dividir por zoom. Solo se re-encaja tras
// reconstruir: "exact" (crear, +/–, pegar) calza al contenido,
// "shrink" (cargar workflow / copiar) solo encoge el área gris sin
// pisar un tamaño manual. Nada de syncWrap, settle ni onResize que
// peleen con el resize manual o recorten el contenido.
// -----------------------------------------------------------------------

const CELL_H = 22;
const GAP = 4;
const HEADER_H = 18;
const FOOTER_H = 22;
const MAX_ROWS = 50;
const MAX_COLS = 10;
const DEFAULT_W = 270;
// Recorte inferior: el frontend monta el wrapper DOM con
// alto = computedHeight - 2*10 (margen) y el nodo suma +38
// (título + resto). Medido en vivo: con recorte 10 el gris
// inferior queda en ~2.5px frente a 10px del lateral; con 2
// ambos quedan en ~10px. Verificado con Playwright.
const BOTTOM_TRIM = 2;

app.registerExtension({
	name: "Mika.ExcelLayout",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "ExcelMika") return;

		const datosWidget = (node) =>
			node.widgets?.find((w) => String(w?.name ?? "").trim() === "datos");

		function readData(node) {
			let rows = 4, cols = 2, cells = [], names = [];
			try {
				const d = JSON.parse(String(datosWidget(node)?.value ?? ""));
				if (d && typeof d === "object") {
					if (Number.isFinite(+d.rows)) rows = Math.max(1, Math.min(MAX_ROWS, +d.rows | 0));
					if (Number.isFinite(+d.cols)) cols = Math.max(1, Math.min(MAX_COLS, +d.cols | 0));
					if (Array.isArray(d.cells)) cells = d.cells;
					if (Array.isArray(d.names)) names = d.names;
				}
			} catch (e) { /* datos corruptos: grilla vacía */ }
			const grid = [];
			for (let r = 0; r < rows; r++) {
				const row = [];
				for (let c = 0; c < cols; c++) {
					row.push(r < cells.length && Array.isArray(cells[r]) && c < cells[r].length
						? String(cells[r][c] ?? "")
						: "");
				}
				grid.push(row);
			}
			const colNames = [];
			for (let c = 0; c < cols; c++) {
				colNames.push(String(names[c] ?? colName(c)));
			}
			return { rows, cols, cells: grid, names: colNames };
		}

		function writeData(node, data) {
			const w = datosWidget(node);
			if (!w) return;
			w.value = JSON.stringify({ rows: data.rows, cols: data.cols, cells: data.cells, names: data.names });
			w.callback?.(w.value);
		}

		// El widget "datos" solo es almacenamiento: cero impacto en el
		// layout. Se oculta en cuanto el nodo existe (no 100ms después
		// en buildTable) para que el primer computeSize ya lo excluya;
		// sin esto el tamaño por defecto incluía su altura (nodo B).
		function hideDatos(node) {
			const w = datosWidget(node);
			if (!w) return;
			w.hidden = true;
			try { w.computeSize = () => [0, 0]; } catch (e) { /* no-op */ }
			try { w.h = 0; } catch (e) { /* no-op */ }
		}

		// Re-encaje completo: setSize solo no mueve el wrapper DOM en
		// el frontend nuevo; hay que invalidar toda la cadena igual
		// que hace text_concatenate_dynamic.js (si no, el wrapper se
		// queda clavado en su altura inicial y el contenido se recorta
		// o sobra gris abajo).
		function relayout(node) {
			try { node.setDirtyCanvas(true, true); } catch (e) { /* no-op */ }
			try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) { /* no-op */ }
			try { app.canvas?.setDirty?.(true, true); } catch (e) { /* no-op */ }
			try { node.graph?.change?.(); } catch (e) { /* no-op */ }
		}

		function styleCell(el) {
			el.style.minWidth = "0";
			el.style.width = "100%";
			el.style.boxSizing = "border-box";
			el.style.background = "var(--comfy-input-bg, #222)";
			el.style.border = "1px solid var(--border-color, #444)";
			el.style.borderRadius = "3px";
			el.style.color = "var(--input-text, #eee)";
			el.style.padding = "1px 4px";
			el.style.height = "18px";
			el.style.fontSize = "11px";
		}

		function styleHead(el) {
			el.style.color = "var(--descrip-text, #888)";
			el.style.fontSize = "10px";
			el.style.textAlign = "center";
			el.style.padding = "0 2px";
			el.style.userSelect = "none";
		}

		function styleBtn(btn) {
			btn.style.flex = "1 1 0%";
			btn.style.height = FOOTER_H + "px";
			btn.style.border = "1px solid var(--border-color, #444)";
			btn.style.borderRadius = "3px";
			btn.style.background = "var(--comfy-input-bg, #222)";
			btn.style.color = "var(--input-text, #eee)";
			btn.style.cursor = "pointer";
			btn.style.fontSize = "11px";
		}

		// Suma/resta 1 a un texto numérico puro ("4"→"5", "4.0"→"5.0").
		// null si no es número (texto, vacío): esas celdas no se tocan.
		function bumpNumber(str, dir) {
			const t = String(str ?? "").trim();
			if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
			const v = parseFloat(t);
			if (!Number.isFinite(v)) return null;
			const m = /\.(\d+)$/.exec(t);
			if (!m) return String(Math.round(v) + dir);
			return (v + dir).toFixed(m[1].length);
		}

		function colName(i) {
			let s = "";
			i++;
			while (i > 0) {
				const m = (i - 1) % 26;
				s = String.fromCharCode(65 + m) + s;
				i = ((i - 1) / 26) | 0;
			}
			return s;
		}

		// Alto del contenido por fórmula: cabecera + N filas + footer +
		// un GAP entre cada bloque (N+1 gaps), menos el recorte que
		// iguala el margen inferior al lateral. Sin medir el DOM.
		function contentHeight(rows) {
			return HEADER_H + rows * CELL_H + FOOTER_H + (rows + 1) * GAP - BOTTOM_TRIM;
		}

		function buildTable(node, fitMode) {
			if (typeof node.addDOMWidget !== "function") return;
			hideDatos(node);
			const w = datosWidget(node);
			if (!w) return;

			const prev = node._mikaDomWidget;
			if (prev) {
				try { prev.element?.remove(); } catch (e) { /* no-op */ }
				try { prev.onRemove?.(); } catch (e) { /* no-op */ }
				const idx = node.widgets.indexOf(prev);
				if (idx >= 0) node.widgets.splice(idx, 1);
				node._mikaDomWidget = null;
			}

			const data = readData(node);

			const root = document.createElement("div");
			root.style.display = "flex";
			root.style.flexDirection = "column";
			root.style.gap = GAP + "px";
			root.style.width = "100%";
			root.style.boxSizing = "border-box";

			const head = document.createElement("div");
			head.style.display = "flex";
			head.style.gap = "4px";
			head.style.height = HEADER_H + "px";
			head.style.flexShrink = "0";
			head.style.alignItems = "center";
			const corner = document.createElement("div");
			corner.style.width = "24px";
			corner.style.flexShrink = "0";
			head.appendChild(corner);
			// Cabeceras editables: doble clic para renombrar la columna
			// (A/B/C → el nombre que quieras). Enter o salir guarda;
			// vacío devuelve la letra por defecto.
			for (let c = 0; c < data.cols; c++) {
				const lab = document.createElement("input");
				lab.type = "text";
				lab.value = data.names[c];
				lab.title = "Doble clic para renombrar la columna";
				lab.readOnly = true;
				lab.style.flex = "1 1 0%";
				lab.style.minWidth = "0";
				lab.style.boxSizing = "border-box";
				lab.style.border = "none";
				lab.style.background = "transparent";
				styleHead(lab);
				lab.style.textAlign = "center";
				lab.style.height = HEADER_H + "px";
				lab.style.pointerEvents = "auto";
				lab.style.cursor = "default";
				lab.addEventListener("dblclick", () => {
					lab.readOnly = false;
					lab.style.background = "var(--comfy-input-bg, #222)";
					lab.style.border = "1px solid var(--border-color, #444)";
					lab.focus();
					lab.select();
				});
				const commit = () => {
					const v = lab.value.trim() || colName(c);
					data.names[c] = v;
					lab.value = v;
					lab.readOnly = true;
					lab.style.background = "transparent";
					lab.style.border = "none";
					writeData(node, data);
				};
				lab.addEventListener("blur", commit);
				lab.addEventListener("keydown", (e) => {
					if (e.key === "Enter") { e.preventDefault(); lab.blur(); }
					if (e.key === "Escape") { lab.value = data.names[c]; lab.blur(); }
				});
				head.appendChild(lab);
			}
			root.appendChild(head);

			const inputs = [];
			for (let r = 0; r < data.rows; r++) {
				const row = document.createElement("div");
				row.style.display = "flex";
				row.style.gap = "4px";
				row.style.height = CELL_H + "px";
				row.style.flexShrink = "0";
				row.style.alignItems = "center";
				const num = document.createElement("div");
				num.textContent = String(r + 1);
				num.style.width = "24px";
				num.style.flexShrink = "0";
				styleHead(num);
				num.style.textAlign = "center";
				row.appendChild(num);
				inputs.push([]);
				for (let c = 0; c < data.cols; c++) {
					const cell = document.createElement("div");
					cell.style.flex = "1 1 0%";
					cell.style.minWidth = "0";
					cell.style.position = "relative";
					cell.style.display = "flex";
					cell.style.alignItems = "center";
					const inp = document.createElement("input");
					inp.type = "text";
					inp.dataset.r = String(r);
					inp.dataset.c = String(c);
					inp.style.flex = "1 1 0%";
					styleCell(inp);
					inp.style.paddingRight = "14px";
					inp.value = data.cells[r][c];
					// Flechas interiores estilo spinner nativo: siempre
					// visibles. Vacía → 0; número → ±1; con texto no hacen
					// nada (para no borrar sin querer).
					const step = document.createElement("div");
					step.style.position = "absolute";
					step.style.right = "2px";
					step.style.top = "1px";
					step.style.bottom = "1px";
					step.style.width = "12px";
					step.style.display = "flex";
					step.style.flexDirection = "column";
					for (const [arrow, dir] of [["▲", 1], ["▼", -1]]) {
						const b = document.createElement("button");
						b.textContent = arrow;
						b.tabIndex = -1;
						b.type = "button";
						b.style.flex = "1 1 0%";
						b.style.fontSize = "7px";
						b.style.lineHeight = "1";
						b.style.padding = "0";
						b.style.border = "none";
						b.style.background = "transparent";
						b.style.color = "var(--descrip-text, #888)";
						b.style.cursor = "pointer";
						b.addEventListener("mousedown", (e) => e.preventDefault());
						b.addEventListener("click", () => {
							const cur = data.cells[r][c];
							let nv;
							if (String(cur).trim() === "") nv = "0";
							else {
								nv = bumpNumber(cur, dir);
								if (nv === null) return;
							}
							data.cells[r][c] = nv;
							inp.value = nv;
							writeData(node, data);
							inp.focus();
							try { inp.setSelectionRange(nv.length, nv.length); } catch (e) { /* no-op */ }
						});
						step.appendChild(b);
					}
					inp.addEventListener("input", () => {
						data.cells[r][c] = inp.value;
						writeData(node, data);
					});
					inp.addEventListener("keydown", (e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							const below = inputs[r + 1]?.[c];
							if (below) below.focus();
						}
					});
					cell.appendChild(inp);
					cell.appendChild(step);
					row.appendChild(cell);
					inputs[r].push(inp);
				}
				root.appendChild(row);
			}

			// Pegado estilo Excel (delegado en la raíz): multilínea
			// rellena hacia abajo desde la celda con foco, tabs a la
			// derecha, agrandando la grilla si hace falta.
			root.addEventListener("paste", (e) => {
				const t = e.target?.closest?.("input[data-r]");
				if (!t) return;
				const raw = e.clipboardData?.getData("text/plain");
				if (raw == null || raw === "") return;
				e.preventDefault();
				const r0 = +t.dataset.r, c0 = +t.dataset.c;
				const lines = String(raw).replace(/\r\n?/g, "\n").split("\n");
				if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
				const needR = Math.min(MAX_ROWS, r0 + lines.length);
				const needC = Math.min(MAX_COLS, c0 + Math.max(...lines.map((l) => l.split("\t").length)));
				while (data.rows < needR) {
					data.cells.push(new Array(data.cols).fill(""));
					data.rows++;
				}
				while (data.cols < needC) {
					for (const row of data.cells) row.push("");
					data.names.push(colName(data.cols));
					data.cols++;
				}
				lines.forEach((line, i) => {
					if (r0 + i >= data.rows) return;
					line.split("\t").forEach((val, j) => {
						if (c0 + j < data.cols) data.cells[r0 + i][c0 + j] = val;
					});
				});
				writeData(node, data);
				buildTable(node, "exact");
			});

			// Botones de filas / columnas.
			const footer = document.createElement("div");
			footer.style.display = "flex";
			footer.style.gap = "4px";
			footer.style.height = FOOTER_H + "px";
			footer.style.flex = "0 0 auto";
			for (const [text, title, action] of [
				["+Fila", "Agregar fila", () => {
					if (data.rows >= MAX_ROWS) return;
					data.cells.push(new Array(data.cols).fill(""));
					data.rows++;
				}],
				["–Fila", "Quitar última fila", () => {
					if (data.rows <= 1) return;
					data.cells.pop();
					data.rows--;
				}],
				["+Col", "Agregar columna", () => {
					if (data.cols >= MAX_COLS) return;
					for (const row of data.cells) row.push("");
					data.names.push(colName(data.cols));
					data.cols++;
				}],
				["–Col", "Quitar última columna", () => {
					if (data.cols <= 1) return;
					for (const row of data.cells) row.pop();
					data.names.pop();
					data.cols--;
				}],
			]) {
				const btn = document.createElement("button");
				btn.textContent = text;
				btn.title = title;
				btn.type = "button";
				styleBtn(btn);
				btn.addEventListener("click", () => {
					action();
					writeData(node, data);
					buildTable(node, "exact");
				});
				footer.appendChild(btn);
			}
			root.appendChild(footer);

			const domWidget = node.addDOMWidget("mika_excel_grid", "div", root);
			domWidget.serialize = false;
			domWidget.computeSize = () => [
				node.size?.[0] ?? DEFAULT_W,
				contentHeight(data.rows),
			];
			node._mikaDomWidget = domWidget;

			// Un único re-encaje tras reconstruir. "exact" (crear, +/–,
			// pegar): el nodo calza al contenido en ambas dimensiones
			// (ancho mínimo = lo más pequeño posible, tipo nodo A).
			// "shrink" (cargar workflow / copiar): solo encoge sin pisar
			// un tamaño manual guardado por el usuario.
			// Tras el encaje, iguala el hueco gris inferior al lateral
			// midiéndolos en pantalla: ninguna constante (margen del
			// wrapper, +38 del frontend, etc.) es fiable entre versiones
			// del frontend, así que se corrige por medida directa.
			const equalize = () => {
				try {
					const ds = app.canvas?.ds;
					if (!ds || !node.size) return;
					const s = ds.scale || 1;
					const off = ds.offset || [0, 0];
					const rect = root.getBoundingClientRect();
					if (!rect.height || !rect.width) return;
					const sideGap = rect.left - (node.pos[0] * s + off[0]);
					const bottomGap = (node.pos[1] + node.size[1]) * s + off[1] - rect.bottom;
					const delta = (bottomGap - sideGap) / s;
					if (Math.abs(delta) > 0.5) {
						node.setSize([node.size[0], Math.max(60, node.size[1] - delta)]);
						relayout(node);
					}
				} catch (e) { /* no-op */ }
			};
			const refit = () => {
				try {
					const size = node.computeSize();
					const h = Math.max(60, size?.[1] || 60);
					const minW = Math.max(0, size?.[0] || 0);
					const curW = node.size?.[0] ?? minW;
					const curH = node.size?.[1] ?? h;
					if (fitMode === "exact") {
						node.setSize([minW, h]);
					} else if (curH - h > 1) {
						node.setSize([curW, h]);
					}
				} catch (e) { /* no-op */ }
				relayout(node);
				requestAnimationFrame(equalize);
			};
			requestAnimationFrame(refit);
			setTimeout(refit, 400);
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
			hideDatos(this);
			setTimeout(() => buildTable(this, "exact"), 100);
			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (info) {
			const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
			setTimeout(() => buildTable(this, "shrink"), 100);
			return r;
		};

		const onRemove = nodeType.prototype.onRemove;
		nodeType.prototype.onRemove = function () {
			const prev = this._mikaDomWidget;
			if (prev) {
				try { prev.element?.remove(); } catch (e) { /* no-op */ }
				this._mikaDomWidget = null;
			}
			return onRemove ? onRemove.apply(this, arguments) : undefined;
		};
	},
});
