import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Load Image-Mika MaskEditor support
// -----------------------------------------------------------------------
// El MaskEditor nativo solo muestra "Open in MaskEditor | Image Canvas"
// cuando el nodo es un "image node" (ver isImageNode en el frontend:
// node.imgs con al menos una imagen o previewMediaType === 'image').
//
// Load Image-Mika usa un STRING (image_path, ruta local o URL) en vez del
// combo con image_upload del Load Image nativo, así que el frontend nunca
// le genera preview y la opción no aparece.
//
// Esta extensión carga el preview en node.imgs (sin tocar el backend):
//  1. widget "image" (lo escribe el MaskEditor al guardar, ej.
//     "clipspace-painted-masked-123.png [temp]") -> /view
//  2. basename de "image_path" -> /view?type=input (caso típico)
//  3. ruta local arbitraria -> /mika/file_picker/file (contenido seguro)
//  4. URL http(s) -> directa (mejor esfuerzo; puede fallar por CORS)
//
// El guardado del MaskEditor escribe el widget "image", que el backend
// prioriza sobre "image_path" (ver LoadImageMika.load_image).
// -----------------------------------------------------------------------

const PREVIEW_TIMEOUT_MS = 10000;
const REFRESH_DEBOUNCE_MS = 300;

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

function imageWidgetUrls(value) {
  const { filename, type } = parseAnnotated(value);
  if (!filename) return [];
  const urls = [];
  const slash = filename.lastIndexOf("/");
  if (slash > 0) {
    urls.push(viewUrl(filename.slice(slash + 1), type, filename.slice(0, slash)));
  }
  urls.push(viewUrl(filename, type));
  return urls;
}

function imagePathUrls(imagePath) {
  const p = String(imagePath || "").trim();
  if (!p) return [];
  if (/^https?:\/\//i.test(p)) return [p];
  const base = p.split(/[\\/]/).pop();
  if (!base) return [];
  const urls = [viewUrl(base, "input")];
  const folder = p.slice(0, p.length - base.length).replace(/[\\/]+$/, "");
  if (folder && folder !== "." && folder !== "./") {
    urls.push(`/mika/file_picker/file?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(base)}`);
  }
  return urls;
}

function loadOne(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => {
      img.src = "";
      reject(new Error("timeout"));
    }, PREVIEW_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`no se pudo cargar: ${url}`));
    };
    img.src = url;
  });
}

// Sondea candidatos sin ensuciar la consola: un <img> fallido loguea
// "Failed to load resource" (ruido 404); fetch, no.
async function probeOk(url) {
  try {
    if (/^https?:\/\//i.test(url) && !url.startsWith(window.location.origin)) {
      return true; // externo: fetch fallaría por CORS aunque <img> cargue
    }
    const ctrl = new AbortController();
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      return res.ok;
    } finally {
      try {
        ctrl.abort();
      } catch (e) {
        /* no-op */
      }
    }
  } catch (e) {
    return false;
  }
}

async function loadFirst(urls) {
  for (const url of urls) {
    if (!(await probeOk(url))) continue;
    try {
      return await loadOne(url);
    } catch (e) { /* probar siguiente candidato */ }
  }
  return null;
}

function collectUrls(node) {
  const wImage = node.widgets?.find((w) => w && w.name === "image");
  const wPath = node.widgets?.find((w) => w && w.name === "image_path");
  const urls = [];
  const imgVal = wImage ? String(wImage.value ?? "").trim() : "";
  if (imgVal) urls.push(...imageWidgetUrls(imgVal));
  const pathVal = wPath ? String(wPath.value ?? "").trim() : "";
  if (pathVal) urls.push(...imagePathUrls(pathVal));
  return [...new Set(urls)];
}

async function refreshPreview(node) {
  if (!node) return;
  const urls = collectUrls(node);
  if (!urls.length) return;
  const token = (node._mikaMaskToken = (node._mikaMaskToken || 0) + 1);
  const img = await loadFirst(urls);
  if (token !== node._mikaMaskToken) return; // refresh más nuevo en curso
  if (img) {
    node.imgs = [img];
    if (typeof node.setDirtyCanvas === "function") {
      node.setDirtyCanvas(true, true);
    }
  }
}

function hookWidget(node, name) {
  const w = node.widgets?.find((x) => x && x.name === name);
  if (!w || w._mikaMaskHooked) return;
  w._mikaMaskHooked = true;
  const orig = w.callback;
  let timer = null;
  w.callback = function () {
    const r = orig ? orig.apply(this, arguments) : undefined;
    clearTimeout(timer);
    timer = setTimeout(() => refreshPreview(node), REFRESH_DEBOUNCE_MS);
    return r;
  };
}

app.registerExtension({
  name: "Mika.LoadImageMaskPreview",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== "LoadImageMika") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      hookWidget(this, "image");
      hookWidget(this, "image_path");
      // Los widgets se restauran después de onNodeCreated; diferir.
      setTimeout(() => {
        hookWidget(this, "image");
        hookWidget(this, "image_path");
        refreshPreview(this);
      }, 100);
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      if (onExecuted) onExecuted.apply(this, arguments);
      refreshPreview(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => {
        hookWidget(this, "image");
        hookWidget(this, "image_path");
        refreshPreview(this);
      }, 100);
      return r;
    };
  },
});
