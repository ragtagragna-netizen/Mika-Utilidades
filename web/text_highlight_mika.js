import { app } from "/scripts/app.js";

console.log("[Mika] Text Highlight cargado — resalta coincidencias parciales mientras escribís");

// Nodos Mika con cajas de texto. Si aparece un nodo nuevo, igual se
// engancha por clase (termina en "Mika" o está en este set).
const MIKA_NODES = new Set([
  "LoadLoraMika", "LoadLoraMikaNoClip", "LoadLoraStackMika",
  "LoadLoraStackNoClipMika", "StringSelectorCut", "StringSelectorMika",
  "StringSelectorCutMika", "FilePickerMika", "SwitchMika",
  "SwitchBypassMika", "TextAffixMika", "ScoreListExtendable",
  "PrimitiveMika", "TextBoxClipboard", "NoteMika", "TextBoxPasteMika",
  "TextBoxVisor", "TagFilter", "TextReplaceDynamic",
  "TextConcatenateDynamic", "LoadImageMika", "SmartTagFilterMika",
  "TagIfMika", "TagRemoverMika", "FloatOutputList", "ExecutionTimerConfig",
  "PromptEditLoopMika", "TextLineSelectorMika", "TextLineStepperMika",
  "ImagePreviewCleanMika", "FastGroupsBypasserMika", "FastGroupsMuterMika",
  "FastNodesBypasserMika", "FastNodesMuterMika", "ListUnpackMika",
  "AnimaResolutionsMika", "SamplerSelectorMika", "SchedulerSelectorMika",
  "ImageSaveAutoMika", "IndexIntMika", "IndexStepperMika",
  "PromptPresetSelectorMika", "PromptPresetStepperMika", "LoadImageNameMika",
  "LoadImageNameMaskMika",
  "LoadImageDirMika", "IfAnyMika", "BypassDetectorMika", "TextSaveMika",
  "AnimaPromptOrganizer", "PromptCleanDedupeMika", "FiltrosMika",
  "FiltrosMikaSelect", "FiltrosPromptMika", "PromptReorganizeMika",
  "TextCleanOrganizeMika", "TextCleanOrganizeConcatMika",
  "TextCleanerCompareMika", "LoadMarianMTCheckPoint", "SmartPromptTranslate",
  "PromptTranslateToText", "ClipboardToMultiRefMika",
]);

const MIN_LEN = 2;
const MAX_MARKS = 200;

// Interruptor global (ajustable desde el panel de ajustes ⚙).
let enabled = true;
let hlSetting = null;

function refreshAll() {
  const nodes = app.graph?._nodes ?? [];
  for (const n of nodes) {
    for (const w of n.widgets ?? []) {
      const el = widgetEl(w);
      if (el?._mikaHlUpdate) {
        try { el._mikaHlUpdate(); } catch (e) { /* no-op */ }
      }
    }
  }
}

function setEnabled(v) {
  enabled = !!v;
  refreshAll();
}

