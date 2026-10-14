import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Excel-Mika
// -----------------------------------------------------------------------
// Tabla editable estilo Excel para anotar scores/pruebas. Los datos
// viven en el widget STRING oculto ("datos", JSON {rows, cols, cells})
// que serializa ComfyUI de forma estándar.
//
// Tamaño: igual que ScoreList-Mika. Altura por fórmula (filas de alto
// fijo), sin medir el DOM ni dividir por zoom. Ancho compacto por
// defecto al crear (lo mínimo usable, medido en vivo); después lo
// manda el usuario. El elemento DOM lleva
// altura explícita igual a la fórmula, así la caja siempre calza con
// el contenido mida quien lo mida. Solo se re-encaja tras reconstruir:
// "exact" (crear, +/–, pegar) fija la altura exacta, "shrink" (cargar
// workflow / copiar) solo encoge el área gris sin pisar un tamaño
// manual. Sin equalize por medida directa: el wrapper DOM lo posiciona
// Vue de forma asíncrona y medirlo antes de tiempo daba deltas basura
// que agrandaban el nodo (carrera intermitente). Nada de syncWrap,
// settle ni onResize que peleen con el resize manual o recorten el
// contenido.
// -----------------------------------------------------------------------

const CELL_H = 22;
const GAP = 4;
const HEADER_H = 18;
const FOOTER_H = 22;
const MAX_ROWS = 50;
const MAX_COLS = 10;
const DEFAULT_W = 270;
// Geometría vertical medida en vivo (frontend 1.55.x): del cuerpo del
// nodo a la grilla hay 12px fijos, y el frontend añade 26px de más
// abajo (la franja gris del nodo A). Se recorta dejando 8px de aire
// bajo los botones, como el mockup B.
const WIDGET_TOP = 12;
const BOTTOM_MARGIN = 8;
const GRID_SLACK = 26 - BOTTOM_MARGIN;

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

		// Ancho por defecto al crear: como el nodo B de referencia (celdas
		// holgadas de ~70px: dígitos + stepper sin apreturas). Medido en
		// vivo: a 150px nada se recorta pero las celdas quedan mínimas;
		// el B equivale a ~190px para 2 columnas. Escala con columnas
		// para no romper pegados anchos.
		function compactWidth(cols) {
			const c = Math.max(1, Math.min(MAX_COLS, cols | 0 || 2));
			return Math.max(190, 48 + c * 70 + (c - 1) * 4);
		}

		// Altura siempre exacta (diseño B, sin área gris abajo): el
		// contenido tiene alto fijo por fórmula y el sobrante no sirve
		// para nada. Se intercepta setSize y se recorta cualquier exceso
		// de alto; el ancho queda libre y el colapsado intacto (más bajo
		// que la fórmula = se deja pasar). Así ni el resize manual ni un
		// auto-crece tardío del frontend dejan área extra. Sin bucles:
		// computeSize no llama a setSize.
		function clampHeight(node) {
			if (!node || node._mikaClampH) return;
			node._mikaClampH = true;
			const prev = node.setSize;
			if (typeof prev !== "function") return;
			node.setSize = function (size) {
				try {
					if (Array.isArray(size) && typeof size[1] === "number" && !this.flags?.collapsed) {
						let h = 0;
						try { h = Math.max(60, this.computeSize?.()?.[1] || 60); } catch (e) { h = 0; }
						if (h > 0 && size[1] > h + 1) size = [size[0], h];
					}
				} catch (e) { /* no-op */ }
				return prev.call(this, size);
			};
		}

		// Alto del contenido por fórmula: cabecera + N filas + footer +
		// un GAP entre cada bloque (N+1 gaps). Sin medir el DOM: el
		// elemento raíz lleva esta misma altura explícita.
		function contentHeight(rows) {
			return HEADER_H + rows * CELL_H + FOOTER_H + (rows + 1) * GAP;
		}

		// Alto total del nodo: contenido + offset superior, sin la franja
		// extra que añade el frontend (se deja solo BOTTOM_MARGIN).
		function fitHeight(rows) {
			return Math.max(60, contentHeight(rows) + WIDGET_TOP + BOTTOM_MARGIN);
		}

		function buildTable(node, fitMode, width) {
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
			// Altura explícita = fórmula: la caja calza con el contenido
			// sin depender de cómo el frontend dimensione el wrapper.
			root.style.height = contentHeight(data.rows) + "px";
			root.style.flexShrink = "0";

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
			// Altura declarada = contenido − franja: así el cálculo propio
			// del frontend (que suma la franja de más) converge al mismo
			// alto del refit en vez de re-agrandar el nodo.
			domWidget.computeSize = () => [
				node.size?.[0] ?? DEFAULT_W,
				contentHeight(data.rows) - GRID_SLACK,
			];
			node._mikaDomWidget = domWidget;

			// Re-encaje tras reconstruir, solo con la fórmula (sin leer el
			// DOM: idempotente, converge siempre al mismo alto). "exact"
			// (crear, +/–, pegar): fija la altura exacta. "shrink" (cargar
			// workflow / copiar): solo encoge sin pisar un tamaño manual
			// guardado por el usuario. El ancho solo se impone al crear
			// (width != null → compacto); en +/–/pegar/cargar lo manda el
			// usuario (igual que ScoreList-Mika). Se repite un par de veces
			// porque el frontend solo auto-crece el nodo, nunca lo encoge.
			const refit = () => {
				try {
					const h = fitHeight(data.rows);
					const curH = node.size?.[1] ?? h;
					const curW = node.size?.[0] ?? DEFAULT_W;
					const newW = width != null ? width : curW;
					const newH = (fitMode === "exact" || curH - h > 1) ? h : curH;
					if (Math.abs(newW - curW) > 0.5 || Math.abs(newH - curH) > 0.5) {
						node.setSize([newW, newH]);
					}
				} catch (e) { /* no-op */ }
				relayout(node);
			};
			requestAnimationFrame(refit);
			setTimeout(refit, 150);
			setTimeout(refit, 400);
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
			hideDatos(this);
			// Tamaño exacto desde el primer frame (evita saltos); el
			// refit "exact" lo confirma con las columnas/filas reales.
			// Va ANTES de clampHeight: sin widget aún, computeSize daría
			// un alto mínimo y el clamp lo aplastaría.
			try {
				const d0 = readData(this);
				this.setSize([compactWidth(d0.cols), fitHeight(d0.rows)]);
			} catch (e) { /* no-op */ }
			clampHeight(this);
			setTimeout(() => buildTable(this, "exact", compactWidth(readData(this).cols)), 100);
			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (info) {
			const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
			clampHeight(this);
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
