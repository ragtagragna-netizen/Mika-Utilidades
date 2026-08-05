import { app } from "/scripts/app.js";

const MAX_SLOTS = 20;
const MODE_OFF = 4; // BYPASS
const MODE_ON = 0;  // ALWAYS

app.registerExtension({
  name: "Mika.FastBypasser",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "FastBypasserMika") return;

    // ------------------------------------------------------------------
    // Forzar aceptar cualquier conexion en nuestros inputs *
    // ------------------------------------------------------------------
    const origOnConnectInput = nodeType.prototype.onConnectInput;
    nodeType.prototype.onConnectInput = function (
      inputIndex,
      outputType,
      outputSlot,
      outputNode,
      outputIndex
    ) {
      return true;
    };

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function getGraph(node) {
      return node.graph || app.graph;
    }

    function getLink(graph, linkId) {
      if (linkId == null || !graph) return null;
      return (
        graph.links?.[linkId] ??
        (graph.links instanceof Map ? graph.links.get(linkId) : null)
      );
    }

    function getConnectedNode(myNode, inputIndex) {
      const graph = getGraph(myNode);
      const input = myNode.inputs?.[inputIndex];
      if (!input?.link) return null;
      const link = getLink(graph, input.link);
      if (!link) return null;
      return graph.getNodeById?.(link.origin_id) || null;
    }

    function setNodeMode(node, mode) {
      node.mode = mode;
      getGraph(node)?.setDirtyCanvas(true, true);
    }

    // ------------------------------------------------------------------
    // Persistencia del mapeo targetNodeId por input name
    // ------------------------------------------------------------------
    function saveMapping(node) {
      const saved = {};
      for (const entry of node._mikaMapping || []) {
        const name = node.inputs?.[entry.inputIndex]?.name;
        if (name) saved[name] = entry.targetNodeId;
      }
      node.properties["_mika_target_map"] = saved;
    }

    function loadMapping(node) {
      return node.properties?.["_mika_target_map"] || {};
    }

    function getNextSlotName(node) {
      const used = new Set((node.inputs || []).map((i) => i.name));
      for (let i = 1; i <= MAX_SLOTS; i++) {
        if (!used.has(`node_${i}`)) return `node_${i}`;
      }
      return null;
    }

    // ------------------------------------------------------------------
    // Estabilizar inputs (estilo rgthree)
    // ------------------------------------------------------------------
    function stabilizeInputs(node) {
      if (!node.graph) return;
      let changed = false;
      const inputs = node.inputs || [];

      // Remover inputs vacios excepto el ultimo
      for (let i = inputs.length - 2; i >= 0; i--) {
        if (!inputs[i]?.link) {
          node.removeInput(i);
          changed = true;
        }
      }

      // Asegurar un input vacio al final
      const last = (node.inputs || [])[(node.inputs || []).length - 1];
      if (!last || last.link != null) {
        const name = getNextSlotName(node);
        if (name) {
          node.addInput(name, "*");
          changed = true;
        }
      }

      // Actualizar labels de inputs conectados
      for (let i = 0; i < (node.inputs || []).length; i++) {
        const input = node.inputs[i];
        if (input?.link) {
          const conn = getConnectedNode(node, i);
          if (conn) input.label = conn.title || input.name;
        }
      }

      if (changed) rebuildWidgets(node);
    }

    // ------------------------------------------------------------------
    // Reconstruir widgets (toggles)
    // ------------------------------------------------------------------
    function rebuildWidgets(node) {
      const toRemove = (node.widgets || []).filter((w) => w._mikaToggle);
      for (const w of toRemove) node.removeWidget(w);

      node._mikaMapping = [];
      const saved = loadMapping(node);
      const graph = getGraph(node);

      for (let i = 0; i < (node.inputs || []).length; i++) {
        const input = node.inputs[i];
        if (!input?.link) continue;

        const conn = getConnectedNode(node, i);
        if (!conn) continue;

        const isSG =
          conn.type === "SubgraphInput" ||
          conn.properties?.["subgraph_input_index"] != null;

        let tid, target;
        if (isSG && saved[input.name]) {
          tid = saved[input.name];
          target = graph.getNodeById?.(tid);
        } else {
          tid = conn.id;
          target = conn;
        }

        if (!target) continue;

        // FIX: value = true significa "enabled" (mode 0)
        const isEnabled = target.mode === MODE_ON;
        const w = node.addWidget(
          "toggle",
          `Enable ${target.title}`,
          isEnabled
        );
        w._mikaToggle = true;
        w._mikaInputIndex = i;
        w._mikaTargetNodeId = tid;

        const _tid = tid;
        w.callback = (val) => {
          const t = getGraph(node).getNodeById?.(_tid);
          if (t) setNodeMode(t, val ? MODE_ON : MODE_OFF);
        };

        node._mikaMapping.push({
          inputIndex: i,
          targetNodeId: tid,
          widget: w,
        });
      }

      saveMapping(node);
      resizeNode(node);
    }

    // ------------------------------------------------------------------
    // Resize
    // ------------------------------------------------------------------
    function resizeNode(node) {
      const vis = (node.widgets || []).filter((w) => !w.hidden);
      const collapsed = node.properties?.["_mika_collapse"];
      const inputCount = (node.inputs || []).length;
      const slotH = collapsed ? 0 : inputCount * 20;
      const h = Math.max(vis.length * 20 + slotH + 6, 36);
      const w = Math.max(node.size?.[0] || 200, 200);
      node.setSize([w, h]);
      node.setDirtyCanvas(true, true);
    }

    // ------------------------------------------------------------------
    // onNodeCreated
    // ------------------------------------------------------------------
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origCreated?.apply(this, arguments);

      this._mikaMapping = [];
      this.properties["_mika_collapse"] = false;

      // Limpiar inputs pre-asignados y empezar con uno vacio
      while (this.inputs.length > 0) this.removeInput(0);
      this.addInput("node_1", "*");

      // Boton collapse: oculta los SLOTS de entrada, no los toggles
      const collapseBtn = this.addWidget(
        "button",
        "\u25BC Slots",
        null,
        () => {
          this.properties["_mika_collapse"] = !this.properties["_mika_collapse"];
          collapseBtn.label = this.properties["_mika_collapse"]
            ? "\u25BA Slots"
            : "\u25BC Slots";
          resizeNode(this);
        }
      );
      collapseBtn.serialize = false;

      this.setSize([200, 40]);
      setTimeout(() => stabilizeInputs(this), 100);
      return r;
    };

    // ------------------------------------------------------------------
    // onConfigure
    // ------------------------------------------------------------------
    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = origConfigure?.apply(this, arguments);
      setTimeout(() => stabilizeInputs(this), 100);
      return r;
    };

    // ------------------------------------------------------------------
    // onConnectionsChange
    // ------------------------------------------------------------------
    const origConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (
      type,
      index,
      connected,
      linkInfo,
      ioSlot
    ) {
      origConn?.apply(this, arguments);
      if (!linkInfo) return;
      setTimeout(() => stabilizeInputs(this), 10);
    };

    // ------------------------------------------------------------------
    // onExecuted: aplicar bypass desde el backend (subgrafos)
    // ------------------------------------------------------------------
    const origExec = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      origExec?.apply(this, arguments);
      const state = message?.bypass_state?.[0];
      if (state && typeof state === "object") {
        const graph = getGraph(this);
        for (const entry of this._mikaMapping || []) {
          const name = this.inputs?.[entry.inputIndex]?.name;
          if (name && name in state) {
            const t = graph.getNodeById?.(entry.targetNodeId);
            if (t) setNodeMode(t, state[name] ? MODE_ON : MODE_OFF);
          }
        }
      }
    };

    // ------------------------------------------------------------------
    // onDrawForeground: polling + ocultar slots colapsados
    // ------------------------------------------------------------------
    const origDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = origDraw?.apply(this, arguments);

      const now = Date.now();

      // Cada 400ms: sincronizar toggles con estado real de los nodos
      if (!this._mikaLastSync || now - this._mikaLastSync > 400) {
        this._mikaLastSync = now;
        const graph = getGraph(this);

        for (const entry of this._mikaMapping || []) {
          const target = graph.getNodeById?.(entry.targetNodeId);
          if (!target) continue;
          const w = entry.widget;
          // FIX: reflejar si el nodo esta habilitado (mode 0)
          const isEnabled = target.mode === MODE_ON;
          if (w.value !== isEnabled) w.value = isEnabled;
        }

        this.setDirtyCanvas(true, true);
      }

      // Cada 2s: verificar que el mapeo coincide con las conexiones
      if (!this._mikaLastRebuild || now - this._mikaLastRebuild > 2000) {
        this._mikaLastRebuild = now;
        let needsRebuild = false;
        const inputs = this.inputs || [];

        for (const entry of this._mikaMapping || []) {
          if (
            entry.inputIndex >= inputs.length ||
            !inputs[entry.inputIndex]?.link
          ) {
            needsRebuild = true;
            break;
          }
        }
        if (!needsRebuild) {
          for (let i = 0; i < inputs.length; i++) {
            if (
              inputs[i]?.link &&
              !(this._mikaMapping || []).some((m) => m.inputIndex === i)
            ) {
              needsRebuild = true;
              break;
            }
          }
        }
        if (needsRebuild) stabilizeInputs(this);
      }

      // Ocultar slots de entrada cuando estan colapsados
      if (this.properties?.["_mika_collapse"] && ctx) {
        const slotH = LiteGraph.NODE_SLOT_HEIGHT || 20;
        const titleH = LiteGraph.NODE_TITLE_HEIGHT || 30;
        const bg = this.bgcolor || "#353535";

        for (let i = 0; i < (this.inputs || []).length; i++) {
          const sy = this.pos[1] + titleH + i * slotH + slotH / 2;
          const sx = this.pos[0];
          ctx.fillStyle = bg;
          ctx.beginPath();
          ctx.arc(sx, sy, 7, 0, Math.PI * 2);
          ctx.fill();

          const label = this.inputs[i].label || this.inputs[i].name;
          if (label) {
            ctx.font = "12px sans-serif";
            const tw = ctx.measureText(label).width;
            ctx.fillRect(sx + 10, sy - 7, tw + 6, 14);
          }
        }
      }

      return r;
    };
  },
});
