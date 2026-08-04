import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Prompt Edit (Loop)-Mika
// - Refresco del cuadro editable tras cada ejecución (onExecuted).
// - Resaltado inline SIN pop-ups: mientras escribís un tag, se pinta con
//   color todo texto del cuadro que coincida (insensible a mayúsculas).
// v2: montaje diferido y blindado — un error de UI ya no impide crear el nodo.
// -----------------------------------------------------------------------

const MIN_FRAGMENTO = 2;

function escapeHTML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fragmentoActual(textarea) {
  const texto = textarea.value ?? "";
  const cursor = textarea.selectionStart ?? texto.length;
  let inicio = 0;
  for (let i = cursor - 1; i >= 0; i--) {
    const c = texto[i];
    if (c === "," || c === "\n" || c === ";") { inicio = i + 1; break; }
  }
  const rawFrag = texto.slice(inicio, cursor);
  const frag = rawFrag.trimStart();
  const inicioReal = inicio + (rawFrag.length - frag.length);
  return { inicioReal, cursor, frag };
}

function construirHTML(texto, frag, r0, r1) {
  const ranges = [];
  if (frag && frag.length >= MIN_FRAGMENTO) {
    const rx = new RegExp(escapeRegExp(frag), "gi");
    let m;
    while ((m = rx.exec(texto)) !== null) {
      const s = m.index;
      const e = s + m[0].length;
      if (!(s < r1 && e > r0)) ranges.push([s, e]);
      if (m[0].length === 0) rx.lastIndex++;
    }
  }
  let out = "";
  let last = 0;
  for (const [s, e] of ranges) {
    out += escapeHTML(texto.slice(last, s));
    out += "<mark>" + escapeHTML(texto.slice(s, e)) + "</mark>";
    last = e;
  }
  out += escapeHTML(texto.slice(last));
  return out + "\n";
}

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const st = document.createElement("style");
  st.textContent =
    `.mika-hl-backdrop mark { background: rgba(255,190,60,0.38); color: transparent; border-radius: 3px; }`;
  document.head.appendChild(st);
}

function getTextarea(widget) {
  if (widget?.inputEl instanceof HTMLElement) return widget.inputEl;
  if (widget?.element instanceof HTMLElement) {
    if (widget.element.tagName === "TEXTAREA") return widget.element;
    return widget.element.querySelector("textarea");
  }
  return null;
}

// -----------------------------------------------------------------------
// Monta la capa de resaltado. Diferido (espera al montaje) y blindado:
// si algo falla, se loguea pero el nodo se crea igual.
// -----------------------------------------------------------------------
function setupHighlight(node, widget) {
  const ta = getTextarea(widget);
  if (!ta || ta._mikaHlBound) return;
  // Aún no montado en el DOM: el tick de onDrawForeground reintentará.
  if (!ta.isConnected || !ta.parentNode) return;

  try {
    injectStyle();
    const parent = ta.parentNode;
    const cs = getComputedStyle(ta);
    const origBg = cs.backgroundColor;

    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }

    // Capa espejo HERMANA del textarea (no lo re-ubica en el DOM).
    const bd = document.createElement("div");
    bd.className = "mika-hl-backdrop";
    bd.setAttribute("aria-hidden", "true");
    Object.assign(bd.style, {
      position: "absolute",
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: "0",
      color: "transparent",
      background: origBg && origBg !== "rgba(0, 0, 0, 0)" ? origBg : "transparent",
      borderRadius: cs.borderRadius,
      boxSizing: cs.boxSizing,
      font: cs.font,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      padding: cs.padding,
      whiteSpace: "pre-wrap",
      overflowWrap: cs.overflowWrap || "break-word",
      wordBreak: cs.wordBreak,
    });

    function alinear() {
      bd.style.top = ta.offsetTop + "px";
      bd.style.left = ta.offsetLeft + "px";
      bd.style.width = ta.offsetWidth + "px";
      bd.style.height = ta.offsetHeight + "px";
    }

    parent.insertBefore(bd, ta);
    alinear();

    ta.style.background = "transparent";
    ta.style.position = "relative";
    ta.style.zIndex = "1";

    function actualizar() {
      const { inicioReal, cursor, frag } = fragmentoActual(ta);
      bd.innerHTML = construirHTML(ta.value, frag, inicioReal, cursor);
      bd.scrollTop = ta.scrollTop;
      alinear();
    }

    ta.addEventListener("input", actualizar);
    ta.addEventListener("keyup", actualizar);
    ta.addEventListener("click", actualizar);
    ta.addEventListener("scroll", () => { bd.scrollTop = ta.scrollTop; });

    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => alinear()).observe(ta);
    }

    node._mikaHlRefresh = (nuevoTexto) => {
      if (nuevoTexto !== undefined) ta.value = nuevoTexto;
      actualizar();
    };

    ta._mikaHlBound = true;
    actualizar();
  } catch (err) {
    console.error("[Mika] PromptEditLoop: no se pudo montar el resaltado.", err);
  }
}

// -----------------------------------------------------------------------
// Registro de la extensión
// -----------------------------------------------------------------------
app.registerExtension({
  name: "Mika.PromptEditLoop",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PromptEditLoopMika") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this.mikaEditWidget =
        (this.widgets ?? []).find((w) => w.name === "editable_text_widget") ?? null;
      try {
        if (this.mikaEditWidget) setupHighlight(this, this.mikaEditWidget);
      } catch (e) { /* nunca impedir la creación del nodo */ }
      return r;
    };

    // Reintento diferido por si el textarea se monta después.
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
      const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
      try {
        if (this.mikaEditWidget) setupHighlight(this, this.mikaEditWidget);
      } catch (e) { /* no-op */ }
      return r;
    };

    // Refresco del cuadro con el prompt nuevo tras cada ejecución.
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const newText = message?.text?.[0];
      if (newText === undefined) return;
      const widget = this.widgets?.find((w) => w.name === "editable_text_widget");
      if (widget) {
        widget.value = newText;
        if (widget.callback) widget.callback(widget.value);
      }
      this._mikaHlRefresh?.(newText);
    };
  },
});