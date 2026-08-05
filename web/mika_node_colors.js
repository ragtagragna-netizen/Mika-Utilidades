import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Colores extra para el menú "Colors" — v3 (variedad sin escalas)
// -----------------------------------------------------------------------
// Paleta reducida: menos variaciones del mismo color, más colores distintos.
// Cada color es claramente distinguible de los demás.
// Mantiene el sistema adaptativo que detecta las claves del frontend.
// -----------------------------------------------------------------------

const MIKA_EXTRA_COLORS = {
  // Primarios puros
  red:      { dark: "#331111", bright: "#FF3333" },
  blue:     { dark: "#111133", bright: "#3366FF" },
  green:    { dark: "#113311", bright: "#33CC33" },
  
  // Secundarios
  yellow:   { dark: "#333311", bright: "#FFCC00" },
  purple:   { dark: "#221133", bright: "#9933FF" },
  orange:   { dark: "#332211", bright: "#FF6600" },
  
  // Terciarios / intermedios
  cyan:     { dark: "#113333", bright: "#00CCCC" },
  magenta:  { dark: "#331133", bright: "#FF00CC" },
  lime:     { dark: "#223311", bright: "#99FF33" },
  
  // Pastel / suaves
  pink:     { dark: "#332233", bright: "#FF66AA" },
  peach:    { dark: "#332222", bright: "#FFAA88" },
  mint:     { dark: "#223333", bright: "#66FFCC" },
  
  // Tierra / cálidos
  brown:    { dark: "#221111", bright: "#AA6633" },
  beige:    { dark: "#332211", bright: "#DDCC99" },
  
  // Fríos / metálicos
  teal:     { dark: "#112233", bright: "#3399AA" },
  navy:     { dark: "#111122", bright: "#334488" },
  
  // Neutros
  gray:     { dark: "#222222", bright: "#AAAAAA" },
  white:    { dark: "#333333", bright: "#EEEEEE" },
};

function hexToLum(hex) {
  try {
    let h = String(hex).replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  } catch (err) {
    return 0;
  }
}

function buildEntry(sample, dark, bright) {
  const entries = Object.entries(sample).filter(
    ([, v]) => typeof v === "string" && v.startsWith("#")
  );

  if (entries.length === 0) {
    return { color: dark, bg_color: bright, bgColor: bright, bg: bright };
  }

  const lums = entries.map(([, v]) => hexToLum(v));
  const mid = (Math.max(...lums) + Math.min(...lums)) / 2;

  const entry = {};
  for (const [k, v] of entries) {
    entry[k] = hexToLum(v) >= mid ? bright : dark;
  }

  const bgSampleKey = entries.find(([k]) => /bg/i.test(k))?.[0];
  const bgIsBright = bgSampleKey ? hexToLum(sample[bgSampleKey]) >= mid : true;
  const bgVal = bgIsBright ? bright : dark;
  const fgVal = bgIsBright ? dark : bright;

  for (const k of ["color", "fg", "title_color"]) if (!(k in entry)) entry[k] = fgVal;
  for (const k of ["bg_color", "bgColor", "bg"]) if (!(k in entry)) entry[k] = bgVal;

  return entry;
}

function extendNodeColors() {
  const LC = window.LGraphCanvas ?? window.LiteGraph?.LGraphCanvas ?? null;
  const nc = LC?.node_colors;
  if (!nc) return false;

  const sample = nc.red ?? nc.green ?? nc.blue ?? Object.values(nc)[0];
  if (!sample || typeof sample !== "object") return false;

  let added = 0;
  for (const [name, val] of Object.entries(MIKA_EXTRA_COLORS)) {
    if (!nc[name]) {
      nc[name] = buildEntry(sample, val.dark, val.bright);
      added++;
    }
  }
  if (added > 0) {
    console.log(`[Mika] v3: ${added} colores variados agregados al menú "Colors".`);
  }
  return true;
}

app.registerExtension({
  name: "Mika.NodeColors",
  async setup() {
    extendNodeColors();
  },
});

extendNodeColors();