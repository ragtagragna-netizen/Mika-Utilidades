import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

/**
 * Mika - Workflow Save (panel flotante)
 *
 * Panel arrastrable ubicado justo encima del Mika - Timer (esquina
 * inferior derecha). Campos de carpeta y nombre, y dos botones:
 *  - "Guardar": guarda el workflow; si ya existe pregunta si
 *    sobreescribir o guardar como copia.
 *  - "Copia": guarda siempre con sufijo " (1)", " (2)", ...
 */

let panelEl = null;
let statusEl = null;
let folderInput = null;
let nameInput = null;
let lastAutoName = null;

const STORAGE_KEY_FOLDER = "mika.workflowSave.folder";

// Nombre de la pestaña/workflow activo en el gestor nativo de ComfyUI.
function activeWorkflowName() {
  try {
    const wf = app.extensionManager?.workflow?.activeWorkflow;
    const name = wf?.name || wf?.filename;
    if (name) return String(name).replace(/\.(json|workflow)$/i, "");
  } catch (e) { /* no-op */ }
  try {
    const active = document.querySelector(
      ".workflow-tab.active .workflow-tab-name, .workflow-tabs .active .tab-name"
    );
    if (active?.textContent) return active.textContent.trim();
  } catch (e) { /* no-op */ }
  return null;
}

// Rellena el campo de nombre sin pisar ediciones manuales del usuario.
function syncWorkflowName() {
  if (!nameInput) return;
  const name = activeWorkflowName();
  if (!name) return;
  if (!nameInput.value || nameInput.value === lastAutoName) {
    nameInput.value = name;
  }
  lastAutoName = name;
}

// Guarda nativo de ComfyUI (equivalente a Ctrl+S / menú Save).
async function nativeSave() {
  await runNativeCommand("Comfy.SaveWorkflow", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true,
    }));
  });
}

// File > Save As de ComfyUI (equivale a Ctrl+Shift+S).
async function nativeSaveAs() {
  await runNativeCommand("Comfy.SaveWorkflowAs", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s", code: "KeyS", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }));
  });
}

async function runNativeCommand(commandId, fallback) {
  try {
    const cmds = app.extensionManager?.command;
    if (cmds?.execute) {
      await cmds.execute(commandId);
      flashStatus("✓ Listo");
      return;
    }
  } catch (e) { /* fallback abajo */ }
  try {
    fallback();
    flashStatus("✓ Listo");
  } catch (e) {
    flashStatus("✗ No se pudo ejecutar", false);
  }
}

function flashStatus(text, ok = true, ms = 2500) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = ok ? "#6fcf6f" : "#e5583c";
  statusEl.style.display = "inline";
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => {
    statusEl.style.display = "none";
  }, ms);
}

