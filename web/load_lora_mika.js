import { app } from "/scripts/app.js";

// Load Lora-Mika: el combo `lora` se despliega como menú en cascada por
// carpetas/subcarpetas. El valor guardado siempre es la ruta relativa
// completa, así los flujos no se rompen.
//
// Compacto: la fila del combo dibuja solo el nombre del fichero (basename)
// y, en los stacks, un switch on/off a la izquierda que vuelca el widget
// `enable_N` (oculto). El valor real nunca se toca: backend, validación y
// workflows siguen usando la ruta completa.

app.registerExtension({
  name: "Comfy.LoadLoraMika",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const SINGLE_NAMES = ["LoadLoraMika", "LoadLoraMikaNoClip"];
    const STACK_NAMES = ["LoadLoraStackMika", "LoadLoraStackNoClipMika"];

    if (
      !SINGLE_NAMES.includes(nodeData.name) &&
      !STACK_NAMES.includes(nodeData.name)
    ) return;

    const isStack = STACK_NAMES.includes(nodeData.name);

    function getLiteGraph() {
      return globalThis.LiteGraph ?? window?.LiteGraph ?? null;
    }

    function buildMenu(values, onPick) {
      // Árbol de directorios -> entradas de menú con submenús.
      const root = { dirs: new Map(), files: [] };

      for (const v of values) {
        const parts = String(v).replace(/\\/g, "/").split("/");
        let node = root;

        for (let i = 0; i < parts.length - 1; i++) {
          if (!node.dirs.has(parts[i])) {
            node.dirs.set(parts[i], { dirs: new Map(), files: [] });
          }

          node = node.dirs.get(parts[i]);
        }

        node.files.push(v);
      }

      function toOptions(dirNode) {
        const options = [];

        for (const [name, sub] of dirNode.dirs) {
          options.push({
            content: name,
            has_submenu: true,
            submenu: { options: toOptions(sub), callback: onPick },
          });
        }

        for (const f of dirNode.files) {
          options.push({
            content: f.replace(/\\/g, "/").split("/").pop(),
            value: f,
          });
        }

        return options;
      }

      return toOptions(root);
    }

    // Busca el primer MouseEvent/PointerEvent real entre los argumentos.
    // El frontend nuevo llama a onClick({e, node, canvas}) y a
    // onPointerDown(pointer, node, canvas); el legacy llama a
    // mouse(event, pos, node). Sin un evento real el ContextMenu cae a
    // left/top 0,0 (esquina superior izquierda).
    function findNativeEvent(...args) {
      const seen = new Set();

      function visit(obj) {
        if (!obj || typeof obj !== "object") return null;
        if (seen.has(obj)) return null;
        seen.add(obj);

        if (
          typeof obj.clientX === "number" &&
          typeof obj.clientY === "number"
        ) {
          return obj;
        }

        for (const key of ["e", "eUp", "eDown", "event", "nativeEvent", "detail"]) {
          if (obj[key] && typeof obj[key] === "object") {
            const found = visit(obj[key]);
            if (found) return found;
          }
        }

        return null;
      }

      for (const a of args) {
        const found = visit(a);
        if (found) return found;
      }

      return null;
    }

    function getWidgetValues(widget, node) {
      let values = widget._mikaAllOptions ?? widget.options?.values ?? [];

      if (typeof values === "function") {
        try {
          values = values(widget, node);
        } catch (e) {
          values = [];
        }
      }

      if (!Array.isArray(values) && values && typeof values === "object") {
        values = Object.values(values);
      }

      return Array.isArray(values) ? values : [];
    }

    function openCascadeMenu(nativeEvent, node, widget, canvas) {
      const LG = getLiteGraph();
      if (!LG?.ContextMenu) return false;

      const list = getWidgetValues(widget, node);
      if (!list.length) return false;

      widget._mikaAllOptions = list;

      const onPick = (v) => {
        const value = v && v.value !== undefined ? v.value : v;
        widget.value = value;

        try {
          widget.callback?.call(
            widget,
            value,
            canvas ?? app.canvas,
            node,
            canvas?.graph_mouse,
            nativeEvent
          );
        } catch (e) {
          /* no-op */
        }

        try {
          node.onWidgetChanged?.(widget.name, value, widget.value, widget);
        } catch (e) {
          /* no-op */
        }

        try {
          node.setDirtyCanvas(true, true);
        } catch (e) {
          /* no-op */
        }
      };

      const options = buildMenu(list, onPick);
      const menuOptions = {
        callback: onPick,
        title: widget.label || widget.name,
        // Abre los submenús al pasar el ratón, sin necesidad de clic.
        autoopen: true,
        className: "dark",
        node,
      };

      if (nativeEvent) {
        menuOptions.event = nativeEvent;
      } else {
        // Sin evento real no abrimos: el ContextMenu caería a 0,0
        // (esquina superior izquierda) y duplicaría el menú bueno.
        return false;
      }

      try {
        const scale = canvas?.ds?.scale ?? app.canvas?.ds?.scale;
        if (scale && Number.isFinite(scale)) {
          menuOptions.scale = Math.max(1, scale);
        }
      } catch (e) {
        /* no-op */
      }

      new LG.ContextMenu(options, menuOptions);

      return true;
    }

    function hookCascadeWidget(node, loraWidget) {
      if (!loraWidget || loraWidget._mikaHooked) return;

      loraWidget._mikaHooked = true;
      // Antirrebote: mouse + onClick + onPointerDown pueden dispararse por
      // el mismo clic físico. Solo el primero abre el menú; el resto se
      // ignora para no duplicarlo.
      loraWidget._mikaLastOpen = 0;

      function guardedOpen(nativeEvent, targetNode, canvas) {
        const now = Date.now();
        if (now - (loraWidget._mikaLastOpen ?? 0) < 350) return true;
        const opened = openCascadeMenu(
          nativeEvent,
          targetNode ?? node,
          loraWidget,
          canvas ?? app.canvas
        );
        if (opened) loraWidget._mikaLastOpen = now;
        // true = evento consumido, no abrir el combo nativo.
        return true;
      }

      // API moderna (frontend actual): retornar true cancela el combo nativo
      // y pointer.onClick se ejecuta una sola vez por clic, sin drag.
      try {
        loraWidget.onPointerDown = function (pointer, targetNode, canvas) {
          try {
            pointer.onClick = (eUp) => {
              const nativeEvent =
                findNativeEvent(eUp, pointer, window?.event) ??
                pointer?.eDown ??
                null;
              guardedOpen(nativeEvent, targetNode ?? node, canvas ?? app.canvas);
            };
          } catch (e) {
            const nativeEvent = findNativeEvent(pointer, window?.event);
            guardedOpen(nativeEvent, targetNode ?? node, canvas ?? app.canvas);
          }
          return true;
        };
      } catch (e) {
        /* no-op */
      }

      // Fallback legacy: solo se usa si onPointerDown no existe en este
      // frontend. Devuelve true para consumir el evento.
      if (typeof loraWidget.onPointerDown !== "function") {
        loraWidget.mouse = function (...args) {
          const nativeEvent = findNativeEvent(...args, window?.event);
          const maybeNode = args.find(
            (a) => a && typeof a === "object" && Array.isArray(a.widgets)
          );
          return guardedOpen(nativeEvent, maybeNode ?? node, app.canvas);
        };
      }

      // Sustituye el onClick del combo nativo (firma nueva {e, node, canvas}
      // o legacy (event, pos, node)). Si onPointerDown ya consumió el clic,
      // el antirrebote evita el segundo menú.
      const originalOnClick = loraWidget.onClick;
      const isDefaultComboClick =
        originalOnClick &&
        /ComboWidget|BaseSteppedWidget|BaseWidget/.test(
          originalOnClick.constructor?.name ?? ""
        );

      loraWidget.onClick = function (...args) {
        // Si es un onClick personalizado de otro pack, lo respetamos.
        if (originalOnClick && !isDefaultComboClick) {
          try {
            return originalOnClick.apply(this, args);
          } catch (e) {
            /* cae al menú en cascada */
          }
        }

        let e, clickNode, canvas;
        if (args[0] && typeof args[0] === "object" && "e" in args[0]) {
          ({ e, node: clickNode, canvas } = args[0]);
        } else {
          [e, , clickNode] = args;
          canvas = app.canvas;
        }

        const nativeEvent = findNativeEvent(e, ...args, window?.event);
        return guardedOpen(nativeEvent, clickNode ?? node, canvas ?? app.canvas);
      };
    }

    // ---- Fila compacta: basename + switch on/off ----
    // El valor del widget NO se toca (sigue la ruta completa para el
    // backend); solo se cambia lo dibujado en el canvas.

    function baseNameOf(v) {
      const s = String(v ?? "");
      const parts = s.replace(/\\/g, "/").split("/");
      return parts.pop() || s;
    }

    function isOn(v) {
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        return s === "true" || s === "1" || s === "on" || s === "yes";
      }
      return !!v && v !== 0;
    }

    function roundRectPath(ctx, x, y, w, h, r) {
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, r);
      } else {
        ctx.rect(x, y, w, h);
      }
    }

    function ellipsis(ctx, text, maxWidth) {
      const s = String(text ?? "");
      if (maxWidth <= 0) return "";
      try {
        if (ctx.measureText(s).width <= maxWidth) return s;
        let lo = 0;
        let hi = s.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (ctx.measureText(s.slice(0, mid) + "…").width <= maxWidth) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        return s.slice(0, Math.max(0, lo - 1)) + "…";
      } catch (e) {
        return s;
      }
    }

    function drawToggle(ctx, x, cy, on) {
      const w = 26;
      const h = 14;
      const y = cy - h / 2;
      ctx.save();
      roundRectPath(ctx, x, y, w, h, h / 2);
      ctx.fillStyle = on ? "#2ea043" : "#3a3f44";
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
      const kx = on ? x + w - h / 2 - 1.5 : x + h / 2 + 1.5;
      ctx.beginPath();
      ctx.arc(kx, cy, h / 2 - 2.5, 0, Math.PI * 2);
      ctx.fillStyle = on ? "#ffffff" : "#999999";
      ctx.fill();
      ctx.restore();
    }

    function toNodeLocal(nativeEvent, node) {
      try {
        const c = app.canvas;
        let p = null;
        if (c && typeof c.convertEventToCanvasOffset === "function") {
          p = c.convertEventToCanvasOffset(nativeEvent);
        }
        if (!p) return null;
        const cx = Array.isArray(p) ? p[0] : (p.x ?? p[0]);
        const cy = Array.isArray(p) ? p[1] : (p.y ?? p[1]);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
        return [cx - node.pos[0], cy - node.pos[1]];
      } catch (e) {
        return null;
      }
    }

    function nodeLocalToScreen(node, x, y, w, h) {
      try {
        const c = app.canvas;
        const r = c.canvas.getBoundingClientRect();
        const s = c.ds?.scale ?? 1;
        const ox = c.ds?.offset?.[0] ?? 0;
        const oy = c.ds?.offset?.[1] ?? 0;
        return {
          left: r.left + (node.pos[0] + x) * s + ox,
          top: r.top + (node.pos[1] + y) * s + oy,
          width: Math.max(30, w * s),
          height: Math.max(16, h * s),
        };
      } catch (e) {
        return null;
      }
    }

    function fmtNum(v) {
      const n = typeof v === "number"
        ? v
        : parseFloat(String(v ?? "").replace(",", "."));
      if (!Number.isFinite(n)) return String(v ?? "");
      return String(Math.round(n * 100) / 100);
    }

    function setFieldValue(node, field, raw) {
      let n = typeof raw === "number"
        ? raw
        : parseFloat(String(raw ?? "").replace(",", "."));
      if (!Number.isFinite(n)) return false;
      const o = field.w.options || {};
      if (Number.isFinite(o.min)) n = Math.max(o.min, n);
      if (Number.isFinite(o.max)) n = Math.min(o.max, n);
      n = Math.round(n * 100) / 100;
      field.w.value = n;
      try {
        field.w.callback?.call(field.w, n, app.canvas, node);
      } catch (e) {
        /* no-op */
      }
      try {
        node.onWidgetChanged?.(field.w.name, n, n, field.w);
      } catch (e) {
        /* no-op */
      }
      try {
        node.setDirtyCanvas(true, true);
      } catch (e) {
        /* no-op */
      }
      return true;
    }

    // Un editor de texto a la vez (input HTML sobre el campo).
    let mikaFieldEditor = null;

    function closeFieldEditor(commit) {
      const ed = mikaFieldEditor;
      mikaFieldEditor = null;
      if (!ed) return;
      try {
        const input = ed.input;
        if (commit && !ed.done) {
          ed.done = true;
          setFieldValue(ed.node, ed.field, input.value);
        }
      } catch (e) {
        /* no-op */
      }
      try {
        ed.input.remove();
      } catch (e) {
        /* no-op */
      }
    }

    function openFieldEditor(node, field, fr) {
      closeFieldEditor(false);
      const r = nodeLocalToScreen(node, fr.x, fr.y, fr.w, fr.h);
      if (!r) return;
      const input = document.createElement("input");
      input.type = "text";
      input.setAttribute("inputmode", "decimal");
      input.value = fmtNum(field.w.value);
      input.style.cssText =
        `position:fixed;left:${r.left}px;top:${r.top}px;` +
        `width:${r.width}px;height:${r.height}px;z-index:10000;` +
        `background:#0d1117;color:#e6edf3;border:1px solid #388bfd;` +
        `border-radius:4px;font:12px Arial,sans-serif;text-align:right;` +
        `padding:0 4px;margin:0;outline:none;box-sizing:border-box;`;
      const ed = { input, node, field, done: false };
      mikaFieldEditor = ed;
      const backstop = (ev) => {
        if (mikaFieldEditor === ed && ev.target !== input) {
          closeFieldEditor(true);
        }
        try {
          window.removeEventListener("pointerdown", backstop, true);
        } catch (e) {
          /* no-op */
        }
      };
      try {
        // Si el input no coge foco, el blur no llegaría: este backstop
        // garantiza que no queden editores huérfanos.
        window.addEventListener("pointerdown", backstop, true);
      } catch (e) {
        /* no-op */
      }
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          closeFieldEditor(true);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          closeFieldEditor(false);
        }
        ev.stopPropagation();
      });
      input.addEventListener("blur", () => closeFieldEditor(true));
      // No dejar que el canvas robe teclas mientras se escribe.
      input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      input.addEventListener("mousedown", (ev) => ev.stopPropagation());
      document.body.appendChild(input);
      try {
        input.focus();
        input.select();
      } catch (e) {
        /* no-op */
      }
    }

    // Ancho de la zona del switch (hit + dibujo). Debe coincidir con draw.
    const TOGGLE_ZONE_W = 36;
    // Geometría de los mini-campos numéricos de la derecha.
    const FIELD_W = 48;
    const FIELD_GAP = 4;
    const FIELD_RIGHT = 4;

    // opts: { enable: widget|nil, fields: [{w, tag}] }
    // Los widgets de fields se ocultan (los dibuja esta fila) pero siguen
    // serializando y ejecutando con normalidad.
    function hookCompactLora(node, loraWidget, opts) {
      if (!loraWidget || loraWidget._mikaCompact) return;
      opts = opts || {};
      loraWidget._mikaCompact = true;
      loraWidget._mikaEnable = opts.enable || null;
      loraWidget._mikaFields = Array.isArray(opts.fields)
        ? opts.fields.filter((f) => f && f.w)
        : [];
      loraWidget._mikaToggleAt = 0;
      loraWidget._mikaFieldAt = 0;

      loraWidget.draw = function (ctx, drawNode, width, y, H) {
        const LG = getLiteGraph() ?? {};
        const W = width || 200;
        const h = H || 20;

        const hasToggle = !!this._mikaEnable;
        const fields = this._mikaFields || [];
        const enabled = hasToggle ? isOn(this._mikaEnable.value) : true;

        const nF = fields.length;
        const fieldsW = nF
          ? FIELD_W * nF + FIELD_GAP * (nF - 1) + FIELD_RIGHT
          : 0;
        const textX = hasToggle ? TOGGLE_ZONE_W + 2 : 8;

        const bg = LG.WIDGET_BGCOLOR ?? "#161b22";
        const ol = LG.WIDGET_OUTLINE_COLOR ?? "#30363d";

        ctx.save();
        roundRectPath(ctx, 0, y + 1, W, h - 2, 4);
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.strokeStyle = ol;
        ctx.lineWidth = 1;
        ctx.stroke();
        // Recorta el texto a la fila (la ruta completa desbordaba el nodo).
        ctx.clip();

        if (hasToggle) {
          drawToggle(ctx, 7, y + h / 2, enabled);
        }

        ctx.globalAlpha = enabled ? 1 : 0.45;
        ctx.fillStyle = LG.WIDGET_TEXT_COLOR ?? "#bcc2c8";
        ctx.font = "12px Arial, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const label = ellipsis(
          ctx,
          baseNameOf(this.value),
          W - textX - fieldsW - 6
        );
        ctx.fillText(label, textX, y + h / 2 + 0.5);

        const frects = [];
        const fh = Math.min(h - 6, 16);
        const fy = y + h / 2 - fh / 2;
        for (let i = 0; i < nF; i++) {
          const fx = W - FIELD_RIGHT - FIELD_W * (nF - i) -
            FIELD_GAP * (nF - 1 - i);
          frects.push({ x: fx, y: fy, w: FIELD_W, h: fh, field: fields[i] });
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          roundRectPath(ctx, fx, fy, FIELD_W, fh, 3);
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.08)";
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = LG.WIDGET_SECONDARY_TEXT_COLOR ?? "#999";
          ctx.font = "11px Arial, sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(fields[i].tag, fx + 5, y + h / 2 + 0.5);
          ctx.fillStyle = LG.WIDGET_TEXT_COLOR ?? "#bcc2c8";
          ctx.font = "12px Arial, sans-serif";
          ctx.textAlign = "right";
          ctx.fillText(
            fmtNum(fields[i].w.value),
            fx + FIELD_W - 5,
            y + h / 2 + 0.5
          );
        }
        ctx.globalAlpha = 1;
        ctx.restore();

        this._mikaGeom = { y, h, w: W, fields: frects };
      };

      const flipEnable = () => {
        const en = loraWidget._mikaEnable;
        if (!en) return false;
        const nv = !isOn(en.value);
        en.value = nv;
        loraWidget._mikaToggleAt = Date.now();
        try {
          en.callback?.call(en, nv, app.canvas, node);
        } catch (e) {
          /* no-op */
        }
        try {
          node.onWidgetChanged?.(en.name, nv, nv, en);
        } catch (e) {
          /* no-op */
        }
        try {
          node.setDirtyCanvas(true, true);
        } catch (e) {
          /* no-op */
        }
        return true;
      };

      const hitToggle = (nativeEvent, targetNode) => {
        if (!loraWidget._mikaEnable || !nativeEvent) return false;
        const g = loraWidget._mikaGeom;
        if (!g) return false;
        const p = toNodeLocal(nativeEvent, targetNode ?? node);
        if (!p) return false;
        return (
          p[0] >= 2 &&
          p[0] <= TOGGLE_ZONE_W &&
          p[1] >= g.y &&
          p[1] <= g.y + g.h
        );
      };

      const hitField = (nativeEvent, targetNode) => {
        if (!nativeEvent) return null;
        const g = loraWidget._mikaGeom;
        if (!g || !g.fields) return null;
        const p = toNodeLocal(nativeEvent, targetNode ?? node);
        if (!p) return null;
        for (const fr of g.fields) {
          if (
            p[0] >= fr.x && p[0] <= fr.x + fr.w &&
            p[1] >= fr.y && p[1] <= fr.y + fr.h
          ) {
            return fr;
          }
        }
        return null;
      };

      const markFieldUsed = () => {
        loraWidget._mikaFieldAt = Date.now();
      };

      // Arrastre horizontal sobre un campo = ajustar valor.
      // Clic sin arrastrar = editor de texto. Consume el evento.
      const beginFieldPress = (pointer, targetNode, canvas, nativeEvent) => {
        const fr = hitField(nativeEvent, targetNode ?? node);
        if (!fr) return false;
        // El canvas puede reenviar el mismo pointerdown dos veces
        // (pointerdown + mousedown): el segundo se consume sin duplicar.
        const now = Date.now();
        if (now - (loraWidget._mikaFieldAt ?? 0) < 400) return true;
        markFieldUsed();
        const startX = nativeEvent.clientX ?? 0;
        const startVal = parseFloat(
          String(fr.field.w.value ?? "").replace(",", ".")
        ) || 0;
        let dragging = false;

        const onMove = (ev) => {
          const dx = (ev.clientX ?? startX) - startX;
          if (!dragging && Math.abs(dx) < 4) return;
          dragging = true;
          try {
            ev.preventDefault();
          } catch (e) {
            /* no-op */
          }
          const perPx = (ev.shiftKey ? 0.001 : 0.01) / 3;
          setFieldValue(
            targetNode ?? node,
            fr.field,
            startVal + dx * perPx
          );
        };
        const onUp = () => {
          try {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            window.removeEventListener("pointercancel", onUp, true);
          } catch (e) {
            /* no-op */
          }
          if (!dragging) {
            openFieldEditor(targetNode ?? node, fr.field, fr);
          }
        };

        try {
          window.addEventListener("pointermove", onMove, true);
          window.addEventListener("pointerup", onUp, true);
          window.addEventListener("pointercancel", onUp, true);
        } catch (e) {
          /* no-op */
        }
        try {
          pointer.onClick = () => true;
        } catch (e) {
          /* no-op */
        }
        return true;
      };

      // Se instala DESPUÉS de hookCascadeWidget: es la capa externa.
      // Toggle/campos -> consumen; resto -> delega al menú en cascada.
      const prevDown = loraWidget.onPointerDown;
      loraWidget.onPointerDown = function (pointer, targetNode, canvas) {
        const tNode = targetNode ?? node;
        const cvs = canvas ?? app.canvas;
        try {
          const nativeEvent = findNativeEvent(pointer, window?.event);
          if (nativeEvent && hitToggle(nativeEvent, tNode)) {
            // Mismo gesto reenviado (pointerdown + mousedown): un solo flip.
            const now = Date.now();
            if (now - (loraWidget._mikaToggleAt ?? 0) < 400) return true;
            flipEnable();
            try {
              pointer.onClick = () => true;
            } catch (e) {
              /* no-op */
            }
            return true;
          }
          if (
            nativeEvent &&
            beginFieldPress(pointer, tNode, cvs, nativeEvent)
          ) {
            return true;
          }
        } catch (e) {
          /* no-op */
        }
        return prevDown
          ? prevDown.apply(this, [pointer, tNode, cvs])
          : undefined;
      };

      const prevClick = loraWidget.onClick;
      loraWidget.onClick = function (...args) {
        try {
          // Doble disparo pointer+click del mismo gesto: se consume.
          const now = Date.now();
          if (now - (loraWidget._mikaToggleAt ?? 0) < 400) return true;
          if (now - (loraWidget._mikaFieldAt ?? 0) < 400) return true;
          let e = args[0] && typeof args[0] === "object" && "e" in args[0]
            ? args[0].e
            : args[0];
          const nativeEvent = findNativeEvent(e, ...args, window?.event);
          let clickNode = node;
          if (args[0] && typeof args[0] === "object" && args[0].node) {
            clickNode = args[0].node;
          }
          if (nativeEvent && hitToggle(nativeEvent, clickNode)) {
            return flipEnable() ? true : undefined;
          }
        } catch (e) {
          /* no-op */
        }
        return prevClick ? prevClick.apply(this, args) : undefined;
      };
    }

    // ---- Stack: visibilidad de slots por lora_count ----

    function stackSlotKind(name) {
      const m = /^(lora|enable|strength_model|strength_clip)_(\d+)$/.exec(
        name ?? ""
      );
      return m ? { kind: m[1], index: parseInt(m[2], 10) } : null;
    }

    function stackSlotIndex(name) {
      const s = stackSlotKind(name);
      return s ? s.index : NaN;
    }

    function updateStackVisibility(node) {
      if (!Array.isArray(node.widgets)) return;

      const countWidget = node.widgets.find((w) => w && w.name === "lora_count");
      let target = parseInt(countWidget?.value, 10);
      if (!Number.isFinite(target)) target = 3;

      let max = 0;
      for (const w of node.widgets) {
        const i = stackSlotIndex(w?.name);
        if (Number.isFinite(i)) max = Math.max(max, i);
      }
      if (max < 1) return;

      target = Math.max(1, Math.min(max, target));

      for (const w of node.widgets) {
        const s = stackSlotKind(w?.name);
        if (!s) continue;
        // Switch y strengths viven dibujados en la fila del lora: esos
        // widgets quedan ocultos pero funcionales (una línea por LoRA).
        w.hidden = s.kind === "lora" ? s.index > target : true;
      }

      try {
        node.setSize(node.computeSize());
      } catch (e) {
        /* no-op */
      }

      try {
        node.setDirtyCanvas(true, true);
      } catch (e) {
        /* no-op */
      }
    }

    function hookCountWidget(node) {
      const countWidget = node.widgets?.find((w) => w && w.name === "lora_count");
      if (!countWidget || countWidget._mikaCountHooked) return;

      countWidget._mikaCountHooked = true;
      const prevCallback = countWidget.callback;

      countWidget.callback = function (value) {
        try {
          prevCallback?.call(this, value);
        } catch (e) {
          /* no-op */
        }
        updateStackVisibility(node);
      };
    }

    function slotFields(node, i) {
      const fields = [];
      const sm = node.widgets?.find((x) => x && x.name === `strength_model_${i}`);
      if (sm) fields.push({ w: sm, tag: "S" });
      const sc = node.widgets?.find((x) => x && x.name === `strength_clip_${i}`);
      if (sc) fields.push({ w: sc, tag: "C" });
      return fields;
    }

    function hook(node) {
      if (!isStack) {
        const single = node.widgets?.find((w) => w.name === "lora");
        hookCascadeWidget(node, single);
        // Una línea: nombre + strengths a la derecha (ocultas pero vivas).
        const fields = [];
        const sm = node.widgets?.find((w) => w && w.name === "strength_model");
        if (sm) {
          sm.hidden = true;
          fields.push({ w: sm, tag: "S" });
        }
        const sc = node.widgets?.find((w) => w && w.name === "strength_clip");
        if (sc) {
          sc.hidden = true;
          fields.push({ w: sc, tag: "C" });
        }
        hookCompactLora(node, single, { enable: null, fields });
        try {
          node.setSize(node.computeSize());
        } catch (e) {
          /* no-op */
        }
        try {
          node.setDirtyCanvas(true, true);
        } catch (e) {
          /* no-op */
        }
        return;
      }

      // Stack: cascada en cada combo lora_N + slots visibles por lora_count.
      for (const w of node.widgets ?? []) {
        const m = /^lora_(\d+)$/.exec(w?.name ?? "");
        if (!m) continue;
        hookCascadeWidget(node, w);
        const en = node.widgets?.find((x) => x && x.name === `enable_${m[1]}`);
        // Compacto: basename + switch + strengths en una línea.
        hookCompactLora(node, w, { enable: en, fields: slotFields(node, m[1]) });
      }

      hookCountWidget(node);
      updateStackVisibility(node);
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;

    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated
        ? onNodeCreated.apply(this, arguments)
        : undefined;

      hook(this);

      if (isStack) {
        // Los links/widgets se restauran después; re-aplica al asentar.
        setTimeout(() => {
          try {
            hook(this);
          } catch (e) {
            /* no-op */
          }
        }, 0);
      }

      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;

    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure
        ? onConfigure.apply(this, arguments)
        : undefined;

      hook(this);

      if (isStack) {
        setTimeout(() => {
          try {
            updateStackVisibility(this);
          } catch (e) {
            /* no-op */
          }
        }, 0);
      }

      return r;
    };
  },
});