function isMikaNode(node) {
  const cls = node?.comfyClass ?? node?.type;
  if (!cls) return false;
  if (MIKA_NODES.has(cls)) return true;
  return /mika$/i.test(cls);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Palabra actual bajo el caret: letras/números y los especiales de
// tags/prompts (_ - ' . / : + #). Mínimo MIN_LEN.
function currentQuery(ta) {
  const pos = ta.selectionStart ?? ta.value.length;
  const v = ta.value ?? "";
  if (!v) return null;
  let s = pos;
  let e = pos;
  const isWord = (c) => /[\p{L}\p{N}_\-'./:+#]/u.test(c);
  while (s > 0 && isWord(v[s - 1])) s--;
  while (e < v.length && isWord(v[e])) e++;
  const word = v.slice(s, e);
  if (word.length < MIN_LEN) return null;
  return { word, start: s, end: e };
}

function buildHtml(text, query) {
  if (!query) return escapeHtml(text) + "\n";
  const lower = text.toLowerCase();
  const q = query.word.toLowerCase();
  let html = "";
  let idx = 0;
  let count = 0;
  let pos = lower.indexOf(q, 0);
  while (pos !== -1 && count < MAX_MARKS) {
    // La coincidencia bajo el caret (la que se está escribiendo) NO se
    // marca: solo se resaltan las coincidencias en el resto del texto.
    const isCurrent = pos < query.end && pos + q.length > query.start;
    html += escapeHtml(text.slice(idx, pos));
    if (isCurrent) {
      html += escapeHtml(text.slice(pos, pos + q.length));
    } else {
      html += `<mark class="mika-hl">${escapeHtml(text.slice(pos, pos + q.length))}</mark>`;
      count++;
    }
    idx = pos + q.length;
    pos = lower.indexOf(q, idx);
  }
  html += escapeHtml(text.slice(idx));
  // El último \n se colapsa sin este extra en un div con pre-wrap.
  if (html.endsWith("\n")) html += " ";
  else html += "\n";
  return html;
}

function isTransparent(c) {
  return !c || c === "transparent" ||
    /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(c);
}

// Fondo REAL del textarea: si es transparente (otro addon como el del
// Prompt Edit Loop lo transparenta por diseño), se sube por los padres
// hasta el primer fondo sólido. Sin espejo con fondo nunca hay caja
// ciega: como último recurso, el oscuro de ComfyUI.
function resolvedBg(ta) {
  try {
    let el = ta;
    for (let i = 0; i < 4 && el; i++) {
      const bg = getComputedStyle(el).backgroundColor;
      if (!isTransparent(bg)) return bg;
      el = el.parentElement;
    }
  } catch (e) { /* no-op */ }
  return "rgb(22, 27, 34)";
}

// Lee el color ORIGINAL quitando un momento la clase que transparenta
// el textarea. Sin esto se guardaba "transparent" y el espejo quedaba
// con texto invisible (caja sólida).
function readOriginal(ta) {
  const had = ta.classList.contains("mika-hl-ta");
  if (had) ta.classList.remove("mika-hl-ta");
  const cs = getComputedStyle(ta);
  const out = { color: cs.color };
  if (had && enabled) ta.classList.add("mika-hl-ta");
  return out;
}

function copyStyle(ta, bd) {
  if (!ta._mikaHlColor || isTransparent(ta._mikaHlColor)) {
    const o = readOriginal(ta);
    if (!isTransparent(o.color)) ta._mikaHlColor = o.color;
  }
  if (!ta._mikaHlBg || isTransparent(ta._mikaHlBg)) {
    ta._mikaHlBg = resolvedBg(ta);
  }
  const cs = getComputedStyle(ta);
  const props = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
    "wordSpacing", "lineHeight", "textTransform", "textIndent", "direction",
    "wordBreak", "lineBreak", "tabSize",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
    "boxSizing", "borderRadius",
  ];
  for (const p of props) {
    try { bd.style[p] = cs[p]; } catch (e) { /* no-op */ }
  }
  bd.style.whiteSpace = "pre-wrap";
  bd.style.wordWrap = "break-word";
  bd.style.overflowWrap = "break-word";
  bd.style.background = ta._mikaHlBg;
  bd.style.color = ta._mikaHlColor;
  // Caret visible con el color real: `caret-color: auto` heredaría el
  // color transparente y el cursor desaparecería al escribir.
  try {
    ta.style.caretColor = ta._mikaHlColor || "";
  } catch (e) { /* no-op */ }
}

function ensureCss() {
  if (document.getElementById("mika-hl-style")) return;
  const st = document.createElement("style");
  st.id = "mika-hl-style";
  st.textContent = `
.mika-hl-wrap { position: relative !important; }
.mika-hl-backdrop {
  position: absolute; inset: 0; margin: 0;
  overflow: hidden; pointer-events: none;
  background: transparent; color: inherit;
  z-index: 0;
}
.mika-hl-backdrop-inner { min-height: 100%; }
.mika-hl-backdrop mark.mika-hl {
  background: rgba(255, 235, 59, 0.45); color: inherit;
  border-radius: 2px; padding: 0;
}
.mika-hl-ta {
  background: transparent !important;
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  position: relative !important;
  z-index: 1 !important;
}
.mika-hl-ta::selection { background: rgba(120, 170, 255, 0.4); }
`;
  document.head.appendChild(st);
}

function attach(ta) {
  if (!ta || ta._mikaHl) return;
  // Solo multilínea: los inputs de una línea no se tocan (eran la
  // mayoría de los resaltados fantasma en nodos ajenos al foco).
  if (ta.tagName !== "TEXTAREA") return;
  ensureCss();

  const parent = ta.parentElement;
  if (!parent) return; // Aún sin DOM: reintenta en el próximo scan.
  if (getComputedStyle(parent).position === "static") {
    parent.classList.add("mika-hl-wrap");
  }

  const bdHolder = { bd: null, inner: null };

  // (Re)crea el espejo si falta o quedó fuera del DOM (p. ej. Vue
  // re-renderizó el contenedor y barrió al anterior). Sin esto el
  // resaltado moría en silencio hasta recargar la página.
  const ensureBackdrop = () => {
    const { bd, inner } = bdHolder;
    if (bd && bd.isConnected && inner && inner.isConnected) return true;
    try { bd?.remove(); } catch (e) { /* no-op */ }
    const nbd = document.createElement("div");
    nbd.className = "mika-hl-backdrop";
    nbd.setAttribute("aria-hidden", "true");
    const ninner = document.createElement("div");
    ninner.className = "mika-hl-backdrop-inner";
    nbd.appendChild(ninner);
    ta.before(nbd);
    nbd.style.display = "none";
    if (!nbd.isConnected) return false;
    bdHolder.bd = nbd;
    bdHolder.inner = ninner;
    return true;
  };

  if (!ensureBackdrop()) return; // Inserción fallida: reintenta luego.
  // Sin clase transparente hasta que haya algo que resaltar.
  ta._mikaHl = true;

  let rafId = 0;
  let lastSig = "";
  let lastContent = "";
  let blocked = false;

  const stopLoop = () => {
    if (rafId) {
      try { cancelAnimationFrame(rafId); } catch (e) { /* no-op */ }
      rafId = 0;
    }
  };

  // Estado seguro: espejo oculto + texto nativo visible. Ante CUALQUIER
  // duda se vuelve aquí: jamás se deja el textarea transparente sin su
  // espejo visible (eso era la "caja sólida" con texto invisible).
  const hide = () => {
    stopLoop();
    blocked = false;
    try { bdHolder.bd.style.display = "none"; } catch (e) { /* no-op */ }
    try { ta.classList.remove("mika-hl-ta"); } catch (e) { /* no-op */ }
    try { ta.style.caretColor = ""; } catch (e) { /* no-op */ }
  };

  const syncStyle = () => copyStyle(ta, bdHolder.bd);

  // Firma barata del contenido (sin forzar layout): decide si hay que
  // repintar el espejo.
  const contentSig = () => {
    try {
      return (
        ta.value.length + "|" + ta.selectionStart + "|" + ta.selectionEnd +
        "|" + ta.scrollTop + "|" + ta.scrollLeft +
        "|" + ta.clientWidth + "|" + ta.clientHeight
      );
    } catch (e) {
      return "";
    }
  };

  // Firma completa (incluye estado del espejo): detecta desyncs externos.
  const sig = () => {
    try {
      const bd = bdHolder.bd;
      return (
        contentSig() + "|" + ta.isConnected + "|" + !!bd?.isConnected +
        "|" + (bd ? bd.style.display : "?") + "|" +
        (ta.className.includes("mika-hl-ta") ? 1 : 0)
      );
    } catch (e) {
      return "";
    }
  };

  const armTick = () => {
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        tick();
      });
    }
  };

  // Fallo de autocuración: volver al texto nativo y NO reintentar hasta
  // que el contenido cambie (evita parpadeo show/hide por frame).
  const blockHeal = () => {
    hide();
    blocked = true;
    lastContent = contentSig();
    lastSig = sig();
  };

  const update = () => {
    try {
      // Textarea fuera del DOM: soltar. Espejo ausente: reconstruirlo.
      if (!ta.isConnected) { hide(); return; }
      if (!ensureBackdrop()) { hide(); return; }
      const bd = bdHolder.bd;
      const inner = bdHolder.inner;
      // Solo la caja CON foco resalta; el resto muestra su texto nativo.
      const query = enabled && document.activeElement === ta ? currentQuery(ta) : null;
      const text = ta.value ?? "";
      if (!query || !text) { hide(); return; }
      bd.style.display = "";
      ta.classList.add("mika-hl-ta");
      syncStyle();
      // El espejo calca la caja de contenido del textarea (no el origen
      // del padre): así no se desplaza con paddings/bordes/scrollbar.
      try {
        bd.style.left = `${ta.offsetLeft + ta.clientLeft}px`;
        bd.style.top = `${ta.offsetTop + ta.clientTop}px`;
        bd.style.width = `${ta.clientWidth}px`;
        bd.style.height = `${ta.clientHeight}px`;
      } catch (e) { /* no-op */ }
      inner.innerHTML = buildHtml(text, query);
      try {
        bd.scrollTop = ta.scrollTop;
        bd.scrollLeft = ta.scrollLeft;
      } catch (e) { /* no-op */ }
      // Autocuración: si el espejo no quedó visible, sin texto legible
      // o descalzado de la caja (típico al abrir: layout aún sin asentar
      // + fondo transparentado por otro addon), volver al texto nativo
      // antes de cegar la caja.
      try {
        const bcs = getComputedStyle(bd);
        const ics = getComputedStyle(inner);
        let aligned = false;
        try {
          const tr = ta.getBoundingClientRect();
          const br = bd.getBoundingClientRect();
          aligned = br.width > 0 && br.height > 0 &&
            Math.abs(br.width - tr.width) <= 4 &&
            Math.abs(br.height - tr.height) <= 4;
        } catch (e) { aligned = false; }
        if (
          bcs.display === "none" || bcs.visibility === "hidden" ||
          !inner.textContent || isTransparent(ics.color) || !aligned
        ) {
          blockHeal();
          return;
        }
      } catch (e) { blockHeal(); return; }
      lastContent = contentSig();
      lastSig = sig();
      // Re-sync mientras tenga foco: cubre IME, drag&drop, scroll y
      // cambios programáticos que no disparan eventos de teclado.
      armTick();
    } catch (e) { hide(); }
  };

  const tick = () => {
    try {
      if (document.activeElement !== ta || !ta.isConnected) {
        hide();
        return;
      }
      if (!ensureBackdrop()) { hide(); return; }
      if (blocked) {
        // Reintentar ante CUALQUIER cambio (contenido, scroll, tamaño,
        // layout): al abrir, el layout se asienta sin que cambie el texto.
        if (sig() !== lastSig) {
          blocked = false;
          update();
        } else {
          armTick();
        }
        return;
      }
      if (sig() !== lastSig) {
        update();
        return;
      }
    } catch (e) { hide(); return; }
    armTick();
  };

  ta._mikaHlDetach = () => {
    hide();
    try { ro.disconnect(); } catch (e) { /* no-op */ }
    try { bdHolder.bd?.remove(); } catch (e) { /* no-op */ }
    ta._mikaHl = false;
  };

  ta.addEventListener("input", update);
  ta.addEventListener("keyup", update);
  ta.addEventListener("click", update);
  ta.addEventListener("select", update);
  ta.addEventListener("cut", update);
  ta.addEventListener("paste", update);
  ta.addEventListener("compositionend", update);
  ta.addEventListener("change", update);
  ta.addEventListener("focus", update);
  ta.addEventListener("blur", update);
  ta.addEventListener("scroll", () => {
    try {
      bdHolder.bd.scrollTop = ta.scrollTop;
      bdHolder.bd.scrollLeft = ta.scrollLeft;
    } catch (e) { /* no-op */ }
  });
  const ro = new ResizeObserver(update);
  try { ro.observe(ta); } catch (e) { /* no-op */ }
  // Primer pintado tras el layout.
  requestAnimationFrame(update);
  setTimeout(update, 100);
  ta._mikaHlUpdate = update;
}