async function sendSave(mode) {
  syncWorkflowName();
  const folder = folderInput.value.trim();
  if (!folder) {
    return sendSaveLocalFolder(mode);
  }
  try {
    localStorage.setItem(STORAGE_KEY_FOLDER, folder);
  } catch (e) { /* no-op */ }
  let workflow;
  try {
    workflow = app.graph.serialize();
  } catch (e) {
    console.error("[Mika] No se pudo serializar el workflow:", e);
    flashStatus("✗ Error serializando", false);
    return;
  }

  const payload = {
    folder: folderInput.value.trim(),
    name: nameInput.value.trim(),
    mode,
    workflow,
  };

  let res;
  try {
    res = await api.fetchApi("/mika/save_workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("[Mika] Error de red guardando workflow:", e);
    flashStatus("✗ Error de red", false);
    return;
  }

  const data = await res.json().catch(() => ({}));

  if (data.status === "exists") {
    const overwrite = window.confirm(
      `Ya existe "${payload.name}" en la carpeta destino.\n\n` +
      `Aceptar = SOBREESCRIBIR\nCancelar = guardar como copia`
    );
    return sendSave(overwrite ? "overwrite" : "copy");
  }

  if (data.status === "ok") {
    console.log(`[Mika] Workflow guardado en: ${data.path}`);
    flashStatus(`✓ ${data.name}`);
    return;
  }

  console.error("[Mika] Error guardando workflow:", data.message || res.statusText);
  flashStatus("✗ Error al guardar", false);
}

// Carpeta vacía = guardar en una carpeta LOCAL del navegador (útil en
// la nube, ej. Google Colab, donde el servidor no accede a tu disco).
// Usa la File System Access API; si el navegador no la soporta, baja
// el archivo como descarga.
async function sendSaveLocalFolder(mode) {
  syncWorkflowName();

  let workflow;
  try {
    workflow = app.graph.serialize();
  } catch (e) {
    console.error("[Mika] No se pudo serializar el workflow:", e);
    flashStatus("✗ Error serializando", false);
    return;
  }

  const baseName = (nameInput.value.trim() || "workflow").replace(/[\\/:*?"<>|]/g, "_");
  let fileName = `${baseName}.json`;

  if (typeof window.showDirectoryPicker === "function") {
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (e) {
      return; // el usuario canceló el selector
    }

    let exists = false;
    try {
      await dirHandle.getFileHandle(fileName, { create: false });
      exists = true;
    } catch (e) { /* no existe */ }

    if (exists && mode === "ask") {
      const overwrite = window.confirm(
        `Ya existe "${fileName}" en la carpeta elegida.\n\n` +
        `Aceptar = SOBREESCRIBIR\nCancelar = guardar como copia`
      );
      mode = overwrite ? "overwrite" : "copy";
    }

    if (mode === "copy") {
      let i = 1;
      while (true) {
        const candidate = `${baseName} (${i}).json`;
        try {
          await dirHandle.getFileHandle(candidate, { create: false });
          i += 1;
        } catch (e) {
          fileName = candidate;
          break;
        }
      }
    }

    try {
      const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(workflow, null, 2));
      await writable.close();
      console.log(`[Mika] Workflow guardado localmente: ${fileName}`);
      flashStatus(`✓ ${fileName}`);
    } catch (e) {
      console.error("[Mika] Error guardando en la carpeta local:", e);
      flashStatus("✗ Error al guardar", false);
    }
    return;
  }

  // Fallback: descarga del navegador (el navegador deduplica el nombre).
  try {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    flashStatus(`✓ ${fileName}`);
  } catch (e) {
    console.error("[Mika] Error descargando el workflow:", e);
    flashStatus("✗ Error al guardar", false);
  }
}

function ensurePanel() {
  if (panelEl) return;

  panelEl = document.createElement("div");
  panelEl.id = "mika-workflow-save-panel";
  Object.assign(panelEl.style, {
    position: "fixed",
    right: "16px",
    bottom: "110px", // justo encima del Mika - Timer
    width: "260px",
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
    alignItems: "center",
    gap: "6px",
  });

  const titleText = document.createElement("span");
  titleText.textContent = "💾 Mika - Workflow Save";
  titleText.style.fontSize = "13px";
  titleText.style.whiteSpace = "nowrap";

  statusEl = document.createElement("span");
  Object.assign(statusEl.style, {
    fontSize: "12px",
    display: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flex: "1",
    textAlign: "right",
  });

  const toggle = document.createElement("span");
  toggle.textContent = "+";
  toggle.style.cursor = "pointer";
  toggle.style.fontSize = "14px";

  header.appendChild(titleText);
  header.appendChild(statusEl);
  header.appendChild(toggle);

  let collapsed = true; // ← el panel arranca contraído por defecto

  const body = document.createElement("div");
  Object.assign(body.style, {
    padding: "6px 10px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  });

  const makeInput = (placeholder, value) => {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = value;
    Object.assign(input.style, {
      width: "100%",
      boxSizing: "border-box",
      background: "#1a1a1e",
      color: "#eee",
      border: "1px solid #444",
      borderRadius: "4px",
      padding: "4px 6px",
      font: "12px/1.4 monospace",
    });
    body.appendChild(input);
    return input;
  };

  let savedFolder = "workflows";
  try {
    savedFolder = localStorage.getItem(STORAGE_KEY_FOLDER) || "workflows";
  } catch (e) { /* no-op */ }

  folderInput = makeInput("Carpeta del servidor (vacío = carpeta local)", savedFolder);
  nameInput = makeInput("Nombre del workflow (vacío = nombre del workflow activo)", "");

  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, { display: "flex", gap: "6px" });

  const makeButton = (label, title, onClick) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title;
    Object.assign(btn.style, {
      flex: "1",
      background: "#2a2a30",
      color: "#eee",
      border: "1px solid #555",
      borderRadius: "4px",
      padding: "4px 0",
      cursor: "pointer",
      font: "12px/1.4 monospace",
    });
    btn.onclick = onClick;
    btnRow.appendChild(btn);
    return btn;
  };

  makeButton("💾 Guardar", "Guardar (pregunta si ya existe)", () => sendSave("ask"));
  makeButton("📄 Copia", "Guardar siempre como copia", () => sendSave("copy"));
  body.appendChild(btnRow);

  const btnNativeRow = document.createElement("div");
  Object.assign(btnNativeRow.style, { display: "flex", gap: "6px" });

  const makeNativeButton = (label, title, onClick) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title;
    Object.assign(btn.style, {
      flex: "1",
      background: "#2a2a30",
      color: "#eee",
      border: "1px solid #555",
      borderRadius: "4px",
      padding: "4px 0",
      cursor: "pointer",
      font: "12px/1.4 monospace",
    });
    btn.onclick = onClick;
    btnNativeRow.appendChild(btn);
    return btn;
  };

  makeNativeButton("☁️ Save", "Save nativo de ComfyUI (Ctrl+S)", nativeSave);
  makeNativeButton("☁️ Save As", "File > Save As de ComfyUI (Ctrl+Shift+S)", nativeSaveAs);
  body.appendChild(btnNativeRow);

  body.style.display = collapsed ? "none" : "flex";
  toggle.onclick = (e) => {
    e.stopPropagation();
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "flex";
    toggle.textContent = collapsed ? "+" : "–";
  };

  panelEl.appendChild(header);
  panelEl.appendChild(body);
  document.body.appendChild(panelEl);

  // Arrastrar el panel desde el header (igual que el Mika - Timer).
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

app.registerExtension({
  name: "Mika.WorkflowSave",

  async setup() {
    ensurePanel();
  },
});
