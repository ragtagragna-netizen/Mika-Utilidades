import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Pose Gallery
// -----------------------------------------------------------------------
// Nodo con una galería de las 491 poses de WaveSpeed AI. La ventana (estilo
// File Picker-Mika) muestra un grid virtualizado con buscador, categoría,
// estilo (line/3d) y ángulo; al elegir una pose se ve en el panel y el nodo
// Python la entrega como IMAGE. La pose elegida viaja en el widget oculto
// "seleccion" (JSON {id, estilo, angulo}).
// -----------------------------------------------------------------------

const CATEGORY_LABELS = {
	"standing": "De pie",
	"fashion": "Moda",
	"glamour": "Glamour y pin-up",
	"boudoir": "Boudoir",
	"couple": "Parejas",
	"everyday": "Cotidiano",
	"sitting-chair": "Sentada en silla",
	"sitting-floor": "Sentada en el suelo",
	"kneeling": "Arrodillada",
	"lying": "Recostada",
	"upper-body": "Cuerpo superior",
	"duo": "Dos personas",
	"action": "Deporte y acción",
	"dance": "Baile",
	"dynamic": "Heroico y cinematográfico",
};

const STYLES = ["line", "3d"];
const STYLE_LABELS = { line: "Line art", "3d": "3D" };
const ANGLES = ["Front", "3/4", "Side"];

const LS_STYLE = "PoseGalleryMika.style";
const LS_ANGLE = "PoseGalleryMika.angle";

const catLabel = (id) => CATEGORY_LABELS[id] || id;
const imgFile = (pose, estilo, angulo) => {
	const imgs = pose?.img?.[estilo] || pose?.img?.line || [];
	return imgs[Math.min(angulo, imgs.length - 1)] || imgs[0] || "";
};
const readInt = (key, def, min, max) => {
	const v = parseInt(localStorage.getItem(key), 10);
	return Number.isFinite(v) && v >= min && v <= max ? v : def;
};

// Pregunta el alcance de la descarga masiva en un menú chico.
function chooseScope(onPick) {
	const ov = document.createElement("div");
	ov.style.cssText =
		"position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10001;display:flex;align-items:center;justify-content:center";
	const bx = document.createElement("div");
	bx.style.cssText =
		"background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:8px;min-width:250px";
	const btnCss =
		"padding:8px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;cursor:pointer;text-align:left";
	const mk = (label, scope) => {
		const b = document.createElement("button");
		b.textContent = label;
		b.style.cssText = btnCss;
		b.onclick = () => { ov.remove(); onPick(scope); };
		return b;
	};
	const cancel = document.createElement("button");
	cancel.textContent = "Cancelar";
	cancel.style.cssText = btnCss;
	cancel.onclick = () => ov.remove();
	bx.append(mk("Solo line art (1.473)", "line"),
		mk("Line art + 3D (2.946)", "all"), cancel);
	ov.appendChild(bx);
	ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
	document.body.appendChild(ov);
}

// Arranca la descarga masiva en el servidor y sigue el progreso.
async function startBulkDownload(scope, setLabel) {
	let poll = 0;
	try {
		const job = fetch(`/mika/pose_gallery/cache?scope=${scope}`);
		poll = setInterval(async () => {
			try {
				const s = await (await fetch("/mika/pose_gallery/cache_status")).json();
				if (s.total > 0) setLabel(`⬇ Descargando ${s.done}/${s.total}...`);
				if (!s.running && poll) { clearInterval(poll); poll = 0; }
			} catch (e) { /* reintenta */ }
		}, 500);
		await job;
	} catch (err) {
		console.error("PoseGalleryMika:", err);
	} finally {
		if (poll) clearInterval(poll);
		setLabel("⬇ Descargar todas");
	}
}

