import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

/**
 * Mika · Tiempos de Ejecución
 *
 * Mide cuánto tarda cada nodo en ejecutarse (a partir de los eventos que
 * el propio ComfyUI ya emite por websocket) y lo muestra de dos formas:
 *
 * 1. Una etiqueta flotando sobre cada nodo con el tiempo de su última
 *    corrida (verde = rápido, amarillo = medio, rojo = lento, azul =
 *    resultado tomado de caché).
 * 2. Un panel flotante, arrastrable y colapsable, en la esquina
 *    inferior derecha, con el detalle de todos los nodos de la corrida
 *    actual ordenados de más lento a más rápido, y el total abajo.
 *
 * No hace falta agregar ningún nodo al workflow para que funcione: se
 * activa solo. El nodo Python opcional "ExecutionTimerConfig" solo sirve
 * para cambiar la configuración (mostrar/ocultar panel o etiquetas,
 * decimales) desde el propio grafo.
 */

const settings = {
	showPanel: true,
	showBadges: true,
	decimals: 2,
};

// id de nodo (string) -> { last, total, runs, max, cached }
const nodeTimes = new Map();
let currentNodeId = null;
let currentStart = 0;
let runTotal = 0;
let running = false;
let runWallStart = 0;
let runWallEnd = 0;

function fmt(ms) {
	if (ms === null || ms === undefined) return "-";
	return `${(ms / 1000).toFixed(settings.decimals)}s`;
}

function liveElapsed() {
	if (runWallStart === 0) return 0;
	const end = running ? performance.now() : runWallEnd || performance.now();
	return end - runWallStart;
}

function nodeLabel(id) {
	const n = app.graph.getNodeById(Number(id));
	if (!n) return `#${id}`;
	return n.title || n.type || `#${id}`;
}

function extractNodeId(detail) {
	if (detail === null || detail === undefined) return null;
	if (typeof detail === "object") {
		if ("node" in detail) return detail.node;
		if ("display_node" in detail) return detail.display_node;
		return null;
	}
	return detail;
}

function colorFor(ratio) {
	if (ratio < 0.3) return "#6fcf6f";
	if (ratio < 0.7) return "#e5c93c";
	return "#e5583c";
}

function finishCurrent(now) {
	if (currentNodeId === null) return;
	const elapsed = now - currentStart;
	const entry = nodeTimes.get(currentNodeId) || { last: 0, total: 0, runs: 0, max: 0, cached: false };
	entry.last = elapsed;
	entry.total += elapsed;
	entry.runs += 1;
	entry.max = Math.max(entry.max, elapsed);
	nodeTimes.set(currentNodeId, entry);
	runTotal += elapsed;
	currentNodeId = null;
}

function resetRun() {
	nodeTimes.clear();
	currentNodeId = null;
	runTotal = 0;
	running = true;
	runWallStart = performance.now();
	runWallEnd = 0;
}

// -----------------------------------------------------------------------
// Panel flotante
// -----------------------------------------------------------------------
let panelEl = null;
let listEl = null;
let totalEl = null;
let statusDotEl = null;
let liveTimeEl = null;
let collapsed = true; // ← MODIFICADO: el panel arranca minimizado

