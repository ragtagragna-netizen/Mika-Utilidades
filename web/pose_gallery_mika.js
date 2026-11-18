import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Pose Gallery
// -----------------------------------------------------------------------
// Nodo con una galería de 779 poses de dos fuentes, separadas por sitio de
// referencia: 491 de WaveSpeed AI y 288 de POSE-DB-01
// (ai-pose-gallery.pages.dev, catálogo de ギア, con nombres en japonés y
// descripción en español). La ventana (estilo File Picker-Mika) muestra un
// grid virtualizado con buscador, fuente, categoría, estilo (line/3d) y
// ángulo; los ángulos del combo salen de la fuente elegida (POSE-DB suma
// "Desde arriba" y "Desde abajo"). Al elegir una pose se ve en el panel y
// el nodo Python la entrega como IMAGE. La pose elegida viaja en el widget
// oculto "seleccion" (JSON {id, estilo, angulo}).
//
// openPoseGallery() también se usa desde la ventana editor del Anima
// Lineart Canvas-Mika: allí la pose seleccionada va como capa de calco.
// Las poses de POSE-DB no tienen estilo 3d: con ese estilo se ve su line
// art, y un ángulo sin imagen cae al primero disponible.
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
	"sitting": "Sentada",
	"kneeling": "Arrodillada",
	"lying": "Recostada",
	"crouching": "Agachada",
	"leaning": "Inclinada al frente",
	"arching": "Arqueada hacia atrás",
	"twisting": "Girada",
	"special": "Especial",
	"cute": "Tierna",
	"pinup": "Pin-up",
	"sexy": "Sexy",
	"upper-body": "Cuerpo superior",
	"duo": "Dos personas",
	"action": "Deporte y acción",
	"dance": "Baile",
	"dynamic": "Heroico y cinematográfico",
};

const STYLES = ["line", "3d"];
const STYLE_LABELS = { line: "Line art", "3d": "3D" };
const ANGLES = ["Front", "3/4", "Side"];
const ALL_SOURCES = "all";

const LS_SOURCE = "PoseGalleryMika.source";
const LS_STYLE = "PoseGalleryMika.style";
const LS_ANGLE = "PoseGalleryMika.angle";

const catLabel = (id) => CATEGORY_LABELS[id] || id;
const poseSource = (pose) => pose?.source || "wavespeed";
const seleccionWidget = (node) =>
	node?.widgets?.find((w) => w.name === "seleccion");
const imgFile = (pose, estilo, angulo) => {
	const imgs = pose?.img?.[estilo] || pose?.img?.line || [];
	const i = Math.min(angulo, imgs.length - 1);
	// Un ángulo sin imagen (string vacío) cae al primero disponible.
	return imgs[i] || imgs.find(Boolean) || "";
};
const readInt = (key, def, min, max) => {
	const v = parseInt(localStorage.getItem(key), 10);
	return Number.isFinite(v) && v >= min && v <= max ? v : def;
};

// URL de la imagen (PNG) de una pose: la usa el calco del Lineart.
export function poseImageUrl(pose, estilo, angulo, format = "png") {
	const file = imgFile(pose, estilo, angulo);
	return `/mika/pose_gallery/image?file=${encodeURIComponent(file)}&format=${format}`;
}

// Nodos del workflow abierto que pueden recibir una imagen en su calco.
function calcoTargets() {
	const nodes = app.graph?._nodes || app.graph?.nodes || [];
	return nodes.filter((n) => n.type === "AnimaLineartCanvasMika"
		&& typeof n._mikaLineart?.addCalcoImage === "function");
}

// Carga una imagen del mismo origen como promesa (para pasarla al calco).
function loadImage(url) {
	return new Promise((res, rej) => {
		const img = new Image();
		img.onload = () => res(img);
		img.onerror = () => rej(new Error("no se pudo cargar la imagen"));
		img.src = url;
	});
}

// Pregunta el alcance de la descarga masiva en un menú chico. Los contadores
// salen del manifiesto (crecen cuando se agregan galerías nuevas).
function chooseScope(counts, onPick) {
	const fmt = (n) => n.toLocaleString("es-AR");
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
	bx.append(mk(`Solo line art (${fmt(counts.line)})`, "line"),
		mk(`Line art + 3D (${fmt(counts.all)})`, "all"), cancel);
	ov.appendChild(bx);
	ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
	document.body.appendChild(ov);
}

