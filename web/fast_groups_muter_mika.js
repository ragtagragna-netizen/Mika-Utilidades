import { app } from "/scripts/app.js";
import { getGroupMembers, enforceModes, releaseActive, forgetController } from "./mika_bypass_engine.js";

const MAX_SLOTS = 20;
const OFF_MODE = 2; // mute (Never)
const TICK_MS = 400;

app.registerExtension({
  name: "Mika.FastGroupsMuter",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "FastGroupsMuterMika") return;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function getGraph(node) {
      return node.graph || app.graph;
    }

    // Grupos por ID estable (inmune a renombres/reordenamientos), con
    // fallback a título como en TrixNodes.
    function findGroupById(graph, groupId, title) {
      const groups = graph?._groups || [];
      let g = null;
      if (groupId !== undefined && groupId !== null) {
        g = groups.find((x) => x && x.id != null && x.id == groupId) || null;
      }
      if (!g && title != null) {
        const lt = String(title).toLowerCase();
        g = groups.find((x) => (x.title || "").toLowerCase() === lt) || null;
      }
      return g;
    }

    // Grupos visibles según el filtro, en orden y acotados a MAX_SLOTS.
    function getVisibleGroups(node, graph) {
      const groups = graph?._groups || [];
      const filterW = node.widgets?.find((w) => w.name === "groups_filter");
      const filterText = (filterW?.value || "").toLowerCase().trim();
      const filters = filterText
        ? filterText.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      return groups
        .filter((g) => {
          if (!g?.title) return false;
          if (filters.length === 0) return true;
          const t = g.title.toLowerCase();
          return filters.some((f) => t.includes(f));
        })
        .slice(0, MAX_SLOTS);
    }

    // ¿El mapping refleja los grupos visibles actuales? Si no, está obsoleto
    // (grupo añadido, eliminado, renombrado o filtro editado).
    function mappingMatches(node, graph, mapping) {
      const visible = getVisibleGroups(node, graph);
      if ((mapping || []).length !== visible.length) return false;
      for (let i = 0; i < visible.length; i++) {
        const entry = mapping[i];
        if (!entry || entry.slot !== `group_${i + 1}`) return false;
        if (String(entry.groupId ?? "") !== String(visible[i].id ?? "")) return false;
        if (entry.groupTitle !== visible[i].title) return false;
      }
      return true;
    }

    // Un grupo se considera "muteado" cuando TODOS sus miembros directos
    // están en modo off.
    function isGroupOff(group) {
      const members = getGroupMembers(group);
      if (members.length === 0) return false;
      return members.every((n) => n.mode === OFF_MODE);
    }

    // Construye los targets {n, active} a partir del mapping y aplica el motor.
    function syncApply(node, mapping) {
      const graph = getGraph(node);
      const targets = [];
      for (const entry of mapping) {
        const group = findGroupById(graph, entry.groupId, entry.groupTitle);
        if (!group) continue;
        const members = getGroupMembers(group);
        for (const m of members) {
          targets.push({ n: m, active: Boolean(entry._active) });
        }
      }
      enforceModes(node, targets, OFF_MODE);
    }

    // Widget PROMOVIDO en el contenedor del subgrafo (el nodo padre). Cuando
    // un widget se promociona al borde del subgrafo, ComfyUI crea una COPIA
    // en el contenedor: se lee/escribe esa copia como control externo.
    function findPromotedWidgetInContainer(node, slotName) {
      const myGraph = node.graph;
      if (!myGraph || myGraph === app.graph) return null;
      const container = (app.graph?.nodes || app.graph?._nodes || []).find(
        (n) => n.subgraph === myGraph || n._subgraph === myGraph
      );
      if (!container || !container.widgets) return null;
      return container.widgets.find((w) => w.name === slotName);
    }

    function hideAllGroupWidgets(node) {
      for (let i = 1; i <= MAX_SLOTS; i++) {
        const w = node.widgets?.find((w) => w.name === `group_${i}`);
        if (w) w.hidden = true;
      }
    }

    // ------------------------------------------------------------------
    // Rebuild: mapping fresco desde los grupos visibles. Solo display;
    // el syncApply final siembra claims con escrituras no-op.
    // ------------------------------------------------------------------
    function rebuild(node) {
      const graph = getGraph(node);
      const visibleGroups = getVisibleGroups(node, graph);

      const filterW = node.widgets?.find((w) => w.name === "groups_filter");
      if (filterW && !filterW._mikaRebuildHooked) {
        filterW._mikaRebuildHooked = true;
        const prevCb = filterW.callback;
        filterW.callback = (v) => {
          try {
            prevCb?.(v);
          } catch (e) {}
          rebuild(node);
        };
      }

      hideAllGroupWidgets(node);
      node._mikaMuteMapping = [];

      for (let i = 0; i < visibleGroups.length; i++) {
        const group = visibleGroups[i];
        const slotName = `group_${i + 1}`;
        const bypassed = isGroupOff(group);

        node._mikaMuteMapping.push({
          slot: slotName,
          groupId: group.id,
          groupTitle: group.title,
          _active: bypassed,
        });

        const widget = node.widgets?.find((w) => w.name === slotName);
        if (widget) {
          widget.hidden = false;
          widget.label = group.title;
          widget.value = bypassed;
          widget.callback = (value) => {
            const entry = node._mikaMuteMapping?.find((m) => m.slot === slotName);
            const boolValue = Boolean(value);
            if (entry) entry._active = boolValue;
            // Write-through al promovido: es la misma perilla.
            const pw = findPromotedWidgetInContainer(node, slotName);
            if (pw) pw.value = boolValue;
            if (entry) entry._lastApplied = boolValue;
            syncApply(node, node._mikaMuteMapping || []);
            if (!boolValue && entry) {
              // OFF explícito: el grupo sale del mute aunque lo hubiera
              // impuesto un actor externo (p.ej. rgthree).
              const g = findGroupById(getGraph(node), entry.groupId, entry.groupTitle);
              if (g) releaseActive(node, getGroupMembers(g));
            }
          };
        }
      }

      syncApply(node, node._mikaMuteMapping);
      const visibleCount = (node.widgets || []).filter((w) => !w.hidden).length;
      const h = Math.max(visibleCount * 20 + 6, 36);
      const w = Math.max(node.size?.[0] || 200, 200);
      node.setSize([w, h]);
      node.setDirtyCanvas(true, true);
    }

    // ------------------------------------------------------------------
    // Tick periódico estilo TrixNodes: concilia display y mantenimiento,
    // pero NUNCA escribe modos por sí solo. La escritura es por click o por
    // cambio en el widget promovido. Funciona en frontend clásico y Vue.
    // ------------------------------------------------------------------
    function tick(node) {
      const graph = getGraph(node);

      let mapping = node._mikaMuteMapping || [];
      if (!mappingMatches(node, graph, mapping)) {
        rebuild(node);
        mapping = node._mikaMuteMapping || [];
      }

      let needEnforce = false;
      let changed = false;
      for (const entry of mapping) {
        const group = findGroupById(graph, entry.groupId, entry.groupTitle);
        if (!group) continue;

        const w = node.widgets?.find((w) => w.name === entry.slot);
        const promoted = findPromotedWidgetInContainer(node, entry.slot);
        const actual = isGroupOff(group);

        if (promoted) {
          // Control externo: manda y se aplica por flanco (solo al cambiar).
          const externalValue = Boolean(promoted.value);
          if (w && w.value !== externalValue) {
            w.value = externalValue;
            changed = true;
          }
          entry._active = externalValue;
          if (entry._lastApplied !== externalValue) {
            entry._lastApplied = externalValue;
            needEnforce = true;
          }
        } else {
          // Toggle propio: el display sigue a la realidad (adopt). Sin
          // escritura: un cambio externo (rgthree) se refleja y listo.
          const shown = w ? Boolean(w.value) : Boolean(entry._active);
          entry._active = shown;
          if (w && shown !== actual) {
            w.value = actual;
            entry._active = actual;
            changed = true;
          }
        }
      }

      if (needEnforce) {
        syncApply(node, mapping);
        changed = true;
      }
      if (changed) node.setDirtyCanvas?.(true, true);
    }

    function startTick(node) {
      if (node._mikaInterval) return;
      node._mikaInterval = setInterval(() => {
        try {
          tick(node);
        } catch (e) {}
      }, TICK_MS);
    }

    function stopTick(node) {
      if (node._mikaInterval) {
        clearInterval(node._mikaInterval);
        node._mikaInterval = null;
      }
    }

    // ------------------------------------------------------------------
    // Ciclo de vida
    // ------------------------------------------------------------------
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this._mikaMuteMapping = [];

      const btn = this.addWidget("button", "Refresh", null, () => rebuild(this));
      btn.serialize = false;

      hideAllGroupWidgets(this);
      this.setSize([200, 40]);
      rebuild(this);
      startTick(this);
      if (!this._mikaRemoveHooked) {
        this._mikaRemoveHooked = true;
        const prevRemove = this.onRemoved;
        this.onRemoved = function () {
          try {
            stopTick(this);
            forgetController(this);
          } catch (e) {}
          if (typeof prevRemove === "function") prevRemove.apply(this, arguments);
        };
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => {
        rebuild(this);
        startTick(this);
      }, 50);
      return r;
    };
  },
});

