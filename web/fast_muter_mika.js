import { app } from "/scripts/app.js";

const MAX_SLOTS = 20;
const MODE_OFF = 2; // MUTE
const MODE_ON = 0;  // ALWAYS

app.registerExtension({
  name: "Mika.FastMuter",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "FastMuterMika") return;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function getGraph(node) {
      return node.graph || app.graph;
    }

    function getConnectedNode(myNode, inputIndex) {
      const graph = getGraph(myNode);
      const input = myNode.inputs?.[inputIndex];
      if (!input?.link) return null;
      const link = graph.links?.[input.link];
      if (!link) return null;
      return graph.getNodeById?.(link.origin_id) || null;
    }

    function isNodeOff(node) {
      return node.mode === MODE_OFF;
    }

    function setNodeMode(node, mode) {
      node.mode = mode;
      getGraph(node)?.setDirtyCanvas(true, true);
    }

    function isBooleanConnection(myNode, inputIndex) {
      const connNode = getConnectedNode(myNode, inputIndex);
      if (!connNode) return false;
      if (connNode.type === "PrimitiveNode") return true;
      const graph = getGraph(myNode);
      const input = myNode.inputs?.[inputIndex];
      const link = graph.links?.[input.link];
      if (link && connNode.outputs?.[link.origin_slot]) {
        const outType = connNode.outputs[link.origin_slot].type;
        return outType === "BOOLEAN";
      }
      return false;
    }

    function resolveBooleanValue(myNode, inputIndex) {
      const connNode = getConnectedNode(myNode, inputIndex);
      if (!connNode) return undefined;
      if (connNode.type === "PrimitiveNode") {
        return Boolean(connNode.widgets?.[0]?.value);
      }
      return undefined;
    }

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

    // ------------------------------------------------------------------
    // Estabilizar inputs (estilo rgthree)
    // ------------------------------------------------------------------
    function stabilizeInputs(node) {
      if (!node.graph) return;
      let changed = false;
      const inputs = node.inputs || [];

      const lastInput = inputs[inputs.length - 1];
      if (!lastInput || lastInput.link != null) {
        if (inputs.length < MAX_SLOTS + 1) {
          const newIdx = inputs.length + 1;
          node.addInput(`node_${newIdx}`, "*");
          changed = true;
        }
      }

      for (let i = inputs.length - 2; i >= 0; i--) {
        if (!inputs[i]?.link) {
          node.removeInput(i);
          changed = true;
        }
      }

      for (let i = 0; i < (node.inputs || []).length; i++) {
        const input = node.inputs[i];
        if (input?.link) {
          const connNode = getConnectedNode(node, i);
          if (connNode) {
            input.label = connNode.title || input.name;
          }
        }
      }

      if (changed) {
        rebuildWidgets(node);
      }
    }

    // ------------------------------------------------------------------
    // Reconstruir widgets
    // ------------------------------------------------------------------
    function rebuildWidgets(node) {
      const toRemove = (node.widgets || []).filter((w) => w._mikaToggle);
      for (const w of toRemove) {
        node.removeWidget(w);
      }

      node._mikaMapping = [];
      const savedTargets = loadMapping(node);
      const graph = getGraph(node);

      for (let i = 0; i < (node.inputs || []).length; i++) {
        const input = node.inputs[i];
        if (!input?.link) continue;

        const connNode = getConnectedNode(node, i);
        if (!connNode) continue;

        const isSGInput =
          connNode.type === "SubgraphInput" ||
          connNode.properties?.["subgraph_input_index"] != null;

        let targetNodeId, targetNode;
        if (isSGInput && savedTargets[input.name]) {
          targetNodeId = savedTargets[input.name];
          targetNode = graph.getNodeById?.(targetNodeId);
        } else {
          targetNodeId = connNode.id;
          targetNode = connNode;
        }

        if (!targetNode) continue;

        const isOff = targetNode.mode === MODE_OFF;
        const widget = node.addWidget(
          "toggle",
          `Enable ${targetNode.title}`,
          isOff
        );
        widget._mikaToggle = true;
        widget._mikaInputIndex = i;
        widget._mikaTargetNodeId = targetNodeId;

        if (node.properties?.["_mika_collapse"]) {
          widget.hidden = true;
        }

        const capturedTargetId = targetNodeId;
        widget.callback = (value) => {
          const g = getGraph(node);
          const t = g.getNodeById?.(capturedTargetId);
          if (t) setNodeMode(t, value ? MODE_ON : MODE_OFF);
        };

        node._mikaMapping.push({
          inputIndex: i,
          targetNodeId: targetNodeId,
          widget: widget,
        });
      }

      saveMapping(node);
      resizeNode(node);
    }

    function resizeNode(node) {
      const visibleWidgets = (node.widgets || []).filter((w) => !w.hidden);
      const inputCount = (node.inputs || []).length;
      const h = Math.max(visibleWidgets.length * 20 + inputCount * 20 + 6, 36);
      const w = Math.max(node.size?.[0] || 200, 200);
      node.setSize([w, h]);
      node.setDirtyCanvas(true, true);
    }

    // ------------------------------------------------------------------
    // onNodeCreated
    // ------------------------------------------------------------------
    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origOnNodeCreated?.apply(this, arguments);

      this._mikaMapping = [];
      this.properties["_mika_collapse"] = false;

      while (this.inputs.length > 0) {
        this.removeInput(0);
      }
      this.addInput("node_1", "*");

      const collapseBtn = this.addWidget(
        "button",
        "\u25BC Toggles",
        null,
        () => {
          this.properties["_mika_collapse"] = !this.properties["_mika_collapse"];
          collapseBtn.label = this.properties["_mika_collapse"]
            ? "\u25BA Toggles"
            : "\u25BC Toggles";
          for (const w of this.widgets || []) {
            if (w._mikaToggle) w.hidden = this.properties["_mika_collapse"];
          }
          resizeNode(this);
        }
      );
      collapseBtn.serialize = false;

      const refreshBtn = this.addWidget(
        "button",
        "Refresh",
        null,
        () => stabilizeInputs(this)
      );
      refreshBtn.serialize = false;

      this.setSize([200, 40]);
      setTimeout(() => stabilizeInputs(this), 100);
      return r;
    };

    // ------------------------------------------------------------------
    // onConfigure
    // ------------------------------------------------------------------
    const origOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = origOnConfigure?.apply(this, arguments);
      setTimeout(() => stabilizeInputs(this), 100);
      return r;
    };

    // ------------------------------------------------------------------
    // onConnectionsChange
    // ------------------------------------------------------------------
    const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (
      type,
      index,
      connected,
      linkInfo,
      ioSlot
    ) {
      origOnConnectionsChange?.apply(this, arguments);
      if (!linkInfo) return;
      setTimeout(() => stabilizeInputs(this), 10);
    };

    // ------------------------------------------------------------------
    // onExecuted: aplicar mute desde el backend
    // ------------------------------------------------------------------
    const origOnExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      origOnExecuted?.apply(this, arguments);

      const bypassState = message?.bypass_state?.[0];
      if (bypassState && typeof bypassState === "object") {
        const graph = getGraph(this);
        for (const entry of this._mikaMapping || []) {
          const inputName = this.inputs?.[entry.inputIndex]?.name;
          if (inputName && inputName in bypassState) {
            const target = graph.getNodeById?.(entry.targetNodeId);
            if (target) {
              setNodeMode(
                target,
                bypassState[inputName] ? MODE_ON : MODE_OFF
              );
            }
          }
        }
      }
    };

    // ------------------------------------------------------------------
    // onDrawForeground
    // ------------------------------------------------------------------
    const origOnDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = origOnDrawForeground?.apply(this, arguments);

      const now = Date.now();
      if (!this._mikaLastSync || now - this._mikaLastSync > 400) {
        this._mikaLastSync = now;

        const graph = getGraph(this);
        let dirty = false;

        for (const entry of this._mikaMapping || []) {
          const target = graph.getNodeById?.(entry.targetNodeId);
          if (!target) continue;

          const w = entry.widget;
          const isBoolConn = isBooleanConnection(this, entry.inputIndex);

          if (isBoolConn) {
            const resolved = resolveBooleanValue(this, entry.inputIndex);
            if (resolved !== undefined) {
              if (target.mode !== (resolved ? MODE_ON : MODE_OFF)) {
                setNodeMode(target, resolved ? MODE_ON : MODE_OFF);
              }
              if (w.value !== resolved) {
                w.value = resolved;
                dirty = true;
              }
            }
            w.disabled = true;
          } else {
            const actualState = target.mode === MODE_OFF;
            if (w.value !== actualState) {
              w.value = actualState;
              dirty = true;
            }
            w.disabled = false;
          }
        }

        if (dirty) this.setDirtyCanvas(true, true);
      }

      return r;
    };
  },
});
