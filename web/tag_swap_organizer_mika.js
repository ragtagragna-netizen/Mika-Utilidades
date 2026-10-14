import { app } from "/scripts/app.js";
import { hookGhostSlots, pruneWidgetlessInputs } from "./mika_ghost_slots.js";

// -----------------------------------------------------------------------
// Mika · Tag Editor-Mika (solo edición, sin entradas ni salidas)
// -----------------------------------------------------------------------
// Toda la configuración vive en el nodo y se edita en la ventana
// flotante del botón "Configurar": destino (título del nodo) +
// sensible a mayúsculas + 3 listas (reemplazar / eliminar / añadir).
// Los widgets (target_title, datos, case_sensitive) quedan ocultos: el
// nodo muestra solo botones de acción, uno por entrada, con el cambio
// en el nombre ("red shirt → red shorts", "− blue jeans", "+ hat").
// El destino se detecta por título y se muestra su ID (vital si hay
// repetidos). Aplica SOLO la entrada pulsada, sin cables ni cola.
// -----------------------------------------------------------------------

function escReg(s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Limpia comas/espacios de los BORDES ("hat," → "hat"): evita ",,"
// cuando el usuario escribe tags con su coma colgante. El interior se
// respeta ("x, y" sigue siendo multi-tag).
function cleanTag(s) {
  return String(s ?? "").replace(/^[\s,]+|[\s,]+$/g, "");
}

function shortLabel(s, max) {
  s = String(s ?? "").trim().replace(/\s+/g, " ");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Si una entrada produjo el mismo tag simple en varios segmentos,
// deja solo la primera aparición ("standing, running" → "walking"
// da "walking, park", no "walking, park, walking").
function collapseReplacement(text, replacement, caseSensitive) {
  const rep = String(replacement ?? "").trim();
  if (!rep || rep.includes(",")) return text;
  const cmp = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  const target = cmp(rep);
  let kept = false;
  const out = [];
  for (const p of String(text).split(",")) {
    if (cmp(p.trim()) === target) {
      if (kept) continue;
      kept = true;
    }
    out.push(p);
  }
  return out.join(",");
}

function swapTags(text, pairs, caseSensitive) {
  let out = text == null ? "" : String(text);
  const alts = [];
  for (const [findRaw, repRaw] of pairs) {
    const rep = repRaw == null ? "" : cleanTag(repRaw);
    if (findRaw == null) continue;
    for (const alt of String(findRaw).split(",")) {
      const t = alt.trim();
      if (t) alts.push([t, rep]);
    }
  }
  // Estable: a igual largo respeta el orden de los pares.
  alts.sort((a, b) => b[0].length - a[0].length);

  const flags = caseSensitive ? "g" : "gi";
  let removedAny = false;
  for (const [alt, rep] of alts) {
    const next = out.replace(new RegExp(escReg(alt), flags), rep);
    if (next !== out) {
      out = next;
      if (!rep) removedAny = true;
    }
  }

  if (removedAny) {
    out = out.split(",").map((p) => p.trim()).filter((p) => p !== "").join(", ");
  }

  return out;
}

function normalizeConfig(raw) {
  const cfg = { target: "", case_sensitive: false, replaces: [], removes: [], adds: [] };
  try {
    const d = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
    if (!d || typeof d !== "object") return cfg;
    if (typeof d.target === "string") cfg.target = d.target;
    cfg.case_sensitive = d.case_sensitive === true;
    for (const item of d.replaces ?? []) {
      if (item && typeof item === "object") {
        cfg.replaces.push({
          find: String(item.find ?? "").trim(),
          replace: item.replace == null ? "" : cleanTag(item.replace),
        });
      }
    }
    for (const key of ["removes", "adds"]) {
      for (const tag of d[key] ?? []) {
        const t = tag == null ? "" : cleanTag(tag);
        if (t) cfg[key].push(t);
      }
    }
  } catch (e) { /* JSON roto: config vacía */ }
  return cfg;
}

function scalarWidget(node, name, defVal) {
  const w = node.widgets?.find((x) => x && x.name === name);
  let v = w ? w.value : defVal;
  if (Array.isArray(v)) v = v.length > 0 ? v[0] : defVal;
  return v == null ? defVal : v;
}

function coerceBool(v) {
  if (typeof v === "string") {
    return ["true", "1", "yes", "on", "sí", "si"].includes(v.trim().toLowerCase());
  }
  return !!v;
}

function readConfig(node) {
  const cfg = normalizeConfig(scalarWidget(node, "datos", ""));
  // Fallback a los widgets espejo (workflows viejos / datos vacío).
  if (!cfg.target) {
    cfg.target = String(scalarWidget(node, "target_title", "") ?? "");
  }
  if (!cfg.case_sensitive) {
    cfg.case_sensitive = coerceBool(scalarWidget(node, "case_sensitive", false));
  }
  return cfg;
}

function writeConfig(node, cfg) {
  const w = node.widgets?.find((x) => x && x.name === "datos");
  if (!w) return false;
  w.value = JSON.stringify(cfg);
  try {
    w.callback?.(w.value, app.canvas, node);
  } catch (e) { /* no-op */ }
  try {
    node.onWidgetChanged?.(w.name, w.value, w.value, w);
  } catch (e) { /* no-op */ }
  // Espejos ocultos (compat + inspección): mismo valor, sin duplicar
  // fuente (la fuente es `datos`).
  try {
    const wt = node.widgets?.find((x) => x && x.name === "target_title");
    if (wt) wt.value = cfg.target;
  } catch (e) { /* no-op */ }
  try {
    const wc = node.widgets?.find((x) => x && x.name === "case_sensitive");
    if (wc) wc.value = !!cfg.case_sensitive;
  } catch (e) { /* no-op */ }
  return true;
}

function applySwapConfig(text, cfg, caseSensitive) {
  const pairs = cfg.replaces.map((p) => [p.find, p.replace]);
  for (const tag of cfg.removes) pairs.push([tag, ""]);
  let out = swapTags(text, pairs, caseSensitive);
  const adds = cfg.adds.map((a) => cleanTag(a)).filter((a) => a !== "");
  if (adds.length) {
    const present = new Set(
      out.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "")
    );
    const missing = adds.filter((a) => !present.has(a.toLowerCase()));
    if (missing.length) {
      // Coma solo al final (estilo con coma colgante): recorta las
      // comas/espacios colgantes para no duplicar ",," y cierra con una.
      const base = out.replace(/[\s,]+$/, "");
      const combined = base ? base + ", " + missing.join(", ") : missing.join(", ");
      out = combined + ",";
    }
  }
  return out;
}

function findTargets(node, title) {
  const t = title != null ? String(title).trim() : String(scalarWidget(node, "target_title", "") ?? "").trim();
  if (!t) return { title: "", targets: [] };
  const targets = (app.graph?._nodes ?? []).filter(
    (n) => String(n.title ?? "").trim() === t
  );
  return { title: t, targets };
}

function targetTextWidget(target) {
  const ws = target.widgets ?? [];
  return (
    ws.find((w) => w && w.name === "editable_text_widget") ??
    ws.find((w) => w && (w.type === "customtext" || w.type === "STRING" || w.type === "text")) ??
    null
  );
}

function widgetTextarea(widget) {
  if (!widget) return null;
  if (widget.inputEl instanceof HTMLElement) return widget.inputEl;
  if (widget.element instanceof HTMLElement) {
    if (widget.element.tagName === "TEXTAREA") return widget.element;
    return widget.element.querySelector("textarea");
  }
  return null;
}

function currentTargetText(target) {
  const widget = targetTextWidget(target);
  if (!widget) return null;
  const v = widget.value ?? widgetTextarea(widget)?.value ?? "";
  return Array.isArray(v) ? (v[0] ?? "") : String(v ?? "");
}

function setTargetText(target, next) {
  const widget = targetTextWidget(target);
  if (!widget) return false;
  widget.value = next;
  const ta = widgetTextarea(widget);
  if (ta && ta.tagName === "TEXTAREA") {
    ta.value = next;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  }
  try {
    widget.callback?.(next, target.graph?.canvas ?? app.canvas, target);
  } catch (e) { /* no-op */ }
  try {
    target.setDirtyCanvas(true, true);
  } catch (e) { /* no-op */ }
  return true;
}

function entryLabel(entry) {
  if (entry.kind === "replace") {
    if (!entry.replace || !String(entry.replace).trim()) {
      return `− ${shortLabel(entry.find, 40)}`;
    }
    return `${shortLabel(entry.find, 22)} → ${shortLabel(entry.replace, 22)}`;
  }
  if (entry.kind === "remove") {
    return `− ${shortLabel(entry.tag, 40)}`;
  }
  return `+ ${shortLabel(entry.tag, 40)}`;
}

function collectEntries(cfg) {
  const entries = [];
  for (const p of cfg.replaces) {
    if (!p.find || !String(p.find).trim()) continue;
    entries.push({ kind: "replace", find: p.find, replace: p.replace, label: "" });
  }
  for (const tag of cfg.removes) {
    entries.push({ kind: "remove", tag, label: "" });
  }
  for (const tag of cfg.adds) {
    entries.push({ kind: "add", tag, label: "" });
  }
  for (const e of entries) e.label = entryLabel(e);
  return entries;
}

function applyEntry(node, entry, btn) {
  const cfg = readConfig(node);
  const { title, targets } = findTargets(node, cfg.target);
  if (!title || targets.length === 0) {
    // Sin destino no hay nada que hacer: abrir la config en vez de
    // fallar en silencio (el título debe coincidir exacto).
    console.warn("[Mika] Tag Editor: destino sin configurar o sin coincidencia; abro Configurar.");
    try { openSwapModal(node); } catch (e) { /* no-op */ }
    return;
  }
  const target = targets[0];
  if (targets.length > 1) {
    console.warn(
      `[Mika] Tag Editor: ${targets.length} nodos titulados "${title}" ` +
      `(IDs ${targets.map((n) => n.id).join(", ")}), uso el primero [ID ${target.id}].`
    );
  }
  const current = currentTargetText(target);
  if (current == null) {
    console.warn(`[Mika] Tag Editor: "${title}" [ID ${target.id}] no tiene caja de texto.`);
    return;
  }
  let next = current;
  if (entry.kind === "replace") {
    next = swapTags(current, [[entry.find, entry.replace]], cfg.case_sensitive);
    // Varios tags del find que caen al mismo reemplazo colapsan en uno
    // solo ("standing, running" → "walking" da uno, no dos).
    if (next !== current) {
      next = collapseReplacement(next, cleanTag(entry.replace), cfg.case_sensitive);
    }
  } else if (entry.kind === "remove") {
    next = swapTags(current, [[entry.tag, ""]], cfg.case_sensitive);
  } else if (entry.kind === "add") {
    next = applySwapConfig(
      current,
      { replaces: [], removes: [], adds: [entry.tag] },
      cfg.case_sensitive
    );
  }
  if (setTargetText(target, next)) {
    console.log(`[Mika] Tag Editor: "${entry.label}" aplicado en "${title}" [ID ${target.id}].`);
    flashButton(node, btn, next !== current);
  }
}

// Parpadeo corto en el botón: ✓ aplicado, = sin cambios (ya estaba
// o sin coincidencia). Sin setSize para no mover el layout.
function flashButton(node, btn, changed) {
  if (!btn) return;
  let orig = null;
  try { orig = btn.name; } catch (e) { return; }
  try {
    btn.name = (changed ? "✓ " : "= ") + orig;
    node.setDirtyCanvas(true, true);
  } catch (e) { /* no-op */ }
  setTimeout(() => {
    try {
      if ((node.widgets ?? []).includes(btn)) {
        btn.name = orig;
        node.setDirtyCanvas(true, true);
      }
    } catch (e) { /* no-op */ }
  }, 900);
}

function hideConfigWidgets(node) {
  for (const key of ["target_title", "datos", "case_sensitive"]) {
    const w = node.widgets?.find((x) => x && x.name === key);
    if (w) {
      try { w.hidden = true; } catch (e) { /* no-op */ }
      // Cero impacto en el layout (como Excel): si no, arrange suma su
      // altura y cualquier resize manual "rebota" más alto (tamaño roto).
      try { w.computeSize = () => [0, 0]; } catch (e) { /* no-op */ }
      try { w.h = 0; } catch (e) { /* no-op */ }
    }
  }
}

function rebuildButtons(node) {
  hideConfigWidgets(node);
  // Sin slots fantasma: los widgets ocultos + restos de definiciones
  // viejas (ej. el slot `text` v1) enganchaban cables sin función.
  try { pruneWidgetlessInputs(node); } catch (e) { /* no-op */ }
  try { hookGhostSlots(node); } catch (e) { /* no-op */ } // filtro + aparca
  try {
    for (const b of node._mikaSwapButtons ?? []) {
      try {
        if (typeof node.removeWidget === "function") node.removeWidget(b);
        else {
          const i = (node.widgets ?? []).indexOf(b);
          if (i >= 0) node.widgets.splice(i, 1);
        }
      } catch (e) { /* no-op */ }
    }
  } catch (e) { /* no-op */ }
  node._mikaSwapButtons = [];

  const cfg = readConfig(node);
  for (const entry of collectEntries(cfg)) {
    try {
      const btn = node.addWidget("button", entry.label, null, () => applyEntry(node, entry, btn));
      if (btn) node._mikaSwapButtons.push(btn);
    } catch (e) { /* no-op */ }
  }
  // Configurar siempre último.
  try {
    const old = node._mikaSwapConfigBtn;
    if (old) {
      if (typeof node.removeWidget === "function") node.removeWidget(old);
      else {
        const i = (node.widgets ?? []).indexOf(old);
        if (i >= 0) node.widgets.splice(i, 1);
      }
    }
  } catch (e) { /* no-op */ }
  try {
    node._mikaSwapConfigBtn =
      node.addWidget("button", "⚙ Configurar", null, () => openSwapModal(node));
  } catch (e) { /* no-op */ }

  // Tamaño: alto fórmula siempre (el contenido son botones fijos:
  // otra altura es franja gris o recorte). El computeSize base incluye
  // la franja y el resize manual rebotaba a ese mínimo "roto": se
  // declara la fórmula como piso para un arrastre libre y estable.
  // Ancho con piso chico (140: entra el botón Configurar) para resize
  // manual libre; de fábrica sale en 240.
  const nBtnF = (node._mikaSwapButtons?.length ?? 0) +
    (node._mikaSwapConfigBtn ? 1 : 0);
  const fH = 2 + Math.max(1, nBtnF) * 24 + 8;
  try {
    node.computeSize = function () { return [140, fH]; };
  } catch (e) { /* no-op */ }

  try {
    const w = Math.max(
      Number.isFinite(node.size?.[0]) ? node.size[0] : 0,
      140
    );
    node.setSize([w, fH]);
  } catch (e) { /* no-op */ }
  try {
    node.setDirtyCanvas(true, true);
  } catch (e) { /* no-op */ }
}

// -----------------------------------------------------------------------
// Ventana flotante de configuración
// -----------------------------------------------------------------------
let swapModal = null;

function closeSwapModal() {
  if (!swapModal) return;
  try { swapModal.overlay.remove(); } catch (e) { /* no-op */ }
  swapModal = null;
}

function modalInput(placeholder) {
  const el = document.createElement("input");
  el.type = "text";
  el.placeholder = placeholder;
  el.style.cssText =
    "flex:1 1 0%;min-width:0;background:#222;color:#eee;border:1px solid #444;" +
    "border-radius:4px;font:12px sans-serif;padding:4px 6px;outline:none;box-sizing:border-box;";
  return el;
}

function modalRow(placeholderA, placeholderB) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;margin-bottom:6px;align-items:center;";
  const a = modalInput(placeholderA);
  row.appendChild(a);
  let b = null;
  if (placeholderB !== null) {
    b = modalInput(placeholderB);
    row.appendChild(b);
  }
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "✖";
  del.title = "Quitar fila";
  del.style.cssText =
    "flex:0 0 auto;background:#3a2222;color:#f88;border:1px solid #644;" +
    "border-radius:4px;font:12px sans-serif;padding:4px 8px;cursor:pointer;";
  row.appendChild(del);
  return { row, a, b, del };
}

