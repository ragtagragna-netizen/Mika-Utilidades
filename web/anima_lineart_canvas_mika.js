import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// -----------------------------------------------------------------------
// Mika · Anima Lineart Canvas
// -----------------------------------------------------------------------
// Nodo con las resoluciones de Anima Resolutions-Mika + un lienzo para
// dibujar/editar lineart a mano. El contenido del lienzo se guarda como
// PNG base64 (sin prefijo "data:") en el widget oculto "dibujo"; el nodo
// Python lo decodifica a IMAGE a la resolución elegida.
//
// Modos:
//   lineart       -> fondo negro, trazo blanco (convención de lineart).
//   dibujo normal -> fondo blanco, color de trazo libre (picker).
//
// Capas del stage, de abajo hacia arriba:
//   stage (fondo del modo) -> canvasUnderlay (calco, referencia) -> canvasPaint (contenido)
// El calco es solo referencia: nunca se exporta ni se guarda.
// -----------------------------------------------------------------------

const TOOLBAR_H = 30; // alto estimado de la barra (para computeSize)
const PAD = 16;       // margen lateral que ComfyUI deja alrededor del DOM
const MAX_UNDO = 20;

// Caché en memoria (por sesión del navegador) del calco y sus capas. ComfyUI
// recrea los nodos al cambiar de pestaña de workflow y, como el calco es solo
// de sesión (no se serializa), se perdería. Se indexa por id de workflow + nodo.
const CALCO_CACHE = new Map();
const calcoKey = (node) => `${node.graph?.id ?? app.graph?.id ?? "g"}:${node.id}`;

const RES_RE = /(\d+)\s*x\s*(\d+)/;

// Ancho del lienzo: todo el ancho del nodo, salvo en proporciones verticales,
// donde se angosta para que su ALTO no supere el ancho del nodo (cuadrado).
// Así cambiar de resolución cambia el área de dibujo, no el largo del nodo.
const stageWidthFor = (cw, ch) => (cw >= ch ? "100%" : `calc(100% * ${cw / ch})`);
const LIN = "lineart";
const NORMAL = "dibujo normal";
const ERASE_PREVIEW = "rgba(255, 0, 170, 0.55)"; // color que marca la zona a borrar

// Cursores SVG (cruz chica y flecha de giro) con contorno claro+oscuro.
const cursorUrl = (inner) =>
	`url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' + inner + "</svg>")}") 10 10`;

const CURSOR_CROSS = cursorUrl(
	'<path d="M10 4v12M4 10h12" stroke="#000" stroke-width="3.4" fill="none"/>' +
	'<path d="M10 4v12M4 10h12" stroke="#fff" stroke-width="1.4" fill="none"/>',
) + ", crosshair";

const CURSOR_ROTATE = cursorUrl(
	'<path d="M16 10a6 6 0 1 1-1.8-4.3" stroke="#000" stroke-width="3.2" fill="none"/>' +
	'<path d="M14.4 2.4l3.1.6-.5 3.1z" fill="#000"/>' +
	'<path d="M16 10a6 6 0 1 1-1.8-4.3" stroke="#fff" stroke-width="1.2" fill="none"/>' +
	'<path d="M14.9 3.4l1.9.4-.3 1.9z" fill="#fff"/>',
) + ", grab";

// Ícono de pincel del botón del "pincel difuminado": usa currentColor para
// adaptarse al tema y lleva un par de motas junto a la punta (el difuminado).
const SOFT_BRUSH_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
	'<path d="M4.4 19.6 12 12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>' +
	'<path d="M12 12 14.6 9.4" fill="none" stroke="currentColor" stroke-width="4.6" stroke-linecap="round"/>' +
	'<path d="M13.6 7.9c2.1-2.1 5.2-4.5 7.9-5.3-.9 2.9-3.1 6.1-5.1 7.9z" fill="currentColor"/>' +
	'<circle cx="22.3" cy="3.4" r="0.9" fill="currentColor" opacity="0.5"/>' +
	'<circle cx="20.5" cy="1.7" r="0.7" fill="currentColor" opacity="0.35"/>' +
	"</svg>";

// Ajustes de la barra que viajan dentro del workflow (widget oculto "pincel"):
// herramienta, grosores, difuminado, grano, figura, fuente y color de trazo.
const PINCEL_KEYS = [
	"tool", "thickness", "eraseThickness", "softThickness", "softBlur", "softGrain",
	"maskThickness", "calcoOpacity", "shape", "font", "fontSize", "userColor",
];

// Figuras del Paint ([id, etiqueta]).
const SHAPES = [
	["line", "Línea"], ["curve", "Curva"], ["ellipse", "Círculo"], ["rect", "Rectángulo"],
	["roundRect", "Rect. redondeado"], ["polygon", "Polígono"], ["triangle", "Triángulo"],
	["rightTriangle", "Triángulo rect."], ["diamond", "Rombo"], ["pentagon", "Pentágono"],
	["hexagon", "Hexágono"], ["arrowRight", "Flecha der."], ["arrowLeft", "Flecha izq."],
	["arrowUp", "Flecha arriba"], ["arrowDown", "Flecha abajo"], ["star4", "Estrella 4"],
	["star5", "Estrella 5"], ["star6", "Estrella 6"], ["calloutRect", "Bocadillo rect."],
	["calloutOval", "Bocadillo óvalo"], ["cloud", "Nube"], ["heart", "Corazón"], ["lightning", "Rayo"],
];

// Fuentes incluidas en el Paint de Windows.
const PAINT_FONTS = [
	"Arial", "Calibri", "Cambria", "Comic Sans MS", "Consolas", "Courier New",
	"Franklin Gothic Medium", "Gabriola", "Georgia", "Impact", "Ink Free",
	"Lucida Console", "Lucida Sans Unicode", "Microsoft Sans Serif", "Palatino Linotype",
	"Segoe Print", "Segoe Script", "Segoe UI", "Sitka Text", "Sylfaen", "Tahoma",
	"Times New Roman", "Verdana", "Wingdings",
];

// Fuentes para cómic (Blambot / Google Fonts, ver gcomics.online) + clásicas.
// Para que se vean hay que tenerlas instaladas en Windows.
const COMIC_FONTS = [
	"Acme Secret Agent", "Anime Ace 3", "SF Toontime", "Creative Block",
	"Dark Arts", "Badaboom", "Creepster", "Antigrav BB", "Drakufrankenwolf",
	"Bangers", "Bowlby One SC", "Bradley Hand ITC", "Britannic Bold", "Broadway",
	"Brush Script MT", "Bungee Inline", "Cabin Sketch", "Komika Axis",
	"Lucky Ape", "Tokio", "Digital Strip", "Webletterer BB", "Zud Juice",
];

// --- Registro de fuentes ---
// Las fuentes de cómic viven en web/fonts/ (empaquetadas como .woff2, ~35 % de
// su tamaño original) y se cargan con @font-face, así se ven sin instalarlas.
// El manifiesto es web/fonts/fonts.json.
const BUNDLED_FONTS = [];
const ADDED_FONTS = (() => {
	try { return JSON.parse(localStorage.getItem("mikaLineartFonts") || "[]"); } catch (e) { return []; }
})();
let bundledLoaded = false;

async function loadBundledFonts() {
	if (bundledLoaded) return;
	bundledLoaded = true;
	try {
		const res = await fetch("/extensions/Mika-Utilidades/fonts/fonts.json", { cache: "no-store" });
		if (!res.ok) return;
		for (const it of await res.json()) {
			if (!it?.file || !it?.family || BUNDLED_FONTS.includes(it.family)) continue;
			try {
				const face = new FontFace(it.family, `url("/extensions/Mika-Utilidades/fonts/${encodeURIComponent(it.file)}")`);
				await face.load();
				document.fonts.add(face);
				BUNDLED_FONTS.push(it.family);
			} catch (e) { /* fuente inválida: se ignora */ }
		}
	} catch (e) { /* sin manifiesto: no pasa nada */ }
}
loadBundledFonts();

function saveAddedFonts() {
	try { localStorage.setItem("mikaLineartFonts", JSON.stringify(ADDED_FONTS)); } catch (e) { /* no-op */ }
}

// Carga archivos de fuente locales (FontFace) y los agrega a la lista.
async function loadFontFiles(files) {
	for (const file of files) {
		try {
			const family = file.name.replace(/\.[^.]+$/, "");
			const face = new FontFace(family, `url("${URL.createObjectURL(file)}")`);
			await face.load();
			document.fonts.add(face);
			if (!ADDED_FONTS.includes(family)) ADDED_FONTS.push(family);
		} catch (e) { /* archivo inválido */ }
	}
	saveAddedFonts();
}

// Grupos de fuentes para el selector (Paint / Cómic / agregadas).
function fontGroups() {
	const comic = [...BUNDLED_FONTS];
	for (const f of COMIC_FONTS) if (!comic.includes(f)) comic.push(f);
	const groups = [["Paint", PAINT_FONTS], ["Cómic", comic]];
	if (ADDED_FONTS.length) groups.push(["Agregadas", ADDED_FONTS]);
	return groups;
}

// Traza una figura dentro de la caja (x0,y0)-(x1,y1). El llamador aplica
// stroke()/fill() con el estilo deseado.
function shapePath(ctx, id, x0, y0, x1, y1) {
	const x = Math.min(x0, x1);
	const y = Math.min(y0, y1);
	const w = Math.abs(x1 - x0);
	const h = Math.abs(y1 - y0);
	const cx = x + w / 2;
	const cy = y + h / 2;
	const poly = (pts) => {
		ctx.beginPath();
		pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
		ctx.closePath();
	};
	const regular = (n, rot) => {
		ctx.beginPath();
		for (let i = 0; i < n; i++) {
			const a = rot + (i * 2 * Math.PI) / n;
			const px = cx + Math.cos(a) * (w / 2);
			const py = cy + Math.sin(a) * (h / 2);
			i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
		}
		ctx.closePath();
	};
	const star = (points, inner) => {
		const N = points * 2;
		ctx.beginPath();
		for (let i = 0; i < N; i++) {
			const f = i % 2 ? inner : 1;
			const a = -Math.PI / 2 + (i * Math.PI) / points;
			const px = cx + Math.cos(a) * (w / 2) * f;
			const py = cy + Math.sin(a) * (h / 2) * f;
			i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
		}
		ctx.closePath();
	};
	const arrow = (dir) => {
		const U = [[0, 0.3], [0.6, 0.3], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.7], [0, 0.7]];
		const m = (u, v) => {
			if (dir === "right") return [x + u * w, y + v * h];
			if (dir === "left") return [x + (1 - u) * w, y + v * h];
			if (dir === "down") return [x + v * w, y + u * h];
			return [x + v * w, y + (1 - u) * h];
		};
		poly(U.map((p) => m(p[0], p[1])));
	};

	switch (id) {
		case "line":
			ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); break;
		case "curve":
			ctx.beginPath();
			ctx.moveTo(x, y + h);
			ctx.bezierCurveTo(x + w * 0.25, y, x + w * 0.75, y + h, x + w, y);
			break;
		case "ellipse":
			ctx.beginPath(); ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2); break;
		case "rect":
			ctx.beginPath(); ctx.rect(x, y, w, h); break;
		case "roundRect": {
			const r = Math.min(w, h) * 0.2;
			ctx.beginPath();
			ctx.moveTo(x + r, y);
			ctx.arcTo(x + w, y, x + w, y + h, r);
			ctx.arcTo(x + w, y + h, x, y + h, r);
			ctx.arcTo(x, y + h, x, y, r);
			ctx.arcTo(x, y, x + w, y, r);
			ctx.closePath();
			break;
		}
		case "polygon":
			poly([[x + w * 0.25, y], [x + w, y], [x + w * 0.75, y + h], [x, y + h]]); break;
		case "triangle":
			poly([[cx, y], [x + w, y + h], [x, y + h]]); break;
		case "rightTriangle":
			poly([[x, y], [x, y + h], [x + w, y + h]]); break;
		case "diamond":
			poly([[cx, y], [x + w, cy], [cx, y + h], [x, cy]]); break;
		case "pentagon": regular(5, -Math.PI / 2); break;
		case "hexagon": regular(6, 0); break;
		case "arrowRight": arrow("right"); break;
		case "arrowLeft": arrow("left"); break;
		case "arrowUp": arrow("up"); break;
		case "arrowDown": arrow("down"); break;
		case "star4": star(4, 0.4); break;
		case "star5": star(5, 0.4); break;
		case "star6": star(6, 0.55); break;
		case "calloutRect": {
			const hb = h * 0.78;
			ctx.beginPath();
			ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + hb);
			ctx.lineTo(x + w * 0.4, y + hb); ctx.lineTo(x + w * 0.22, y + h);
			ctx.lineTo(x + w * 0.3, y + hb); ctx.lineTo(x, y + hb);
			ctx.closePath();
			break;
		}
		case "calloutOval": {
			const hb = h * 0.8;
			ctx.beginPath();
			ctx.ellipse(cx, y + hb / 2, w / 2, hb / 2, 0, 0, Math.PI * 2);
			ctx.moveTo(x + w * 0.3, y + hb * 0.85);
			ctx.lineTo(x + w * 0.2, y + h);
			ctx.lineTo(x + w * 0.42, y + hb * 0.9);
			ctx.closePath();
			break;
		}
		case "cloud": {
			const r = Math.min(w, h) * 0.28;
			ctx.beginPath();
			ctx.arc(x + w * 0.3, cy, r, Math.PI * 0.5, Math.PI * 1.5);
			ctx.arc(x + w * 0.5, y + r, r, Math.PI * 1.0, Math.PI * 1.8);
			ctx.arc(x + w * 0.75, cy - r * 0.3, r, Math.PI * 1.4, Math.PI * 0.4);
			ctx.arc(x + w * 0.55, cy + r * 0.7, r, Math.PI * 0.1, Math.PI * 1.2);
			ctx.closePath();
			break;
		}
		case "heart":
			ctx.beginPath();
			ctx.moveTo(cx, y + h);
			ctx.bezierCurveTo(x - w * 0.15, cy + h * 0.1, x + w * 0.1, y - h * 0.1, cx, y + h * 0.3);
			ctx.bezierCurveTo(x + w * 0.9, y - h * 0.1, x + w * 1.15, cy + h * 0.1, cx, y + h);
			ctx.closePath();
			break;
		case "lightning":
			poly([[x + w * 0.55, y], [x + w * 0.15, y + h * 0.55], [x + w * 0.45, y + h * 0.55], [x + w * 0.3, y + h], [x + w * 0.85, y + h * 0.4], [x + w * 0.5, y + h * 0.4]]);
			break;
		default:
			break;
	}
}

