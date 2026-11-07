import { app } from "/scripts/app.js";

// Image Saver PC-Mika: tras cada ejecucion escribe las imagenes en la
// carpeta de tu PC elegida con el boton (File System Access API, el
// navegador pide permiso). Recrea dentro la subcarpeta indicada en el
// widget path (una ruta tipo C:/Fotos/proyecto se vuelve Fotos/proyecto,
// ya que la web no puede abrir rutas absolutas por si sola).
// Sin API disponible (o sin carpeta elegida) cae a descarga clasica.

const dirHandles = new Map();

function sanitizeParts(subfolder) {
	const rel = String(subfolder || "").replace(/\\/g, "/").replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
	return rel.split("/").map((p) => p.replace(/[\\/:*?"<>|]/g, "_").trim().replace(/^\.+|\.+$/g, "")).filter((p) => p && p !== "." && p !== "..");
}

async function ensurePermission(handle) {
	const opts = { mode: "readwrite" };
	try {
		if ((await handle.queryPermission(opts)) === "granted") return true;
	} catch (e) { /* no-op */ }
	try {
		return (await handle.requestPermission(opts)) === "granted";
	} catch (e) {
		return false;
	}
}

async function saveToFolder(handle, parts, filename, blob) {
	let dir = handle;
	for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
	const file = await dir.getFileHandle(filename, { create: true });
	const writable = await file.createWritable();
	try {
		await writable.write(blob);
	} finally {
		await writable.close();
	}
}

function classicDownload(parts, filename, blob) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = [...parts, filename].join("/");
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}

app.registerExtension({
	name: "Mika.ImageSaverPC",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== "ImageSaverPcMika") return;

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

			this.addWidget("button", "carpeta PC (elegir)", "elegir", async () => {
				try {
					if (!window.showDirectoryPicker) {
						alert("Este navegador no permite elegir carpeta (usa Chrome o Edge). Se descargara a la carpeta de descargas.");
						return;
					}
					const handle = await window.showDirectoryPicker({ mode: "readwrite" });
					if (await ensurePermission(handle)) {
						dirHandles.set(this.id, handle);
						console.log("[Mika PC] carpeta elegida:", handle.name);
					}
				} catch (e) {
					console.log("[Mika PC] seleccion cancelada");
				}
			});
			this.addWidget("combo", "auto-guardar PC", "on", () => {}, { values: ["on", "off"] });
			return r;
		};

		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);
			const images = message?.images;
			if (!images?.length) return;
			const auto = this.widgets?.find((w) => w.name === "auto-guardar PC");
			if (auto && auto.value === "off") return;

			(async () => {
				const handle = dirHandles.get(this.id);
				const ok = handle ? await ensurePermission(handle) : false;
				for (const info of images) {
					const url = `/view?filename=${encodeURIComponent(info.filename)}&type=${info.type}&subfolder=${encodeURIComponent(info.subfolder || "")}`;
					const res = await fetch(url);
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const blob = await res.blob();
					const parts = sanitizeParts(info.subfolder);
					if (ok) await saveToFolder(handle, parts, info.filename, blob);
					else classicDownload(parts, info.filename, blob);
				}
				console.log(`[Mika PC] ${images.length} imagen(es) guardadas${ok ? " en tu carpeta PC" : " (descarga clasica)"}.`);
			})().catch((e) => console.error("[Mika PC] error guardando:", e));
		};
	},
});