function widgetEl(w) {
  if (w?.inputEl instanceof HTMLElement) return w.inputEl;
  if (w?.element instanceof HTMLElement) {
    if (/^(TEXTAREA|INPUT)$/.test(w.element.tagName)) return w.element;
    return w.element.querySelector("textarea, input[type='text']");
  }
  return null;
}

function scanNode(node) {
  if (!isMikaNode(node)) return;
  ensureDetachOnRemove(node);
  for (const w of node.widgets ?? []) {
    const t = w?.type;
    if (t !== "customtext" && t !== "STRING" && t !== "text") continue;
    const el = widgetEl(w);
    if (el) attach(el);
  }
}

// Al borrar el nodo, suelta espejos/observadores/listeners de sus cajas
// (evita ResizeObserver huérfanos que retienen los textareas).
function ensureDetachOnRemove(node) {
  if (!node || node._mikaHlDetachHook) return;
  node._mikaHlDetachHook = true;
  const prev = node.onRemoved;
  node.onRemoved = function () {
    try {
      for (const w of this.widgets ?? []) {
        try { widgetEl(w)?._mikaHlDetach?.(); } catch (e) { /* no-op */ }
      }
    } catch (e) { /* no-op */ }
    return prev ? prev.apply(this, arguments) : undefined;
  };
}