app.registerExtension({
	name: "Mika.PoseGalleryMika",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "PoseGalleryMika") return;

		const seleccionWidget = (node) =>
			node.widgets?.find((w) => w.name === "seleccion");

		// Guarda la pose elegida en el widget oculto (viaja con el workflow).
		function writeSelection(node, pose, estilo, angulo) {
			const w = seleccionWidget(node);
			if (!w || !pose) return;
			const value = JSON.stringify({
				id: pose.id, estilo, angulo: angulo,
			});
			w.value = value;
			if (typeof w.callback === "function") w.callback(value);
			node.setDirtyCanvas(true, true);
		}

		async function openGallery(node) {
			const resp = await fetch("/mika/pose_gallery/list");
			const manifest = await resp.json();
			const poses = manifest.poses || [];
			if (!poses.length) {
				alert("No se pudo leer el listado de poses (" +
					(manifest.error || "data/poses.json") + ").");
				return;
			}

			let estilo = STYLES.includes(localStorage.getItem(LS_STYLE))
				? localStorage.getItem(LS_STYLE) : "line";
			let angulo = readInt(LS_ANGLE, 0, 0, ANGLES.length - 1);

			// Pose ya guardada (si la hay) para arrancar el panel.
			let selected = null;
			try {
				const saved = JSON.parse(seleccionWidget(node)?.value || "");
				selected = poses.find((p) => p.id === saved?.id) || null;
			} catch (e) { /* sin selección previa */ }

			// --- Overlay ---
			const overlay = document.createElement("div");
			overlay.style.cssText =
				"position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center";

			const box = document.createElement("div");
			box.style.cssText =
				"background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:8px;width:95vw;height:90vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.6)";

			// --- Cabecera ---
			const header = document.createElement("div");
			header.style.cssText =
				"display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid #333";

			const filter = document.createElement("input");
			filter.placeholder = `Buscar en ${poses.length} poses...`;
			filter.style.cssText =
				"flex:1;padding:6px 8px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px";

			const catSel = document.createElement("select");
			catSel.style.cssText =
				"padding:6px 4px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px";
			catSel.appendChild(new Option("Todas las categorías", ""));
			for (const c of manifest.categories || []) {
				catSel.appendChild(new Option(`${catLabel(c.id)} (${c.count})`, c.id));
			}

			const styleBtn = document.createElement("button");
			styleBtn.style.cssText =
				"padding:6px 12px;min-width:90px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;cursor:pointer";
			const syncStyleBtn = () => { styleBtn.textContent = STYLE_LABELS[estilo]; };

			const angleSel = document.createElement("select");
			angleSel.style.cssText = catSel.style.cssText;
			ANGLES.forEach((a, i) => angleSel.appendChild(new Option(a, String(i))));

			const count = document.createElement("span");
			count.style.cssText = "color:#999;white-space:nowrap";

			const closeBtn = document.createElement("button");
			closeBtn.textContent = "✕";
			closeBtn.title = "Cerrar";
			closeBtn.style.cssText =
				"padding:6px 12px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;cursor:pointer";

			header.append(filter, catSel, styleBtn, angleSel, count, closeBtn);

			// --- Cuerpo: grid + panel ---
			const body = document.createElement("div");
			body.style.cssText = "display:flex;flex:1;min-height:0";

			const gridWrap = document.createElement("div");
			gridWrap.style.cssText =
				"flex:1;overflow-y:auto;padding:0 10px;position:relative";
			const spacer = document.createElement("div");
			spacer.style.cssText = "position:relative;width:100%";
			gridWrap.appendChild(spacer);

			const panel = document.createElement("div");
			panel.style.cssText =
				"width:340px;flex-shrink:0;border-left:1px solid #333;display:flex;flex-direction:column;padding:10px;gap:8px";
			const preview = document.createElement("img");
			preview.style.cssText =
				"width:100%;max-height:52vh;object-fit:contain;border-radius:4px;background:repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50%/16px 16px";
			const pName = document.createElement("strong");
			pName.style.cssText = "font-size:15px";
			const pCat = document.createElement("small");
			pCat.style.cssText = "color:#999";
			const pDesc = document.createElement("div");
			pDesc.style.cssText =
				"font-size:12px;color:#bbb;white-space:pre-wrap;overflow-y:auto;flex:1;min-height:40px";

			const actions = document.createElement("div");
			actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
			const selectBtn = document.createElement("button");
			selectBtn.textContent = "✔ Seleccionar";
			selectBtn.style.cssText =
				"flex:1;padding:8px;background:#2a5a2a;color:#ddd;border:1px solid #4a4;border-radius:4px;cursor:pointer;white-space:nowrap";
			const copyBtn = document.createElement("button");
			copyBtn.textContent = "📋 Copiar imagen";
			copyBtn.title = "Copiar al portapapeles (para pegar en el lienzo)";
			copyBtn.style.cssText =
				"flex:1;padding:8px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;cursor:pointer;white-space:nowrap";
			const dlBtn = document.createElement("button");
			dlBtn.textContent = "⬇ Descargar";
			dlBtn.title = "Guardar esta pose como PNG";
			dlBtn.style.cssText = copyBtn.style.cssText;
			actions.append(selectBtn, copyBtn, dlBtn);

			panel.append(preview, pName, pCat, pDesc, actions);
			body.append(gridWrap, panel);

			box.append(header, body);
			overlay.appendChild(box);
			document.body.appendChild(overlay);

			// --- Selección + panel ---
			const showPreview = (pose) => {
				const file = imgFile(pose, estilo, angulo);
				preview.src = file
					? `/mika/pose_gallery/image?file=${encodeURIComponent(file)}&format=webp`
					: "";
				pName.textContent = pose?.name || "";
				pCat.textContent = catLabel(pose?.category);
				pDesc.textContent = pose?.desc || "";
			};

			const choose = (pose) => {
				selected = pose;
				showPreview(pose);
			};

			// --- Filtro + grid virtualizado ---
			let filtered = [];
			const refreshFiltered = () => {
				const t = filter.value.trim().toLowerCase();
				const cat = catSel.value;
				filtered = poses.filter((p) => {
					if (cat && p.category !== cat) return false;
					if (!t) return true;
					return (p.name || "").toLowerCase().includes(t) ||
						(p.id || "").toLowerCase().includes(t) ||
						(p.tags || []).some((tag) => tag.toLowerCase().includes(t));
				});
				count.textContent = `${filtered.length} poses`;
			};

			const COLS = 7, GAP = 10, LABEL_H = 30, PAD = 4;
			const renderWindow = () => {
				const width = gridWrap.clientWidth - 20;
				if (width <= 0) return;
				const cellW = Math.floor((width - GAP * (COLS - 1)) / COLS);
				const cellH = cellW + LABEL_H + PAD * 2;
				const rowH = cellH + GAP;
				const rows = Math.ceil(filtered.length / COLS);
				spacer.style.height = Math.max(0, rows * rowH - GAP) + "px";
				spacer.innerHTML = "";

				if (!filtered.length) {
					const empty = document.createElement("div");
					empty.textContent = "Sin resultados";
					empty.style.cssText = "padding:10px;color:#999";
					spacer.appendChild(empty);
					return;
				}

				const firstRow = Math.max(0, Math.floor(gridWrap.scrollTop / rowH) - 1);
				const visRows = Math.ceil(gridWrap.clientHeight / rowH) + 2;
				const start = firstRow * COLS;
				const end = Math.min(filtered.length, (firstRow + visRows) * COLS);

				for (let i = start; i < end; i++) {
					const pose = filtered[i];
					const col = i % COLS;
					const row = Math.floor(i / COLS);
					const item = document.createElement("div");
					item.title = pose.name;
					item.style.cssText =
						"position:absolute;cursor:pointer;border-radius:4px;background:#2a2a2a;padding:4px;text-align:center;box-sizing:border-box;" +
						`left:${col * (cellW + GAP)}px;top:${row * rowH}px;width:${cellW}px;height:${cellH}px;`;
					item.onmouseenter = () => (item.style.background = "#3a3a3a");
					item.onmouseleave = () => (item.style.background = "#2a2a2a");
					if (selected && selected.id === pose.id) {
						item.style.outline = "2px solid #4d9fff";
					}

					const file = imgFile(pose, estilo, angulo);
					if (file) {
						const img = document.createElement("img");
						img.src = `/mika/pose_gallery/thumb?file=${encodeURIComponent(file)}&size=240`;
						img.loading = "lazy";
						img.onerror = () => img.remove();
						img.style.cssText =
							`width:100%;height:${cellW}px;object-fit:contain;border-radius:3px;display:block;` +
							"background:repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50%/16px 16px";
						item.appendChild(img);
					}

					const label = document.createElement("div");
					label.textContent = pose.name;
					label.style.cssText =
						"font-size:11px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
					item.appendChild(label);

					item.onclick = () => choose(pose);
					spacer.appendChild(item);
				}
			};

			let rafId = 0;
			const requestRender = () => {
				if (rafId) return;
				rafId = requestAnimationFrame(() => { rafId = 0; renderWindow(); });
			};
			gridWrap.addEventListener("scroll", requestRender);

			const refresh = () => { refreshFiltered(); requestRender(); };
			filter.oninput = refresh;
			catSel.onchange = refresh;

			styleBtn.onclick = () => {
				estilo = estilo === "line" ? "3d" : "line";
				localStorage.setItem(LS_STYLE, estilo);
				syncStyleBtn();
				refresh();
				if (selected) showPreview(selected);
			};
			angleSel.onchange = () => {
				angulo = parseInt(angleSel.value, 10) || 0;
				localStorage.setItem(LS_ANGLE, String(angulo));
				refresh();
				if (selected) showPreview(selected);
			};

			const close = () => overlay.remove();
			closeBtn.onclick = close;
			overlay.onclick = (e) => { if (e.target === overlay) close(); };
			overlay.addEventListener("keydown", (e) => {
				if (e.key === "Escape") { e.stopPropagation(); close(); }
			});

			selectBtn.onclick = () => {
				if (!selected) return;
				writeSelection(node, selected, estilo, angulo);
				close();
			};

			// Copiar al portapapeles (para pegar en el lienzo). Copia también
			// fija la selección, así la salida coincide con lo copiado.
			copyBtn.onclick = async () => {
				if (!selected) return;
				writeSelection(node, selected, estilo, angulo);
				const url = `/mika/pose_gallery/image?file=${encodeURIComponent(imgFile(selected, estilo, angulo))}&format=png`;
				try {
					if (!navigator.clipboard?.write || !window.ClipboardItem) {
						throw new Error("portapapeles no disponible");
					}
					const blob = await (await fetch(url)).blob();
					await navigator.clipboard.write(
						[new ClipboardItem({ "image/png": blob })]);
					copyBtn.textContent = "📋 ¡Copiada!";
					setTimeout(() => { copyBtn.textContent = "📋 Copiar imagen"; }, 1200);
				} catch (err) {
					console.error("PoseGalleryMika:", err);
					window.open(url, "_blank");
					alert("No se pudo copiar al portapapeles. Se abrió la imagen para que la guardes y la uses.");
				}
			};

			dlBtn.onclick = () => {
				if (!selected) return;
				const a = document.createElement("a");
				a.href = `/mika/pose_gallery/image?file=${encodeURIComponent(imgFile(selected, estilo, angulo))}&format=png`;
				a.download = `${selected.id}-${estilo}-${angulo}.png`;
				a.click();
			};

			// Estado inicial.
			syncStyleBtn();
			angleSel.value = String(angulo);
			if (selected) showPreview(selected);
			refresh();
			filter.focus();
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
			const node = this;

			// El widget de estado no se muestra: lo escribe la galería.
			const w = seleccionWidget(node);
			if (w) w.hidden = true;

			this.addWidget("button", "🖼 Abrir galería", null, () => {
				openGallery(node).catch((err) =>
					console.error("PoseGalleryMika:", err));
			});

			// Descarga masiva: baja todo a user/mika_pose_gallery/ para que la
			// galería funcione sin internet. Muestra el progreso en la etiqueta.
			let caching = false;
			this.addWidget("button", "⬇ Descargar todas", null, () => {
				if (caching) return;
				chooseScope((scope) => {
					if (!scope) return;
					caching = true;
					const btn = node.widgets.find(
						(w) => w.type === "button" && w.name.includes("Descargar todas"));
					const setLabel = (t) => {
						if (btn) { btn.name = t; node.setDirtyCanvas(true, true); }
					};
					startBulkDownload(scope, setLabel).finally(() => { caching = false; });
				});
			});

			return r;
		};
	},
});
