import { app } from "/scripts/app.js";

const MAX_SLOTS = 20;

app.registerExtension({
  name: "Mika.FastGroupsBypasser",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "FastGroupsBypasserMika") return;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function isNodeInGroup(node, group) {
      if (!node?.pos || !node?.size || !group?.pos || !group?.size) return false;
      return (
        node.pos[0] >= group.pos[0] &&
        node.pos[1] >= group.pos[1] &&
        node.pos[0] + node.size[0] <= group.pos[0] + group.size[0] &&
        node.pos[1] + node.size[1] <= group.pos[1] + group.size[1]
      );
    }

    function getGraph(node) {
      return node.graph || app.graph;
    }

    function isGroupBypassed(node, group) {
      const graph = getGraph(node);
      const nodes = graph?._nodes || [];
      const inGroup = nodes.filter((n) => isNodeInGroup(n, group));
      if (inGroup.length === 0) return false;
      return inGroup.every((n) => n.mode === 4);
    }

    function setGroupBypass(node, group, bypass) {
      const graph = getGraph(node);
      const nodes = graph?._nodes || [];
      for (const n of nodes.filter((nd) => isNodeInGroup(nd, group))) {
        n.mode = bypass ? 4 : 0;
      }
      graph?.setDirtyCanvas(true, true);
    }

    function findGroupByTitle(node, title) {
      const graph = getGraph(node);
      return (graph?._groups || []).find(
        (g) => g.title?.toLowerCase() === title.toLowerCase()
      );
    }

    function isInputConnected(node, widgetName) {
      if (!node.inputs) return false;
      const idx = node.inputs.findIndex((i) => i.name === widgetName);
      if (idx < 0) return false;
      return node.isInputConnected(idx);
    }

    // ------------------------------------------------------------------
    // findContainerForGraph: dado un grafo (subgrafo), busca
    // recursivamente en app.graph el nodo contenedor cuya
    // propiedad .subgraph apunta a ese grafo.
    // API oficial: node.subgraph (no _subgraph).
    // ------------------------------------------------------------------
    function findContainerForGraph(targetGraph) {
      function walk(graph) {
        if (!graph) return null;
        for (const node of graph._nodes || graph.nodes || []) {
          // API oficial de ComfyUI: node.subgraph
          if (node.subgraph === targetGraph) return node;
          // Compatibilidad con versiones que usan _subgraph
          if (node._subgraph === targetGraph) return node;
          // Recursión para subgrafos anidados
          const inner = node.subgraph || node._subgraph;
          if (inner) {
            const found = walk(inner);
            if (found) return found;
          }
        }
        return null;
      }
      return walk(app.graph);
    }

    // ------------------------------------------------------------------
    // resolveValueFromLink: dado un linkId y un grafo, resuelve el
    // valor booleano siguiendo la cadena de links.
    // ------------------------------------------------------------------
    function resolveValueFromLink(linkId, graph, visited) {
      if (linkId == null || !graph) return undefined;
      if (!visited) visited = new Set();

      const link = graph.links?.[linkId];
      if (!link) return undefined;

      const originNode = graph.getNodeById?.(link.origin_id);
      if (!originNode) return undefined;

      // Evitar loops
      const key = `${graph.id ?? "?"}:${originNode.id}`;
      if (visited.has(key)) return undefined;
      visited.add(key);

      // --- PrimitiveNode: valor en widget[0] ---
      if (originNode.type === "PrimitiveNode") {
        const val = originNode.widgets?.[0]?.value;
        return val !== undefined ? Boolean(val) : undefined;
      }

      // --- Reroute: seguir el link de entrada ---
      if (originNode.type === "Reroute") {
        const inLink = originNode.inputs?.[0]?.link;
        if (inLink != null) {
          return resolveValueFromLink(inLink, graph, visited);
        }
        return undefined;
      }

      // --- Nodo con subgrafo (contenedor): descender al subgrafo interno ---
      const innerGraph = originNode.subgraph || originNode._subgraph;
      if (innerGraph) {
        // Buscar un SubgraphInput dentro del subgrafo que tenga
        // una propiedad que lo vincule al output slot del contenedor.
        for (const innerNode of innerGraph._nodes || innerGraph.nodes || []) {
          const sgIdx = innerNode.properties?.["subgraph_input_index"];
          if (sgIdx !== undefined && sgIdx !== null) {
            // Verificar que este SubgraphInput corresponde al output slot
            // que está conectado a nuestro link (origin_slot)
            // El SubgraphInput tiene un output que se conecta dentro del subgrafo.
            // No seguimos hacia adentro, sino que leemos el widget del contenedor.
            break;
          }
        }
        // Leer el widget promovido del contenedor, si existe
        if (originNode.widgets?.length > 0) {
          const val = originNode.widgets[0].value;
          return val !== undefined ? Boolean(val) : undefined;
        }
      }

      // --- Cualquier otro nodo: intentar leer widget ---
      if (originNode.widgets?.length > 0) {
        const val = originNode.widgets[0].value;
        return val !== undefined ? Boolean(val) : undefined;
      }

      return undefined;
    }

    // ------------------------------------------------------------------
    // resolveLinkedValue: resuelve el valor boolean de un input
    // conectado, atravesando fronteras de subgrafos.
    //
    // Estrategia (basada en la API real de ComfyUI docs.comfy.org):
    //
    //   1. Seguir el link en el grafo actual hasta el nodo origen.
    //   2. Si el origen es PrimitiveNode → leer su widget.
    //   3. Si el origen es Reroute → seguir su input.
    //   4. Si NO podemos obtener el valor del origen:
    //      a. Detectar si estamos en un subgrafo (buscando
    //         un contenedor en app.graph vía node.subgraph).
    //      b. Si estamos en subgrafo, encontrar el nodo contenedor.
    //      c. Buscar el input del contenedor que corresponde a
    //         nuestro input (por nombre o por SubgraphInput interno).
    //      d. Si ese input del contenedor tiene un link en el grafo
    //         padre, seguir ese link recursivamente.
    //      e. Si no tiene link, leer el widget promovido del contenedor.
    // ------------------------------------------------------------------
    function resolveLinkedValue(node, widgetName) {
      if (!node.inputs) return undefined;
      const idx = node.inputs.findIndex((i) => i.name === widgetName);
      if (idx < 0) return undefined;
      if (!node.isInputConnected(idx)) return undefined;

      const graph = getGraph(node);
      const linkId = node.inputs[idx].link;
      if (linkId == null) return undefined;

      // Intentar resolver directamente en el grafo actual
      const directValue = resolveValueFromLink(linkId, graph);
      if (directValue !== undefined) return directValue;

      // No se pudo resolver en el grafo actual.
      // Detectar si estamos dentro de un subgrafo.
      const container = findContainerForGraph(graph);
      if (!container) return undefined; // No estamos en subgrafo

      // Estamos en un subgrafo. El nodo origen de nuestro link
      // probablemente es un SubgraphInput. Necesitamos encontrar
      // qué input del contenedor corresponde.
      //
      // Estrategia: buscar en los inputs del contenedor cuál
      // tiene un link cuyo interior apunta a nuestro nodo.
      // Simplificación: buscar por nombre de widget promovido.

      // Método A: Buscar widget promovido en el contenedor con el
      // mismo nombre que nuestro input.
      const promotedWidget = container.widgets?.find(
        (w) => w.name === widgetName
      );
      if (promotedWidget) {
        return Boolean(promotedWidget.value ?? false);
      }

      // Método B: Seguir el link del input interno para encontrar
      // el SubgraphInput y usar su propiedad subgraph_input_index.
      const link = graph.links?.[linkId];
      if (link) {
        const originNode = graph.getNodeById?.(link.origin_id);
        if (originNode) {
          // El origen podría ser el SubgraphInput node.
          // Buscar la propiedad que lo vincula al input del contenedor.
          const sgIdx =
            originNode.properties?.["subgraph_input_index"] ??
            originNode.properties?.["input_index"] ??
            originNode.properties?.["index"];

          if (sgIdx !== undefined && sgIdx !== null) {
            // Encontrar el input correspondiente en el contenedor
            if (container.inputs?.[sgIdx]) {
              const containerInput = container.inputs[sgIdx];
              // Si el input del contenedor tiene un link externo,
              // seguir ese link en el grafo padre (app.graph o
              // el grafo donde vive el contenedor).
              if (containerInput.link != null) {
                const parentGraph = container.graph || app.graph;
                const parentValue = resolveValueFromLink(
                  containerInput.link,
                  parentGraph
                );
                if (parentValue !== undefined) return parentValue;
              }
              // Si no tiene link externo, el valor viene del widget
              // promovido del contenedor.
              if (container.widgets?.length > 0) {
                // Intentar encontrar el widget correcto por el nombre
                // del input del contenedor
                const inputName = containerInput.name;
                const wMatch = container.widgets.find(
                  (w) => w.name === inputName || w.label === inputName
                );
                if (wMatch) return Boolean(wMatch.value ?? false);
                // Fallback: primer widget
                return Boolean(container.widgets[0].value ?? false);
              }
            }
          }

          // Método C: Si no hay subgraph_input_index, intentar
          // mapear por posición. Buscar qué input del contenedor
          // está conectado internamente a este origen.
          // El contenedor tiene inputs que corresponden a los
          // SubgraphInput del grafo interno, en orden.
          if (container.inputs) {
            for (let ci = 0; ci < container.inputs.length; ci++) {
              const cInput = container.inputs[ci];
              if (cInput.link != null) {
                const parentGraph = container.graph || app.graph;
                const pVal = resolveValueFromLink(
                  cInput.link,
                  parentGraph
                );
                if (pVal !== undefined) {
                  // Verificar si este input del contenedor realmente
                  // corresponde a nuestro link interno. Podemos
                  // comprobar si el tipo coincide (BOOLEAN).
                  if (cInput.type === "BOOLEAN") {
                    return pVal;
                  }
                }
              }
            }
          }
        }
      }

      // Último recurso: leer widgets del contenedor
      if (container.widgets?.length > 0) {
        return Boolean(container.widgets[0].value ?? false);
      }

      return undefined;
    }

    // ------------------------------------------------------------------
    // Ocultar todos los widgets group_N
    // ------------------------------------------------------------------
    function hideAllGroupWidgets(node) {
      for (let i = 1; i <= MAX_SLOTS; i++) {
        const w = node.widgets?.find((w) => w.name === `group_${i}`);
        if (w) {
          w.hidden = true;
          w._mikaGroupToggle = false;
          w._mikaGroupTitle = null;
          w._mikaLastValue = undefined;
        }
      }
    }

    // ------------------------------------------------------------------
    // Reconstruir: mostrar solo los grupos detectados
    // ------------------------------------------------------------------
    function rebuild(node) {
      const graph = getGraph(node);
      const groups = graph?._groups || [];

      const filterW = node.widgets?.find((w) => w.name === "groups_filter");
      const filterText = (filterW?.value || "").toLowerCase().trim();
      const filters = filterText
        ? filterText.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

      const visibleGroups = groups.filter((g) => {
        if (!g?.title) return false;
        if (filters.length === 0) return true;
        const t = g.title.toLowerCase();
        return filters.some((f) => t.includes(f));
      });

      hideAllGroupWidgets(node);
      node._mikaGroupMapping = [];

      for (let i = 0; i < Math.min(visibleGroups.length, MAX_SLOTS); i++) {
        const group = visibleGroups[i];
        const slotName = `group_${i + 1}`;
        const bypassed = isGroupBypassed(node, group);

        node._mikaGroupMapping.push({
          slot: slotName,
          groupTitle: group.title,
        });

        const widget = node.widgets?.find((w) => w.name === slotName);
        if (widget) {
          widget.hidden = false;
          widget.label = group.title;
          widget.value = bypassed;
          widget._mikaGroupToggle = true;
          widget._mikaGroupTitle = group.title;
          widget._mikaLastValue = bypassed;
          widget.callback = (value) => {
            const g = findGroupByTitle(node, group.title);
            if (g) setGroupBypass(node, g, value);
          };
        }
      }

      // Forzar que el próximo poll en onDrawForeground corra inmediatamente
      node._mikaLastSync = 0;

      compactResize(node);
    }

    // ------------------------------------------------------------------
    // Compactar nodo
    // ------------------------------------------------------------------
    function compactResize(node) {
      const visibleCount = (node.widgets || []).filter((w) => !w.hidden).length;
      const h = Math.max(visibleCount * 20 + 6, 36);
      const w = Math.max(node.size?.[0] || 200, 200);
      node.setSize([w, h]);
      node.setDirtyCanvas(true, true);
    }

    // ------------------------------------------------------------------
    // onNodeCreated
    // ------------------------------------------------------------------
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this._mikaGroupMapping = [];
      const btn = this.addWidget("button", "Refresh", null, () => rebuild(this));
      btn.serialize = false;
      hideAllGroupWidgets(this);
      this.setSize([200, 40]);
      rebuild(this);
      return r;
    };

    // ------------------------------------------------------------------
    // onConfigure
    // ------------------------------------------------------------------
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => rebuild(this), 50);
      return r;
    };

    // ------------------------------------------------------------------
    // onExecuted: aplicar bypass desde el backend (fallback post-ejecución)
    // ------------------------------------------------------------------
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);

      const bypassState = message?.bypass_state?.[0];
      if (bypassState && typeof bypassState === "object") {
        const mapping = this._mikaGroupMapping || [];
        for (const [slotName, shouldBypass] of Object.entries(bypassState)) {
          const entry = mapping.find((m) => m.slot === slotName);
          if (entry) {
            const group = findGroupByTitle(this, entry.groupTitle);
            if (group) {
              setGroupBypass(this, group, Boolean(shouldBypass));
            }
          }
        }
      }
    };

    // ------------------------------------------------------------------
    // onDrawForeground: sincronización activa cada 400ms
    //
    // CAMBIO CLAVE vs versión original:
    //   - Input NO conectado → el widget controla el grupo
    //   - Input SÍ conectado → se resuelve el valor real del link
    //     (atravesando subgrafos) y se aplica el bypass activamente.
    //     onExecuted sigue como fallback post-ejecución.
    // ------------------------------------------------------------------
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;

      const now = Date.now();
      if (!this._mikaLastSync || now - this._mikaLastSync > 400) {
        this._mikaLastSync = now;

        const graph = getGraph(this);
        const groups = graph?._groups || [];

        for (const w of this.widgets || []) {
          if (!w._mikaGroupToggle || !w._mikaGroupTitle) continue;

          const group = groups.find((g) => g.title === w._mikaGroupTitle);
          if (!group) continue;

          const inputConnected = isInputConnected(this, w.name);

          if (inputConnected) {
            // --- Input conectado ---
            const resolvedValue = resolveLinkedValue(this, w.name);

            if (resolvedValue !== undefined) {
              const currentState = isGroupBypassed(this, group);
              if (currentState !== resolvedValue) {
                setGroupBypass(this, group, resolvedValue);
              }
              if (w.value !== resolvedValue) {
                w.value = resolvedValue;
              }
            } else {
              // No se pudo resolver: reflejar estado actual
              const actualState = isGroupBypassed(this, group);
              if (w.value !== actualState) {
                w.value = actualState;
              }
            }

            w.disabled = true;
          } else {
            // --- Input NO conectado ---
            const actualState = isGroupBypassed(this, group);

            // Detectar si el usuario toggeló el widget comparando
            // con el valor del poll anterior. Si cambió, aplicar bypass.
            // Esto es un fallback por si widget.callback no dispara.
            if (
              w._mikaLastValue !== undefined &&
              w.value !== w._mikaLastValue
            ) {
              // El widget cambió desde el último poll → aplicar
              setGroupBypass(this, group, w.value);
            } else if (w.value !== actualState) {
              // El grupo cambió externamente → sincronizar widget
              w.value = actualState;
            }
            w._mikaLastValue = w.value;
            w.disabled = false;
          }
        }

        this.setDirtyCanvas(true, true);
      }

      return r;
    };
  },
});