function modalSection(titleText, hint) {
  const sec = document.createElement("div");
  sec.style.marginBottom = "12px";
  const h = document.createElement("div");
  h.style.cssText = "font:600 12px sans-serif;color:#ccc;margin-bottom:2px;";
  h.textContent = titleText;
  sec.appendChild(h);
  if (hint) {
    const p = document.createElement("div");
    p.style.cssText = "font:11px sans-serif;color:#888;margin-bottom:6px;";
    p.textContent = hint;
    sec.appendChild(p);
  }
  const list = document.createElement("div");
  sec.appendChild(list);
  const add = document.createElement("button");
  add.type = "button";
  add.style.cssText =
    "background:#22303a;color:#8cf;border:1px solid #345;border-radius:4px;" +
    "font:12px sans-serif;padding:4px 10px;cursor:pointer;margin-top:2px;";
  sec.appendChild(add);
  return { sec, list, add };
}

function refreshTargetStatus(node, targetInput, statusEl) {
  const { title, targets } = findTargets(node, targetInput.value);
  let html = "";
  let color = "#888";
  if (!title) {
    html = "Escribí el título del nodo destino.";
  } else if (targets.length === 0) {
    color = "#f88";
    html = `⚠ Sin coincidencia para "${title}".`;
  } else if (targets.length === 1) {
    const t = targets[0];
    const preview = shortLabel(currentTargetText(t) ?? "", 90);
    color = "#8f8";
    html = `✓ ${title} [ID ${t.id}] (${t.type})` + (preview ? ` — "${preview}"` : "");
  } else {
    color = "#fc6";
    html = `⚠ ${targets.length} nodos titulados "${title}": ` +
      targets.map((n) => `[ID ${n.id}]`).join(" ") +
      " — se usa el primero.";
  }
  statusEl.textContent = html;
  statusEl.style.color = color;
}

