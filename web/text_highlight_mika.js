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

// Palabra actual bajo el caret: letras/números/_/-/'. Mínimo MIN_LEN.
function currentQuery(ta) {
  const pos = ta.selectionStart ?? ta.value.length;
  const v = ta.value ?? "";
  if (!v) return null;
  let s = pos;
  let e = pos;
  const isWord = (c) => /[\p{L}\p{N}_\-']/u.test(c);
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
    const isCurrent =
      pos < query.end && pos + q.length > query.start;
    html += escapeHtml(text.slice(idx, pos));
    html += isCurrent
      ? `<mark class="mika-hl-cur">${escapeHtml(text.slice(pos, pos + q.length))}</mark>`
      : `<mark class="mika-hl">${escapeHtml(text.slice(pos, pos + q.length))}</mark>`;
    idx = pos + q.length;
    count++;
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

// Lee el color/fondo ORIGINAL quitando un momento la clase que
// transparenta el textarea. Sin esto se guardaba "transparent" y el
// espejo quedaba con texto invisible (caja sólida).
function readOriginal(ta) {
  const had = ta.classList.contains("mika-hl-ta");
  if (had) ta.classList.remove("mika-hl-ta");
  const cs = getComputedStyle(ta);
  const out = { color: cs.color, bg: cs.backgroundColor };
  if (had && enabled) ta.classList.add("mika-hl-ta");
  return out;
}

function copyStyle(ta, bd, isInput) {
  if (!ta._mikaHlColor || isTransparent(ta._mikaHlColor)) {
    const o = readOriginal(ta);
    if (!isTransparent(o.color)) ta._mikaHlColor = o.color;
    if (!isTransparent(o.bg)) ta._mikaHlBg = o.bg;
  }
  const cs = getComputedStyle(ta);
  const props = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
    "lineHeight", "textTransform", "wordSpacing", "textIndent",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
    "boxSizing", "borderRadius",
  ];
  for (const p of props) bd.style[p] = cs[p];
  bd.style.whiteSpace = isInput ? "pre" : "pre-wrap";
  bd.style.wordWrap = isInput ? "normal" : "break-word";
  bd.style.overflowWrap = isInput ? "normal" : "break-word";
  bd.style.background = ta._mikaHlBg;
  bd.style.color = ta._mikaHlColor;
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
.mika-hl-backdrop mark.mika-hl-cur {
  background: rgba(255, 152, 0, 0.75); color: #000;
  border-radius: 2px; padding: 0;
}
.mika-hl-ta {
  background: transparent !important;
  color: transparent !important;
  caret-color: auto !important;
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
  if (ta.tagName !== "TEXTAREA" && ta.tagName !== "INPUT") return;
  ensureCss();
  ta._mikaHl = true;

  const isInput = ta.tagName === "INPUT";
  const parent = ta.parentElement;
  if (parent && getComputedStyle(parent).position === "static") {
    parent.classList.add("mika-hl-wrap");
  }

  const bd = document.createElement("div");
  bd.className = "mika-hl-backdrop";
  bd.setAttribute("aria-hidden", "true");
  const inner = document.createElement("div");
  inner.className = "mika-hl-backdrop-inner";
  bd.appendChild(inner);
  ta.before(bd);
  ta.classList.add("mika-hl-ta");

  const syncStyle = () => copyStyle(ta, bd, isInput);
  syncStyle();

  const update = () => {
    try {
      if (!enabled) {
        bd.style.display = "none";
        ta.classList.remove("mika-hl-ta");
        return;
      }
      bd.style.display = "";
      ta.classList.add("mika-hl-ta");
      syncStyle();
      const text = ta.value ?? "";
      const q = isInput
        ? (ta.value.length >= MIN_LEN ? { word: ta.value, start: 0, end: ta.value.length } : null)
        : currentQuery(ta);
      // En inputs de una línea se resaltan coincidencias dentro del
      // propio valor solo si hay selección parcial; si no, sin marcas.
      let query = q;
      if (isInput && ta.selectionStart != null && ta.selectionEnd != null &&
          ta.selectionEnd > ta.selectionStart) {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        query = sel.length >= MIN_LEN
          ? { word: sel, start: ta.selectionStart, end: ta.selectionEnd }
          : null;
      } else if (isInput) {
        query = null;
      }
      inner.innerHTML = buildHtml(text, query);
      bd.scrollTop = ta.scrollTop;
      bd.scrollLeft = ta.scrollLeft;
      bd.style.width = `${ta.clientWidth}px`;
      bd.style.height = `${ta.clientHeight}px`;
    } catch (e) { /* no-op */ }
  };

  ta.addEventListener("input", update);
  ta.addEventListener("keyup", update);
  ta.addEventListener("click", update);
  ta.addEventListener("select", update);
  ta.addEventListener("scroll", () => {
    bd.scrollTop = ta.scrollTop;
    bd.scrollLeft = ta.scrollLeft;
  });
  new ResizeObserver(update).observe(ta);
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
  for (const w of node.widgets ?? []) {
    const t = w?.type;
    if (t !== "customtext" && t !== "STRING" && t !== "text") continue;
    const el = widgetEl(w);
    if (el) attach(el);
  }
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