// Cantidad de imágenes por alcance, del manifiesto (cacheado por sesión).
let poseCountsCache = null;
async function poseCounts() {
	if (poseCountsCache) return poseCountsCache;
	const counts = { line: 0, all: 0 };
	try {
		const manifest = await (await fetch("/mika/pose_gallery/list")).json();
		for (const p of manifest.poses || []) {
			const line = p.img?.line?.length || 0;
			counts.line += line;
			counts.all += line + (p.img?.["3d"]?.length || 0);
		}
	} catch (e) { /* sin manifiesto: contadores en 0 */ }
	poseCountsCache = counts;
	return counts;
}

// -----------------------------------------------------------------------
// Apertura de la galería.
//   node     → PoseGalleryMika: la selección se guarda en su widget oculto.
//   onSelect → callback (pose, estilo, angulo) para quien abre sin nodo
//              (la ventana editor del Lineart manda la pose a su calco).
// -----------------------------------------------------------------------
export async function openPoseGallery({ node, onSelect } = {}) {
	const resp = await fetch("/mika/pose_gallery/list");
	const manifest = await resp.json();
	const poses = manifest.poses || [];
	if (!poses.length) {
		alert("No se pudo leer el listado de poses (" +
			(manifest.error || "data/poses.json") + ").");
		return;
	}

	// Fuentes del manifiesto, con sus ángulos y estilos. Un manifiesto viejo
	// sin "sources" se comporta como antes: una sola galería de 3 ángulos.
	const sources = manifest.sources || [];
	const byId = new Map(sources.map((s) => [s.id, s]));
	const sourceOf = (id) => (id === ALL_SOURCES ? null : byId.get(id) || null);
	const anglesFor = (id) => sourceOf(id)?.angles || ANGLES;
	const stylesFor = (id) => sourceOf(id)?.styles || STYLES;
	const sourceLabel = (id) => (id === ALL_SOURCES ? "Varias fuentes" : sourceOf(id)?.label || id);

	let source = localStorage.getItem(LS_SOURCE) || ALL_SOURCES;
	if (source !== ALL_SOURCES && !byId.has(source)) source = ALL_SOURCES;
	let estilo = STYLES.includes(localStorage.getItem(LS_STYLE))
		? localStorage.getItem(LS_STYLE) : "line";
	let angulo = readInt(LS_ANGLE, 0, 0, 4);

	// Pose ya guardada (si la hay) para arrancar el panel.
	let selected = null;
	try {
		const saved = JSON.parse(seleccionWidget(node)?.value || "");
		selected = poses.find((p) => p.id === saved?.id) || null;
	} catch (e) { /* sin selección previa */ }

	// --- Overlay ---
	const overlay = document.createElement("div");
	overlay.dataset.mika = "pose-overlay";
	overlay.style.cssText =
		"position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center";
	// Abierta desde la ventana editor del Lineart: tiene que quedar ENCIMA de
	// esa ventana (su z-index crece con cada foco, arranca en 10020).
	const editorTop = Math.max(0, ...[...document
		.querySelectorAll('[data-mika="editor-root"]')]
		.map((el) => parseInt(el.style.zIndex, 10) || 0));
	if (editorTop >= 10000) overlay.style.zIndex = String(editorTop + 1);

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

	// Fuente de referencia: separa las poses por sitio. Los contadores de
	// cada fuente salen de las poses mismas (p.source; viejo = wavespeed).
	const srcSel = document.createElement("select");
	srcSel.title = "Sitio de referencia de las poses";
	srcSel.style.cssText =
		"padding:6px 4px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px";
	const srcCounts = {};
	for (const p of poses) srcCounts[poseSource(p)] = (srcCounts[poseSource(p)] || 0) + 1;
	srcSel.appendChild(new Option(`Todas (${poses.length})`, ALL_SOURCES));
	for (const s of sources) {
		srcSel.appendChild(new Option(`${s.label} (${srcCounts[s.id] || 0})`, s.id));
	}
	srcSel.value = source;

	const catSel = document.createElement("select");
	catSel.style.cssText = srcSel.style.cssText;
	catSel.appendChild(new Option("Todas las categorías", ""));
	for (const c of manifest.categories || []) {
		catSel.appendChild(new Option(`${catLabel(c.id)} (${c.count})`, c.id));
	}

	const styleBtn = document.createElement("button");
	styleBtn.style.cssText =
		"padding:6px 12px;min-width:90px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;cursor:pointer";
	const syncStyleBtn = () => {
		styleBtn.textContent = STYLE_LABELS[estilo];
		// POSE-DB no tiene 3D: con esa fuente el toggle no aplica.
		const has3d = source === ALL_SOURCES || stylesFor(source).includes("3d");
		styleBtn.disabled = !has3d;
		styleBtn.style.opacity = has3d ? "1" : "0.45";
		styleBtn.title = has3d ? "Cambiar entre line art y 3D"
			: "Esta fuente solo tiene line art";
	};

	// El combo de ángulos se rearma con la fuente activa (POSE-DB suma
	// "Desde arriba" y "Desde abajo"; con todas se ven las 5 y WaveSpeed
	// cae al lado más cercano).
	const angleSel = document.createElement("select");
	angleSel.style.cssText = catSel.style.cssText;
	const rebuildAngles = () => {
		// Con todas las fuentes se unen sus ángulos; sin metadata de fuentes
		// (manifiesto viejo) quedan los tres de siempre.
		const list = source === ALL_SOURCES
			? (sources.length
				? Array.from(new Set(sources.flatMap((s) => s.angles || [])))
				: ANGLES)
			: anglesFor(source);
		angleSel.innerHTML = "";
		list.forEach((a, i) => angleSel.appendChild(new Option(a, String(i))));
		if (angulo > list.length - 1) angulo = Math.max(0, list.length - 1);
		angleSel.value = String(angulo);
	};

	const count = document.createElement("span");
	count.style.cssText = "color:#999;white-space:nowrap";

	const closeBtn = document.createElement("button");
	closeBtn.textContent = "✕";
	closeBtn.title = "Cerrar";
	closeBtn.style.cssText =
		"padding:6px 12px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;cursor:pointer";

	header.append(filter, srcSel, catSel, styleBtn, angleSel, count, closeBtn);

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
	const calcoBtn = document.createElement("button");
	calcoBtn.dataset.mika = "pose-calco-btn";
	calcoBtn.textContent = "🖼️ A calco";
	calcoBtn.title = "Mandar esta pose como capa de calco del Anima Lineart Canvas";
	calcoBtn.style.cssText = copyBtn.style.cssText;
	// Con más de un Lineart en el workflow, se elige el destino por ID.
	const calcoSel = document.createElement("select");
	calcoSel.title = "Nodo destino del calco";
	calcoSel.style.cssText = catSel.style.cssText;
	calcoSel.style.display = "none";
	const calcoMsg = document.createElement("div");
	calcoMsg.dataset.mika = "pose-calco-msg";
	calcoMsg.style.cssText =
		"display:none;font-size:12px;color:#f88;white-space:pre-wrap";
	actions.append(selectBtn, copyBtn, calcoBtn, calcoSel, dlBtn);

	panel.append(preview, pName, pCat, pDesc, calcoMsg, actions);
	body.append(gridWrap, panel);

	box.append(header, body);
	overlay.appendChild(box);
	document.body.appendChild(overlay);

	// --- Selección + panel ---
	const showPreview = (pose) => {
		preview.src = pose ? poseImageUrl(pose, estilo, angulo, "webp") : "";
		pName.textContent = pose?.name || "";
		pCat.textContent = pose
			? `${sourceLabel(poseSource(pose))} · ${catLabel(pose?.category)}`
			: "";
		pDesc.textContent = pose?.desc || "";
	};

	const choose = (pose) => {
		selected = pose;
		showPreview(pose);
	};

	// Guarda la pose elegida en el widget oculto (viaja con el workflow).
	function writeSelection(pose, est, ang) {
		if (!node) return;
		const w = node.widgets?.find((x) => x.name === "seleccion");
		if (!w || !pose) return;
		const value = JSON.stringify({ id: pose.id, estilo: est, angulo: ang });
		w.value = value;
		if (typeof w.callback === "function") w.callback(value);
		node.setDirtyCanvas(true, true);
	}

	// Destino del calco: uno solo = directo; varios = se elige por ID.
	// Al recargar se conserva el ID elegido si sigue existiendo.
	const syncCalcoTargets = () => {
		const targets = calcoTargets();
		const keep = calcoSel.value;
		calcoSel.innerHTML = "";
		for (const t of targets) {
			calcoSel.appendChild(new Option(`Nodo ${t.id}`, String(t.id)));
		}
		if (targets.some((t) => String(t.id) === keep)) calcoSel.value = keep;
		calcoSel.style.display = targets.length > 1 ? "" : "none";
		calcoBtn.disabled = !targets.length;
		calcoBtn.title = targets.length
			? "Mandar esta pose como capa de calco del Anima Lineart Canvas"
			: "No hay ningún Anima Lineart Canvas en este workflow";
		return targets;
	};

	// --- Filtro + grid virtualizado ---
	let filtered = [];
	const refreshFiltered = () => {
		const t = filter.value.trim().toLowerCase();
		const cat = catSel.value;
		filtered = poses.filter((p) => {
			if (source !== ALL_SOURCES && poseSource(p) !== source) return false;
			if (cat && p.category !== cat) return false;
			if (!t) return true;
			return (p.name || "").toLowerCase().includes(t) ||
				(p.id || "").toLowerCase().includes(t) ||
				(p.desc || "").toLowerCase().includes(t) ||
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
	srcSel.onchange = () => {
		source = srcSel.value;
		localStorage.setItem(LS_SOURCE, source);
		rebuildAngles();
		syncStyleBtn();
		refresh();
		if (selected) showPreview(selected);
	};

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
		writeSelection(selected, estilo, angulo);
		onSelect?.(selected, estilo, angulo);
		close();
	};

	// Copiar al portapapeles (para pegar en el lienzo). Copiar también
	// fija la selección, así la salida coincide con lo copiado.
	copyBtn.onclick = async () => {
		if (!selected) return;
		writeSelection(selected, estilo, angulo);
		const url = poseImageUrl(selected, estilo, angulo, "png");
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
		a.href = poseImageUrl(selected, estilo, angulo, "png");
		a.download = `${selected.id}-${estilo}-${angulo}.png`;
		a.click();
	};

	// Mandar la pose al calco del nodo Lineart (sin portapapeles).
	let calcoSending = false;
	const showCalcoMsg = (text, isError) => {
		calcoMsg.textContent = text || "";
		calcoMsg.style.display = text ? "" : "none";
		calcoMsg.style.color = isError ? "#f88" : "#bbb";
	};
	calcoBtn.onclick = async () => {
		// Un clic por vez: un doble clic no debe apilar dos veces.
		if (calcoSending) return;
		if (!selected) { showCalcoMsg(""); return; }
		calcoSending = true;
		try {
			const targets = syncCalcoTargets();
			const node2 = targets.length === 1
				? targets[0]
				: targets.find((t) => String(t.id) === calcoSel.value);
			if (!node2) {
				showCalcoMsg("No hay ningún Anima Lineart Canvas en este workflow.", false);
				return;
			}
			// Se fija acá lo que se manda: si el usuario cambia de pose,
			// estilo o ángulo mientras baja la imagen, van y se registran
			// los de este clic.
			const pose = selected, est = estilo, ang = angulo;
			const img = await loadImage(poseImageUrl(pose, est, ang, "png"));
			node2._mikaLineart.addCalcoImage(img);
			writeSelection(pose, est, ang);
			showCalcoMsg("");
			calcoBtn.textContent = `🖼️ ¡Al nodo ${node2.id}!`;
			setTimeout(() => { calcoBtn.textContent = "🖼️ A calco"; }, 1200);
		} catch (err) {
			console.error("PoseGalleryMika:", err);
			showCalcoMsg("No se pudo mandar la pose al calco: " +
				((err && err.message) || err), true);
		} finally {
			calcoSending = false;
		}
	};

	// Estado inicial.
	syncStyleBtn();
	rebuildAngles();
	syncCalcoTargets();
	if (selected) showPreview(selected);
	refresh();
	filter.focus();
}

app.registerExtension({
	name: "Mika.PoseGalleryMika",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "PoseGalleryMika") return;

		async function openGallery(node) {
			return openPoseGallery({ node });
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
				poseCounts().then((counts) => {
					chooseScope(counts, (scope) => {
						if (!scope) return;
						caching = true;
						const btn = node.widgets.find(
							(x) => x.type === "button" && x.name.includes("Descargar todas"));
						const setLabel = (t) => {
							if (btn) { btn.name = t; node.setDirtyCanvas(true, true); }
						};
						startBulkDownload(scope, setLabel).finally(() => { caching = false; });
					});
				}).catch((err) => {
					console.error("PoseGalleryMika:", err);
				});
			});

			return r;
		};
	},
});

// Arranca la descarga masiva en el servidor y sigue el progreso. El endpoint
// devuelve enseguida (lanza un hilo), así que hay que esperar a que
// cache_status diga que terminó; resolver al final mantiene el botón ocupado.
function startBulkDownload(scope, setLabel) {
	return new Promise((resolve) => {
		let poll = 0;
		const stop = (label) => {
			if (poll) { clearInterval(poll); poll = 0; }
			setLabel(label);
			resolve();
		};
		fetch(`/mika/pose_gallery/cache?scope=${scope}`).then(() => {
			poll = setInterval(async () => {
				let s = null;
				try {
					s = await (await fetch("/mika/pose_gallery/cache_status")).json();
				} catch (e) {
					return; // reintenta en el próximo tick
				}
				if (s.total > 0) setLabel(`⬇ Descargando ${s.done}/${s.total}...`);
				if (!s.running) stop("⬇ Descargar todas");
			}, 500);
		}).catch((err) => {
			console.error("PoseGalleryMika:", err);
			stop("⬇ Descargar todas (error)");
		});
	});
}
