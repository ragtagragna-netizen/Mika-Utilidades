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

    function isGroupBypassed(graph, group) {
      const nodes = graph?._nodes || [];
      const inGroup = nodes.filter((n) => isNodeInGroup(n, group));
      if (inGroup.length === 0) return false;
      return inGroup.every((n) => n.mode === 4);
    }

    function setGroupBypass(graph, group, bypass) {
      const nodes = graph?._nodes || [];
      for (const n of nodes.filter((nd) => isNodeInGroup(nd, group))) {
        n.mode = bypass ? 4 : 0;
      }
      graph?.setDirtyCanvas(true, true);
    }

    function findGroupByTitle(graph, title) {
      return (graph?._groups || []).find(
        (g) => g.title?.toLowerCase() === title.toLowerCase()
      );
    }

    // ------------------------------------------------------------------
    // FIX CLAVE: encontrar el widget PROMOVIDO en el contenedor del
    // subgrafo (el nodo padre). Cuando un widget de nuestro nodo se
    // promociona al borde del subgrafo, ComfyUI crea una COPIA en el
    // subgraphNode (contenedor). Leemos el valor de esa copia.
    // ------------------------------------------------------------------
    function findPromotedWidgetInContainer(node, slotName) {
      // Buscar el contenedor del subgrafo: un nodo en app.graph
      // cuyo .subgraph sea el grafo donde vive nuestro nodo.
      const myGraph = node.graph;
      if (!myGraph || myGraph === app.graph) return null; // no estamos en subgrafo

      const container = (app.graph?.nodes || app.graph?._nodes || []).find(
        (n) => n.subgraph === myGraph || n._subgraph === myGraph
      );
      if (!container || !container.widgets) return null;

      // El widget copiado en el contenedor tiene el MISMO nombre
      // que el widget original dentro del subgrafo.
      return container.widgets.find((w) => w.name === slotName);
    }

    // ------------------------------------------------------------------
    // Ocultar widgets
    // ------------------------------------------------------------------
    function hideAllGroupWidgets(node) {
      for (let i = 1; i <= MAX_SLOTS; i++) {
        const w = node.widgets?.find((w) => w.name === `group_${i}`);
        if (w) w.hidden = true;
      }
    }

    // ------------------------------------------------------------------
    // Rebuild
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
        const bypassed = isGroupBypassed(graph, group);

        node._mikaGroupMapping.push({
          slot: slotName,
          groupTitle: group.title,
          _lastValue: bypassed,
        });

        const widget = node.widgets?.find((w) => w.name === slotName);
        if (widget) {
          widget.hidden = false;
          widget.label = group.title;
          widget.value = bypassed;
          widget.callback = (value) => {
            const g = findGroupByTitle(graph, group.title);
            if (g) {
              setGroupBypass(graph, g, value);
              const entry = node._mikaGroupMapping?.find((m) => m.slot === slotName);
              if (entry) entry._lastValue = value;
            }
          };
        }
      }

      const visibleCount = (node.widgets || []).filter((w) => !w.hidden).length;
      const h = Math.max(visibleCount * 20 + 6, 36);
      const w = Math.max(node.size?.[0] || 200, 200);
      node.setSize([w, h]);
      node.setDirtyCanvas(true, true);
      node._mikaLastSync = 0;
    }

    // ------------------------------------------------------------------
    // onNodeCreated
    // ------------------------------------------------------------------
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this._mikaGroupMapping = [];
      this._mikaLastSync = 0;

      const btn = this.addWidget("button", "Refresh", null, () => rebuild(this));
      btn.serialize = false;

      hideAllGroupWidgets(this);
      this.setSize([200, 40]);
      rebuild(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => rebuild(this), 50);
      return r;
    };

    // ------------------------------------------------------------------
    // onExecuted — fallback desde el backend
    // ------------------------------------------------------------------
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const bypassState = message?.bypass_state?.[0];
      if (!bypassState || typeof bypassState !== "object") return;

      const graph = getGraph(this);
      const mapping = this._mikaGroupMapping || [];

      for (const [slotName, shouldBypass] of Object.entries(bypassState)) {
        const entry = mapping.find((m) => m.slot === slotName);
        if (!entry) continue;
        const group = findGroupByTitle(graph, entry.groupTitle);
        if (!group) continue;

        const target = Boolean(shouldBypass);
        if (isGroupBypassed(graph, group) !== target) {
          setGroupBypass(graph, group, target);
        }
        entry._lastValue = target;
        const widget = this.widgets?.find((w) => w.name === slotName);
        if (widget) widget.value = target;
      }
    };

    // ------------------------------------------------------------------
    // onDrawForeground — polling con soporte para widget PROMOVIDO
    // ------------------------------------------------------------------
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;

      const now = Date.now();
      if (!this._mikaLastSync || now - this._mikaLastSync > 400) {
        this._mikaLastSync = now;

        const graph = getGraph(this);
        const groups = graph?._groups || [];
        const mapping = this._mikaGroupMapping || [];

        for (const entry of mapping) {
          const { slot, groupTitle } = entry;
          const group = groups.find((g) => g.title === groupTitle);
          if (!group) continue;

          const w = this.widgets?.find((w) => w.name === slot);
          const actualState = isGroupBypassed(graph, group);

          // FIX CLAVE: buscar el widget PROMOVIDO en el contenedor
          const promotedWidget = findPromotedWidgetInContainer(this, slot);

          if (promotedWidget) {
            // Hay widget promovido: el usuario lo controla desde fuera
            // del subgrafo. Leer su valor y aplicarlo al grupo.
            const externalValue = Boolean(promotedWidget.value);
            if (externalValue !== actualState) {
              setGroupBypass(graph, group, externalValue);
            }
            entry._lastValue = externalValue;
            if (w) w.value = externalValue;
          } else {
            // Sin widget promovido: polling bidireccional normal
            const prev = entry._lastValue;
            if (w && prev !== undefined && w.value !== prev && w.value !== actualState) {
              setGroupBypass(graph, group, w.value);
              entry._lastValue = w.value;
            } else if (w && w.value !== actualState) {
              w.value = actualState;
              entry._lastValue = actualState;
            }
          }
        }

        this.setDirtyCanvas(true, true);
      }

      return r;
    };
  },
});