// -----------------------------------------------------------------------
// Mika · slots fantasma compartidos (Excel, Organizer, …)
// -----------------------------------------------------------------------
// Los inputs con widget oculto (w.hidden = true) conservan y=0 y el
// frontend (arrange) les calcula una posición junto al borde superior
// del nodo, donde enganchan cables y resaltados sin función real.
//
// - parkGhostSlots(node): fija la y de esos widgets sobre un ancla
//   (el primer slot real; si no hay —nodos solo-edición— fuera de la
//   pantalla) y arrange los reubica solo cada frame. No toca links.
// - hookGhostSlotFilter(node): filtra las 5 vías de búsqueda para que
//   ni el hover ni el soltado caigan en fantasmas. Idempotente.
// - pruneWidgetlessInputs(node): elimina slots sin widget linkeado
//   (restos de definiciones viejas, ej. el `text` del Organizer v1).
//   Desconecta links muertos que el backend ya ignora.
// -----------------------------------------------------------------------

export function resolveWidget(node, slot) {
  try {
    if (!node || !slot || !slot.widget) return null;
    if (slot._widget && typeof slot._widget === "object") {
      return slot._widget;
    }
    const ref = slot.widget;
    const name = typeof ref === "string"
      ? ref
      : ref && typeof ref.name === "string" ? ref.name : null;
    if (!name) {
      return (typeof ref === "object" && ref) || null;
    }
    return node.widgets?.find((w) => w && w.name === name) ?? null;
  } catch (e) {
    return null;
  }
}

// Fantasma = slot con widget linkeado cuyo widget está oculto, o cuyo
// widget ya no existe. Los slots reales no tienen `widget`.
export function isGhostSlot(node, slot) {
  if (!slot || !slot.widget) return false;
  const w = resolveWidget(node, slot);
  if (!w) return true;
  return !!w.hidden;
}

export function parkGhostSlots(node) {
  try {
    if (!Array.isArray(node?.inputs)) return;
    // Ancla en locales: primer slot sin widget; sin ninguno, fuera de
    // la pantalla ([10,-1000]) para que ni se vea ni enganche.
    let anchor = null;
    for (let i = 0; i < node.inputs.length; i++) {
      const s = node.inputs[i];
      if (!s || s.widget) continue;
      try {
        const p = node.getInputPos(i);
        if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
          anchor = [p[0] - node.pos[0], p[1] - node.pos[1]];
        }
      } catch (e) { /* no-op */ }
      break;
    }
    if (!anchor) anchor = [10, -1000];
    // y tal que el slot caiga en el ancla (el layout suma medio slot).
    const anchorY = anchor[1] - anchor[0];
    for (const s of node.inputs) {
      if (!s || !s.widget) continue;
      const w = resolveWidget(node, s);
      if (!w) {
        // Huérfano: sin widget no hay y que fijar; pos directa.
        try { s.pos = [anchor[0], anchor[1]]; } catch (e) { /* no-op */ }
        continue;
      }
      if (!w.hidden) continue;
      try { w.y = anchorY; } catch (e) { /* no-op */ }
    }
    try { node.setDirtyCanvas(true, true); } catch (e) { /* no-op */ }
  } catch (e) { /* no-op */ }
}

export function pruneWidgetlessInputs(node) {
  try {
    if (!Array.isArray(node?.inputs)) return;
    for (let i = node.inputs.length - 1; i >= 0; i--) {
      const s = node.inputs[i];
      if (!s || s.widget) continue;
      try { node.removeInput(i); } catch (e) { /* no-op */ }
    }
  } catch (e) { /* no-op */ }
}

export function hookGhostSlotFilter(node) {
  if (!node || node._mikaGhostFilter) return;
  node._mikaGhostFilter = true;

  // Vía principal de conexión y resaltado del frontend actual.
  try {
    const prev = node.getInputOnPos;
    if (typeof prev === "function") {
      node.getInputOnPos = function (...args) {
        const hit = prev.apply(this, args);
        if (hit && isGhostSlot(this, hit)) return undefined;
        return hit;
      };
    }
  } catch (e) { /* no-op */ }

  // Vías internas (si existen en esta versión del frontend).
  for (const key of ["getNodeInputOnPos", "getNodeOutputOnPos"]) {
    try {
      const prev = node[key];
      if (typeof prev === "function") {
        node[key] = function (...args) {
          const hit = prev.apply(this, args);
          if (hit && isGhostSlot(this, hit)) return undefined;
          return hit;
        };
      }
    } catch (e) { /* no-op */ }
  }

  // Vía hover: devuelve el slot/input.
  try {
    const prev = node.getSlotOnPos;
    if (typeof prev === "function") {
      node.getSlotOnPos = function (...args) {
        const hit = prev.apply(this, args);
        if (
          hit && this.inputs && this.inputs.includes(hit) &&
          isGhostSlot(this, hit)
        ) {
          let out = null;
          try {
            out = typeof this.getOutputOnPos === "function"
              ? this.getOutputOnPos.apply(this, args)
              : null;
          } catch (e) { /* no-op */ }
          return out ?? null;
        }
        return hit;
      };
    }
  } catch (e) { /* no-op */ }

  // Vía conexión legacy: devuelve {input, slot, link_pos}.
  try {
    const prev = node.getSlotInPosition;
    if (typeof prev === "function") {
      node.getSlotInPosition = function (...args) {
        const hit = prev.apply(this, args);
        if (hit && hit.input && isGhostSlot(this, hit.input)) return null;
        return hit;
      };
    }
  } catch (e) { /* no-op */ }

  // Fallback de soltado sobre widget.
  try {
    const prev = node.getSlotFromWidget;
    if (typeof prev === "function") {
      node.getSlotFromWidget = function (widget, ...rest) {
        if (widget && widget.hidden) return undefined;
        const hit = prev.apply(this, [widget, ...rest]);
        if (hit && isGhostSlot(this, hit)) return undefined;
        return hit;
      };
    }
  } catch (e) { /* no-op */ }
}

export function hookGhostSlots(node) {
  hookGhostSlotFilter(node);
  parkGhostSlots(node);
}
