import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Colores extra para el menú "Colors" — v5
// -----------------------------------------------------------------------
// Paleta amplia que recorre el círculo cromático completo: primarios,
// secundarios, terciarios, pasteles y tonos cálidos/fríos bien diferenciados.
// v5: 5 colores nuevos (black, gold, sky, emerald, lavender) y corrección
// del tooltip del selector de colores nuevo:
//  - se registran traducciones "color.<nombre>" en el i18n del frontend
//    para que el tooltip muestre "Orange" / "Naranja" en vez de la clave
//    cruda "color.orange".
//  - se eliminan tooltips de PrimeVue huérfanos que se acumulaban en la
//    parte superior de la ventana cada vez que se elegía un color.
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

  // Terciarios extra (v4): llenan huecos del círculo cromático
  violet:   { dark: "#1A1033", bright: "#8B5CF6" },
  indigo:   { dark: "#141238", bright: "#6366F1" },
  turquoise:{ dark: "#0E3330", bright: "#2DD4BF" },
  olive:    { dark: "#24310F", bright: "#A3E635" },
  crimson:  { dark: "#331017", bright: "#E11D48" },

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

  // Nuevos (v5): negros, amarillos dorados, azules cielo, verdes esmeralda
  // y violetas lavanda para cubrir las familias que pedían más variedad.
  black:    { dark: "#E8E8E8", bright: "#1B1B1B" }, // cuerpo negro, texto claro
  gold:     { dark: "#33260D", bright: "#F5B301" },
  sky:      { dark: "#0F2433", bright: "#38BDF8" },
  emerald:  { dark: "#0A2E1E", bright: "#10B981" },
  lavender: { dark: "#241B2E", bright: "#C084FC" },
};

const MIKA_COLOR_LABELS = {
  en: {
    red: "Red", blue: "Blue", green: "Green", yellow: "Yellow",
    purple: "Purple", orange: "Orange", cyan: "Cyan", magenta: "Magenta",
    lime: "Lime", violet: "Violet", indigo: "Indigo", turquoise: "Turquoise",
    olive: "Olive", crimson: "Crimson", pink: "Pink", peach: "Peach",
    mint: "Mint", brown: "Brown", beige: "Beige", teal: "Teal",
    navy: "Navy", gray: "Gray", white: "White",
    black: "Black", gold: "Gold", sky: "Sky", emerald: "Emerald",
    lavender: "Lavender",
  },
  es: {
    red: "Rojo", blue: "Azul", green: "Verde", yellow: "Amarillo",
    purple: "Púrpura", orange: "Naranja", cyan: "Cian", magenta: "Magenta",
    lime: "Lima", violet: "Violeta", indigo: "Índigo", turquoise: "Turquesa",
    olive: "Oliva", crimson: "Carmesí", pink: "Rosa", peach: "Melocotón",
    mint: "Menta", brown: "Marrón", beige: "Beige", teal: "Azul petróleo",
    navy: "Azul marino", gray: "Gris", white: "Blanco",
    black: "Negro", gold: "Dorado", sky: "Celeste", emerald: "Esmeralda",
    lavender: "Lavanda",
  },
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
  for (const k of ["bg_color", "bgColor", "bg", "bgcolor"]) if (!(k in entry)) entry[k] = bgVal;

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
    console.log(`[Mika] v5: ${added} colores variados agregados al menú "Colors".`);
  }
  return true;
}

// El frontend nuevo genera el tooltip/nombre con la clave i18n `color.<nombre>`.
// Sin traducción vue-i18n devuelve la clave cruda ("color.orange"), que es lo
// que se veía acumulándose arriba. Registramos traducciones en/es para cada
// color añadido; el resto de idiomas caen al fallback en inglés.
function patchColorLabels() {
  const i18n = document.getElementById("vue-app")?.__vue_app__?.config
    ?.globalProperties?.$i18n;
  if (!i18n || typeof i18n.mergeLocaleMessage !== "function") return false;

  for (const loc of Object.keys(MIKA_COLOR_LABELS)) {
    i18n.mergeLocaleMessage(loc, { color: MIKA_COLOR_LABELS[loc] });
  }
  return true;
}

// PrimeVue deja a veces un tooltip huérfano (div.p-tooltip colgado de <body>)
// al cerrarse el selector de colores mientras el tooltip está visible; cada
// selección añadía uno nuevo en la parte superior. Se limpian al pulsar
// cualquier cosa (un tooltip legítimo reaparece al mover el ratón).
function installTooltipSweep() {
  const sweep = () => {
    for (const el of document.querySelectorAll(".p-tooltip")) el.remove();
  };
  window.addEventListener("pointerdown", sweep, { capture: true });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") sweep();
  });
}

app.registerExtension({
  name: "Mika.NodeColors",
  async setup() {
    extendNodeColors();
    // El i18n del frontend puede no existir todavía en setup; se reintenta
    // unos segundos sin bloquear el arranque.
    let tries = 0;
    const timer = setInterval(() => {
      if (patchColorLabels() || ++tries >= 20) clearInterval(timer);
    }, 500);
    installTooltipSweep();
  },
});