function ensurePanel() {
	if (panelEl) return;

	panelEl = document.createElement("div");
	panelEl.id = "mika-timer-panel";
	Object.assign(panelEl.style, {
		position: "fixed",
		right: "16px",
		bottom: "16px",
		width: "260px",
		maxHeight: "50vh",
		background: "rgba(20,20,24,0.92)",
		color: "#eee",
		font: "13px/1.5 monospace",
		border: "1px solid #444",
		borderRadius: "8px",
		boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
		zIndex: 10000,
		display: "flex",
		flexDirection: "column",
		overflow: "hidden",
		userSelect: "none",
	});

	const header = document.createElement("div");
	Object.assign(header.style, {
		padding: "6px 10px",
		background: "#2a2a30",
		cursor: "move",
		fontWeight: "bold",
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: "6px",
	});

	const titleWrap = document.createElement("div");
	titleWrap.style.display = "flex";
	titleWrap.style.alignItems = "center";
	titleWrap.style.gap = "6px";

	statusDotEl = document.createElement("span");
	Object.assign(statusDotEl.style, {
		width: "8px",
		height: "8px",
		borderRadius: "50%",
		background: "#888",
		display: "inline-block",
	});

	const titleText = document.createElement("span");
	titleText.textContent = "⏱ Mika · Tiempos de ejecución";
	titleText.style.fontSize = "14px";

	liveTimeEl = document.createElement("span");
	Object.assign(liveTimeEl.style, {
		fontSize: "14px",
		color: "#6fcf6f",
		display: "none",
	});

	titleWrap.appendChild(statusDotEl);
	titleWrap.appendChild(titleText);
	titleWrap.appendChild(liveTimeEl);

	const toggle = document.createElement("span");
	toggle.textContent = "–";
	toggle.style.cursor = "pointer";
	toggle.style.fontSize = "14px";
	toggle.onclick = (e) => {
		e.stopPropagation();
		collapsed = !collapsed;
		body.style.display = collapsed ? "none" : "flex";
		totalWrap.style.display = collapsed ? "none" : "flex";
		liveTimeEl.style.display = collapsed ? "inline" : "none";
		toggle.textContent = collapsed ? "+" : "–";
		renderPanel();
	};

	header.appendChild(titleWrap);
	header.appendChild(toggle);

	const body = document.createElement("div");
	Object.assign(body.style, {
		overflowY: "auto",
		padding: "6px 10px",
		display: "flex",
		flexDirection: "column",
		gap: "4px",
	});

	listEl = document.createElement("div");
	listEl.style.display = "flex";
	listEl.style.flexDirection = "column";
	listEl.style.gap = "4px";
	body.appendChild(listEl);

	const totalWrap = document.createElement("div");
	Object.assign(totalWrap.style, {
		padding: "6px 10px",
		borderTop: "1px solid #444",
		display: "flex",
		justifyContent: "space-between",
		fontWeight: "bold",
	});

	const totalLabel = document.createElement("span");
	totalLabel.textContent = "Total";
	totalEl = document.createElement("span");
	totalWrap.appendChild(totalLabel);
	totalWrap.appendChild(totalEl);

	panelEl.appendChild(header);
	panelEl.appendChild(body);
	panelEl.appendChild(totalWrap);

	// ← MODIFICADO: estado inicial minimizado del panel
	body.style.display = collapsed ? "none" : "flex";
	totalWrap.style.display = collapsed ? "none" : "flex";
	liveTimeEl.style.display = collapsed ? "inline" : "none";
	toggle.textContent = collapsed ? "+" : "–";

	document.body.appendChild(panelEl);

	// Arrastrar el panel desde el header.
	let dragging = false;
	let offX = 0;
	let offY = 0;

	header.addEventListener("mousedown", (e) => {
		if (e.target === toggle) return;
		dragging = true;
		const rect = panelEl.getBoundingClientRect();
		offX = e.clientX - rect.left;
		offY = e.clientY - rect.top;
		e.preventDefault();
	});

	window.addEventListener("mousemove", (e) => {
		if (!dragging) return;
		panelEl.style.left = `${e.clientX - offX}px`;
		panelEl.style.top = `${e.clientY - offY}px`;
		panelEl.style.right = "auto";
		panelEl.style.bottom = "auto";
	});

	window.addEventListener("mouseup", () => {
		dragging = false;
	});
}

function renderPanel() {
	if (!settings.showPanel) {
		if (panelEl) panelEl.style.display = "none";
		return;
	}

	ensurePanel();
	panelEl.style.display = "flex";

	statusDotEl.style.background = running ? "#6fcf6f" : "#888";
	liveTimeEl.textContent = fmt(liveElapsed());
	liveTimeEl.style.color = running ? "#6fcf6f" : "#9aa0a6";

	const entries = [...nodeTimes.entries()].filter(([, v]) => v.last);
	entries.sort((a, b) => b[1].last - a[1].last);
	const maxTime = entries.reduce((m, [, v]) => Math.max(m, v.last), 0) || 1;

	listEl.innerHTML = "";

	for (const [id, v] of entries) {
		const row = document.createElement("div");
		Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px" });

		const bar = document.createElement("div");
		Object.assign(bar.style, {
			height: "6px",
			width: `${Math.max(4, (v.last / maxTime) * 60)}px`,
			background: colorFor(v.last / maxTime),
			borderRadius: "3px",
			flexShrink: "0",
		});

		const label = document.createElement("span");
		label.textContent = nodeLabel(id);
		Object.assign(label.style, {
			flex: "1",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis",
		});

		const time = document.createElement("span");
		time.textContent = fmt(v.last);
		time.style.opacity = "0.85";

		row.appendChild(bar);
		row.appendChild(label);
		row.appendChild(time);
		listEl.appendChild(row);
	}

	const cachedCount = [...nodeTimes.values()].filter((v) => v.cached && !v.last).length;
	if (cachedCount > 0) {
		const cachedRow = document.createElement("div");
		cachedRow.style.opacity = "0.6";
		cachedRow.textContent = `+ ${cachedCount} tomados de caché`;
		listEl.appendChild(cachedRow);
	}

	if (entries.length === 0 && cachedCount === 0) {
		const empty = document.createElement("div");
		empty.style.opacity = "0.6";
		empty.textContent = running ? "Ejecutando..." : "Sin datos todavía.";
		listEl.appendChild(empty);
	}

	totalEl.textContent = fmt(runTotal);
}

