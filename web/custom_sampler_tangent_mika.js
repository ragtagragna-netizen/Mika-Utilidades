/**
 * Barra plegable de las opciones avanzadas del tangent afinado del
 * Custom Sampler Tangent-Mika.
 *
 * Los widgets marcados `advanced` en el nodo se pliegan bajo una barra
 * "▸/▾ ajustes avanzados (N)" que se abre y se cierra con clic. El estado
 * vive en `node.properties.mika_show_advanced` (se guarda en el workflow).
 * Un input cableado queda siempre visible.
 *
 * El combo `preset` escribe los 7 valores de la curva al elegir uno; si se
 * toca un ajuste a mano, el combo pasa a "personalizado".
 *
 * Adaptado de was-node-suite-comfyui/web/was_advanced_inputs.js (MIT,
 * (c) WASasquatch), apoyado en `interface/decoration.js` y
 * `interface/visibility.js`.
 */
import { app } from "/scripts/app.js";
import { addSectionHeader } from "./interface/decoration.js";
import { isWidgetWired, setWidgetHidden } from "./interface/visibility.js";

const EXT_NAME = "Mika.CustomSamplerTangent.AdvancedInputs";

// Solo nuestros nodos: el Tangent y el Scheduler (misma barra de ajustes).
const OWNED = new Set(["CustomSamplerTangentMika", "CustomSamplerSchedulerMika"]);

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

// Presets rápidos de la curva: los mismos valores que _MIKA_TANGENT_PRESETS
// en nodes.py. El preset se elige en el combo junto a la barra de ajustes.
const CURVE_KEYS = ["start", "middle", "end", "pivot_1", "pivot_2", "slope_1", "slope_2"];
const PRESET_WIDGET = "preset";
const PRESETS = {
  estable: { start: 1.0, middle: 0.50, end: 0.0, pivot_1: 0.50, pivot_2: 0.50, slope_1: 0.05, slope_2: 0.05 },
  medio: { start: 1.0, middle: 0.55, end: 0.0, pivot_1: 0.50, pivot_2: 0.50, slope_1: 0.07, slope_2: 0.05 },
  "más tags": { start: 1.0, middle: 0.58, end: 0.0, pivot_1: 0.50, pivot_2: 0.50, slope_1: 0.07, slope_2: 0.05 },
  original: { start: 1.0, middle: 0.50, end: 0.0, pivot_1: 0.60, pivot_2: 0.60, slope_1: 0.20, slope_2: 0.20 },
  // Meseta del shifted_tangent con refino suave (carácter artístico estable).
  artístico: { start: 1.0, middle: 0.50, end: 0.0, pivot_1: 0.60, pivot_2: 0.50, slope_1: 0.20, slope_2: 0.05 },
  // Bong simulado con la curva del modelo (shift 3 de Anima): imita al
  // bong raw con error ~0.01 sigmas, de 12 a 50 pasos.
  "bong (simulado)": { start: 1.0, middle: 0.22, end: 0.0, pivot_1: 0.65, pivot_2: 0.55, slope_1: 0.10, slope_2: 0.20 },
};

function widgetNamed(node, name) {
  return (node.widgets ?? []).find((widget) => widget.name === name);
}

/** Escribe los 7 valores del preset en los widgets (sin disparar callbacks). */
function applyPreset(node, name) {
  const values = PRESETS[name];
  if (!values) return;
  for (const key of CURVE_KEYS) {
    const widget = widgetNamed(node, key);
    // Un input cableado manda: su valor viene de Sigma Curve-Mika.
    if (!widget || isWidgetWired(widget, node)) continue;
    widget.value = values[key];
  }
  node.setDirtyCanvas?.(true, true);
}

/** Un ajuste manual deja el combo en "personalizado" (sin disparar callbacks). */
function markPersonalizado(node) {
  const widget = widgetNamed(node, PRESET_WIDGET);
  if (widget && widget.value !== "personalizado") {
    widget.value = "personalizado";
    node.setDirtyCanvas?.(true, true);
  }
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
        const node = this;
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

        // Combo de presets: escribe la curva y vuelve a "personalizado" si
        // el usuario toca un ajuste a mano.
        const preset = widgetNamed(node, PRESET_WIDGET);
        if (preset) {
          const originalPresetCb = preset.callback;
          preset.callback = function (value) {
            originalPresetCb?.apply(this, arguments);
            applyPreset(node, value);
          };
        }
        for (const key of CURVE_KEYS) {
          const widget = widgetNamed(node, key);
          if (!widget) continue;
          const originalCb = widget.callback;
          widget.callback = function (value) {
            originalCb?.apply(this, arguments);
            markPersonalizado(node);
          };
        }
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
