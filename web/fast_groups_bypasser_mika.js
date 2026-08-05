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
    // Ocultar todos los widgets group_N
    // ------------------------------------------------------------------
    function hideAllGroupWidgets(node) {
      for (let i = 1; i <= MAX_SLOTS; i++) {
        const w = node.widgets?.find((w) => w.name === `group_${i}`);
        if (w) {
          w.hidden = true;
          w._mikaGroupToggle = false;
          w._mikaGroupTitle = null;
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

      // 1. Ocultar todos los widgets group_N
      hideAllGroupWidgets(node);

      // 2. Guardar el mapeo grupo -> slot en el nodo
      node._mikaGroupMapping = [];

      // 3. Mostrar y configurar solo los widgets necesarios
      for (let i = 0; i < Math.min(visibleGroups.length, MAX_SLOTS); i++) {
        const group = visibleGroups[i];
        const slotName = `group_${i + 1}`;
        const bypassed = isGroupBypassed(node, group);

        // Guardar mapeo para usar en onExecuted
        node._mikaGroupMapping.push({
          slot: slotName,
          groupTitle: group.title,
        });

        // Configurar el widget existente (definido en Python)
        const widget = node.widgets?.find((w) => w.name === slotName);
        if (widget) {
          widget.hidden = false;
          widget.label = group.title;
          widget.value = bypassed;
          widget._mikaGroupToggle = true;
          widget._mikaGroupTitle = group.title;
          widget.callback = (value) => {
            const g = findGroupByTitle(node, group.title);
            if (g) setGroupBypass(node, g, value);
          };
        }
      }

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

      // Ocultar todos los group_N al inicio
      hideAllGroupWidgets(this);

      this.setSize([200, 40]);
      rebuild(this);
      return r;
    };

    // ------------------------------------------------------------------
    // onConfigure: reconstruir al cargar workflow
    // ------------------------------------------------------------------
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => rebuild(this), 50);
      return r;
    };

    // ------------------------------------------------------------------
    // onExecuted: aplicar bypass usando el MAPEO GUARDADO
    // ------------------------------------------------------------------
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);

      const bypassState = message?.bypass_state?.[0];
      if (!bypassState || typeof bypassState !== "object") return;

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
    };

    // ------------------------------------------------------------------
    // onDrawForeground: sincronización robusta cada 400ms.
    // Esta es la lógica principal que garantiza el bypass, incluso
    // cuando el BOOLEAN viene conectado desde fuera del subgrafo.
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

          const actualState = isGroupBypassed(this, group);
          const inputConnected = isInputConnected(this, w.name);

          if (inputConnected) {
            // BOOLEAN conectado: el valor del widget (actualizado por ComfyUI
            // con el valor del input) tiene prioridad. Si el widget dice algo
            // diferente al estado real del grupo, aplicar el valor del widget.
            if (w.value !== actualState) {
              setGroupBypass(this, group, w.value);
            }
          } else {
            // Sin BOOLEAN conectado: el estado real del grupo tiene prioridad.
            // Actualizar el widget para que lo refleje.
            if (w.value !== actualState) {
              w.value = actualState;
            }
          }
        }

        this.setDirtyCanvas(true, true);
      }

      return r;
    };
  },
});