function scanAll() {
  const nodes = app.graph?._nodes ?? [];
  for (const n of nodes) {
    try { scanNode(n); } catch (e) { /* no-op */ }
  }
}

app.registerExtension({
  name: "Mika.TextHighlight",
  init() {
    try {
      hlSetting = app.ui.settings.addSetting({
        id: "Mika.TextHighlight.Enabled",
        name: "✨ Mika: resaltar coincidencias",
        defaultValue: true,
        type: "boolean",
        onChange(value) {
          setEnabled(value);
        },
      });
      if (hlSetting) enabled = !!hlSetting.value;
    } catch (e) { /* frontend antiguo sin panel de ajustes */ }
  },
  setup() {
    // Por si init() corrió antes de que existiera el panel.
    if (!hlSetting) {
      try {
        hlSetting = app.ui.settings.addSetting({
          id: "Mika.TextHighlight.Enabled",
          name: "✨ Mika: resaltar coincidencias",
          defaultValue: true,
          type: "boolean",
          onChange(value) {
            setEnabled(value);
          },
        });
        if (hlSetting) enabled = !!hlSetting.value;
      } catch (e) { /* no-op */ }
    }
    // Atrapa widgets creados tarde (text_count, pair_count, etc.).
    setInterval(scanAll, 1500);
    setTimeout(scanAll, 1000);
  },
  nodeCreated(node) {
    // Los inputEl se crean de forma asíncrona: reintenta unas veces.
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      try { scanNode(node); } catch (e) { /* no-op */ }
      if (tries >= 10) clearInterval(timer);
    }, 300);
    setTimeout(() => { try { scanNode(node); } catch (e) { /* no-op */ } }, 50);
  },
});
