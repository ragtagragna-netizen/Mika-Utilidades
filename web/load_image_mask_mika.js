import { app, ComfyApp } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Load Image Mask-Mika: botón para abrir el MaskEditor
// -----------------------------------------------------------------------
// La API del frontend vive en la CLASE ComfyApp (estáticos), no en la
// instancia `app`: ComfyApp.copyToClipspace / clipspace_return_node /
// open_maskeditor (ver src/scripts/app.ts y extensions/core/maskeditor.ts).
// Si el nodo aún no tiene preview (node.imgs vacío), se precarga la
// imagen del widget vía /view antes de abrir el editor.
// -----------------------------------------------------------------------

console.log("[Mika] Load Image Mask cargado — botón MaskEditor");

const BUTTON_LABEL = "Abrir MaskEditor";
const PREVIEW_TIMEOUT_MS = 10000;

function parseAnnotated(value) {
  const m = String(value).match(/^(.*)\s\[(\w+)\]\s*$/);
  if (m) return { filename: m[1].trim(), type: m[2] };
  return { filename: String(value).trim(), type: "input" };
}

function viewUrl(filename, type, subfolder) {
  let url = `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type || "input")}`;
  if (subfolder) url += `&subfolder=${encodeURIComponent(subfolder)}`;
  return url;
}

function candidateUrls(value) {
  const { filename, type } = parseAnnotated(value);
  if (!filename) return [];
  if (/^https?:\/\//i.test(filename)) return [filename];
  const urls = [];
  const slash = filename.lastIndexOf("/");
  if (slash > 0) {
    urls.push(viewUrl(filename.slice(slash + 1), type, filename.slice(0, slash)));
  }
  urls.push(viewUrl(filename, type));
  return urls;
}

function loadOne(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error("timeout")), PREVIEW_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error(`no se pudo cargar: ${url}`)); };
    img.src = url;
  });
}

async function ensureNodeImgs(node) {
  if (node?.imgs?.length) return true;
  const w = (node.widgets ?? []).find((x) => x && x.name === "image");
  const value = String(w?.value ?? "").trim();
  if (!value) return false;
  for (const url of candidateUrls(value)) {
    try {
      const img = await loadOne(url);
      node.imgs = [img];
      if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
      return true;
    } catch (e) { /* probar siguiente candidato */ }
  }
  return false;
}

async function openEditor(node) {
  if (typeof ComfyApp?.copyToClipspace !== "function" ||
      typeof ComfyApp?.open_maskeditor !== "function") {
    console.error("[Mika] Este frontend no expone la API del MaskEditor.");
    return;
  }
  const ok = await ensureNodeImgs(node);
  if (!ok) {
    console.error("[Mika] El nodo no tiene imagen para editar.");
    return;
  }
  ComfyApp.copyToClipspace(node);
  ComfyApp.clipspace_return_node = node;
  ComfyApp.open_maskeditor();
}

function addMaskButton(node) {
  if (!node || node.comfyClass !== "LoadImageNameMaskMika") return;
  if ((node.widgets ?? []).some((w) => w?.name === BUTTON_LABEL)) return;
  try {
    node.addWidget("button", BUTTON_LABEL, null, () => {
      openEditor(node).catch((e) =>
        console.error("[Mika] No se pudo abrir el MaskEditor.", e));
    });
    if (typeof node.setSize === "function" && typeof node.computeSize === "function") {
      try { node.setSize(node.computeSize()); } catch (e) { /* no-op */ }
    }
  } catch (e) { /* no-op */ }
}

app.registerExtension({
  name: "Mika.LoadImageNameMask",

  nodeCreated(node) {
    addMaskButton(node);
  },
});