app.registerExtension({
	name: "Mika.AnimaLineartCanvas",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		const INPAINT = "AnimaInpaintCanvasMika";
		if (nodeData.name !== "AnimaLineartCanvasMika" && nodeData.name !== INPAINT) return;
		// El mismo lienzo sirve a los dos nodos; el de inpaint suma la imagen
		// de fondo, la mascara y sus salidas.
		const isInpaint = nodeData.name === INPAINT;

		const findWidget = (node, name) =>
			node.widgets?.find((w) => String(w?.name ?? "") === name);
		const dibujoWidget = (node) => findWidget(node, "dibujo");
		const resolucionWidget = (node) => findWidget(node, "resolucion");
		const modoWidget = (node) => findWidget(node, "modo");
		const archivoWidget = (node) => findWidget(node, "archivo");

		// Guarda el nombre del último archivo cargado (sale como "nombre_archivo").
		function setArchivo(node, name) {
			const w = archivoWidget(node);
			if (!w) return;
			w.value = name || "";
			w.callback?.(w.value);
		}

		// Ajustes de la barra guardados dentro del workflow: van en
		// node.properties (viaja en el archivo y lo restaura LiteGraph al cargar).
		function readPincelState(node) {
			const s = node.properties?.mikaPincel;
			return s && typeof s === "object" ? s : null;
		}

		function writePincelState(node) {
			const st = node._mikaLineart;
			if (!st || !node.properties) return;
			const state = {};
			for (const k of PINCEL_KEYS) state[k] = st[k];
			node.properties.mikaPincel = state;
		}

		const modo = (node) =>
			String(modoWidget(node)?.value ?? LIN) === NORMAL ? NORMAL : LIN;
		const isLineart = (node) => modo(node) === LIN;
		const modeBg = (node) => (isLineart(node) ? "#000" : "#fff");
		const modeStroke = (node) =>
			isLineart(node) ? "#fff" : (node._mikaLineart?.userColor || "#000");

		function parseRes(value) {
			const m = RES_RE.exec(String(value ?? ""));
			return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [1024, 1024];
		}

		const paintCtx = (node) => node._mikaLineart.paint.getContext("2d");

		function setWidget(node, value) {
			const w = dibujoWidget(node);
			if (!w) return;
			w.value = value;
			w.callback?.(value);
		}

		// Imagen fuente del nodo de inpaint (fondo del modo + imagen de entrada),
		// igual que su salida "image".
		function composeBase(node) {
			const st = node._mikaLineart;
			const [w, h] = parseRes(resolucionWidget(node)?.value);
			const tmp = document.createElement("canvas");
			tmp.width = w;
			tmp.height = h;
			const ctx = tmp.getContext("2d");
			ctx.fillStyle = modeBg(node);
			ctx.fillRect(0, 0, w, h);
			if (st.baseCanvas) ctx.drawImage(st.baseCanvas, 0, 0);
			return tmp;
		}

		// Imagen final (fondo del modo + trazos), igual que la salida del nodo.
		function composeOutput(node) {
			const st = node._mikaLineart;
			const [w, h] = parseRes(resolucionWidget(node)?.value);
			const tmp = document.createElement("canvas");
			tmp.width = w;
			tmp.height = h;
			const ctx = tmp.getContext("2d");
			ctx.fillStyle = modeBg(node);
			ctx.fillRect(0, 0, w, h);
			const t = paintTf(node);
			ctx.save();
			ctx.translate(t.cx, t.cy);
			ctx.rotate(t.rot);
			ctx.scale(t.sx, t.sy);
			ctx.drawImage(st.paint, -st.paint.width / 2, -st.paint.height / 2);
			ctx.restore();
			return tmp;
		}

		// Guarda la capa de trazos TAL CUAL (transparente). El fondo del modo
		// lo compone el nodo Python, así cambiar de modo tras recargar el
		// workflow sigue funcionando.
		function write(node) {
			const st = node._mikaLineart;
			if (!st) return;
			// La salida del trazo incluye su transformación: si hay una viva,
			// se hornea acá (transparente; el fondo lo pone el nodo Python).
			const t = st.paintTransform;
			let out = st.paint;
			if (t) {
				out = document.createElement("canvas");
				out.width = st.paint.width;
				out.height = st.paint.height;
				const ctx = out.getContext("2d");
				ctx.translate(t.cx, t.cy);
				ctx.rotate(t.rot);
				ctx.scale(t.sx, t.sy);
				ctx.drawImage(st.paint, -st.paint.width / 2, -st.paint.height / 2);
			}
			setWidget(node, out.toDataURL("image/png").split(",")[1]);
			st.dirty = true;
		}

		function load(node) {
			const st = node._mikaLineart;
			const ctx = paintCtx(node);
			ctx.globalCompositeOperation = "source-over";
			ctx.clearRect(0, 0, st.paint.width, st.paint.height);
			const val = dibujoWidget(node)?.value;
			st.dirty = typeof val === "string" && !!val;
			if (!st.dirty) return;
			const img = new Image();
			img.onload = () => {
				ctx.clearRect(0, 0, st.paint.width, st.paint.height);
				ctx.globalCompositeOperation = "source-over";
				ctx.drawImage(img, 0, 0);
				renderPreview(node);
			};
			img.src = "data:image/png;base64," + val;
		}

		// Estado deshacible: el trazo y (en el nodo de inpaint) la máscara.
		function snapshot(node) {
			const st = node._mikaLineart;
			return {
				paint: st.paint.toDataURL("image/png"),
				mask: st.maskCanvas ? st.maskCanvas.toDataURL("image/png") : null,
			};
		}

		function restore(node, snap) {
			const st = node._mikaLineart;
			const ctx = paintCtx(node);
			const img = new Image();
			img.onload = () => {
				ctx.clearRect(0, 0, st.paint.width, st.paint.height);
				ctx.globalCompositeOperation = "source-over";
				ctx.drawImage(img, 0, 0);
				clearOverlay(node);
				renderPreview(node);
				write(node);
			};
			img.src = snap.paint;
			if (!st.maskCanvas) return;
			const mctx = st.maskCanvas.getContext("2d");
			mctx.setTransform(1, 0, 0, 1, 0, 0);
			mctx.globalCompositeOperation = "source-over";
			mctx.clearRect(0, 0, st.maskCanvas.width, st.maskCanvas.height);
			if (!snap.mask) {
				redrawMask(node);
				writeMask(node);
				return;
			}
			const mimg = new Image();
			mimg.onload = () => {
				mctx.clearRect(0, 0, st.maskCanvas.width, st.maskCanvas.height);
				mctx.drawImage(mimg, 0, 0);
				redrawMask(node);
				writeMask(node);
			};
			mimg.src = snap.mask;
		}

		function pushUndo(node) {
			const st = node._mikaLineart;
			st.undo.push(snapshot(node));
			if (st.undo.length > MAX_UNDO) st.undo.shift();
			st.redo.length = 0;
		}

		function clearOverlay(node) {
			const st = node._mikaLineart;
			if (!st?.overlay) return;
			st.overlay.getContext("2d").clearRect(0, 0, st.overlay.width, st.overlay.height);
		}

		function clearPaint(node) {
			const st = node._mikaLineart;
			const ctx = paintCtx(node);
			ctx.globalCompositeOperation = "source-over";
			ctx.clearRect(0, 0, st.paint.width, st.paint.height);
			clearOverlay(node);
			renderPreview(node);
			st.dirty = false;
			setWidget(node, "");
		}

		// --- Imagen de entrada (solo inpaint) ---
		// El frontend no puede leer tensores, así que sacamos la imagen ya
		// ejecutada del nodo aguas arriba (app.nodeOutputs / node.imgs), igual
		// que hacen otros canvas. El nodo Python la compone en "image".
		function upstreamImage(node) {
			const slot = node.inputs?.findIndex((i) => i.name === "imagen") ?? -1;
			if (slot < 0) return null;
			const inp = node.inputs[slot];
			if (inp.link == null) return null;
			const up = (app.graph?._nodes || []).find(
				(n) => (n.outputs || []).some((o) => (o.links || []).includes(inp.link)),
			);
			if (!up) return null;
			const entry = app.nodeOutputs?.[up.id]?.images?.[0];
			if (entry?.filename) {
				const sub = entry.subfolder ? `&subfolder=${encodeURIComponent(entry.subfolder)}` : "";
				const typ = entry.type ? `&type=${encodeURIComponent(entry.type)}` : "";
				return {
					key: `${entry.filename}|${entry.subfolder || ""}|${entry.type || ""}`,
					url: `/api/view?filename=${encodeURIComponent(entry.filename)}${sub}${typ}`,
				};
			}
			const src = up.imgs?.[0]?.src;
			if (src) return { key: String(src).replace(/([?&])(rand|t)=[^&]*/g, "$1"), url: src };
			return null;
		}

		// Rectángulo donde cae la imagen de entrada (contain, centrada): el
		// mismo encaje que hace el nodo Python en "image".
		function baseRectOf(st) {
			if (!st?.baseCanvas || !st.baseImg) return null;
			const s = Math.min(st.baseCanvas.width / st.baseImg.width, st.baseCanvas.height / st.baseImg.height);
			const w = st.baseImg.width * s;
			const h = st.baseImg.height * s;
			return { x: (st.baseCanvas.width - w) / 2, y: (st.baseCanvas.height - h) / 2, w, h };
		}

		function copyCanvas(src) {
			const c = document.createElement("canvas");
			c.width = src.width;
			c.height = src.height;
			c.getContext("2d").drawImage(src, 0, 0);
			return c;
		}

		function drawMapped(canvas, shot, f, dx, dy) {
			const ctx = canvas.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.setTransform(f, 0, 0, f, dx, dy);
			ctx.drawImage(shot, 0, 0);
			ctx.setTransform(1, 0, 0, 1, 0, 0);
		}

		// Fondo del lienzo: la imagen de entrada encajada "contain" y centrada.
		function drawBase(node) {
			const st = node._mikaLineart;
			if (!st?.baseCanvas) return;
			const ctx = st.baseCanvas.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, st.baseCanvas.width, st.baseCanvas.height);
			const r = baseRectOf(st);
			if (r) ctx.drawImage(st.baseImg, r.x, r.y, r.w, r.h);
			const lctx = st.baseLayer.getContext("2d");
			lctx.setTransform(1, 0, 0, 1, 0, 0);
			lctx.clearRect(0, 0, st.baseLayer.width, st.baseLayer.height);
			lctx.drawImage(st.baseCanvas, 0, 0);
		}

		function loadBaseFromInput(node) {
			const st = node._mikaLineart;
			if (!st?.baseCanvas) return;
			const found = upstreamImage(node);
			if (!found) {
				if (st.baseSrc !== null) {
					st.baseSrc = null;
					st.baseImg = null;
					drawBase(node);
				}
				return;
			}
			if (found.key === st.baseSrc) return;
			const img = new Image();
			img.onload = () => {
				if (node._mikaLineart !== st) return;
				st.baseSrc = found.key;
				st.baseImg = img;
				st.contentSize = { w: img.width, h: img.height };
				drawBase(node);
			};
			img.onerror = () => { /* sin imagen usable: se ignora */ };
			img.src = found.url;
		}

		// Dibuja el calco con su transformación (centro, escala, rotación).
		// Es solo referencia visual: nunca entra en la salida.
		function drawUnderlay(node) {
			const st = node._mikaLineart;
			if (!st?.underlay) return;
			const ctx = st.underlay.getContext("2d");
			ctx.clearRect(0, 0, st.underlay.width, st.underlay.height);
			const img = st.underlayImg;
			const t = st.underlayTransform;
			if (img && t) {
				ctx.save();
				ctx.translate(t.cx, t.cy);
				ctx.rotate(t.rot);
				ctx.scale(t.sx, t.sy);
				ctx.drawImage(img, -img.width / 2, -img.height / 2);
				ctx.restore();
			}
			drawCalcoLayers(node);
		}

		// Carga una imagen en la capa editable (reemplaza el contenido,
		// deshacible). "contain", centrada.
		function loadContent(node, img, name) {
			const st = node._mikaLineart;
			cancelSel(node);
			setArchivo(node, name);
			st.contentSize = { w: img.width, h: img.height };
			pushUndo(node);
			const ctx = paintCtx(node);
			ctx.globalCompositeOperation = "source-over";
			ctx.clearRect(0, 0, st.paint.width, st.paint.height);
			clearOverlay(node);
			const cw = st.paint.width;
			const ch = st.paint.height;
			const scale = Math.min(cw / img.width, ch / img.height);
			const dw = img.width * scale;
			const dh = img.height * scale;
			ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
			renderPreview(node);
			write(node);
		}

		// Caja de los píxeles visibles de un canvas (muestreada en chico).
		function boundsOf(canvas) {
			const maxSide = 256;
			const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
			const tw = Math.max(1, Math.round(canvas.width * s));
			const th = Math.max(1, Math.round(canvas.height * s));
			const t = document.createElement("canvas");
			t.width = tw; t.height = th;
			const c = t.getContext("2d");
			c.drawImage(canvas, 0, 0, tw, th);
			const d = c.getImageData(0, 0, tw, th).data;
			let minX = tw, minY = th, maxX = -1, maxY = -1;
			for (let y = 0; y < th; y++) {
				for (let x = 0; x < tw; x++) {
					if (d[(y * tw + x) * 4 + 3] > 8) {
						if (x < minX) minX = x;
						if (x > maxX) maxX = x;
						if (y < minY) minY = y;
						if (y > maxY) maxY = y;
					}
				}
			}
			if (maxX < 0) return null;
			const k = 1 / s;
			return { x: minX * k, y: minY * k, w: (maxX - minX + 1) * k, h: (maxY - minY + 1) * k };
		}

		function cornersBounds(corners) {
			if (!corners) return null;
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const [x, y] of corners) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
			return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
		}

		// Cambia el tamaño interno del lienzo reencajando el contenido
		// ("contain"): el trazo y el calco se escalan juntos para que nada
		// quede recortado.
		function resize(node, nw, nh) {
			const st = node._mikaLineart;
			if (!st || (st.paint.width === nw && st.paint.height === nh)) return;
			st.sel = null;
			st.lasso = null;
			st.softPts = null;
			const shot = document.createElement("canvas");
			shot.width = st.paint.width;
			shot.height = st.paint.height;
			if (st.paint.width && st.paint.height) shot.getContext("2d").drawImage(st.preview, 0, 0);
			// La máscara acompaña a la imagen de entrada (si hay) o al lienzo, así
			// queda alineada con lo que compone el nodo Python.
			const maskShot = st.maskCanvas ? copyCanvas(st.maskCanvas) : null;
			const baseRectBefore = baseRectOf(st);
			// La caja a reencajar es la unión del trazo, el calco base y las
			// capas, para que nada quede recortado.
			let bounds = boundsOf(shot);
			if (st.underlayImg && st.underlayTransform) bounds = unionRect(bounds, cornersBounds(layerCorners(node, "underlay")));
			for (const l of st.calcoLayers) if (l.visible) bounds = unionRect(bounds, cornersBounds(cornersOfTf(l.tf, l.w, l.h)));

			st.paint.width = nw;
			st.paint.height = nh;
			st.preview.width = nw;
			st.preview.height = nh;
			st.underlay.width = nw;
			st.underlay.height = nh;
			st.calcoLayersCanvas.width = nw;
			st.calcoLayersCanvas.height = nh;
			if (st.baseCanvas) { st.baseCanvas.width = nw; st.baseCanvas.height = nh; }
			if (st.maskCanvas) { st.maskCanvas.width = nw; st.maskCanvas.height = nh; }
			st.softScratch.width = nw;
			st.softScratch.height = nh;
			st.overlay.width = nw;
			st.overlay.height = nh;
			st.handles.width = nw;
			st.handles.height = nh;
			st.stage.style.aspectRatio = `${nw} / ${nh}`;
			st.stage.style.width = stageWidthFor(nw, nh);

			// Un solo mapeo para todo: con imagen de entrada se sigue el paso del
			// rectángulo de la imagen (viejo -> nuevo), así el trazo, la máscara
			// y la base quedan alineados; sin imagen, el "contain" por caja.
			const after = baseRectBefore ? baseRectOf(st) : null;
			let f = 0;
			let dx = 0;
			let dy = 0;
			let crop = null;
			if (after) {
				f = after.w / baseRectBefore.w;
				dx = after.x - baseRectBefore.x * f;
				dy = after.y - baseRectBefore.y * f;
			} else if (bounds && bounds.w > 0 && bounds.h > 0) {
				f = Math.min(nw / bounds.w, nh / bounds.h);
				const destW = bounds.w * f;
				const destH = bounds.h * f;
				dx = (nw - destW) / 2 - bounds.x * f;
				dy = (nh - destH) / 2 - bounds.y * f;
				crop = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, destW, destH };
			}

			const ctx = paintCtx(node);
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalCompositeOperation = "source-over";
			ctx.clearRect(0, 0, nw, nh);
			if (f > 0) {
				if (crop) {
					ctx.drawImage(shot, crop.x, crop.y, crop.w, crop.h, (nw - crop.destW) / 2, (nh - crop.destH) / 2, crop.destW, crop.destH);
				} else {
					ctx.setTransform(f, 0, 0, f, dx, dy);
					ctx.drawImage(shot, 0, 0);
					ctx.setTransform(1, 0, 0, 1, 0, 0);
				}
				st.paintTransform = null;
				const mapTf = (t) => ({ cx: dx + f * t.cx, cy: dy + f * t.cy, sx: t.sx * f, sy: t.sy * f, rot: t.rot });
				if (st.underlayTransform) st.underlayTransform = mapTf(st.underlayTransform);
				for (const l of st.calcoLayers) {
					l.tf = mapTf(l.tf);
					l.tf0 = mapTf(l.tf0);
				}
			}
			// La base se redibuja "contain" en el tamaño nuevo y la máscara usa
			// el mismo mapeo que el trazo.
			drawBase(node);
			if (maskShot) {
				if (f > 0) drawMapped(st.maskCanvas, maskShot, f, dx, dy);
				redrawMask(node);
				writeMask(node);
			}
			drawUnderlay(node);
			renderPreview(node);
			drawTransformUI(node);
			refreshCursor(node);
			if (st.dirty) write(node);
			if (st.underlayImg || st.calcoLayers.length) writeCalco(node);
			st.refit?.();
		}

		// Aplica fondo del modo, color de trazo y visibilidad del picker.
		function applyMode(node) {
			const st = node._mikaLineart;
			if (!st) return;
			st.stage.style.background = modeBg(node);
			st.color = modeStroke(node);
			clearOverlay(node);
			if (st.colorInput) st.colorInput.style.display = isLineart(node) ? "none" : "";
		}

		function hookWidget(node, widget, fn) {
			if (!widget || widget._mikaHooked) return;
			widget._mikaHooked = true;
			const orig = widget.callback;
			widget.callback = function (value, ...rest) {
				const r = orig ? orig.apply(this, [value, ...rest]) : undefined;
				fn(value ?? widget.value);
				return r;
			};
		}

		function mkButton(label, title) {
			const b = document.createElement("button");
			b.textContent = label;
			b.title = title || label;
			b.style.height = "22px";
			b.style.minWidth = "26px";
			b.style.padding = "0 6px";
			b.style.border = "1px solid var(--border-color, #444)";
			b.style.borderRadius = "3px";
			b.style.background = "var(--comfy-input-bg, #222)";
			b.style.color = "var(--input-text, #eee)";
			b.style.cursor = "pointer";
			b.style.fontSize = "12px";
			return b;
		}

		// Botón con un ícono SVG en lugar de texto.
		function mkIconButton(icon, title) {
			const b = mkButton("", title);
			b.innerHTML = icon;
			b.style.display = "inline-flex";
			b.style.alignItems = "center";
			b.style.justifyContent = "center";
			return b;
		}

		function mkValueLabel(v) {
			const s = document.createElement("span");
			s.textContent = String(v);
			s.style.fontSize = "11px";
			s.style.minWidth = "16px";
			s.style.textAlign = "center";
			s.style.color = "var(--input-text, #eee)";
			return s;
		}

		function mkGroup(...nodes) {
			const g = document.createElement("span");
			g.style.display = "inline-flex";
			g.style.alignItems = "center";
			g.style.gap = "2px";
			g.style.flexShrink = "0";
			for (const n of nodes) g.appendChild(n);
			return g;
		}

		function styleInput(el) {
			el.style.height = "22px";
			el.style.background = "var(--comfy-input-bg, #222)";
			el.style.color = "var(--input-text, #eee)";
			el.style.border = "1px solid var(--border-color, #444)";
			el.style.borderRadius = "3px";
			el.style.fontSize = "12px";
			el.style.boxSizing = "border-box";
			return el;
		}

		// Selector de fuente con vista previa: cada opción se muestra con su
		// propia tipografía (como el desplegable del Paint). La lista se arma
		// al abrir, así refleja las fuentes que se hayan cargado.
		function mkFontPicker(getValue, onPick, getGroups) {
			const wrap = document.createElement("span");
			wrap.style.position = "relative";
			wrap.style.display = "inline-block";

			const btn = document.createElement("button");
			btn.title = "Fuente";
			btn.style.height = "22px";
			btn.style.minWidth = "130px";
			btn.style.maxWidth = "150px";
			btn.style.padding = "0 8px";
			btn.style.border = "1px solid var(--border-color, #444)";
			btn.style.borderRadius = "3px";
			btn.style.background = "var(--comfy-input-bg, #222)";
			btn.style.color = "var(--input-text, #eee)";
			btn.style.cursor = "pointer";
			btn.style.fontSize = "15px";
			btn.style.overflow = "hidden";
			btn.style.whiteSpace = "nowrap";
			btn.style.textOverflow = "ellipsis";
			btn.style.textAlign = "left";

			const refreshBtn = () => {
				const v = getValue();
				btn.textContent = v + " ▾";
				btn.style.fontFamily = `"${v}"`;
			};
			refreshBtn();

			const panel = document.createElement("div");
			panel.style.position = "absolute";
			panel.style.zIndex = "30";
			panel.style.left = "0";
			panel.style.top = "24px";
			panel.style.maxHeight = "280px";
			panel.style.overflowY = "auto";
			panel.style.minWidth = "210px";
			panel.style.background = "var(--comfy-menu-bg, #222)";
			panel.style.border = "1px solid var(--border-color, #444)";
			panel.style.borderRadius = "4px";
			panel.style.padding = "3px";
			panel.style.display = "none";

			const buildList = () => {
				panel.textContent = "";
				for (const [gname, fonts] of getGroups()) {
					const h = document.createElement("div");
					h.textContent = gname;
					h.style.fontSize = "10px";
					h.style.opacity = "0.6";
					h.style.padding = "3px 6px";
					panel.appendChild(h);
					for (const f of fonts) {
						const it = document.createElement("div");
						it.textContent = f;
						it.style.fontFamily = `"${f}"`;
						it.style.fontSize = "16px";
						it.style.padding = "3px 9px";
						it.style.cursor = "pointer";
						it.style.whiteSpace = "nowrap";
						it.onmouseenter = () => { it.style.background = "var(--comfy-input-bg, #3a3a3a)"; };
						it.onmouseleave = () => { it.style.background = ""; };
						it.onclick = () => { onPick(f); refreshBtn(); panel.style.display = "none"; };
						panel.appendChild(it);
					}
				}
			};

			wrap.refreshList = () => { if (panel.style.display !== "none") buildList(); };
			btn.onclick = (e) => {
				e.stopPropagation();
				if (panel.style.display === "none") { buildList(); panel.style.display = "block"; }
				else panel.style.display = "none";
			};
			const closeOnOutside = (e) => {
				if (!wrap.isConnected) { document.removeEventListener("pointerdown", closeOnOutside); return; }
				if (!wrap.contains(e.target)) panel.style.display = "none";
			};
			document.addEventListener("pointerdown", closeOnOutside);

			wrap.appendChild(btn);
			wrap.appendChild(panel);
			return wrap;
		}

		// Menú para sumar tipografías: cargar archivos locales (.ttf/.otf),
		// agregar una instalada por nombre, o abrir dafont para bajar más.
		function mkFontAddMenu(onChanged) {
			const wrap = document.createElement("span");
			wrap.style.position = "relative";
			wrap.style.display = "inline-block";

			const btn = document.createElement("button");
			btn.textContent = "➕";
			btn.title = "Agregar tipografías";
			btn.style.height = "22px";
			btn.style.minWidth = "26px";
			btn.style.border = "1px solid var(--border-color, #444)";
			btn.style.borderRadius = "3px";
			btn.style.background = "var(--comfy-input-bg, #222)";
			btn.style.color = "var(--input-text, #eee)";
			btn.style.cursor = "pointer";
			btn.style.fontSize = "12px";

			const panel = document.createElement("div");
			panel.style.position = "absolute";
			panel.style.zIndex = "30";
			panel.style.left = "0";
			panel.style.top = "24px";
			panel.style.minWidth = "240px";
			panel.style.background = "var(--comfy-menu-bg, #222)";
			panel.style.border = "1px solid var(--border-color, #444)";
			panel.style.borderRadius = "4px";
			panel.style.padding = "4px";
			panel.style.display = "none";

			const item = (label, fn) => {
				const d = document.createElement("div");
				d.textContent = label;
				d.style.padding = "5px 8px";
				d.style.cursor = "pointer";
				d.style.fontSize = "12px";
				d.style.whiteSpace = "nowrap";
				d.onmouseenter = () => { d.style.background = "var(--comfy-input-bg, #3a3a3a)"; };
				d.onmouseleave = () => { d.style.background = ""; };
				d.onclick = () => { panel.style.display = "none"; fn(); };
				panel.appendChild(d);
			};

			const input = document.createElement("input");
			input.type = "file";
			input.accept = ".ttf,.otf,.woff,.woff2";
			input.multiple = true;
			input.style.display = "none";
			input.addEventListener("change", async () => {
				await loadFontFiles(Array.from(input.files || []));
				input.value = "";
				onChanged();
			});
			wrap.appendChild(input);

			item("Cargar fuentes (.ttf / .otf)…", () => input.click());
			item("Agregar instalada por nombre…", () => {
				const n = prompt("Nombre de la fuente (como figura en Windows):");
				if (n && !ADDED_FONTS.includes(n)) {
					ADDED_FONTS.push(n);
					saveAddedFonts();
					onChanged();
				}
			});
			item("Abrir dafont (temas de cómic)…", () => {
				window.open("https://www.dafont.com/es/theme.php?cat=102", "_blank");
			});

			btn.onclick = (e) => {
				e.stopPropagation();
				panel.style.display = panel.style.display === "none" ? "block" : "none";
			};
			const closeOnOutside = (e) => {
				if (!wrap.isConnected) { document.removeEventListener("pointerdown", closeOnOutside); return; }
				if (!wrap.contains(e.target)) panel.style.display = "none";
			};
			document.addEventListener("pointerdown", closeOnOutside);

			wrap.appendChild(btn);
			wrap.appendChild(panel);
			return wrap;
		}

		function withImageFile(file, onPick) {
			if (!file) return;
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = () => { try { onPick(img, file.name || ""); } finally { URL.revokeObjectURL(url); } };
			img.onerror = () => URL.revokeObjectURL(url);
			img.src = url;
		}

		function nameFromUrl(url) {
			try { return decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || ""); } catch (e) { return ""; }
		}

		function withImageUrl(url, onPick) {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.onload = () => onPick(img, nameFromUrl(url));
			img.src = url;
		}

		// Botón de archivo con <label>: la activación es nativa (no depende de
		// input.click(), que algunos navegadores bloquean).
		function mkFileButton(label, title, onPick) {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = "image/*";
			input.style.display = "none";
			input.addEventListener("change", () => {
				const file = input.files?.[0];
				input.value = "";
				if (file) withImageFile(file, onPick);
			});

			const btn = document.createElement("label");
			btn.textContent = label;
			btn.title = title || label;
			btn.style.height = "22px";
			btn.style.minWidth = "26px";
			btn.style.padding = "0 6px";
			btn.style.border = "1px solid var(--border-color, #444)";
			btn.style.borderRadius = "3px";
			btn.style.background = "var(--comfy-input-bg, #222)";
			btn.style.color = "var(--input-text, #eee)";
			btn.style.cursor = "pointer";
			btn.style.fontSize = "12px";
			btn.style.display = "inline-flex";
			btn.style.alignItems = "center";
			btn.style.justifyContent = "center";
			btn.style.boxSizing = "border-box";
			btn.appendChild(input);
			return btn;
		}

		// Pega una imagen del portapapeles (el navegador pide permiso).
		async function pasteFromClipboard(apply) {
			try {
				if (!navigator.clipboard?.read) {
					throw new Error("tu navegador no permite leer el portapapeles");
				}
				const items = await navigator.clipboard.read();
				for (const item of items) {
					const type = item.types.find((t) => t.startsWith("image/"));
					if (!type) continue;
					const blob = await item.getType(type);
					withImageFile(blob, apply);
					return;
				}
				alert("No hay ninguna imagen en el portapapeles.");
			} catch (e) {
				alert("No se pudo pegar la imagen: " + ((e && e.message) || e));
			}
		}

		// Devuelve true si tomó un archivo/URL del arrastre. Lo arrastrado se
		// agrega como capa del CALCO (referencia tenue), no en la capa editable.
		function handleDroppedData(node, dt) {
			if (!dt) return false;
			// En el nodo de inpaint lo que se arrastra es la imagen a editar (capa
			// de trazo); en el de lineart, una referencia de calco.
			const dropImage = (img, name) =>
				(isInpaint ? loadContent(node, img, name) : addCalcoLayer(node, img, name));
			const files = Array.from(dt.files || []);
			const file = files.find((f) => (f.type || "").startsWith("image/")) || files[0];
			if (file) {
				withImageFile(file, dropImage);
				return true;
			}
			const uri = firstUri(dt.getData ? dt.getData("text/uri-list") : "") ||
				firstUri(dt.getData ? dt.getData("text/plain") : "");
			if (uri) {
				let target = null;
				try { target = new URL(uri, location.href); } catch (e) { /* no-op */ }
				// Solo mismo origen (arrastres desde el propio ComfyUI).
				if (target && target.origin === location.origin) {
					withImageUrl(target.href, dropImage);
					return true;
				}
			}
			return false;
		}

		function firstUri(text) {
			return String(text || "").split(/[\r\n]+/).map((s) => s.trim()).find(Boolean) || "";
		}

		function wireDomDrop(node, el) {
			el.addEventListener("dragover", (e) => {
				e.preventDefault();
				if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
			});
			el.addEventListener("drop", (e) => {
				e.preventDefault();
				e.stopPropagation();
				handleDroppedData(node, e.dataTransfer);
			});
		}

		// Permite navegar el grafo con el mouse sin salir del nodo: la rueda
		// hace zoom y el botón central (o Alt + arrastrar) panea. Se engancha
		// en captura para no iniciar un trazo al panear.
		function wireCanvasNav(el) {
			const canvasApi = () => app.canvas;
			let pan = null;

			el.addEventListener("wheel", (e) => {
				const c = canvasApi();
				if (!c?.processMouseWheel) return;
				e.preventDefault();
				e.stopPropagation();
				c.processMouseWheel(e);
			}, { passive: false });

			el.addEventListener("pointerdown", (e) => {
				const panBtn = e.button === 1 || (e.button === 0 && e.altKey);
				if (!panBtn) return;
				e.preventDefault();
				e.stopPropagation();
				const ds = canvasApi()?.ds;
				pan = { x: e.clientX, y: e.clientY, off: ds ? [...ds.offset] : null };
				try { el.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }
			}, { capture: true });

			el.addEventListener("pointermove", (e) => {
				if (!pan) return;
				e.preventDefault();
				e.stopPropagation();
				const c = canvasApi();
				const ds = c?.ds;
				if (!ds || !pan.off) return;
				ds.offset = [pan.off[0] + (e.clientX - pan.x), pan.off[1] + (e.clientY - pan.y)];
				ds.computeVisibleArea?.();
				ds.onChanged?.();
				c.setDirty(true, true);
			}, { capture: true });

			const endPan = (e) => {
				if (!pan) return;
				pan = null;
				e?.stopPropagation?.();
			};
			el.addEventListener("pointerup", endPan, { capture: true });
			el.addEventListener("pointercancel", endPan, { capture: true });
		}

		// --- Cursor circular con el tamaño de la herramienta activa ---
		function toolSize(node) {
			const st = node._mikaLineart;
			if (st.tool === "maskBrush" || st.tool === "maskErase") return st.maskThickness;
			if (st.tool === "eraser") return st.eraseThickness;
			if (st.tool === "soft") return st.softThickness;
			return st.thickness;
		}

		function placeCursor(node, clientX, clientY) {
			const st = node._mikaLineart;
			// El círculo del pincel solo se oculta si hay una transformación
			// en curso: tener una capa seleccionada no cambia el cursor.
			if (!st?.brushCursor || st.transformMode || st.tool === "text" || st.tool === "select" || st.textObj || st.sel) return;
			const c = st.preview;
			const r = c.getBoundingClientRect();
			if (!r.width || !r.height) return;
			// Coordenadas LOCALES: el DOM del nodo se escala con CSS al hacer
			// zoom, así que screen-px != layout-px.
			const kx = (c.offsetWidth || r.width) / r.width;
			const ky = (c.offsetHeight || r.height) / r.height;
			st.cursorPos = [clientX, clientY];
			// El círculo refleja el grosor real (incluido 1 px) escalado por
			// la transformación de la capa; sin mínimo alto.
			const t = paintTf(node);
			const layerScale = Math.sqrt(Math.abs(t.sx * t.sy)) || 1;
			const d = Math.max(1, toolSize(node) * ((c.offsetWidth || r.width) / st.paint.width) * layerScale);
			st.brushCursor.style.width = d + "px";
			st.brushCursor.style.height = d + "px";
			st.brushCursor.style.left = (clientX - r.left) * kx + "px";
			st.brushCursor.style.top = (clientY - r.top) * ky + "px";
			st.brushCursor.style.display = "block";
		}

		function clientToCanvas(node, clientX, clientY) {
			const c = node._mikaLineart.preview;
			const r = c.getBoundingClientRect();
			return [(clientX - r.left) * c.width / r.width, (clientY - r.top) * c.height / r.height];
		}

		// Cursor de resize según la diagonal visual de la esquina (con rotación).
		function resizeCursor(node, corner) {
			const which = primaryLayer(node);
			const corners = layerCorners(node, which);
			const t = layerGeom(node, which)?.t;
			if (!corners || !t) return "nwse-resize";
			const deg = (Math.atan2(corners[corner][1] - t.cy, corners[corner][0] - t.cx) * 180 / Math.PI + 360) % 180;
			return deg <= 90 ? "nwse-resize" : "nesw-resize";
		}

		function updatePointerCursor(node, clientX, clientY) {
			const st = node._mikaLineart;
			const c = st?.preview;
			if (!c) return;
			st.lastClientPos = [clientX, clientY];
			// Los cursores de mover/redimensionar/rotar solo aparecen cuando la
			// transformación está activa (✥, un texto en edición o una pieza
			// del lazo); con solo tener una capa seleccionada, el cursor sigue
			// siendo el de la herramienta.
			if (!st.transformMode && !st.textObj && !st.sel) { c.style.cursor = CURSOR_CROSS; return; }
			const [x, y] = clientToCanvas(node, clientX, clientY);
			const hit = transformHit(node, x, y);
			if (!hit) c.style.cursor = CURSOR_CROSS;
			else if (hit.kind === "rotate") c.style.cursor = CURSOR_ROTATE;
			else if (hit.kind === "resize") c.style.cursor = resizeCursor(node, hit.corner);
			else c.style.cursor = "move";
		}

		function hideCursor(node) {
			const st = node._mikaLineart;
			if (!st?.brushCursor) return;
			st.brushCursor.style.display = "none";
			st.cursorPos = null;
		}

		function refreshCursor(node) {
			const st = node._mikaLineart;
			if (st?.cursorPos) placeCursor(node, st.cursorPos[0], st.cursorPos[1]);
		}

		// --- Capas transformables (trazo y calco) ---
		// Cada capa tiene una transformación {cx, cy, sx, sy, rot} que mapea
		// puntos locales (centrados) al espacio del lienzo:
		//   content = center + R(rot) · S(sx, sy) · local
		const identityTf = (w, h) => ({ cx: w / 2, cy: h / 2, sx: 1, sy: 1, rot: 0 });
		const paintTf = (node) => {
			const st = node._mikaLineart;
			return st.paintTransform || identityTf(st.paint.width, st.paint.height);
		};

		function fitUnderlay(node) {
			const st = node._mikaLineart;
			const img = st?.underlayImg;
			if (!img) return;
			const cw = st.paint.width;
			const ch = st.paint.height;
			const s = Math.min(cw / img.width, ch / img.height);
			st.underlayTransform = { cx: cw / 2, cy: ch / 2, sx: s, sy: s, rot: 0 };
		}

		// Estira el calco para ocupar exactamente el lienzo (escala X e Y
		// independientes; puede distorsionar). Centrado y sin rotación.
		function stretchUnderlay(node) {
			const st = node._mikaLineart;
			const img = st?.underlayImg;
			if (!img) return;
			st.underlayTransform = {
				cx: st.paint.width / 2,
				cy: st.paint.height / 2,
				sx: st.paint.width / img.width,
				sy: st.paint.height / img.height,
				rot: 0,
			};
		}

		// --- Capas del calco (apilables, solo de sesión) ---

		// Nombre de capa: "calco", "calco2", "calco3"…
		function calcoLayerName(st) {
			const n = st.calcoNameSeq++;
			return n === 0 ? "calco" : "calco" + (n + 1);
		}

		// Convierte una imagen en una capa: fuente propia, encaje "contain"
		// centrado y miniatura para el panel.
		function makeLayer(node, img) {
			const st = node._mikaLineart;
			const src = document.createElement("canvas");
			src.width = img.width || img.naturalWidth;
			src.height = img.height || img.naturalHeight;
			src.getContext("2d").drawImage(img, 0, 0);
			const cw = st.paint.width;
			const ch = st.paint.height;
			const s = Math.min(cw / src.width, ch / src.height);
			const tf = { cx: cw / 2, cy: ch / 2, sx: s, sy: s, rot: 0 };
			const thumb = document.createElement("canvas");
			const ts = Math.min(1, 64 / Math.max(src.width, src.height));
			thumb.width = Math.max(1, Math.round(src.width * ts));
			thumb.height = Math.max(1, Math.round(src.height * ts));
			thumb.getContext("2d").drawImage(src, 0, 0, thumb.width, thumb.height);
			return { id: "L" + (st.layerSeq++), name: calcoLayerName(st), w: src.width, h: src.height, src, tf, tf0: { ...tf }, visible: true, thumb: thumb.toDataURL("image/png") };
		}

		function addCalcoLayer(node, img, name) {
			const st = node._mikaLineart;
			const layer = makeLayer(node, img);
			st.calcoLayers.push(layer);
			st.selection = [layerKey(layer)];
			if (name) setArchivo(node, name);
			drawCalcoLayers(node);
			renderLayerPanel(node);
			drawTransformUI(node);
			writeCalco(node);
		}

		function removeCalcoLayer(node, id) {
			const st = node._mikaLineart;
			st.calcoLayers = st.calcoLayers.filter((l) => l.id !== id);
			st.selection = st.selection.filter((k) => k !== "L:" + id);
			drawCalcoLayers(node);
			renderLayerPanel(node);
			drawTransformUI(node);
			writeCalco(node);
		}

		function toggleCalcoLayer(node, id) {
			const st = node._mikaLineart;
			const l = st.calcoLayers.find((x) => x.id === id);
			if (!l) return;
			l.visible = !l.visible;
			if (!l.visible) st.selection = st.selection.filter((k) => k !== layerKey(l));
			drawCalcoLayers(node);
			renderLayerPanel(node);
			drawTransformUI(node);
			writeCalco(node);
		}

		function moveCalcoLayer(node, id, dir) {
			const st = node._mikaLineart;
			const i = st.calcoLayers.findIndex((l) => l.id === id);
			const j = i + dir;
			if (i < 0 || j < 0 || j >= st.calcoLayers.length) return;
			const [l] = st.calcoLayers.splice(i, 1);
			st.calcoLayers.splice(j, 0, l);
			drawCalcoLayers(node);
			renderLayerPanel(node);
			writeCalco(node);
		}

		// Dibuja las capas del calco (encima del calco base, debajo del trazo),
		// de abajo hacia arriba, solo las visibles.
		function drawCalcoLayers(node) {
			const st = node._mikaLineart;
			if (!st?.calcoLayersCanvas) return;
			const ctx = st.calcoLayersCanvas.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, st.calcoLayersCanvas.width, st.calcoLayersCanvas.height);
			for (const l of st.calcoLayers) {
				if (!l.visible) continue;
				ctx.save();
				ctx.translate(l.tf.cx, l.tf.cy);
				ctx.rotate(l.tf.rot);
				ctx.scale(l.tf.sx, l.tf.sy);
				ctx.drawImage(l.src, -l.w / 2, -l.h / 2);
				ctx.restore();
			}
		}

		// Composición del calco (fondo blanco + calco base + capas visibles),
		// igual que la salida "calco" del nodo.
		function composeCalco(node) {
			const st = node._mikaLineart;
			const [w, h] = parseRes(resolucionWidget(node)?.value);
			const tmp = document.createElement("canvas");
			tmp.width = w;
			tmp.height = h;
			const ctx = tmp.getContext("2d");
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, w, h);
			const img = st.underlayImg;
			const t = st.underlayTransform;
			if (img && t) {
				ctx.save();
				ctx.translate(t.cx, t.cy);
				ctx.rotate(t.rot);
				ctx.scale(t.sx, t.sy);
				ctx.drawImage(img, -img.width / 2, -img.height / 2);
				ctx.restore();
			}
			for (const l of st.calcoLayers) {
				if (!l.visible) continue;
				ctx.save();
				ctx.translate(l.tf.cx, l.tf.cy);
				ctx.rotate(l.tf.rot);
				ctx.scale(l.tf.sx, l.tf.sy);
				ctx.drawImage(l.src, -l.w / 2, -l.h / 2);
				ctx.restore();
			}
			return tmp;
		}

		function setCalcoWidget(node, value) {
			const w = node.widgets?.find((x) => x.name === "calco");
			if (!w) return;
			w.value = value;
			w.callback?.(value);
		}

		function writeCalco(node) {
			const st = node._mikaLineart;
			if (!st) return;
			setCalcoWidget(node, composeCalco(node).toDataURL("image/png").split(",")[1]);
			persistCalcoCache(node);
		}

		// --- Máscara de inpaint (solo en el nodo de inpaint) ---
		// Se pinta rojo opaco sobre transparente; el canal alfa ES la máscara
		// (1 = zona a regenerar). El nodo Python la lee del widget "mascara".

		function setMascaraWidget(node, value) {
			const w = node.widgets?.find((x) => x.name === "mascara");
			if (!w) return;
			w.value = value;
			w.callback?.(value);
		}

		function maskHasContent(node) {
			const st = node._mikaLineart;
			if (!st?.maskCanvas) return false;
			const c = st.maskCanvas;
			const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
			for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
			return false;
		}

		// Capa visible: solo muestra la máscara, y se oculta si está vacía.
		// `show` evita el barrido de píxeles mientras se dibuja (caro a 1024²).
		function redrawMask(node, show = null) {
			const st = node._mikaLineart;
			if (!st?.maskCanvas || !st.maskLayer) return;
			const ctx = st.maskLayer.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, st.maskLayer.width, st.maskLayer.height);
			ctx.drawImage(st.maskCanvas, 0, 0);
			const visible = show === null ? maskHasContent(node) : show;
			st.maskLayer.style.display = visible ? "" : "none";
		}

		function writeMask(node) {
			const st = node._mikaLineart;
			if (!st?.maskCanvas) return;
			setMascaraWidget(node, maskHasContent(node) ? st.maskCanvas.toDataURL("image/png").split(",")[1] : "");
		}

		function loadMask(node) {
			const st = node._mikaLineart;
			if (!st?.maskCanvas) return;
			const ctx = st.maskCanvas.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalCompositeOperation = "source-over";
			ctx.clearRect(0, 0, st.maskCanvas.width, st.maskCanvas.height);
			const val = node.widgets?.find((x) => x.name === "mascara")?.value;
			if (!(typeof val === "string" && val)) {
				redrawMask(node);
				return;
			}
			const img = new Image();
			img.onload = () => {
				ctx.clearRect(0, 0, st.maskCanvas.width, st.maskCanvas.height);
				ctx.drawImage(img, 0, 0);
				redrawMask(node);
			};
			img.src = "data:image/png;base64," + val;
		}

		function clearMask(node) {
			const st = node._mikaLineart;
			if (!st?.maskCanvas) return;
			pushUndo(node);
			const ctx = st.maskCanvas.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalCompositeOperation = "source-over";
			ctx.clearRect(0, 0, st.maskCanvas.width, st.maskCanvas.height);
			redrawMask(node);
			writeMask(node);
		}

		// Invierte: lo pintado queda transparente y el resto rojo opaco.
		function invertMask(node) {
			const st = node._mikaLineart;
			if (!st?.maskCanvas) return;
			pushUndo(node);
			const old = document.createElement("canvas");
			old.width = st.maskCanvas.width;
			old.height = st.maskCanvas.height;
			old.getContext("2d").drawImage(st.maskCanvas, 0, 0);
			const ctx = st.maskCanvas.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalCompositeOperation = "source-over";
			ctx.fillStyle = "#ff3b3b";
			ctx.fillRect(0, 0, st.maskCanvas.width, st.maskCanvas.height);
			ctx.globalCompositeOperation = "destination-out";
			ctx.drawImage(old, 0, 0);
			ctx.globalCompositeOperation = "source-over";
			redrawMask(node);
			writeMask(node);
		}

		// --- Proyecto (importar/exportar) y guardado de imágenes ---

		// Nombre base para los archivos exportados (del último archivo cargado).
		function exportBaseName(node) {
			const raw = archivoWidget(node)?.value || "";
			const base = String(raw).replace(/\.[^./\\]+$/, "").trim();
			return base || "anima_lineart";
		}

		function downloadUrl(url, filename) {
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.style.display = "none";
			document.body.appendChild(a);
			a.click();
			a.remove();
		}

		function imageToDataUrl(img) {
			const c = document.createElement("canvas");
			c.width = img.width || img.naturalWidth;
			c.height = img.height || img.naturalHeight;
			c.getContext("2d").drawImage(img, 0, 0);
			return c.toDataURL("image/png");
		}

		function imageFromBase64(b64) {
			return new Promise((resolve, reject) => {
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = () => reject(new Error("no se pudo decodificar una imagen del proyecto"));
				img.src = "data:image/png;base64," + b64;
			});
		}

		// Nombre del proyecto (sin la extensión) para la salida "nombre_archivo".
		function projectBaseName(name) {
			return String(name || "").replace(/\.[^./\\]+$/, "").trim() || "anima_lineart";
		}

		// Canvas del trazo con su transformación horneada (transparente).
		function bakeTrazo(node) {
			const st = node._mikaLineart;
			const t = st.paintTransform;
			if (!t) return st.paint;
			const out = document.createElement("canvas");
			out.width = st.paint.width;
			out.height = st.paint.height;
			const ctx = out.getContext("2d");
			ctx.translate(t.cx, t.cy);
			ctx.rotate(t.rot);
			ctx.scale(t.sx, t.sy);
			ctx.drawImage(st.paint, -st.paint.width / 2, -st.paint.height / 2);
			return out;
		}

		// Guarda una de las salidas como PNG: la imagen fuente del nodo de inpaint
		// (fondo + foto), el trazo, la máscara o el calco.
		function saveImage(node, which) {
			const st = node._mikaLineart;
			if (!st) return;
			let canvas;
			if (which === "calco") canvas = composeCalco(node);
			else if (which === "mascara") canvas = st.maskCanvas;
			else if (which === "imagen") canvas = composeBase(node);
			else canvas = composeOutput(node);
			downloadUrl(canvas.toDataURL("image/png"), `${exportBaseName(node)}_${which}.png`);
		}

		// Exporta trazo + calco (base y capas) + resolución y modo a un JSON.
		function exportProject(node) {
			const st = node._mikaLineart;
			if (!st) return;
			const project = {
				mika: "anima-lineart-canvas",
				version: 1,
				resolucion: resolucionWidget(node)?.value ?? null,
				modo: modoWidget(node)?.value ?? null,
				trazo: bakeTrazo(node).toDataURL("image/png").split(",")[1],
				calco: {
					base: (st.underlayImg && st.underlayTransform)
						? { img: imageToDataUrl(st.underlayImg).split(",")[1], tf: st.underlayTransform }
						: null,
					capas: st.calcoLayers.map((l) => ({
						name: l.name, tf: l.tf, tf0: l.tf0, visible: l.visible,
						img: imageToDataUrl(l.src).split(",")[1],
					})),
				},
			};
			// La máscara solo existe en el nodo de inpaint.
			if (st.maskCanvas) project.mascara = st.maskCanvas.toDataURL("image/png").split(",")[1];
			const url = URL.createObjectURL(new Blob([JSON.stringify(project)], { type: "application/json" }));
			downloadUrl(url, `${exportBaseName(node)}.mika.json`);
			setTimeout(() => URL.revokeObjectURL(url), 10000);
		}

		// Restaura un proyecto exportado con exportProject.
		async function importProject(node, file) {
			const st = node._mikaLineart;
			if (!st || !file || st._importing) return;
			let project;
			try {
				project = JSON.parse(await file.text());
			} catch (e) {
				alert("No se pudo leer el proyecto: " + ((e && e.message) || e));
				return;
			}
			if (project?.mika !== "anima-lineart-canvas") {
				alert("El archivo no es un proyecto de este nodo.");
				return;
			}
			st._importing = true;
			try {
				// Decodificar todo antes de tocar el estado, así un archivo
				// incompleto no deja el nodo a medio importar.
				const trazo = project.trazo ? await imageFromBase64(project.trazo) : null;
				const base = project.calco?.base?.img ? await imageFromBase64(project.calco.base.img) : null;
				const mascara = (project.mascara && st.maskCanvas) ? await imageFromBase64(project.mascara) : null;
				const capas = [];
				for (const c of (project.calco?.capas || [])) capas.push({ c, img: await imageFromBase64(c.img) });

				cancelSel(node);
				const rw = resolucionWidget(node);
				if (project.resolucion && rw && project.resolucion !== rw.value) {
					rw.value = project.resolucion;
					rw.callback?.(project.resolucion);
				}
				const mw = modoWidget(node);
				if (project.modo && mw && project.modo !== mw.value) {
					mw.value = project.modo;
					mw.callback?.(project.modo);
				}
				const paint = paintCtx(node);
				paint.setTransform(1, 0, 0, 1, 0, 0);
				paint.globalCompositeOperation = "source-over";
				paint.clearRect(0, 0, st.paint.width, st.paint.height);
				if (trazo) paint.drawImage(trazo, 0, 0);
				st.paintTransform = null;
				st.contentSize = null;
				st.undo = [];
				st.redo = [];
				renderPreview(node);
				write(node);

				st.calcoLayers = capas.map(({ c, img }) => {
					const layer = makeLayer(node, img);
					if (c.name) layer.name = c.name;
					if (c.tf) { layer.tf = c.tf; layer.tf0 = c.tf0 || c.tf; }
					layer.visible = c.visible !== false;
					return layer;
				});
				st.underlayImg = base;
				st.underlayTransform = base ? (project.calco.base.tf || null) : null;
				st.underlay.style.display = "";
				st.selection = [];
				st.sel = null;
				setArchivo(node, projectBaseName(file.name));
				drawUnderlay(node);
				drawTransformUI(node);
				renderLayerPanel(node);
				writeCalco(node);
				if (st.maskCanvas) {
					const mctx = st.maskCanvas.getContext("2d");
					mctx.setTransform(1, 0, 0, 1, 0, 0);
					mctx.globalCompositeOperation = "source-over";
					mctx.clearRect(0, 0, st.maskCanvas.width, st.maskCanvas.height);
					if (mascara) mctx.drawImage(mascara, 0, 0);
					redrawMask(node);
					writeMask(node);
				}
				st.refit?.();
			} catch (e) {
				alert("No se pudo importar el proyecto: " + ((e && e.message) || e));
			} finally {
				st._importing = false;
			}
		}

		// Funde en el calco base las capas calco SELECCIONADAS y visibles.
		function mergeSelected(node) {
			const st = node._mikaLineart;
			const keys = st.selection.filter((k) => String(k).startsWith("L:"));
			const sel = keys.map((k) => layerByKey(node, k)).filter((l) => l && l.visible);
			if (!sel.length) return;
			const W = st.paint.width, H = st.paint.height;
			const comp = document.createElement("canvas");
			comp.width = W; comp.height = H;
			const ctx = comp.getContext("2d");
			const img = st.underlayImg;
			const t = st.underlayTransform;
			if (img && t) {
				ctx.save();
				ctx.translate(t.cx, t.cy); ctx.rotate(t.rot); ctx.scale(t.sx, t.sy);
				ctx.drawImage(img, -img.width / 2, -img.height / 2);
				ctx.restore();
			}
			for (const l of st.calcoLayers) {
				if (!sel.includes(l)) continue;
				ctx.save();
				ctx.translate(l.tf.cx, l.tf.cy); ctx.rotate(l.tf.rot); ctx.scale(l.tf.sx, l.tf.sy);
				ctx.drawImage(l.src, -l.w / 2, -l.h / 2);
				ctx.restore();
			}
			const out = new Image();
			out.onload = () => {
				st.underlayImg = out;
				st.underlayTransform = { cx: W / 2, cy: H / 2, sx: 1, sy: 1, rot: 0 };
				st.calcoLayers = st.calcoLayers.filter((l) => !sel.includes(l));
				st.selection = st.selection.filter((k) => !keys.includes(k) && layerGeom(node, k));
				drawUnderlay(node);
				renderLayerPanel(node);
				drawTransformUI(node);
				writeCalco(node);
			};
			out.src = comp.toDataURL("image/png");
		}

		// Miniatura chica de una capa ("paint" | "underlay").
		function thumbOf(node, key) {
			const st = node._mikaLineart;
			const src = key === "paint" ? st.preview : (key === "underlay" ? st.underlay : null);
			if (!src || !src.width || !src.height) return "";
			const c = document.createElement("canvas");
			const ts = Math.min(1, 64 / Math.max(src.width, src.height));
			c.width = Math.max(1, Math.round(src.width * ts));
			c.height = Math.max(1, Math.round(src.height * ts));
			c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
			return c.toDataURL("image/png");
		}

		function toggleBaseVisibility(node) {
			const st = node._mikaLineart;
			const hide = st.underlay.style.display !== "none";
			st.underlay.style.display = hide ? "none" : "";
			if (hide) st.selection = st.selection.filter((k) => k !== "underlay");
			persistCalcoCache(node);
			renderLayerPanel(node);
			drawTransformUI(node);
		}

		function removeBase(node) {
			const st = node._mikaLineart;
			st.underlayImg = null;
			st.underlayTransform = null;
			st.selection = st.selection.filter((k) => k !== "underlay");
			drawUnderlay(node);
			renderLayerPanel(node);
			drawTransformUI(node);
			writeCalco(node);
		}

		// Tira de capas: trazo, calco (base), calco2… Clic = seleccionar;
		// Ctrl+clic = multi-selección; 👁/✕/↑↓ por capa.
		function renderLayerPanel(node) {
			const st = node._mikaLineart;
			const panel = st?.layerPanel;
			if (!panel) return;
			panel.replaceChildren();
			panel.style.display = "flex";

			const mkItemBtn = (label, title, fn) => {
				const b = document.createElement("button");
				b.textContent = label;
				b.title = title;
				b.style.fontSize = "10px";
				b.style.lineHeight = "1";
				b.style.padding = "1px 3px";
				b.style.cursor = "pointer";
				b.onclick = (e) => { e.stopPropagation(); fn(); };
				return b;
			};

			const addItem = (key, label, thumbSrc, opts) => {
				const item = document.createElement("div");
				item.style.display = "inline-flex";
				item.style.flexDirection = "column";
				item.style.alignItems = "center";
				const th = document.createElement("img");
				th.src = thumbSrc || "";
				th.style.width = "48px";
				th.style.height = "36px";
				th.style.objectFit = "contain";
				th.style.background = "#000";
				th.style.border = isSelected(node, key) ? "2px solid #4a9" : "1px solid var(--border-color, #444)";
				th.style.borderRadius = "3px";
				th.style.cursor = "pointer";
				if (opts && opts.dim) th.style.opacity = "0.35";
				th.onclick = (e) => {
					if (e.ctrlKey || e.metaKey) toggleSelection(node, key);
					else if (isSelected(node, key) && st.selection.length === 1) clearSelection(node);
					else setSelection(node, [key]);
				};
				item.appendChild(th);
				const name = document.createElement("div");
				name.textContent = label;
				name.style.fontSize = "10px";
				name.style.opacity = "0.85";
				item.appendChild(name);
				if (opts && opts.controls) {
					const bar = document.createElement("div");
					bar.style.display = "flex";
					bar.style.gap = "1px";
					for (const [lbl, title, fn] of opts.controls) bar.appendChild(mkItemBtn(lbl, title, fn));
					item.appendChild(bar);
				}
				panel.appendChild(item);
			};

			addItem("paint", "trazo", thumbOf(node, "paint"), null);
			if (st.underlayImg) {
				addItem("underlay", "calco base", thumbOf(node, "underlay"), {
					controls: [
						["👁", "Mostrar/ocultar el calco base", () => toggleBaseVisibility(node)],
						["✕", "Quitar el calco base", () => removeBase(node)],
					],
				});
			}
			for (let i = 0; i < st.calcoLayers.length; i++) {
				const l = st.calcoLayers[i];
				addItem(layerKey(l), l.name, l.thumb, {
					dim: !l.visible,
					controls: [
						["👁", "Mostrar/ocultar", () => toggleCalcoLayer(node, l.id)],
						["✕", "Borrar capa", () => removeCalcoLayer(node, l.id)],
						["↑", "Subir", () => moveCalcoLayer(node, l.id, +1)],
						["↓", "Bajar", () => moveCalcoLayer(node, l.id, -1)],
					],
				});
			}
			st.refit?.();
		}

		// Ajusta la resolución del nodo a la fuente más parecida: el calco o la
		// imagen cargada en el trazo, según el selector (con reserva a la otra).
		// Prioriza la proporción (para no deformar) y desempata por área.
		function adaptResolution(node) {
			const st = node._mikaLineart;
			const w = resolucionWidget(node);
			if (!w) return;
			const calco = st?.underlayImg ? { w: st.underlayImg.width, h: st.underlayImg.height } : null;
			const content = st?.contentSize || null;
			// Fuente: la capa calco de la primaria seleccionada; si no, el trazo.
			let selSize = null;
			const prim = primaryLayer(node);
			if (prim === "underlay" || (typeof prim === "string" && prim.startsWith("L:"))) {
				const g = layerGeom(node, prim);
				if (g) selSize = { w: g.w, h: g.h };
			}
			const src = selSize || content || calco;
			if (!src) return;
			const target = src.w / src.h;
			const targetArea = src.w * src.h;
			let best = null;
			let score = Infinity;
			for (const opt of (w.options?.values || [])) {
				const [ow, oh] = parseRes(opt);
				const s = Math.abs(Math.log((ow / oh) / target)) + 0.15 * Math.abs(Math.log((ow * oh) / targetArea));
				if (s < score) { score = s; best = opt; }
			}
			if (best && best !== w.value) { w.value = best; w.callback?.(best); }
		}

		// --- Selección de capas (tira inferior) ---
		// Claves: "paint" (trazo) | "underlay" (calco base) | "L:<id>" (capa).
		function layerKey(layer) { return "L:" + layer.id; }
		function layerByKey(node, key) {
			if (typeof key !== "string" || !key.startsWith("L:")) return null;
			const id = key.slice(2);
			return node._mikaLineart.calcoLayers.find((l) => l.id === id) || null;
		}
		function layerVisible(node, key) {
			const st = node._mikaLineart;
			if (key === "paint") return true;
			if (key === "underlay") return st.underlay.style.display !== "none";
			const l = layerByKey(node, key);
			return !!(l && l.visible);
		}
		function selectedLayers(node) {
			return node._mikaLineart.selection.filter((k) => layerGeom(node, k) && layerVisible(node, k));
		}
		function isSelected(node, key) { return node._mikaLineart.selection.includes(key); }
		function persistCalcoCache(node) {
			const st = node._mikaLineart;
			CALCO_CACHE.set(calcoKey(node), {
				underlayImg: st.underlayImg, underlayTransform: st.underlayTransform,
				calcoLayers: st.calcoLayers, selection: st.selection.slice(),
				layerSeq: st.layerSeq, calcoNameSeq: st.calcoNameSeq, contentSize: st.contentSize,
			});
		}
		function setSelection(node, keys) {
			node._mikaLineart.selection = keys.slice();
			persistCalcoCache(node);
			drawTransformUI(node);
			renderLayerPanel(node);
		}
		function toggleSelection(node, key) {
			const s = node._mikaLineart.selection;
			const i = s.indexOf(key);
			if (i >= 0) s.splice(i, 1);
			else s.push(key);
			persistCalcoCache(node);
			drawTransformUI(node);
			renderLayerPanel(node);
		}
		function clearSelection(node) { setSelection(node, []); }

		// Dimensiones y transformación de una capa.
		function layerGeom(node, which) {
			const st = node._mikaLineart;
			if (which === "paint") return { t: paintTf(node), w: st.paint.width, h: st.paint.height };
			if (which === "underlay") {
				const img = st.underlayImg;
				const t = st.underlayTransform;
				if (!img || !t) return null;
				return { t, w: img.width, h: img.height };
			}
			if (which === "sel") {
				const s = st.sel;
				return s ? { t: s.tf, w: s.w, h: s.h } : null;
			}
			if (which === "text") {
				const o = st.textObj;
				return o ? { t: o.tf, w: o.w, h: o.h } : null;
			}
			const l = layerByKey(node, which);
			return l ? { t: l.tf, w: l.w, h: l.h } : null;
		}

		// Esquinas del rectángulo (w×h) con la transformación t.
		function cornersOfTf(t, w, h) {
			const hw = (w * t.sx) / 2;
			const hh = (h * t.sy) / 2;
			const cos = Math.cos(t.rot);
			const sin = Math.sin(t.rot);
			const pt = (x, y) => [t.cx + x * cos - y * sin, t.cy + x * sin + y * cos];
			return [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)];
		}

		function layerCorners(node, which) {
			const g = layerGeom(node, which);
			if (!g) return null;
			return cornersOfTf(g.t, g.w, g.h);
		}

		// Unión de dos cajas {x,y,w,h} (cualquiera puede ser null).
		function unionRect(a, b) {
			if (!a) return b;
			if (!b) return a;
			const x = Math.min(a.x, b.x);
			const y = Math.min(a.y, b.y);
			const x2 = Math.max(a.x + a.w, b.x + b.w);
			const y2 = Math.max(a.y + a.h, b.y + b.h);
			return { x, y, w: x2 - x, h: y2 - y };
		}

		// Capa que controla el marco/handles (el lazo/texto en curso tienen
		// prioridad; si no, la última capa seleccionada).
		function primaryLayer(node) {
			const st = node._mikaLineart;
			if (st.sel) return "sel";
			if (st.textObj) return "text";
			const s = affectedLayers(node);
			return s.length ? s[s.length - 1] : null;
		}

		function affectedLayers(node) {
			const st = node._mikaLineart;
			if (st.sel) return ["sel"];
			if (st.textObj) return ["text"];
			return selectedLayers(node);
		}

		function setLayerTf(node, which, t) {
			const st = node._mikaLineart;
			if (which === "paint") st.paintTransform = t;
			else if (which === "underlay") st.underlayTransform = t;
			else if (which === "sel") { if (st.sel) st.sel.tf = t; }
			else if (which === "text") { if (st.textObj) st.textObj.tf = t; }
			else { const l = layerByKey(node, which); if (l) l.tf = t; }
		}

		function handleSize(node) {
			return Math.max(10, node._mikaLineart.paint.width * 0.014);
		}

		function rotateHandlePos(node, which) {
			const corners = layerCorners(node, which);
			if (!corners) return null;
			const topMid = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
			const botMid = [(corners[3][0] + corners[2][0]) / 2, (corners[3][1] + corners[2][1]) / 2];
			let nx = topMid[0] - botMid[0];
			let ny = topMid[1] - botMid[1];
			const len = Math.hypot(nx, ny) || 1;
			const hs = handleSize(node);
			const dist = node._mikaLineart.paint.width * 0.05 + hs;
			// Mantenemos el handle dentro del lienzo (si no, queda fuera del
			// área que recibe los eventos y no se puede agarrar).
			const W = node._mikaLineart.paint.width;
			const H = node._mikaLineart.paint.height;
			const hx = topMid[0] + (nx / len) * dist;
			const hy = topMid[1] + (ny / len) * dist;
			return [Math.min(W - hs, Math.max(hs, hx)), Math.min(H - hs, Math.max(hs, hy))];
		}

		function pointInQuad(px, py, q) {
			let inside = false;
			for (let i = 0, j = 3; i < 4; j = i++) {
				const xi = q[i][0], yi = q[i][1], xj = q[j][0], yj = q[j][1];
				if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
					inside = !inside;
				}
			}
			return inside;
		}

		function drawTransformUI(node) {
			const st = node._mikaLineart;
			if (!st?.handles) return;
			const ctx = st.handles.getContext("2d");
			ctx.clearRect(0, 0, st.handles.width, st.handles.height);
			if (!st.transformMode && !st.textObj && !st.sel && !selectedLayers(node).length) return;
			const which = primaryLayer(node);
			const layers = affectedLayers(node);
			if (!layers.length) return;
			const hs = handleSize(node);
			ctx.lineWidth = Math.max(1, st.handles.width / 500);

			// Marco de cada capa afectada (el control va en la primaria).
			for (const l of layers) {
				const corners = layerCorners(node, l);
				if (!corners) continue;
				ctx.strokeStyle = l === which ? "rgba(0, 220, 255, 0.9)" : "rgba(255, 190, 60, 0.55)";
				ctx.beginPath();
				ctx.moveTo(corners[0][0], corners[0][1]);
				for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
				ctx.closePath();
				ctx.stroke();
			}

			const corners = layerCorners(node, which);
			if (!corners) return;
			ctx.fillStyle = "rgba(0, 220, 255, 0.9)";
			for (let i = 0; i < 4; i++) {
				ctx.fillRect(corners[i][0] - hs / 2, corners[i][1] - hs / 2, hs, hs);
			}

			const rot = rotateHandlePos(node, which);
			if (rot) {
				const topMid = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
				ctx.beginPath();
				ctx.moveTo(topMid[0], topMid[1]);
				ctx.lineTo(rot[0], rot[1]);
				ctx.stroke();
				ctx.beginPath();
				ctx.arc(rot[0], rot[1], hs / 1.6, 0, Math.PI * 2);
				ctx.fill();
			}
		}

		function transformHit(node, x, y) {
			const st = node._mikaLineart;
			if (!st?.transformMode && !st?.textObj && !st?.sel && !selectedLayers(node).length) return null;
			const which = primaryLayer(node);
			const corners = layerCorners(node, which);
			if (!corners) return null;
			const hs = handleSize(node);
			const rot = rotateHandlePos(node, which);
			if (rot && Math.hypot(x - rot[0], y - rot[1]) <= hs) return { kind: "rotate" };
			for (let i = 0; i < 4; i++) {
				if (Math.hypot(x - corners[i][0], y - corners[i][1]) <= hs) {
					return { kind: "resize", corner: i };
				}
			}
			if (pointInQuad(x, y, corners)) return { kind: "move" };
			return null;
		}

		const CORNER_SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

		// --- Render de la capa de trazo con su transformación ---
		function renderPreview(node) {
			const st = node._mikaLineart;
			if (!st?.preview) return;
			const ctx = st.preview.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, st.preview.width, st.preview.height);
			const t = paintTf(node);
			ctx.save();
			ctx.translate(t.cx, t.cy);
			ctx.rotate(t.rot);
			ctx.scale(t.sx, t.sy);
			ctx.drawImage(st.paint, -st.paint.width / 2, -st.paint.height / 2);
			ctx.restore();
		}

		// Ejecuta fn con la transformación de la capa de trazo aplicada.
		function withTf(node, ctx, fn) {
			const st = node._mikaLineart;
			const t = paintTf(node);
			ctx.save();
			ctx.translate(t.cx, t.cy);
			ctx.rotate(t.rot);
			ctx.scale(t.sx, t.sy);
			ctx.translate(-st.paint.width / 2, -st.paint.height / 2);
			fn(ctx);
			ctx.restore();
		}

		// --- Texto en edición (objeto movible/escalable/invertible) ---
		function measureText(node, text, font, size) {
			const ctx = paintCtx(node);
			ctx.save();
			ctx.font = `${size}px "${font}"`;
			const m = ctx.measureText(text || " ");
			ctx.restore();
			return { w: Math.max(1, m.width), h: size * 1.2 };
		}

		function drawTextObj(node) {
			const st = node._mikaLineart;
			if (!st?.overlay) return;
			const ctx = st.overlay.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, st.overlay.width, st.overlay.height);
			const o = st.textObj;
			if (!o) return;
			drawTextInto(ctx, o, o.tf);
		}

		// Dibuja el texto aplicando su transformación (centrada).
		function drawTextInto(ctx, o, t) {
			ctx.save();
			ctx.translate(t.cx, t.cy);
			ctx.rotate(t.rot);
			ctx.scale(t.sx, t.sy);
			ctx.globalCompositeOperation = "source-over";
			ctx.fillStyle = o.color;
			ctx.font = `${o.size}px "${o.font}"`;
			ctx.textBaseline = "top";
			ctx.fillText(o.text, -o.w / 2, -o.h / 2);
			ctx.restore();
		}

		function createTextObj(node, cx, cy) {
			const st = node._mikaLineart;
			const size = measureText(node, st.text, st.font, st.fontSize);
			st.textObj = {
				text: st.text, font: st.font, size: st.fontSize, color: st.color,
				w: size.w, h: size.h,
				tf: { cx, cy, sx: 1, sy: 1, rot: 0 },
			};
			drawTextObj(node);
			drawTransformUI(node);
		}

		// Fija el texto en la capa de trazo y termina la edición.
		function commitTextObj(node) {
			const st = node._mikaLineart;
			const o = st.textObj;
			if (!o) return;
			drawTextInto(paintCtx(node), o, o.tf);
			withTf(node, node._mikaLineart.preview.getContext("2d"), (ctx) => drawTextInto(ctx, o, o.tf));
			st.textObj = null;
			drawTextObj(node);
			drawTransformUI(node);
			write(node);
		}

		function cancelTextObj(node) {
			const st = node._mikaLineart;
			if (!st.textObj) return;
			st.textObj = null;
			drawTextObj(node);
			drawTransformUI(node);
		}

		// --- Selección a mano alzada (lazo; pieza flotante: mover/escalar/rotar/espejar) ---
		function traceLasso(ctx, pts, dx, dy) {
			ctx.beginPath();
			ctx.moveTo(pts[0][0] + dx, pts[0][1] + dy);
			for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + dx, pts[i][1] + dy);
			ctx.closePath();
		}

		function drawLasso(node) {
			const st = node._mikaLineart;
			const ctx = st.overlay.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, st.overlay.width, st.overlay.height);
			const l = st.lasso;
			if (!l || l.pts.length < 2) return;
			ctx.strokeStyle = "rgba(0, 220, 255, 0.95)";
			ctx.lineWidth = Math.max(1, st.overlay.width / 500);
			ctx.setLineDash([8, 6]);
			traceLasso(ctx, l.pts, 0, 0);
			ctx.stroke();
			ctx.setLineDash([]);
		}

		// Pieza flotante = base (capa con el rectángulo vaciado) + recorte movible.
		function drawSel(node) {
			const st = node._mikaLineart;
			const ctx = st.overlay.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, st.overlay.width, st.overlay.height);
			const s = st.sel;
			if (!s) return;
			ctx.globalAlpha = s.opacity;
			for (const p of s.pieces) ctx.drawImage(p.base, 0, 0);
			ctx.save();
			ctx.translate(s.tf.cx, s.tf.cy);
			ctx.rotate(s.tf.rot);
			ctx.scale(s.tf.sx, s.tf.sy);
			for (const p of s.pieces) ctx.drawImage(p.float, -s.w / 2, -s.h / 2);
			ctx.restore();
			ctx.globalAlpha = 1;
		}

		// Canvas (tamaño lienzo) con la capa "tal como se ve", para cortarle un
		// área con el lazo.
		function sourceOf(node, key) {
			const st = node._mikaLineart;
			if (key === "paint") return st.preview;
			if (key === "underlay") return st.underlay;
			const l = layerByKey(node, key);
			if (!l) return null;
			const c = document.createElement("canvas");
			c.width = st.paint.width; c.height = st.paint.height;
			const cx = c.getContext("2d");
			cx.save();
			cx.translate(l.tf.cx, l.tf.cy);
			cx.rotate(l.tf.rot);
			cx.scale(l.tf.sx, l.tf.sy);
			cx.drawImage(l.src, -l.w / 2, -l.h / 2);
			cx.restore();
			return c;
		}

		// Crea la pieza flotante a partir del lazo: corta la misma área de
		// TODAS las capas seleccionadas; una sola transformación para todas.
		function createSelection(node, pts) {
			const st = node._mikaLineart;
			if (!pts || pts.length < 3) return;
			const keys = affectedLayers(node).filter((k) => k !== "text" && k !== "sel");
			if (!keys.length) return;
			const W = st.paint.width, H = st.paint.height;
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const [x, y] of pts) {
				if (x < minX) minX = x;
				if (y < minY) minY = y;
				if (x > maxX) maxX = x;
				if (y > maxY) maxY = y;
			}
			const bx = Math.max(0, Math.floor(minX));
			const by = Math.max(0, Math.floor(minY));
			const bw = Math.min(W - bx, Math.ceil(maxX) - bx);
			const bh = Math.min(H - by, Math.ceil(maxY) - by);
			if (bw < 4 || bh < 4) return;

			const pieces = [];
			for (const key of keys) {
				const src = sourceOf(node, key);
				if (!src) continue;
				// Base: la capa completa con la zona del lazo vaciada.
				const base = document.createElement("canvas");
				base.width = W; base.height = H;
				const bctx = base.getContext("2d");
				bctx.drawImage(src, 0, 0);
				bctx.globalCompositeOperation = "destination-out";
				traceLasso(bctx, pts, 0, 0);
				bctx.fill();
				bctx.globalCompositeOperation = "source-over";
				// Recorte: solo lo que queda dentro del lazo.
				const float = document.createElement("canvas");
				float.width = bw; float.height = bh;
				const fctx = float.getContext("2d");
				fctx.save();
				traceLasso(fctx, pts, -bx, -by);
				fctx.clip();
				fctx.drawImage(src, -bx, -by);
				fctx.restore();
				pieces.push({ key, base, float });
			}
			if (!pieces.length) return;
			const tf = { cx: bx + bw / 2, cy: by + bh / 2, sx: 1, sy: 1, rot: 0 };
			st.sel = { keys: pieces.map((p) => p.key), pieces, w: bw, h: bh, tf, tf0: { ...tf }, opacity: 1 };
			drawSel(node);
			drawTransformUI(node);
		}

		function commitSel(node) {
			const st = node._mikaLineart;
			const s = st.sel;
			if (!s) return;
			const W = st.paint.width, H = st.paint.height;
			const outs = s.pieces.map((p) => {
				const out = document.createElement("canvas");
				out.width = W; out.height = H;
				const ctx = out.getContext("2d");
				ctx.drawImage(p.base, 0, 0);
				ctx.save();
				ctx.translate(s.tf.cx, s.tf.cy);
				ctx.rotate(s.tf.rot);
				ctx.scale(s.tf.sx, s.tf.sy);
				ctx.drawImage(p.float, -s.w / 2, -s.h / 2);
				ctx.restore();
				return { key: p.key, out };
			});
			st.sel = null;
			for (const { key, out } of outs) {
				if (key === "paint") {
					const pctx = paintCtx(node);
					pctx.setTransform(1, 0, 0, 1, 0, 0);
					pctx.globalCompositeOperation = "source-over";
					pctx.clearRect(0, 0, W, H);
					pctx.drawImage(out, 0, 0);
					st.paintTransform = null;
					renderPreview(node);
					write(node);
				} else if (key === "underlay") {
					const img = new Image();
					img.onload = () => { drawUnderlay(node); writeCalco(node); };
					st.underlayImg = img;
					st.underlayTransform = { cx: W / 2, cy: H / 2, sx: 1, sy: 1, rot: 0 };
					img.src = out.toDataURL("image/png");
				} else {
					const l = layerByKey(node, key);
					if (!l) continue;
					const tc = document.createElement("canvas");
					const ts = Math.min(1, 64 / Math.max(W, H));
					tc.width = Math.max(1, Math.round(W * ts));
					tc.height = Math.max(1, Math.round(H * ts));
					tc.getContext("2d").drawImage(out, 0, 0, tc.width, tc.height);
					l.thumb = tc.toDataURL("image/png");
					const img = new Image();
					img.onload = () => { drawCalcoLayers(node); writeCalco(node); };
					l.src = img;
					l.w = W; l.h = H;
					l.tf = { cx: W / 2, cy: H / 2, sx: 1, sy: 1, rot: 0 };
					l.tf0 = { ...l.tf };
					img.src = out.toDataURL("image/png");
				}
			}
			clearOverlay(node);
			renderLayerPanel(node);
			drawTransformUI(node);
		}

		function cancelSel(node) {
			const st = node._mikaLineart;
			if (st.lasso) { st.lasso = null; clearOverlay(node); }
			if (!st.sel) return;
			st.sel = null;
			clearOverlay(node);
			drawTransformUI(node);
		}

		// Invierte (espeja) la capa, el texto o la selección en edición.
		function flipTarget(node, axis) {
			const st = node._mikaLineart;
			if (st.textObj) {
				const t = st.textObj.tf;
				if (axis === "h") t.sx *= -1; else t.sy *= -1;
				drawTextObj(node);
				drawTransformUI(node);
				return;
			}
			const touched = affectedLayers(node);
			for (const which of touched) {
				const g = layerGeom(node, which);
				if (!g) continue;
				const t = { ...g.t };
				if (axis === "h") t.sx *= -1; else t.sy *= -1;
				setLayerTf(node, which, t);
			}
			drawUnderlay(node);
			renderPreview(node);
			if (st.sel) drawSel(node);
			drawTransformUI(node);
			if (touched.includes("paint")) write(node);
			if (touched.includes("underlay") || touched.some((k) => String(k).startsWith("L:"))) writeCalco(node);
		}

		// Punto del lienzo -> coordenadas fuente de la capa de trazo.
		function contentToSource(node, cx, cy) {
			const st = node._mikaLineart;
			const t = st.paintTransform;
			if (!t) return [cx, cy];
			const dx = cx - t.cx;
			const dy = cy - t.cy;
			const c = Math.cos(-t.rot);
			const s = Math.sin(-t.rot);
			const rx = dx * c - dy * s;
			const ry = dx * s + dy * c;
			return [st.paint.width / 2 + rx / t.sx, st.paint.height / 2 + ry / t.sy];
		}

		function applyTransformDrag(node, x, y) {
			const st = node._mikaLineart;
			const d = st.transformDrag;
			if (!d) return;

			if (d.kind === "move") {
				for (const which of d.layers) {
					const s0 = d.start[which];
					setLayerTf(node, which, { ...s0, cx: s0.cx + (x - d.startX), cy: s0.cy + (y - d.startY) });
				}
			} else if (d.kind === "rotate") {
				const ang = Math.atan2(y - d.pivot[1], x - d.pivot[0]);
				const dTheta = ang - d.startAngle;
				const c = Math.cos(dTheta);
				const s = Math.sin(dTheta);
				for (const which of d.layers) {
					const s0 = d.start[which];
					const dx = s0.cx - d.pivot[0];
					const dy = s0.cy - d.pivot[1];
					setLayerTf(node, which, {
						cx: d.pivot[0] + dx * c - dy * s,
						cy: d.pivot[1] + dx * s + dy * c,
						sx: s0.sx, sy: s0.sy, rot: s0.rot + dTheta,
					});
				}
			} else if (d.kind === "resize") {
				if (d.single) {
					// Capa única: conserva el comportamiento clásico
					// (uniforme, o libre X/Y si "libre" está activo).
					const which = d.layers[0];
					const s0 = d.start[which];
					const hw = d.w / 2;
					const hh = d.h / 2;
					const [sgx, sgy] = CORNER_SIGNS[d.corner] || [1, 1];
					const cos = Math.cos(s0.rot);
					const sin = Math.sin(s0.rot);
					const axs = -sgx * hw * s0.sx;
					const ays = -sgy * hh * s0.sy;
					const anchorX = s0.cx + axs * cos - ays * sin;
					const anchorY = s0.cy + axs * sin + ays * cos;
					const vx = x - anchorX;
					const vy = y - anchorY;
					const lx = vx * cos + vy * sin;
					const ly = -vx * sin + vy * cos;
					let nsx = Math.abs(lx) / (2 * hw);
					let nsy = Math.abs(ly) / (2 * hh);
					if (!st.freeResize) {
						const n = Math.hypot(lx, ly) / Math.hypot(2 * hw, 2 * hh);
						nsx = n;
						nsy = n;
					}
					const sx = Math.max(0.02, nsx);
					const sy = Math.max(0.02, nsy);
					const cxs = sgx * hw * sx;
					const cys = sgy * hh * sy;
					setLayerTf(node, which, {
						cx: anchorX + cxs * cos - cys * sin,
						cy: anchorY + cxs * sin + cys * cos,
						sx, sy, rot: s0.rot,
					});
				} else {
					// Varias capas: escala proporcional respecto a la ancla
					// compartida para mantenerlas rígidas entre sí.
					const f = Math.max(0.02, Math.hypot(x - d.anchor[0], y - d.anchor[1]) / (d.startDist || 1));
					for (const which of d.layers) {
						const s0 = d.start[which];
						const dx = s0.cx - d.anchor[0];
						const dy = s0.cy - d.anchor[1];
						setLayerTf(node, which, {
							cx: d.anchor[0] + dx * f, cy: d.anchor[1] + dy * f,
							sx: s0.sx * f, sy: s0.sy * f, rot: s0.rot,
						});
					}
				}
			}
			drawUnderlay(node);
			renderPreview(node);
			if (st.sel) drawSel(node);
			if (st.textObj) drawTextObj(node);
			drawTransformUI(node);
		}

		function build(node) {
			if (typeof node.addDOMWidget !== "function") return;
			const dw = dibujoWidget(node);
			if (!dw) return;
			dw.hidden = true;
			const aw = archivoWidget(node);
			if (aw) aw.hidden = true;
			const cw = node.widgets?.find((w) => w.name === "calco");
			if (cw) { cw.hidden = true; cw.serialize = false; }
			// La máscara es del nodo de inpaint y va oculta (pero se serializa).
			const mw = node.widgets?.find((w) => w.name === "mascara");
			if (mw) mw.hidden = true;
			const ppw = node.widgets?.find((w) => w.name === "preprocesador");
			if (ppw) ppw.hidden = true;

			const prev = node._mikaDomWidget;
			if (prev) {
				try { prev.element?.remove(); } catch (e) { /* no-op */ }
				try { prev.onRemove?.(); } catch (e) { /* no-op */ }
				const idx = node.widgets.indexOf(prev);
				if (idx >= 0) node.widgets.splice(idx, 1);
				node._mikaDomWidget = null;
			}

			// ComfyUI puede reconstruir el nodo (p. ej. al volver a la
			// pestaña). Conservamos el calco y los ajustes de herramienta.
			const prevState = node._mikaLineart;

			const [rw, rh] = parseRes(resolucionWidget(node)?.value);

			const root = document.createElement("div");
			root.style.display = "flex";
			root.style.flexDirection = "column";
			root.style.gap = "4px";
			root.style.width = "100%";
			root.style.boxSizing = "border-box";

			const toolbar = document.createElement("div");
			toolbar.style.display = "flex";
			toolbar.style.gap = "4px";
			toolbar.style.alignItems = "center";
			toolbar.style.flexWrap = "wrap";

			const stage = document.createElement("div");
			stage.style.position = "relative";
			stage.style.width = stageWidthFor(rw, rh);
			stage.style.margin = "0 auto";
			stage.style.aspectRatio = `${rw} / ${rh}`;
			stage.style.background = modeBg(node);
			stage.style.border = "1px solid var(--border-color, #444)";
			stage.style.borderRadius = "3px";
			stage.style.overflow = "hidden";
			stage.style.touchAction = "none";

			// Fondo con la imagen de entrada (solo inpaint): la compone el nodo
			// Python en "image"; acá se muestra para poder dibujar encima.
			let baseCanvas = null;
			let baseLayer = null;
			if (isInpaint) {
				baseCanvas = document.createElement("canvas");
				baseCanvas.width = rw;
				baseCanvas.height = rh;
				baseCanvas.style.display = "none";
				baseLayer = document.createElement("canvas");
				baseLayer.width = rw;
				baseLayer.height = rh;
				baseLayer.style.position = "absolute";
				baseLayer.style.inset = "0";
				baseLayer.style.width = "100%";
				baseLayer.style.height = "100%";
				baseLayer.style.pointerEvents = "none";
			}

			const underlay = document.createElement("canvas");
			underlay.width = rw;
			underlay.height = rh;
			underlay.style.position = "absolute";
			underlay.style.inset = "0";
			underlay.style.width = "100%";
			underlay.style.height = "100%";
			underlay.style.opacity = "0.4";
			underlay.style.pointerEvents = "none";

			// Capas del calco (encima del calco base, debajo del trazo), al
			// mismo tono tenue que el calco base: son referencia para calcar.
			const calcoLayersCanvas = document.createElement("canvas");
			calcoLayersCanvas.width = rw;
			calcoLayersCanvas.height = rh;
			calcoLayersCanvas.style.position = "absolute";
			calcoLayersCanvas.style.inset = "0";
			calcoLayersCanvas.style.width = "100%";
			calcoLayersCanvas.style.height = "100%";
			calcoLayersCanvas.style.opacity = "0.4";
			calcoLayersCanvas.style.pointerEvents = "none";

			// Máscara de inpaint (solo inpaint): rojo opaco sobre transparente,
			// por encima del trazo para ver qué se está marcando.
			let maskCanvas = null;
			let maskLayer = null;
			if (isInpaint) {
				maskCanvas = document.createElement("canvas");
				maskCanvas.width = rw;
				maskCanvas.height = rh;
				maskCanvas.style.display = "none";
				maskLayer = document.createElement("canvas");
				maskLayer.width = rw;
				maskLayer.height = rh;
				maskLayer.style.position = "absolute";
				maskLayer.style.inset = "0";
				maskLayer.style.width = "100%";
				maskLayer.style.height = "100%";
				maskLayer.style.opacity = "0.45";
				maskLayer.style.pointerEvents = "none";
				maskLayer.style.display = "none";
			}

			// Fuente (offscreen) del contenido editable: imagen + trazos, en
			// coordenadas de lienzo. Se muestra a través de "preview", que le
			// aplica la transformación de la capa (paintTransform).
			const paint = document.createElement("canvas");
			paint.width = rw;
			paint.height = rh;
			paint.style.display = "none";

			// Lienzo de trabajo del pincel difuminado: ahí se arma el trazo
			// (desenfoque + grano) y recién al soltar se hornea en "paint".
			const softScratch = document.createElement("canvas");
			softScratch.width = rw;
			softScratch.height = rh;
			softScratch.style.display = "none";

			// Capa visible del contenido editable (render de paint con su
			// transformación) y superficie que recibe el dibujo.
			const preview = document.createElement("canvas");
			preview.width = rw;
			preview.height = rh;
			preview.style.position = "absolute";
			preview.style.inset = "0";
			preview.style.width = "100%";
			preview.style.height = "100%";
			preview.style.cursor = CURSOR_CROSS;

			// Vista previa del borrador: marca en un color propio la zona a
			// borrar mientras se arrastra; se limpia al soltar y nunca se
			// exporta.
			const overlay = document.createElement("canvas");
			overlay.width = rw;
			overlay.height = rh;
			overlay.style.position = "absolute";
			overlay.style.inset = "0";
			overlay.style.width = "100%";
			overlay.style.height = "100%";
			overlay.style.pointerEvents = "none";

			// UI de transformación del calco (marco + handles), encima de todo.
			const handles = document.createElement("canvas");
			handles.width = rw;
			handles.height = rh;
			handles.style.position = "absolute";
			handles.style.inset = "0";
			handles.style.width = "100%";
			handles.style.height = "100%";
			handles.style.pointerEvents = "none";

			// Cursor circular semitransparente que sigue al mouse y refleja el
			// tamaño de la herramienta activa (como el editor de máscaras).
			const brushCursor = document.createElement("div");
			brushCursor.style.position = "absolute";
			brushCursor.style.pointerEvents = "none";
			brushCursor.style.borderRadius = "50%";
			brushCursor.style.border = "1px dashed rgba(255, 255, 255, 0.95)";
			brushCursor.style.boxShadow = "0 0 0 1px rgba(0, 0, 0, 0.6)";
			brushCursor.style.background = "rgba(90, 170, 255, 0.20)";
			brushCursor.style.transform = "translate(-50%, -50%)";
			brushCursor.style.display = "none";
			brushCursor.style.zIndex = "5";

			if (baseLayer) stage.appendChild(baseLayer);
			stage.appendChild(underlay);
			stage.appendChild(calcoLayersCanvas);
			stage.appendChild(preview);
			if (maskLayer) stage.appendChild(maskLayer);
			stage.appendChild(overlay);
			stage.appendChild(handles);
			stage.appendChild(brushCursor);
			const layerPanel = document.createElement("div");
			layerPanel.style.display = "none";
			layerPanel.style.gap = "4px";
			layerPanel.style.flexWrap = "wrap";
			layerPanel.style.alignItems = "flex-start";
			layerPanel.style.minHeight = "38px";

			root.appendChild(toolbar);
			root.appendChild(layerPanel);
			root.appendChild(stage);

			node._mikaLineart = {
				stage, paint, preview, underlay, calcoLayersCanvas, overlay, handles, brushCursor, underlayImg: null,
				baseCanvas, baseLayer, baseImg: null, baseSrc: null,
				maskCanvas, maskLayer, maskThickness: 30,
				calcoLayers: [], selection: [], layerSeq: 0, calcoNameSeq: 0, layerPanel,
				undo: [], redo: [],
				// El pincel difuminado es la herramienta por defecto.
				tool: "soft", shape: "rect", font: "Arial", fontSize: 48, text: "", thickness: 1, eraseThickness: 40,
				softScratch, softThickness: 2, softBlur: 1, softGrain: 80, softPts: null, grainTile: null, grainRand: null, _grainFor: null, _grainPat: null,
				calcoOpacity: 40,
				userColor: "#000",
				color: modeStroke(node), dirty: false, erasePoints: null,
				cursorPos: null,
				transformMode: false, freeResize: false,
				underlayTransform: null, paintTransform: null, transformDrag: null,
				shapeStart: null, shapeEnd: null, textObj: null,
				sel: null, lasso: null, contentSize: null,
			};
			const st = node._mikaLineart;

			// Estado guardado en el workflow (widget oculto "pincel"). Lo de la
			// sesión (prevState) se aplica después y pisa esto si existe.
			const savedState = readPincelState(node);
			if (savedState) {
				for (const k of PINCEL_KEYS) if (savedState[k] !== undefined) st[k] = savedState[k];
			}

			if (prevState) {
				for (const k of ["underlayImg", "underlayTransform", "transformMode", "freeResize", "tool", "shape", "font", "fontSize", "thickness", "eraseThickness", "softThickness", "softBlur", "softGrain", "calcoOpacity", "userColor", "contentSize", "calcoLayers", "selection", "layerSeq", "calcoNameSeq", "baseImg", "baseSrc", "maskThickness"]) {
					if (prevState[k] !== undefined) st[k] = prevState[k];
				}
				const ow = prevState.paint?.width;
				if (ow && ow !== st.paint.width) {
					const k = st.paint.width / ow;
					for (const key of ["underlayTransform"]) {
						const t = st[key];
						if (t) st[key] = { cx: t.cx * k, cy: t.cy * k, sx: t.sx * k, sy: t.sy * k, rot: t.rot };
					}
					const mapK = (t) => ({ ...t, cx: t.cx * k, cy: t.cy * k, sx: t.sx * k, sy: t.sy * k });
					for (const l of st.calcoLayers) {
						l.tf = mapK(l.tf);
						l.tf0 = mapK(l.tf0);
					}
				}
			} else {
				// Arranque limpio (recarga del workflow): el trazo ya viene
				// horneado en el widget "dibujo", sin transformación viva.
				st.paintTransform = null;
			}

			// Si ComfyUI recreó el nodo (p. ej. al cambiar de pestaña de
			// workflow), el calco de la sesión se recupera de la caché.
			if (!st.underlayImg && !st.calcoLayers.length) {
				const c = CALCO_CACHE.get(calcoKey(node));
				if (c) {
					st.underlayImg = c.underlayImg || null;
					st.underlayTransform = c.underlayTransform || null;
					st.calcoLayers = c.calcoLayers || [];
					st.selection = (c.selection || []).filter((k) => layerGeom(node, k) && layerVisible(node, k));
					if (c.calcoNameSeq) st.calcoNameSeq = c.calcoNameSeq;
					st.layerSeq = c.layerSeq || st.layerSeq;
					st.contentSize = c.contentSize || null;
				}
			}

			// --- Herramientas: pincel / borrador / forma / texto ---
			const brushBtn = mkButton("✏️", "Pincel");
			const eraserBtn = mkButton("🧽", "Borrador");
			const softBtn = mkIconButton(SOFT_BRUSH_ICON, "Pincel difuminado: borde suave y/o grano tipo lápiz");
			const shapeBtn = mkButton("▭", "Forma (elegí la figura en la lista)");
			const textBtn = mkButton("🅣", "Texto (escribí y hacé clic en el lienzo)");
			const selectBtn = mkButton("▚", "Seleccionar a mano alzada (lazo) un área del trazo/calco para editarla");
			const toolBtns = { brush: brushBtn, eraser: eraserBtn, soft: softBtn, shape: shapeBtn, text: textBtn, select: selectBtn };
			// Herramientas de máscara: solo en el nodo de inpaint.
			let maskBrushBtn = null;
			let maskEraseBtn = null;
			if (isInpaint) {
				maskBrushBtn = mkButton("🖌️", "Pincel de máscara (zona a regenerar)");
				maskEraseBtn = mkButton("🧼", "Borrador de máscara");
				toolBtns.maskBrush = maskBrushBtn;
				toolBtns.maskErase = maskEraseBtn;
			}
			let updateToolExtras = () => {};
			const refreshTools = () => {
				for (const [id, b] of Object.entries(toolBtns)) {
					b.style.outline = st.tool === id ? "1px solid #4a9" : "none";
				}
				updateToolExtras();
				writePincelState(node);
			};
			for (const [id, b] of Object.entries(toolBtns)) {
				b.onclick = () => { st.tool = id; refreshTools(); refreshCursor(node); };
			}
			refreshTools();

			const mkSlider = (max, value, title, onInput, min = 1) => {
				const s = document.createElement("input");
				s.type = "range";
				s.min = String(min);
				s.max = String(max);
				s.value = String(value);
				s.title = title;
				s.style.width = "70px";
				s.addEventListener("input", () => {
					onInput(parseInt(s.value, 10) || min);
					writePincelState(node);
				});
				return s;
			};

			const thickVal = mkValueLabel(st.thickness);
			const thick = mkSlider(64, st.thickness, "Grosor lápiz", (v) => {
				st.thickness = v;
				thickVal.textContent = String(v);
				refreshCursor(node);
			});
			const eraseVal = mkValueLabel(st.eraseThickness);
			const eraseThick = mkSlider(128, st.eraseThickness, "Grosor borrador", (v) => {
				st.eraseThickness = v;
				eraseVal.textContent = String(v);
				refreshCursor(node);
			});
			// Pincel difuminado: sliders propios (aparecen con esa herramienta).
			// "Grosor" y "Difuminado" son suyos; "Grano" da textura de lápiz.
			const softThickVal = mkValueLabel(st.softThickness);
			const softThick = mkSlider(128, st.softThickness, "Grosor pincel difuminado", (v) => {
				st.softThickness = v;
				softThickVal.textContent = String(v);
				refreshCursor(node);
			});
			const softVal = mkValueLabel(st.softBlur);
			const softBlur = mkSlider(40, st.softBlur, "Difuminado: suaviza el borde del trazo", (v) => {
				st.softBlur = v;
				softVal.textContent = String(v);
			});
			const grainVal = mkValueLabel(st.softGrain);
			const grain = mkSlider(100, st.softGrain, "Grano: textura tipo lápiz / carboncillo", (v) => {
				st.softGrain = v;
				grainVal.textContent = String(v);
			}, 0);
			const softGroup = mkGroup(softThick, softThickVal, softBlur, softVal, grain, grainVal);
			// Grupos de grosor: cada herramienta muestra el suyo (el de lápiz
			// también con las formas, que usan el mismo grosor).
			const thickGroup = mkGroup(thick, thickVal);
			const eraseGroup = mkGroup(eraseThick, eraseVal);
			let maskThickGroup = null;
			if (isInpaint) {
				const maskVal = mkValueLabel(st.maskThickness);
				const maskThick = mkSlider(128, st.maskThickness, "Grosor máscara", (v) => {
					st.maskThickness = v;
					maskVal.textContent = String(v);
					refreshCursor(node);
				});
				maskThickGroup = mkGroup(maskThick, maskVal);
			}
			const maskClearBtn = isInpaint ? mkButton("🧹", "Limpiar la máscara") : null;
			if (maskClearBtn) maskClearBtn.onclick = () => clearMask(node);
			const maskInvertBtn = isInpaint ? mkButton("⇆", "Invertir la máscara") : null;
			if (maskInvertBtn) maskInvertBtn.onclick = () => invertMask(node);

			st.colorInput = document.createElement("input");
			st.colorInput.type = "color";
			st.colorInput.value = st.userColor || "#000000";
			st.colorInput.title = "Color de trazo (dibujo normal)";
			st.colorInput.style.width = "28px";
			st.colorInput.style.height = "22px";
			st.colorInput.style.padding = "0";
			st.colorInput.addEventListener("input", () => {
				st.userColor = st.colorInput.value;
				if (!isLineart(node)) st.color = st.userColor;
				writePincelState(node);
			});

			// --- Formas ---
			const shapeSel = styleInput(document.createElement("select"));
			for (const [id, label] of SHAPES) {
				const o = document.createElement("option");
				o.value = id;
				o.textContent = label;
				shapeSel.appendChild(o);
			}
			shapeSel.value = st.shape;
			shapeSel.title = "Figura";
			shapeSel.onchange = () => { st.shape = shapeSel.value; writePincelState(node); };

			// --- Texto: fuentes del Paint + fuentes de cómic (con vista previa) ---
			const fontSel = mkFontPicker(() => st.font, (f) => { st.font = f; writePincelState(node); }, fontGroups);
			const fontAdd = mkFontAddMenu(() => fontSel.refreshList?.());
			const fontSizeInput = styleInput(document.createElement("input"));
			fontSizeInput.type = "number";
			fontSizeInput.min = "8";
			fontSizeInput.max = "400";
			fontSizeInput.value = String(st.fontSize);
			fontSizeInput.title = "Tamaño de fuente";
			fontSizeInput.style.width = "54px";
			fontSizeInput.oninput = () => { st.fontSize = parseInt(fontSizeInput.value, 10) || 48; writePincelState(node); };
			const textInput = styleInput(document.createElement("input"));
			textInput.type = "text";
			textInput.placeholder = "texto…";
			textInput.value = st.text;
			textInput.title = "Texto a colocar (clic en el lienzo)";
			textInput.style.width = "120px";
			textInput.oninput = () => { st.text = textInput.value; };

			const shapeGroup = mkGroup(shapeSel);
			const fontGroup = mkGroup(fontSel, fontAdd, fontSizeInput, textInput);
			updateToolExtras = () => {
				const t = st.tool;
				shapeGroup.style.display = t === "shape" ? "inline-flex" : "none";
				fontGroup.style.display = t === "text" ? "inline-flex" : "none";
				thickGroup.style.display = t === "brush" || t === "shape" ? "inline-flex" : "none";
				eraseGroup.style.display = t === "eraser" ? "inline-flex" : "none";
				softGroup.style.display = t === "soft" ? "inline-flex" : "none";
				if (maskThickGroup) {
					const maskTool = t === "maskBrush" || t === "maskErase";
					maskThickGroup.style.display = maskTool ? "inline-flex" : "none";
				}
			};
			updateToolExtras();

			// --- Deshacer / rehacer / limpiar ---
			const undoBtn = mkButton("↶", "Deshacer");
			const redoBtn = mkButton("↷", "Rehacer");
			const clearBtn = mkButton("🗑️", "Limpiar");
			undoBtn.onclick = () => {
				if (!st.undo.length) return;
				st.redo.push(snapshot(node));
				restore(node, st.undo.pop());
			};
			redoBtn.onclick = () => {
				if (!st.redo.length) return;
				st.undo.push(snapshot(node));
				restore(node, st.redo.pop());
			};
			clearBtn.onclick = () => { pushUndo(node); clearPaint(node); };

			// --- Cargar imagen para editar (capa de contenido) ---
			const loadBtn = mkFileButton(
				"📂",
				"Cargar imagen para editar",
				(img, name) => loadContent(node, img, name),
			);
			const pasteEditBtn = mkButton("📋✏️", "Pegar imagen del portapapeles para editar");
			pasteEditBtn.onclick = () => pasteFromClipboard((img) => loadContent(node, img));

			// --- Calcar (referencia; no se exporta) ---
			const traceBtn = mkFileButton(
				"🖼️",
				"Importar imagen para calcar como capa (o arrastrá una imagen sobre el nodo)",
				(img, name) => addCalcoLayer(node, img, name),
			);
			const pasteTraceBtn = mkButton("📋🖼️", "Pegar imagen del portapapeles como capa del calco");
			pasteTraceBtn.onclick = () => pasteFromClipboard((img) => addCalcoLayer(node, img));

			// --- Lineart propio desde el calco seleccionado (NO encola el grafo) ---
			function paintMaskIntoPaint(node, dataUrl) {
				return new Promise((resolve) => {
					const st = node._mikaLineart;
					const m = new Image();
					m.onload = () => {
						const W = st.paint.width;
						const H = st.paint.height;
						const s = Math.min(W / m.naturalWidth, H / m.naturalHeight);
						const dw = Math.max(1, Math.round(m.naturalWidth * s));
						const dh = Math.max(1, Math.round(m.naturalHeight * s));
						const dx = Math.round((W - dw) / 2);
						const dy = Math.round((H - dh) / 2);
						const color = modeStroke(node);

						const tmp = document.createElement("canvas");
						tmp.width = dw;
						tmp.height = dh;
						const tctx = tmp.getContext("2d");
						tctx.drawImage(m, 0, 0, dw, dh);
						const id = tctx.getImageData(0, 0, dw, dh);
						const d = id.data;
						let cr = 0, cg = 0, cb = 0;
						if (color[0] === "#") {
							let hex = color.slice(1);
							if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
							cr = parseInt(hex.slice(0, 2), 16) || 0;
							cg = parseInt(hex.slice(2, 4), 16) || 0;
							cb = parseInt(hex.slice(4, 6), 16) || 0;
						}
						// El gris de la máscara pasa a ser el alfa; el color, el del trazo.
						for (let i = 0; i < d.length; i += 4) {
							const a = d[i];
							d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = a;
						}
						tctx.putImageData(id, 0, 0);

						pushUndo(node);
						const ctx = paintCtx(node);
						ctx.globalCompositeOperation = "source-over";
						ctx.clearRect(0, 0, W, H);
						ctx.drawImage(tmp, dx, dy);
						st.dirty = true;
						renderPreview(node);
						write(node);
						resolve();
					};
					m.onerror = () => resolve();
					m.src = dataUrl;
				});
			}

			// Una capa de calco guarda un canvas O una imagen (según la operación):
			// normalizamos a canvas para poder exportarla.
			function drawableToCanvas(d) {
				const w = d.naturalWidth || d.width || 1;
				const h = d.naturalHeight || d.height || 1;
				const c = document.createElement("canvas");
				c.width = Math.max(1, w);
				c.height = Math.max(1, h);
				c.getContext("2d").drawImage(d, 0, 0, c.width, c.height);
				return c;
			}

			async function runLineartFromCalco() {
				const st = node._mikaLineart;
				// Solo cuentan el calco base o las capas de calco (no el trazo).
				const keys = (st.selection || []).filter((k) => k === "underlay" || String(k).startsWith("L:"));
				const key = keys.find((k) => layerGeom(node, k)) || keys[0];
				if (!key) { alert("[Mika] Seleccioná una capa de calco para pasarla a lineart."); return; }

				const drawable = key === "underlay" ? st.underlayImg : (layerByKey(node, key) || {}).src;
				if (!drawable) { alert("[Mika] No se encontró la imagen del calco seleccionado."); return; }
				const srcCanvas = drawableToCanvas(drawable);

				const preproc = String(findWidget(node, "preprocesador")?.value || "lineart");
				const resolution = Math.max(256, Math.min(2048, Math.max(srcCanvas.width, srcCanvas.height)));

				const old = lineartBtn.textContent;
				lineartBtn.textContent = "⚡ …";
				try {
					const payload = srcCanvas.toDataURL("image/png");
					const r = await api.fetchApi("/mika/lineart/preprocess", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ preprocessor: preproc, image: payload, resolution }),
					});
					const j = await r.json();
					if (!r.ok || !j.image) throw new Error(j.error || `HTTP ${r.status}`);
					await paintMaskIntoPaint(node, j.image);
				} catch (e) {
					alert("[Mika] No se pudo generar el lineart: " + ((e && e.message) || e));
				} finally {
					lineartBtn.textContent = old;
				}
			}

			const preprocSel = document.createElement("select");
			preprocSel.title = "Preprocesador de lineart propio";
			preprocSel.style.cssText =
				"font:12px sans-serif;height:22px;padding:0 4px;border:1px solid var(--border-color,#444);" +
				"border-radius:3px;background:var(--comfy-input-bg,#222);color:var(--input-text,#eee);";
			const preprocW = findWidget(node, "preprocesador");
			for (const opt of (preprocW?.options?.values || ["lineart"])) {
				const o = document.createElement("option");
				o.value = opt;
				o.textContent = opt;
				preprocSel.appendChild(o);
			}
			preprocSel.value = String(preprocW?.value || "lineart");
			preprocSel.onchange = () => {
				if (!preprocW) return;
				preprocW.value = preprocSel.value;
				try { preprocW.callback?.(preprocSel.value); } catch (e) { /* no-op */ }
			};
			const lineartBtn = mkButton("⚡", "Crear un lineart desde la capa de calco seleccionada (no ejecuta el workflow)");
			lineartBtn.onclick = () => { runLineartFromCalco(); };
			const fitResBtn = mkButton("📐", "Ajustar la resolución al tamaño del calco o de la imagen cargada");
			fitResBtn.onclick = () => adaptResolution(node);
			const transformBtn = mkButton("✥", "Mover / escalar / rotar las capas seleccionadas");
			transformBtn.onclick = () => {
				st.transformMode = !st.transformMode;
				transformBtn.style.outline = st.transformMode ? "1px solid #4a9" : "none";
				if (st.transformMode) hideCursor(node);
				else refreshCursor(node);
				if (st.lastClientPos) updatePointerCursor(node, st.lastClientPos[0], st.lastClientPos[1]);
				else preview.style.cursor = CURSOR_CROSS;
				drawTransformUI(node);
			};
			const freeBtn = mkButton("libre", "Resize libre: X e Y por separado (apagado = mantiene proporción)");
			freeBtn.onclick = () => {
				st.freeResize = !st.freeResize;
				freeBtn.style.outline = st.freeResize ? "1px solid #4a9" : "none";
			};
			transformBtn.style.outline = st.transformMode ? "1px solid #4a9" : "none";
			freeBtn.style.outline = st.freeResize ? "1px solid #4a9" : "none";
			const resetBtn = mkButton("⟲", "Reestablecer las capas seleccionadas (encajar y centrar, sin rotación)");
			resetBtn.onclick = () => {
				if (st.sel) { st.sel.tf = { ...st.sel.tf0 }; drawSel(node); drawTransformUI(node); return; }
				const keys = affectedLayers(node);
				if (!keys.length) return;
				for (const which of keys) {
					if (which === "paint") st.paintTransform = null;
					else if (which === "underlay") fitUnderlay(node);
					else { const l = layerByKey(node, which); if (l) l.tf = { ...l.tf0 }; }
				}
				drawUnderlay(node);
				renderPreview(node);
				drawTransformUI(node);
				write(node);
				writeCalco(node);
			};
			const stretchBtn = mkButton("⛶", "Ajustar al tamaño del nodo las capas seleccionadas (estirar para llenar)");
			stretchBtn.onclick = () => {
				if (st.sel) {
					const W = st.paint.width, H = st.paint.height;
					st.sel.tf = { cx: W / 2, cy: H / 2, sx: W / st.sel.w, sy: H / st.sel.h, rot: 0 };
					drawSel(node);
					drawTransformUI(node);
					return;
				}
				const W = st.paint.width, H = st.paint.height;
				const keys = affectedLayers(node);
				if (!keys.length) return;
				for (const which of keys) {
					if (which === "paint") st.paintTransform = null;
					else if (which === "underlay") stretchUnderlay(node);
					else { const l = layerByKey(node, which); if (l) l.tf = { cx: W / 2, cy: H / 2, sx: W / l.w, sy: H / l.h, rot: 0 }; }
				}
				drawUnderlay(node);
				renderPreview(node);
				drawTransformUI(node);
				write(node);
				writeCalco(node);
			};
			const flipHBtn = mkButton("↔", "Invertir horizontalmente (las capas seleccionadas o el texto)");
			flipHBtn.onclick = () => flipTarget(node, "h");
			const flipVBtn = mkButton("↕", "Invertir verticalmente (las capas seleccionadas o el texto)");
			flipVBtn.onclick = () => flipTarget(node, "v");
			const copyBtn = mkButton("📄", "Copiar la imagen (fondo + trazos) al portapapeles");
			copyBtn.onclick = () => {
				composeOutput(node).toBlob(async (blob) => {
					try {
						await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
					} catch (e) {
						alert("No se pudo copiar la imagen: " + ((e && e.message) || e));
					}
				}, "image/png");
			};
			const opacity = document.createElement("input");
			opacity.type = "range";
			opacity.min = "0";
			opacity.max = "100";
			opacity.value = String(st.calcoOpacity);
			opacity.title = "Opacidad del calco";
			opacity.style.width = "60px";
			const applyCalcoOpacity = () => {
				const v = String((st.calcoOpacity || 0) / 100);
				underlay.style.opacity = v;
				calcoLayersCanvas.style.opacity = v;
			};
			applyCalcoOpacity();
			opacity.addEventListener("input", () => {
				st.calcoOpacity = parseInt(opacity.value, 10) || 0;
				applyCalcoOpacity();
				writePincelState(node);
			});

			const mergeBtn = mkButton("⤓", "Unir las capas seleccionadas al calco");
			mergeBtn.onclick = () => mergeSelected(node);

			toolbar.appendChild(brushBtn);
			toolbar.appendChild(eraserBtn);
			toolbar.appendChild(softBtn);
			toolbar.appendChild(shapeBtn);
			toolbar.appendChild(textBtn);
			toolbar.appendChild(selectBtn);
			if (maskBrushBtn) toolbar.appendChild(maskBrushBtn);
			if (maskEraseBtn) toolbar.appendChild(maskEraseBtn);
			toolbar.appendChild(thickGroup);
			toolbar.appendChild(eraseGroup);
			if (maskThickGroup) toolbar.appendChild(maskThickGroup);
			toolbar.appendChild(softGroup);
			if (maskClearBtn) toolbar.appendChild(maskClearBtn);
			if (maskInvertBtn) toolbar.appendChild(maskInvertBtn);
			toolbar.appendChild(st.colorInput);
			toolbar.appendChild(shapeGroup);
			toolbar.appendChild(fontGroup);
			toolbar.appendChild(undoBtn);
			toolbar.appendChild(redoBtn);
			toolbar.appendChild(clearBtn);
			toolbar.appendChild(loadBtn);
			toolbar.appendChild(pasteEditBtn);
			toolbar.appendChild(traceBtn);
			toolbar.appendChild(pasteTraceBtn);
			toolbar.appendChild(preprocSel);
			toolbar.appendChild(lineartBtn);
			toolbar.appendChild(fitResBtn);
			toolbar.appendChild(transformBtn);
			toolbar.appendChild(freeBtn);
			toolbar.appendChild(resetBtn);
			toolbar.appendChild(stretchBtn);
			toolbar.appendChild(flipHBtn);
			toolbar.appendChild(flipVBtn);
			toolbar.appendChild(copyBtn);
			toolbar.appendChild(opacity);
			toolbar.appendChild(mergeBtn);
			wireDomDrop(node, root);
			wireCanvasNav(root);
			drawCalcoLayers(node);
			renderLayerPanel(node);
			if (st.underlayImg || st.calcoLayers.length) writeCalco(node);

			// --- Dibujo ---
			let drawing = false;
			let last = null;

			// Puntero -> coordenadas del lienzo (espacio de la capa visible).
			const posCanvas = (e) => {
				const r = preview.getBoundingClientRect();
				return [
					(e.clientX - r.left) * preview.width / r.width,
					(e.clientY - r.top) * preview.height / r.height,
				];
			};
			// Puntero -> coordenadas fuente de la capa de trazo (con inversa).
			const pos = (e) => {
				const [cx, cy] = posCanvas(e);
				return contentToSource(node, cx, cy);
			};

			// Dibuja un segmento (o un punto) en un contexto 2D.
			const seg = (ctx, x, y, thickness, composite, color) => {
				ctx.globalCompositeOperation = composite;
				ctx.strokeStyle = color;
				ctx.fillStyle = color;
				ctx.lineWidth = thickness;
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				if (!last) {
					ctx.beginPath();
					ctx.arc(x, y, thickness / 2, 0, Math.PI * 2);
					ctx.fill();
				} else {
					ctx.beginPath();
					ctx.moveTo(last[0], last[1]);
					ctx.lineTo(x, y);
					ctx.stroke();
				}
			};

			// Máscara: el mismo trazo, pero sobre el canvas de máscara y en
			// coordenadas del lienzo (no lleva la transformación del trazo).
			const maskSeg = (x, y) => {
				seg(
					st.maskCanvas.getContext("2d"), x, y, st.maskThickness,
					st.tool === "maskErase" ? "destination-out" : "source-over", "#ff3b3b",
				);
				redrawMask(node, true);
				last = [x, y];
			};

			// Lápiz: dibuja en la fuente y en la capa visible (transformada).
			const strokeTo = (x, y) => {
				seg(paintCtx(node), x, y, st.thickness, "source-over", st.color);
				withTf(node, preview.getContext("2d"), (ctx) => seg(ctx, x, y, st.thickness, "source-over", st.color));
				last = [x, y];
			};

			// --- Pincel difuminado (borde suave + grano tipo lápiz) ---
			// El trazo en curso se compone en "softScratch": se dibuja la
			// polilínea con desenfoque y, si hay grano, se recorta su alfa con
			// una máscara de ruido. Recién al soltar se hornea en "paint".
			// Mientras se dibuja se previsualiza en "overlay" (encima de todo).

			// Máscara de ruido para el grano. El ruido es fijo; al mover el
			// slider solo cambia cuánto se aplica (misma textura, no "tiembla").
			const grainPattern = () => {
				const N = 256;
				if (!st.grainRand) {
					st.grainRand = new Float32Array(N * N);
					for (let i = 0; i < st.grainRand.length; i++) st.grainRand[i] = Math.random();
				}
				if (!st.grainTile) {
					st.grainTile = document.createElement("canvas");
					st.grainTile.width = N;
					st.grainTile.height = N;
				}
				if (st._grainFor === st.softGrain && st._grainPat) return st._grainPat;
				const tctx = st.grainTile.getContext("2d");
				const img = tctx.createImageData(N, N);
				const g = Math.min(1, Math.max(0, st.softGrain / 100));
				for (let i = 0; i < st.grainRand.length; i++) {
					img.data[i * 4 + 3] = Math.round(255 * (1 - g * (1 - st.grainRand[i])));
				}
				tctx.putImageData(img, 0, 0);
				st._grainFor = st.softGrain;
				st._grainPat = tctx.createPattern(st.grainTile, "repeat");
				return st._grainPat;
			};

			const buildSoft = () => {
				const s = st.softScratch;
				const ctx = s.getContext("2d");
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.globalCompositeOperation = "source-over";
				ctx.filter = "none";
				ctx.clearRect(0, 0, s.width, s.height);
				const pts = st.softPts;
				if (!pts || !pts.length) return;
				ctx.strokeStyle = st.color;
				ctx.fillStyle = st.color;
				ctx.lineWidth = st.softThickness;
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				const paint = () => {
					ctx.beginPath();
					if (pts.length === 1) {
						ctx.arc(pts[0][0], pts[0][1], st.softThickness / 2, 0, Math.PI * 2);
						ctx.fill();
					} else {
						ctx.moveTo(pts[0][0], pts[0][1]);
						for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
						ctx.stroke();
					}
				};
				// Halo difuminado y, encima, el núcleo nítido: el slider suaviza
				// el borde sin que la línea desaparezca.
				if (st.softBlur > 0) {
					ctx.save();
					ctx.filter = `blur(${st.softBlur}px)`;
					paint();
					ctx.restore();
				}
				paint();
				if (st.softGrain > 0) {
					ctx.globalCompositeOperation = "destination-in";
					ctx.fillStyle = grainPattern();
					ctx.fillRect(0, 0, s.width, s.height);
					ctx.globalCompositeOperation = "source-over";
				}
			};

			const softLive = () => {
				buildSoft();
				clearOverlay(node);
				withTf(node, st.overlay.getContext("2d"), (ctx) => ctx.drawImage(st.softScratch, 0, 0));
			};

			const commitSoft = () => {
				buildSoft();
				paintCtx(node).drawImage(st.softScratch, 0, 0);
				clearOverlay(node);
				st.softPts = null;
				renderPreview(node);
			};

			// Borrador: marca la zona a borrar en el overlay (color propio);
			// recién al soltar se aplica el borrado real.
			const erasePreviewTo = (x, y) => {
				withTf(node, st.overlay.getContext("2d"), (ctx) => seg(ctx, x, y, st.eraseThickness, "source-over", ERASE_PREVIEW));
				last = [x, y];
				if (st.erasePoints) st.erasePoints.push([x, y]);
			};

			const commitErase = () => {
				const pts = st.erasePoints || [];
				clearOverlay(node);
				if (!pts.length) return;
				const ctx = paintCtx(node);
				ctx.globalCompositeOperation = "destination-out";
				ctx.strokeStyle = "#000";
				ctx.fillStyle = "#000";
				ctx.lineWidth = st.eraseThickness;
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				if (pts.length === 1) {
					ctx.beginPath();
					ctx.arc(pts[0][0], pts[0][1], st.eraseThickness / 2, 0, Math.PI * 2);
					ctx.fill();
				} else {
					ctx.beginPath();
					ctx.moveTo(pts[0][0], pts[0][1]);
					for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
					ctx.stroke();
				}
				ctx.globalCompositeOperation = "source-over";
			};

			// Estilo común de trazo para formas/texto.
			const applyStrokeStyle = (ctx, color, width) => {
				ctx.globalCompositeOperation = "source-over";
				ctx.strokeStyle = color;
				ctx.fillStyle = color;
				ctx.lineWidth = width;
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
			};

			// Forma: se previsualiza en el overlay mientras se arrastra.
			const shapePreviewTo = (x, y) => {
				st.shapeEnd = [x, y];
				if (!st.shapeStart) return;
				clearOverlay(node);
				withTf(node, st.overlay.getContext("2d"), (ctx) => {
					applyStrokeStyle(ctx, st.color, st.thickness);
					shapePath(ctx, st.shape, st.shapeStart[0], st.shapeStart[1], x, y);
					ctx.stroke();
				});
			};

			// Forma: fija el resultado en la capa de trazo.
			const commitShape = () => {
				clearOverlay(node);
				const s = st.shapeStart;
				const e = st.shapeEnd;
				if (!s || !e) return;
				const pctx = paintCtx(node);
				applyStrokeStyle(pctx, st.color, st.thickness);
				shapePath(pctx, st.shape, s[0], s[1], e[0], e[1]);
				pctx.stroke();
				withTf(node, preview.getContext("2d"), (ctx) => {
					applyStrokeStyle(ctx, st.color, st.thickness);
					shapePath(ctx, st.shape, s[0], s[1], e[0], e[1]);
					ctx.stroke();
				});
			};

			// Prepara el arrastre de transformación sobre la capa primaria; el
			// mismo gesto se aplica a todas las capas afectadas por el selector.
			const beginTransform = (tx, ty) => {
				const hit = transformHit(node, tx, ty);
				if (!hit) return false;
				const which = primaryLayer(node);
				const g = layerGeom(node, which);
				if (!g) return false;
				const layers = affectedLayers(node).filter((l) => layerGeom(node, l));
				if (!layers.length) return false;
				const start = {};
				for (const l of layers) start[l] = { ...layerGeom(node, l).t };
				const drag = {
					kind: hit.kind,
					corner: hit.corner,
					startX: tx, startY: ty,
					layers, start,
					single: layers.length === 1,
					w: g.w, h: g.h,
				};
				if (hit.kind === "rotate") {
					drag.pivot = [g.t.cx, g.t.cy];
					drag.startAngle = Math.atan2(ty - g.t.cy, tx - g.t.cx);
				} else if (hit.kind === "resize") {
					const corners = layerCorners(node, which);
					drag.anchor = corners[(hit.corner + 2) % 4];
					drag.startDist = Math.hypot(tx - drag.anchor[0], ty - drag.anchor[1]) || 1;
				}
				st.transformDrag = drag;
				return true;
			};

			preview.addEventListener("pointerdown", (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				try { preview.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }

				if (st.transformMode) {
					const [tx, ty] = posCanvas(e);
					if (!beginTransform(tx, ty)) return;
					hideCursor(node);
					return;
				}

				// Selección flotante: si se toca el marco se edita; si no, se fija.
				if (st.sel) {
					const [tx, ty] = posCanvas(e);
					if (transformHit(node, tx, ty)) {
						beginTransform(tx, ty);
						hideCursor(node);
						return;
					}
					commitSel(node);
				}

				// Texto en edición: si se toca el marco se arrastra/redimensiona;
				// si no, se fija y (con la herramienta texto) empieza otro.
				if (st.textObj) {
					const [tx, ty] = posCanvas(e);
					if (transformHit(node, tx, ty)) {
						beginTransform(tx, ty);
						hideCursor(node);
						return;
					}
					commitTextObj(node);
				}

				hideCursor(node);
				if (st.tool === "text") {
					if (!st.text) { alert("Escribí un texto en el campo antes de colocarlo."); return; }
					pushUndo(node);
					const [cx, cy] = posCanvas(e);
					createTextObj(node, cx, cy);
					return;
				}

				if (st.tool === "select") {
					if (!selectedLayers(node).length) return;
					const [cx, cy] = posCanvas(e);
					st.lasso = { pts: [[cx, cy]] };
					drawLasso(node);
					return;
				}

				if (st.tool === "maskBrush" || st.tool === "maskErase") {
					pushUndo(node);
					drawing = true;
					last = null;
					const [mx, my] = posCanvas(e);
					maskSeg(mx, my);
					return;
				}

				if (st.tool === "soft") {
					pushUndo(node);
					drawing = true;
					last = null;
					st.softPts = [pos(e)];
					softLive();
					return;
				}

				pushUndo(node);
				drawing = true;
				last = null;
				const [x, y] = pos(e);
				if (st.tool === "shape") {
					st.shapeStart = [x, y];
					st.shapeEnd = [x, y];
				} else if (st.tool === "eraser") {
					st.erasePoints = [];
					erasePreviewTo(x, y);
				} else {
					strokeTo(x, y);
				}
			});
			preview.addEventListener("pointerenter", (e) => {
				updatePointerCursor(node, e.clientX, e.clientY);
				if (!st.transformMode) placeCursor(node, e.clientX, e.clientY);
			});
			preview.addEventListener("pointerleave", () => hideCursor(node));
			preview.addEventListener("pointermove", (e) => {
				if (st.lasso) {
					const [cx, cy] = posCanvas(e);
					const pts = st.lasso.pts;
					const p = pts[pts.length - 1];
					if (Math.hypot(cx - p[0], cy - p[1]) > 2) {
						pts.push([cx, cy]);
						drawLasso(node);
					}
					return;
				}
				if (st.transformDrag) {
					const [cx, cy] = posCanvas(e);
					applyTransformDrag(node, cx, cy);
					return;
				}
				updatePointerCursor(node, e.clientX, e.clientY);
				if (st.transformMode) { hideCursor(node); return; }
				if (!drawing) { placeCursor(node, e.clientX, e.clientY); return; }
				if (st.tool === "maskBrush" || st.tool === "maskErase") {
					const [mx, my] = posCanvas(e);
					maskSeg(mx, my);
					return;
				}
				const [x, y] = pos(e);
				if (st.tool === "soft") {
					const p = st.softPts[st.softPts.length - 1];
					if (Math.hypot(x - p[0], y - p[1]) >= 1) {
						st.softPts.push([x, y]);
						softLive();
					}
				} else if (st.tool === "shape") shapePreviewTo(x, y);
				else if (st.tool === "eraser") erasePreviewTo(x, y);
				else strokeTo(x, y);
			});
			const endStroke = () => {
				if (st.transformDrag) {
					const layers = st.transformDrag.layers;
					st.transformDrag = null;
					if (layers.includes("paint")) write(node);
					if (layers.includes("underlay") || layers.some((k) => String(k).startsWith("L:"))) writeCalco(node);
					drawTransformUI(node);
					return;
				}
				if (st.lasso) {
					const pts = st.lasso.pts;
					st.lasso = null;
					clearOverlay(node);
					createSelection(node, pts);
					return;
				}
				if (!drawing) return;
				drawing = false;
				const wasMaskStroke = st.tool === "maskBrush" || st.tool === "maskErase";
				if (st.tool === "shape") commitShape();
				else if (st.tool === "eraser") { commitErase(); renderPreview(node); }
				else if (st.tool === "soft") commitSoft();
				st.erasePoints = null;
				st.shapeStart = null;
				st.shapeEnd = null;
				last = null;
				if (wasMaskStroke) writeMask(node);
				else write(node);
			};
			preview.addEventListener("pointerup", (e) => {
				endStroke();
				if (!st.transformMode) placeCursor(node, e.clientX, e.clientY);
			});
			preview.addEventListener("pointercancel", () => { endStroke(); hideCursor(node); });

			// --- Montar el DOM widget ---
			const domWidget = node.addDOMWidget("mika_lineart_canvas", "div", root);
			domWidget.serialize = false;
			domWidget.computeSize = (width) => {
				const w = width ?? node.size?.[0] ?? 320;
				const [cw, ch] = parseRes(resolucionWidget(node)?.value);
				const inner = Math.max(32, w - PAD);
				const tb = (st && st._toolbarH) || TOOLBAR_H * 4;
				const lp = (st?.layerPanel && st.layerPanel.style.display !== "none") ? (st.layerPanel.offsetHeight || 44) : 0;
				// El alto del lienzo se limita al ancho (cuadrado): en verticales
				// no crece más allá de eso.
				return [w, tb + 12 + inner / Math.max(1, cw / ch) + lp];
			};
			node._mikaDomWidget = domWidget;

			// Input oculto para "Importar proyecto" (menú contextual).
			const projectInput = document.createElement("input");
			projectInput.type = "file";
			projectInput.accept = ".json,application/json";
			projectInput.style.display = "none";
			projectInput.addEventListener("change", () => {
				const file = projectInput.files?.[0];
				projectInput.value = "";
				if (file) importProject(node, file);
			});
			root.appendChild(projectInput);
			node._mikaProjectInput = projectInput;

			// Enter fija el texto en edición; Escape lo cancela.
			if (node._mikaKeyHandler) document.removeEventListener("keydown", node._mikaKeyHandler, true);
			const onKey = (e) => {
				if (e.key === "Enter") {
					if (st.sel) { e.preventDefault(); commitSel(node); }
					else if (st.textObj) { e.preventDefault(); commitTextObj(node); }
				} else if (e.key === "Escape") {
					if (st.sel) { e.preventDefault(); cancelSel(node); }
					else if (st.textObj) { e.preventDefault(); cancelTextObj(node); }
				}
			};
			node._mikaKeyHandler = onKey;
			document.addEventListener("keydown", onKey, true);

			hookWidget(node, resolucionWidget(node), (value) => {
				const [nw, nh] = parseRes(value);
				resize(node, nw, nh);
			});
			hookWidget(node, modoWidget(node), () => applyMode(node));

			// Drop sobre el área de canvas del nodo (fuera del DOM widget):
			// ComfyUI llama a estos hooks desde su handler de document.
			node.onDragOver = (e) => {
				const dt = e?.dataTransfer;
				if (!dt) return false;
				if (Array.from(dt.items || []).some((it) => it.kind === "file")) return true;
				return (dt.types || []).includes("text/uri-list");
			};
			node.onDragDrop = async (e) => {
				e?.preventDefault?.();
				return handleDroppedData(node, e?.dataTransfer);
			};

			applyMode(node);
			load(node);
			if (isInpaint) {
				loadBaseFromInput(node);
				loadMask(node);
				// Si ComfyUI reconstruyó el nodo, la imagen ya cargada sigue en
				// memoria pero el canvas nuevo está vacío: hay que redibujarla
				// (loadBaseFromInput no lo hace si la clave no cambió).
				drawBase(node);
			}
			drawUnderlay(node);
			drawTransformUI(node);

			const refit = () => {
				try {
					if (toolbar.offsetHeight) st._toolbarH = toolbar.offsetHeight;
					const size = node.computeSize();
					const h = Math.max(140, size?.[1] || 140);
					if (Math.abs((node.size?.[1] ?? 0) - h) > 1) {
						node.setSize([node.size?.[0] ?? 320, h]);
					}
				} catch (e) { /* no-op */ }
				node.setDirtyCanvas(true, true);
			};
			st.refit = refit;
			requestAnimationFrame(refit);
			setTimeout(refit, 400);

			// La imagen de entrada llega recién cuando el nodo aguas arriba se
			// ejecutó: reintentamos al conectar y al terminar cada corrida.
			if (isInpaint) {
				node.onConnectionsChange = () => loadBaseFromInput(node);
				if (node._mikaExecHandler) app.api?.removeEventListener?.("execution_success", node._mikaExecHandler);
				node._mikaExecHandler = () => {
					if (node._mikaLineart === st) loadBaseFromInput(node);
				};
				app.api?.addEventListener?.("execution_success", node._mikaExecHandler);
			}
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
			setTimeout(() => build(this), 100);
			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
			setTimeout(() => build(this), 100);
			return r;
		};

		// Menú del botón derecho sobre el nodo: importar/exportar proyecto y
		// guardar el trazo o el calco como imagen.
		const onGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
		nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
			const r = onGetExtraMenuOptions ? onGetExtraMenuOptions.apply(this, arguments) : undefined;
			const node = this;
			if (Array.isArray(options) && node._mikaLineart) {
				if (node._mikaLineart.maskCanvas) {
					options.push(
						null,
						{ content: "Importar proyecto…", callback: () => node._mikaProjectInput?.click() },
						{ content: "Exportar proyecto (trazo + calco + máscara)", callback: () => exportProject(node) },
						{ content: "Guardar imagen fuente", callback: () => saveImage(node, "imagen") },
						{ content: "Guardar trazo (forma)", callback: () => saveImage(node, "trazo") },
						{ content: "Guardar máscara", callback: () => saveImage(node, "mascara") },
					);
				} else {
					options.push(
						null,
						{ content: "Importar proyecto…", callback: () => node._mikaProjectInput?.click() },
						{ content: "Exportar proyecto (trazo + calco)", callback: () => exportProject(node) },
						{ content: "Guardar trazo como imagen", callback: () => saveImage(node, "trazo") },
						{ content: "Guardar calco como imagen", callback: () => saveImage(node, "calco") },
					);
				}
			}
			return r;
		};

		const onRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function () {
			const prev = this._mikaDomWidget;
			if (prev) {
				try { prev.element?.remove(); } catch (e) { /* no-op */ }
				this._mikaDomWidget = null;
			}
			if (this._mikaKeyHandler) {
				document.removeEventListener("keydown", this._mikaKeyHandler, true);
				this._mikaKeyHandler = null;
			}
			if (this._mikaExecHandler) {
				app.api?.removeEventListener?.("execution_success", this._mikaExecHandler);
				this._mikaExecHandler = null;
			}
			this._mikaLineart = null;
			return onRemoved ? onRemoved.apply(this, arguments) : undefined;
		};
	},
});
