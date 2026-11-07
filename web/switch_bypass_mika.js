import { app } from "/scripts/app.js";

// Switch Bypass-Mika: inputs dinámicos (como SwitchMika) + detección de
// bypass del nodo origen de cada input (como BypassDetectorMika). El
// estado se escribe en los widgets ocultos bypass_i para que el backend
// pueda leerlo al ejecutarse.

const BYPASS_MODE = 4;
const MUTE_MODE = 2;
const TICK_MS = 400;

app.registerExtension({
    name: "Mika.SwitchBypass",

    async nodeCreated(node) {
        if (node.comfyClass !== "SwitchBypassMika") return;

        const cleanName = (v) => String(v ?? "").trim();

        // --- Inputs dinámicos según number_of_inputs ---
        const updateInputs = () => {
            const initialWidth = node.size[0];
            const numInputsWidget = node.widgets.find(w => w.name === "number_of_inputs");
            if (!numInputsWidget) return;

            const numInputs = numInputsWidget.value;
            if (!node.inputs) node.inputs = [];

            // Limpiar cualquier slot sin nombre que no sea input_N (p.ej.
            // restos del renderizado inicial del frontend). Los links del
            // grafo apuntan por ÍNDICE de slot (target_slot), así que al
            // quitar un slot hay que reindexar los links posteriores o las
            // conexiones se pierden al recargar el workflow.
            const removedIdx = [];
            node.inputs = node.inputs.filter((inp, idx) => {
                const named = inp != null && inp.name != null && /^input_\d+$/.test(inp.name);
                const keep = named || inp?.link != null;
                if (!keep) removedIdx.push(idx);
                return keep;
            });
            if (removedIdx.length) {
                const graph = node.graph || app.graph;
                for (const l of Object.values(graph?.links || {})) {
                    if (!l || l.target_id !== node.id) continue;
                    const shift = removedIdx.filter(r => r < l.target_slot).length;
                    if (shift) l.target_slot -= shift;
                }
            }

            const existingInputs = node.inputs;

            if (existingInputs.length < numInputs) {
                for (let i = existingInputs.length + 1; i <= numInputs; i++) {
                    const inputName = `input_${i}`;
                    if (!node.inputs.find(i2 => i2.name === inputName)) {
                        node.addInput(inputName, "*");
                    }
                }
            } else {
                node.inputs = node.inputs.filter(
                    i => !i.name.startsWith("input_") ||
                        parseInt(i.name.split("_")[1]) <= numInputs
                );
            }

            node.setSize(node.computeSize());
            node.size[0] = initialWidth; // ancho fijo
        };

        const numInputsWidget = node.widgets.find(w => w.name === "number_of_inputs");
        if (numInputsWidget) {
            node.widgets = [numInputsWidget, ...node.widgets.filter(w => w !== numInputsWidget)];
            numInputsWidget.callback = () => {
                updateInputs();
                app.graph.setDirtyCanvas(true);
            };
        }

        // Ocultar los widgets bypass_i (solo los escribe el tick).
        for (const w of node.widgets ?? []) {
            if (/^bypass_\d+$/.test(cleanName(w.name))) w.hidden = true;
        }

        // --- Detección de bypass ---
        function getLinkedSourceNode(input) {
            if (!input || input.link == null) return null;
            const graph = node.graph || app.graph;
            if (!graph) return null;

            let linkId = input.link;
            let depth = 0;
            while (linkId != null && depth < 8) {
                const link = graph.links?.[linkId];
                if (!link) return null;
                const src = graph.getNodeById(link.origin_id);
                if (!src) return null;
                if (src.type === "Reroute") {
                    linkId = src.inputs?.[0]?.link;
                    depth++;
                    continue;
                }
                return src;
            }
            return null;
        }

        // Contenedor cuyo grafo interior es targetGraph (búsqueda recursiva).
        function getInnerGraph(n) {
            if (!n) return null;
            return n.subgraph || n._subgraph || null;
        }

        function findContainerOf(targetGraph) {
            function search(graph, depth = 0) {
                if (!graph || depth > 8) return null;
                for (const n of graph._nodes || graph.nodes || []) {
                    if (getInnerGraph(n) === targetGraph) return n;
                    const inner = getInnerGraph(n);
                    if (inner) {
                        const found = search(inner, depth + 1);
                        if (found) return found;
                    }
                }
                return null;
            }
            return search(app.graph, 0);
        }

        // Bypass si el nodo o cualquier subgrafo ancestro está en bypass o
        // muteado (un bypass manual de subgrafo no propaga el modo).
        function isBypassed(n) {
            if (!n) return false;
            if (n.mode === BYPASS_MODE || n.mode === MUTE_MODE) return true;

            const visited = new Set();
            let g = n.graph || n._graph || null;
            while (g && !visited.has(g)) {
                visited.add(g);
                if (g === app.graph) break;
                const container = findContainerOf(g);
                if (!container) break;
                if (container.mode === BYPASS_MODE || container.mode === MUTE_MODE) return true;
                g = container.graph || container._graph || null;
            }
            return false;
        }

        function syncBypass() {
            for (let i = 1; ; i++) {
                const widget = node.widgets?.find(w => cleanName(w.name) === `bypass_${i}`);
                if (!widget) break;

                const input = node.inputs?.find(inp => cleanName(inp.name) === `input_${i}`);
                const src = getLinkedSourceNode(input);
                const bypassed = src ? isBypassed(src) : false;

                if (widget.value !== bypassed) {
                    widget.value = bypassed;
                    if (typeof widget.callback === "function") widget.callback(bypassed);
                }
            }
            node.setDirtyCanvas?.(true, true);
        }

        node._mikaBypassInterval = setInterval(() => {
            try { syncBypass(); } catch (e) {}
        }, TICK_MS);

        const prevRemove = node.onRemoved;
        node.onRemoved = function () {
            if (node._mikaBypassInterval) {
                clearInterval(node._mikaBypassInterval);
                node._mikaBypassInterval = null;
            }
            if (typeof prevRemove === "function") prevRemove.apply(this, arguments);
        };

        setTimeout(updateInputs, 0);
        setTimeout(syncBypass, 0);
    },
});
