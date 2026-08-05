import { app } from "/scripts/app.js";

const MAX_SLOTS = 20;

app.registerExtension({
  name: "Mika.FastGroupsMuter",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "FastGroupsMuterMika") return;

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

    // MUTE = mode 2 (Never)
    function isGroupMuted(graph, group) {
      const nodes = graph?._nodes || [];
      const inGroup = nodes.filter((n) => isNodeInGroup(n, group));
      if (inGroup.length === 0) return false;
      return inGroup.every((n) => n.mode === 2);
    }

    function setGroupMute(graph, group, mute) {
      const nodes = graph?._nodes || [];
      for (const n of nodes.filter((nd) => isNodeInGroup(nd, group))) {
        n.mode = mute ? 2 : 0;
      }
      graph?.setDirtyCanvas(true, true);
    }

    function findGroupByTitle(graph, title) {
      return (graph?._groups || []).find(
        (g) => g.title?.toLowerCase() === title.toLowerCase()
      );
    }

    // Buscar widget PROMOVIDO en el contenedor del subgrafo
    function findPromotedWidgetInContainer(node, slotName) {
      const myGraph = node.graph;
      if (!myGraph || myGraph === app.graph) return null;

      const container = (app.graph?.nodes || app.graph?._nodes || []).find(
        (n) => n.subgraph === myGraph || n._subgraph === myGraph
      );
      if (!container || !container.widgets) return null;

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
      node._mikaMuteMapping = [];

      for (let i = 0; i < Math.min(visibleGroups.length, MAX_SLOTS); i++) {
        const group = visibleGroups[i];
        const slotName = `group_${i + 1}`;
        const muted = isGroupMuted(graph, group);

        node._mikaMuteMapping.push({
          slot: slotName,
          groupTitle: group.title,
          _lastValue: muted,
        });

        const widget = node.widgets?.find((w) => w.name === slotName);
        if (widget) {
          widget.hidden = false;
          widget.label = group.title;
          widget.value = muted;
          widget.callback = (value) => {
            const g = findGroupByTitle(graph, group.title);
            if (g) {
              setGroupMute(graph, g, value);
              const entry = node._mikaMuteMapping?.find((m) => m.slot === slotName);
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
      this._mikaMuteMapping = [];
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
      const muteState = message?.mute_state?.[0];
      if (!muteState || typeof muteState !== "object") return;

      const graph = getGraph(this);
      const mapping = this._mikaMuteMapping || [];

      for (const [slotName, shouldMute] of Object.entries(muteState)) {
        const entry = mapping.find((m) => m.slot === slotName);
        if (!entry) continue;
        const group = findGroupByTitle(graph, entry.groupTitle);
        if (!group) continue;

        const target = Boolean(shouldMute);
        if (isGroupMuted(graph, group) !== target) {
          setGroupMute(graph, group, target);
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
        const mapping = this._mikaMuteMapping || [];

        for (const entry of mapping) {
          const { slot, groupTitle } = entry;
          const group = groups.find((g) => g.title === groupTitle);
          if (!group) continue;

          const w = this.widgets?.find((w) => w.name === slot);
          const actualState = isGroupMuted(graph, group);

          // Buscar widget PROMOVIDO en el contenedor del subgrafo
          const promotedWidget = findPromotedWidgetInContainer(this, slot);

          if (promotedWidget) {
            const externalValue = Boolean(promotedWidget.value);
            if (externalValue !== actualState) {
              setGroupMute(graph, group, externalValue);
            }
            entry._lastValue = externalValue;
            if (w) w.value = externalValue;
          } else {
            const prev = entry._lastValue;
            if (w && prev !== undefined && w.value !== prev && w.value !== actualState) {
              setGroupMute(graph, group, w.value);
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