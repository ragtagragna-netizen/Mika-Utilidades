// Motor de bypass/mute para los nodos Fast Groups/Fast Nodes-Mika.
// Diseño estilo "Bypass Nodes w Groups by ID" de TrixNodes, minimalista:
//   - Cada controlador es independiente: no hay registro compartido ni modos
//     originales. La última acción explícita gana y el display sigue a la
//     realidad. Por construcción es imposible que peleen entre ellos.
//   - Solo se escribe por acción explícita (click en el toggle o cambio en un
//     control externo promovido/linkeado). El timer solo lee (display).
//   - OFF explícito = todo a activo (uniforme, como rgthree): sale del
//     bypass/mute aunque el off lo hubiera impuesto un actor externo.
//   - Los grupos se resuelven por ID estable (+ fallback a título) y los
//     miembros en vivo; los subgrafos se expanden al forzar.
import { app } from "/scripts/app.js";

export function getInnerGraph(n) {
  if (!n) return null;
  if (n.subgraph) return n.subgraph;
  if (n._subgraph) return n._subgraph;
  if (typeof n.getInnerGraph === "function") {
    try {
      return n.getInnerGraph();
    } catch (e) {
      return null;
    }
  }
  return null;
}

export function getGroupMembers(group) {
  if (!group) return [];
  try {
    if (group.recomputeInsideNodes) group.recomputeInsideNodes();
  } catch (e) {}
  // API moderna (ComfyUI frontend / @comfyorg/litegraph): `children` es un
  // Set con nodos Y subgrupos anidados, mantenido por recomputeInsideNodes.
  // Se aceptan además los formatos legacy (_children como Set o Array,
  // _nodes, nodes) para compatibilidad.
  let pool = null;
  if (group.children instanceof Set) pool = Array.from(group.children);
  else if (group._children instanceof Set) pool = Array.from(group._children);
  else if (Array.isArray(group._children)) pool = group._children;
  else if (Array.isArray(group._nodes)) pool = group._nodes;
  else if (Array.isArray(group.nodes)) pool = group.nodes;
  else pool = [];
  return pool.filter(isGraphNode);
}

// Nodos de verdad (excluye subgrupos anidados y objetos raros). Los grupos
// no tienen `mode`; los nodos siempre.
function isGraphNode(c) {
  if (!c) return false;
  try {
    if (typeof LGraphNode !== "undefined" && c instanceof LGraphNode) return true;
  } catch (e) {}
  return c.mode !== undefined && !!c.pos && !!c.size;
}

// Últimos nodos forzados por cada controlador (runtime): sirve para limpiar
// los que dejan de ser objetivo (sale del grupo / se desconecta).
const lastForced = new Map(); // controller -> Set<LGraphNode>

function expandMembers(members) {
  const seen = new Set();
  const out = [];
  const walk = (n) => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
    const inner = getInnerGraph(n);
    if (inner) {
      for (const c of inner._nodes || inner.nodes || []) walk(c);
    }
  };
  for (const m of members || []) walk(m);
  return out;
}

function setMode(n, mode, graph) {
  if (!n || n.mode === mode) return;
  n.mode = mode;
  graph?.setDirtyCanvas?.(true, true);
}

// Fuerza `offMode` sobre los targets activos (expandiendo subgrafos).
// `targets`: array de { n: LGraphNode, active: boolean }.
// Lo que este controlador forzaba y ya no es objetivo vuelve a activo.
export function enforceModes(controller, targets, offMode) {
  if (!controller) return;
  const graph = controller.graph || app.graph;
  const want = new Set();
  for (const t of targets || []) {
    if (t && t.active && t.n) {
      for (const n of expandMembers([t.n])) want.add(n);
    }
  }
  const prev = lastForced.get(controller) || new Set();
  for (const n of prev) {
    if (!want.has(n)) setMode(n, 0, graph);
  }
  for (const n of want) setMode(n, offMode, graph);
  lastForced.set(controller, want);
}

// OFF explícito: los miembros dados a activo. Solo ellos: los que sigan
// forzados por otras entradas se conservan intactos en lastForced.
export function releaseActive(controller, members) {
  if (!controller) return;
  const graph = controller.graph || app.graph;
  const all = new Set(expandMembers(members));
  const prev = lastForced.get(controller) || new Set();
  const kept = new Set();
  for (const n of prev) {
    if (!all.has(n)) kept.add(n);
  }
  for (const n of all) setMode(n, 0, graph);
  lastForced.set(controller, kept);
  graph?.setDirtyCanvas?.(true, true);
}

// Al eliminar el nodo se suelta el control SIN tocar los modos: lo bypassado
// queda bypassado (el estado ya es de los nodos del canvas).
export function forgetController(controller) {
  if (!controller) return;
  lastForced.delete(controller);
}