function openSwapModal(node) {
  closeSwapModal();
  const cfg = readConfig(node);
  // Copia de trabajo: Cancelar no toca el nodo.
  const work = JSON.parse(JSON.stringify(cfg));

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10000;" +
    "display:flex;align-items:center;justify-content:center;";
  const box = document.createElement("div");
  box.style.cssText =
    "background:#1b1e24;color:#e6edf3;border:1px solid #444;border-radius:8px;" +
    "padding:14px;width:min(480px,90vw);max-height:76vh;overflow-y:auto;" +
    "box-shadow:0 8px 32px rgba(0,0,0,0.6);box-sizing:border-box;";
  const title = document.createElement("div");
  title.style.cssText = "font:600 14px sans-serif;margin-bottom:10px;cursor:move;user-select:none;";
  title.textContent = "Tag Editor — Configurar";
  box.appendChild(title);
  overlay.appendChild(box);

  // Destino + case (antes widgets del nodo).
  const destSec = document.createElement("div");
  destSec.style.marginBottom = "12px";
  const destLabel = document.createElement("div");
  destLabel.style.cssText = "font:600 12px sans-serif;color:#ccc;margin-bottom:6px;";
  destLabel.textContent = "Nodo destino";
  destSec.appendChild(destLabel);
  const targetInput = modalInput("título del nodo (ej. MiPrompt)");
  targetInput.value = work.target || "";
  targetInput.style.marginBottom = "6px";
  destSec.appendChild(targetInput);
  const caseWrap = document.createElement("label");
  caseWrap.style.cssText = "display:flex;gap:6px;align-items:center;font:12px sans-serif;color:#ccc;margin-bottom:6px;cursor:pointer;";
  const caseBox = document.createElement("input");
  caseBox.type = "checkbox";
  caseBox.checked = !!work.case_sensitive;
  caseWrap.appendChild(caseBox);
  caseWrap.appendChild(document.createTextNode("Sensible a mayúsculas"));
  destSec.appendChild(caseWrap);
  const statusEl = document.createElement("div");
  statusEl.style.cssText = "font:11px sans-serif;min-height:14px;";
  destSec.appendChild(statusEl);
  box.appendChild(destSec);

  const grab = { rows: [], removes: [], adds: [] };

  function bindPairRow(list, pair) {
    const { row, a, b, del } = modalRow("buscar: red shirt, blue jeans", "reemplazo (vacío = quitar)");
    a.value = pair.find;
    b.value = pair.replace;
    const rec = { pair, a, b, row };
    grab.rows.push(rec);
    del.onclick = () => {
      const i = grab.rows.indexOf(rec);
      if (i >= 0) grab.rows.splice(i, 1);
      row.remove();
    };
    list.appendChild(row);
  }

  function bindTagRow(list, kind, value) {
    const { row, a, del } = modalRow("tag", null);
    a.value = value;
    const rec = { a, row };
    grab[kind].push(rec);
    del.onclick = () => {
      const g = grab[kind];
      const i = g.indexOf(rec);
      if (i >= 0) g.splice(i, 1);
      row.remove();
    };
    list.appendChild(row);
  }

  const sRep = modalSection("Reemplazar", "find admite varios tags por coma; cada uno se cambia donde esté.");
  sRep.add.textContent = "+ Añadir reemplazo";
  sRep.add.onclick = () => bindPairRow(sRep.list, { find: "", replace: "" });
  for (const p of work.replaces) bindPairRow(sRep.list, p);
  box.appendChild(sRep.sec);

  const sDel = modalSection("Eliminar", "Se quitan del prompt y se limpian las comas.");
  sDel.add.textContent = "+ Añadir tag a eliminar";
  sDel.add.onclick = () => bindTagRow(sDel.list, "removes", "");
  for (const t of work.removes) bindTagRow(sDel.list, "removes", t);
  box.appendChild(sDel.sec);

  const sAdd = modalSection("Añadir", "Se agregan al final si aún no están.");
  sAdd.add.textContent = "+ Añadir tag a agregar";
  sAdd.add.onclick = () => bindTagRow(sAdd.list, "adds", "");
  for (const t of work.adds) bindTagRow(sAdd.list, "adds", t);
  box.appendChild(sAdd.sec);

  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:10px;";
  const btnCancel = document.createElement("button");
  btnCancel.type = "button";
  btnCancel.textContent = "Cancelar";
  btnCancel.style.cssText =
    "background:#2a2a2a;color:#ccc;border:1px solid #444;border-radius:4px;" +
    "font:12px sans-serif;padding:6px 14px;cursor:pointer;";
  const btnSave = document.createElement("button");
  btnSave.type = "button";
  btnSave.textContent = "Guardar";
  btnSave.style.cssText =
    "background:#1f6feb;color:#fff;border:1px solid #388bfd;border-radius:4px;" +
    "font:12px sans-serif;padding:6px 14px;cursor:pointer;";
  foot.appendChild(btnCancel);
  foot.appendChild(btnSave);
  box.appendChild(foot);

  const refresh = () => refreshTargetStatus(node, targetInput, statusEl);
  targetInput.addEventListener("input", refresh);
  refresh();

  btnCancel.onclick = () => closeSwapModal();
  btnSave.onclick = () => {
    const next = {
      target: targetInput.value.trim(),
      case_sensitive: !!caseBox.checked,
      replaces: [],
      removes: [],
      adds: [],
    };
    for (const r of grab.rows) {
      next.replaces.push({ find: r.a.value, replace: r.b.value });
    }
    for (const r of grab.removes) next.removes.push(r.a.value);
    for (const r of grab.adds) next.adds.push(r.a.value);
    // Normaliza (tira vacíos) igual que el backend.
    const clean = normalizeConfig(JSON.stringify(next));
    if (writeConfig(node, clean)) {
      rebuildButtons(node);
    }
    closeSwapModal();
  };
  overlay.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  overlay.addEventListener("mousedown", (ev) => ev.stopPropagation());
  // Las teclas se quedan en el modal: sin esto el canvas borra nodos
  // con Supr/Retroceso mientras se escribe en un campo.
  overlay.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeSwapModal();
    ev.stopPropagation();
  });

  // Arrastre por el título.
  try {
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    title.addEventListener("pointerdown", (ev) => {
      drag = true;
      sx = ev.clientX; sy = ev.clientY;
      const r = box.getBoundingClientRect();
      ox = r.left; oy = r.top;
      box.style.position = "fixed";
      box.style.left = ox + "px";
      box.style.top = oy + "px";
      box.style.margin = "0";
      try { title.setPointerCapture(ev.pointerId); } catch (e) { /* no-op */ }
      ev.preventDefault();
    });
    title.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      box.style.left = ox + ev.clientX - sx + "px";
      box.style.top = oy + ev.clientY - sy + "px";
    });
    title.addEventListener("pointerup", () => { drag = false; });
  } catch (e) { /* sin arrastre */ }

  document.body.appendChild(overlay);
  swapModal = { overlay, node };
  try {
    targetInput.focus();
  } catch (e) { /* no-op */ }
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && swapModal) closeSwapModal();
});

app.registerExtension({
  name: "Mika.TagSwapOrganizer",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "TagSwapOrganizerMika") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      // Fábrica: ancho compacto (mockup #11); después manda el usuario.
      rebuildButtons(this);
      try { this.setSize([240, this.size[1]]); } catch (e) { /* no-op */ }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => {
        try { rebuildButtons(this); } catch (e) { /* no-op */ }
      }, 0);
      return r;
    };
  },
});
