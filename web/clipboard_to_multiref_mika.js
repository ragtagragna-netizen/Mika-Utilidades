import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// -----------------------------------------------------------------------
// Mika · Clipboard to MultiRef-Mika
// -----------------------------------------------------------------------
// Botón "📋 PEGAR DEL PORTAPAPELES": sube la imagen del portapapeles a
// input/ y la manda a la ranura elegida del nodo "Academia SD Multi Image
// Reference" cuyo título coincida con el widget target_node_title (mismo
// convenio de búsqueda que usan Multi Image Reference Out e Image Save &
// Send de academiasd).
// -----------------------------------------------------------------------

const MULTIREF_TYPE = "AcademiaSD_MultiImageReference";
const FEEDBACK_MS = 1200;

function findTargets(node) {
  const title = String(node.widgets?.find((w) => w.name === "target_node_title")?.value ?? "").trim();
  const targets = (app.graph?._nodes ?? []).filter(
    (n) => n.type === MULTIREF_TYPE && String(n.title ?? "").trim() === title
  );
  return { title, targets };
}

async function readClipboardImage() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    throw new Error("Este navegador no permite leer imágenes del portapapeles. Usá el botón de subir del propio nodo.");
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = (item.types ?? []).find((t) => t.startsWith("image/"));
    if (type) {
      const blob = await item.getType(type);
      return { blob, ext: type.split("/")[1]?.replace("jpeg", "jpg") || "png" };
    }
  }
  throw new Error("El portapapeles no tiene ninguna imagen.");
}

async function uploadImage(blob, ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const file = new File([blob], `mika_paste_${stamp}.${ext}`, { type: blob.type || `image/${ext}` });
  const body = new FormData();
  body.append("image", file);
  body.append("type", "input");
  body.append("overwrite", "false");
  const res = await api.fetchApi("/upload/image", { method: "POST", body });
  if (!res.ok) throw new Error(`Error al subir (${res.status})`);
  const data = await res.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

async function runPaste(node, button) {
  const original = button.name;
  const flash = (text) => {
    button.name = text;
    app.graph?.setDirtyCanvas?.(true, true);
    setTimeout(() => {
      button.name = original;
      app.graph?.setDirtyCanvas?.(true, true);
    }, FEEDBACK_MS);
  };

  try {
    const { title, targets } = findTargets(node);
    if (!title || targets.length === 0) {
      const available = [...new Set(
        (app.graph?._nodes ?? []).filter((n) => n.type === MULTIREF_TYPE).map((n) => n.title)
      )];
      alert(
        `[Mika] ⚠️ No hay ningún "Academia SD Multi Image Reference" titulado "${title || "(vacío)"}".\n` +
        `Renombrá el nodo destino o ajustá target_node_title.` +
        (available.length ? `\nDisponibles: ${available.join(", ")}` : "")
      );
      return;
    }
    if (targets.length > 1) {
      alert(`[Mika] ⚠️ Hay ${targets.length} nodos titulados "${title}". Ponele un título único a cada uno.`);
      return;
    }
    const target = targets[0];
    if (typeof target.asdReceiveImage !== "function") {
      alert(`[Mika] ⚠️ El nodo "${title}" no sabe recibir imágenes. Actualizá el paquete academiasd.`);
      return;
    }

    button.name = "⏳ PORTAPAPELES…";
    app.graph?.setDirtyCanvas?.(true, true);
    const { blob, ext } = await readClipboardImage();

    button.name = "⏳ SUBIENDO…";
    app.graph?.setDirtyCanvas?.(true, true);
    const file = await uploadImage(blob, ext);

    const slotWidget = node.widgets?.find((w) => w.name === "slot");
    const match = /image_(\d+)/.exec(String(slotWidget?.value ?? "image_1"));
    const slotIndex = Math.max(1, parseInt(match?.[1] ?? "1", 10)) - 1;

    if (target.asdReceiveImage(file, slotIndex)) {
      target.setDirtyCanvas?.(true, true);
      app.graph?.setDirtyCanvas?.(true, true);
      flash("✅ ¡ENVIADA!");
    } else {
      flash("❌ RECHAZADA");
    }
  } catch (e) {
    console.error("Mika:", e);
    flash("❌ ERROR");
  }
}

app.registerExtension({
  name: "Mika.ClipboardToMultiRefMika",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "ClipboardToMultiRefMika") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const button = this.addWidget("button", "📋 PEGAR DEL PORTAPAPELES", null, () => {
        runPaste(this, button);
      });
      button.serialize = false;
      return r;
    };

    const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_graph, options) {
      const r = origGetExtraMenuOptions ? origGetExtraMenuOptions.apply(this, arguments) : undefined;
      if (Array.isArray(options)) {
        options.push(null);
        options.push({
          content: "📋 Pegar del portapapeles",
          callback: () => runPaste(this, { name: "", }),
        });
      }
      return r;
    };
  },
});
