/**
 * Barra plegable de las opciones avanzadas del tangent afinado del
 * Custom Sampler Tangent-Mika.
 *
 * Los widgets marcados `advanced` en el nodo se pliegan bajo una barra
 * "▸/▾ ajustes avanzados (N)" que se abre y se cierra con clic. El estado
 * vive en `node.properties.mika_show_advanced` (se guarda en el workflow).
 * Un input cableado queda siempre visible.
 *
 * Adaptado de was-node-suite-comfyui/web/was_advanced_inputs.js (MIT,
 * (c) WASasquatch), apoyado en `interface/decoration.js` y
 * `interface/visibility.js`.
 */
import { app } from "/scripts/app.js";
import { addSectionHeader } from "./interface/decoration.js";
import { isWidgetWired, setWidgetHidden } from "./interface/visibility.js";

const EXT_NAME = "Mika.CustomSamplerTangent.AdvancedInputs";

// Solo nuestros nodos.
const OWNED = new Set(["CustomSamplerTangentMika"]);

const HEADER_NAME = "mika_advanced_header";
const OPEN_PROPERTY = "mika_show_advanced";

/**
 * Los nombres de los inputs marcados como avanzados, en orden de declaración.
 */
function advancedNames(nodeData) {
  const names = [];
  for (const group of ["required", "optional"]) {
    for (const [name, spec] of Object.entries(nodeData?.input?.[group] ?? {})) {
      if (Array.isArray(spec) && spec[1]?.advanced === true) names.push(name);
    }
  }
  return names;
}

/**
 * Los widgets dibujados para los inputs avanzados, con los controles que
 * viajan con ellos (p. ej. el combo de "control_after_generate").
 */
function advancedWidgets(node, names) {
  const found = [];
  for (const widget of node.widgets ?? []) {
    if (!names.has(widget.name)) continue;
    found.push([widget, widget]);
    for (const linked of widget.linkedWidgets ?? []) found.push([linked, widget]);
  }
  return found;
}

/**
 * Dibuja o pliega los widgets avanzados según el estado de la barra.
 * Un input cableado queda siempre dibujado.
 */
function fold(node, names) {
  const open = Boolean(node.properties?.[OPEN_PROPERTY]);
  let changed = false;
  for (const [widget, input] of advancedWidgets(node, names)) {
    // La barra manda, en cualquiera de los dos renderers.
    widget.advanced = false;
    if (widget.options) widget.options.advanced = false;
    const shown = open || isWidgetWired(input, node);
    if (setWidgetHidden(widget, !shown)) changed = true;
  }
  if (!changed) return;
  // Solo el alto se toma del tamaño recalculado.
  const computed = node.computeSize?.();
  if (computed) node.setSize([node.size[0], computed[1]]);
  node.graph?.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: EXT_NAME,

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!OWNED.has(String(nodeData?.name ?? ""))) return;
    const declared = advancedNames(nodeData);
    if (!declared.length) return;

    const proto = nodeType.prototype;
    // Los defs se registran de nuevo en un refresh: no envolver dos veces.
    if (proto.__mika_advanced_inputs_wrapped) return;
    proto.__mika_advanced_inputs_wrapped = true;
    const names = new Set(declared);

    const originalOnNodeCreated = proto.onNodeCreated;
    proto.onNodeCreated = function () {
      const result = originalOnNodeCreated?.apply(this, arguments);
      try {
        this.properties = this.properties ?? {};
        if (!(OPEN_PROPERTY in this.properties)) this.properties[OPEN_PROPERTY] = false;
        const first = (this.widgets ?? []).find((widget) => names.has(widget.name));
        if (first) {
          addSectionHeader(this, {
            name: HEADER_NAME,
            before: first.name,
            title: (node) => {
              const open = Boolean(node.properties?.[OPEN_PROPERTY]);
              return `${open ? "\u25be" : "\u25b8"} ajustes avanzados (${names.size})`;
            },
            onClick: (node) => {
              node.properties[OPEN_PROPERTY] = !node.properties[OPEN_PROPERTY];
              fold(node, names);
            },
          });
        }
        fold(this, names);
      } catch (error) {
        console.error(`[${EXT_NAME}] Failed to fold ${this.type}:`, error);
      }
      return result;
    };

    const originalOnConfigure = proto.onConfigure;
    proto.onConfigure = function () {
      const result = originalOnConfigure?.apply(this, arguments);
      try {
        fold(this, names);
      } catch (error) {
        console.error(`[${EXT_NAME}] Failed to fold ${this.type}:`, error);
      }
      return result;
    };

    const originalOnConnectionsChange = proto.onConnectionsChange;
    proto.onConnectionsChange = function () {
      const result = originalOnConnectionsChange?.apply(this, arguments);
      try {
        fold(this, names);
      } catch (error) {
        console.error(`[${EXT_NAME}] Failed to fold ${this.type}:`, error);
      }
      return result;
    };
  },
});