function tickLive() {
	if (!panelEl || !liveTimeEl) return;
	liveTimeEl.textContent = fmt(liveElapsed());
}

// -----------------------------------------------------------------------
// Eventos de ComfyUI
// -----------------------------------------------------------------------
app.registerExtension({
	name: "Mika.ExecutionTimer",

	async setup() {
		api.addEventListener("execution_start", () => {
			resetRun();
			renderPanel();
		});

		api.addEventListener("executing", (evt) => {
			const now = performance.now();
			finishCurrent(now);
			const id = extractNodeId(evt.detail);
			if (id !== null && id !== undefined) {
				currentNodeId = String(id);
				currentStart = now;
			} else {
				running = false;
				runWallEnd = now;
			}
			app.graph.setDirtyCanvas(true, false);
			renderPanel();
		});

		api.addEventListener("execution_cached", (evt) => {
			const ids = evt.detail?.nodes ?? [];
			for (const id of ids) {
				const key = String(id);
				const entry = nodeTimes.get(key) || { last: 0, total: 0, runs: 0, max: 0, cached: false };
				entry.cached = true;
				nodeTimes.set(key, entry);
			}
			renderPanel();
		});

		api.addEventListener("execution_error", () => {
			finishCurrent(performance.now());
			running = false;
			runWallEnd = performance.now();
			app.graph.setDirtyCanvas(true, false);
			renderPanel();
		});

		api.addEventListener("execution_interrupted", () => {
			finishCurrent(performance.now());
			running = false;
			runWallEnd = performance.now();
			app.graph.setDirtyCanvas(true, false);
			renderPanel();
		});

		// Configuración enviada desde el nodo Python opcional "ExecutionTimerConfig".
		api.addEventListener("mika-timer-config", (evt) => {
			Object.assign(settings, evt.detail || {});
			renderPanel();
		});

		renderPanel();

		setInterval(() => {
			if (running) tickLive();
		}, 100);
	},

	async nodeCreated(node) {
		const onDrawForeground = node.onDrawForeground;
		node.onDrawForeground = function (ctx) {
			const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;

			if (!settings.showBadges) return r;
			if (this.flags?.collapsed) return r;

			const entry = nodeTimes.get(String(this.id));
			if (!entry) return r;

			const isCacheOnly = entry.cached && !entry.last;
			const label = isCacheOnly ? "caché" : fmt(entry.last);

			let fg = "#7CFC7C";
			if (isCacheOnly) {
				fg = "#7ec8ff";
			} else if (runTotal > 0) {
				fg = colorFor(Math.min(1, (entry.last / runTotal) * 3));
			}

			ctx.save();
			ctx.font = "12px sans-serif";
			const textWidth = ctx.measureText(label).width;
			const pad = 4;
			const w = textWidth + pad * 2;
			const h = 16;
			const x = this.size[0] - w;
			const y = -h - 6;

			ctx.fillStyle = "rgba(0,0,0,0.65)";
			if (ctx.roundRect) {
				ctx.beginPath();
				ctx.roundRect(x, y, w, h, 4);
				ctx.fill();
			} else {
				ctx.fillRect(x, y, w, h);
			}

			ctx.fillStyle = fg;
			ctx.textBaseline = "middle";
			ctx.fillText(label, x + pad, y + h / 2 + 1);
			ctx.restore();

			return r;
		};
	},
});

// -----------------------------------------------------------------------
// MODIFICADO: el nodo de configuración (ExecutionTimerConfig) arranca
// minimizado (colapsado) al agregarlo. Al cargar un workflow guardado,
// configure() aplica después los flags guardados, así que se respeta
// si lo dejaste expandido y guardaste así.
// -----------------------------------------------------------------------
app.registerExtension({
	name: "Mika.ExecutionTimerStartCollapsed",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "ExecutionTimerConfig") return;

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated
				? onNodeCreated.apply(this, arguments)
				: undefined;

			this.flags = this.flags || {};
			this.flags.collapsed = true;

			try {
				this.setDirtyCanvas(true, true);
			} catch (e) { /* no-op */ }

			return r;
		};
	},
});