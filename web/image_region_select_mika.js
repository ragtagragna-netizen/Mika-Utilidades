import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// -----------------------------------------------------------------------
// Mika · Image Region Select
// -----------------------------------------------------------------------
// Nodo para cargar (o pegar, o arrastrar) UNA O VARIAS imágenes y marcar
// zonas (▭ rectángulo, ◯ círculo/elipse, ✎ lazo). Cada zona recuerda de qué
// imagen salió (`img`); la lista de salida mezcla recortes de todas. La
// geometría vive en el widget oculto "zonas" (normalizada 0..1) y la lista
// de imágenes en "imagenes"; el nodo Python recorta y rellena.
// -----------------------------------------------------------------------

const NODE_NAME = "ImageRegionSelectMika";
const PAD = 16;
const HANDLE = 7;
const PALETTE = [
  "#ff5c5c", "#4cc2ff", "#7bd94c", "#ffcf4c",
  "#b98bff", "#ff7bd0", "#4ce0c2", "#ff9b4c",
];
const SHAPES = [["rect", "▭", "Rectángulo"], ["ellipse", "◯", "Círculo"], ["free", "✎", "Lazo"]];
const WIRE = "wire";

const clamp01 = (v) => Math.max(0, Math.min(1, v));

const findWidget = (node, name) => node.widgets?.find((w) => String(w?.name) === name);

function viewUrl(value) {
  let name = String(value ?? "").trim();
  if (!name) return null;
  const slash = name.lastIndexOf("/");
  const sub = slash > 0 ? name.slice(0, slash) : "";
  const file = slash > 0 ? name.slice(slash + 1) : name;
  let url = `/view?filename=${encodeURIComponent(file)}&type=input`;
  if (sub) url += `&subfolder=${encodeURIComponent(sub)}`;
  return url;
}

function zoneBBox(zone) {
  const pts = zone.shape === "free" ? zone.points : null;
  if (pts && pts.length) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
  }
  return Array.isArray(zone.rect) ? zone.rect : [0, 0, 0, 0];
}

function recalcRect(zone) {
  zone.rect = zoneBBox({ ...zone, points: zone.points });
}

function boxContains(box, nx, ny) {
  return nx >= box[0] && nx <= box[0] + box[2] && ny >= box[1] && ny <= box[1] + box[3];
}

app.registerExtension({
  name: "Mika.ImageRegionSelect",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    function readJsonWidget(node, name) {
      try {
        const data = JSON.parse(findWidget(node, name)?.value || "[]");
        if (Array.isArray(data)) return data;
      } catch (e) { /* valor corrupto: arrancar vacío */ }
      return [];
    }

    function readZones(node) {
      return readJsonWidget(node, "zonas").filter((z) => z && typeof z === "object");
    }

    function readImages(node) {
      return readJsonWidget(node, "imagenes").filter((n) => typeof n === "string" && n.trim());
    }

    function fillColor(node) {
      return String(findWidget(node, "relleno")?.value ?? "transparente");
    }

    function build(node) {
      if (typeof node.addDOMWidget !== "function") return;
      for (const name of ["archivo", "zonas", "imagenes"]) {
        const w = findWidget(node, name);
        if (w) w.hidden = true; // ocultos pero serializados
      }

      const prev = node._mikaRegionDom;
      if (prev) {
        try { prev.element?.remove(); } catch (e) { /* no-op */ }
        const idx = node.widgets?.indexOf(prev);
        if (idx >= 0) node.widgets.splice(idx, 1);
        node._mikaRegionDom = null;
      }

      const zones = readZones(node);
      let nameSeq = 0;
      for (const z of zones) {
        const n = parseInt(z.name, 10);
        if (!Number.isNaN(n) && n > nameSeq) nameSeq = n;
      }

      const st = node._mikaRegion = {
        zones,
        images: readImages(node),
        active: null,
        sel: -1,
        shape: node.properties?.mikaRegionShape || "rect",
        undo: [],
        imgCache: new Map(),   // src -> Image (completa)
        thumbCache: new Map(), // src -> canvas (miniatura)
        wireConnected: false,
        img: null,
        imgSrc: null,
        drag: null,
        nameSeq,
        writing: false,
      };

      const root = document.createElement("div");
      root.style.cssText = "display:flex;flex-direction:column;gap:6px;padding-bottom:2px;";

      // `flex:0 0 auto` en los hijos: sin esto el contenedor flex los encoge al
      // alto del nodo (el lienzo se aplastaba y la tira de zonas quedaba tapada).
      const gallery = document.createElement("div");
      gallery.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-height:4px;flex:0 0 auto;";

      const toolbar = document.createElement("div");
      toolbar.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;flex:0 0 auto;";

      const stage = document.createElement("div");
      stage.style.cssText =
        "position:relative;box-sizing:border-box;background:#2b2b2b;border:1px solid var(--border-color,#444);border-radius:4px;overflow:hidden;align-self:center;flex:0 0 auto;";

      const canvas = document.createElement("canvas");
      canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;";
      stage.appendChild(canvas);

      const strip = document.createElement("div");
      strip.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start;flex:0 0 auto;";

      root.append(gallery, toolbar, stage, strip);
      st.canvas = canvas;
      st.stage = stage;
      st.toolbar = toolbar;
      st.gallery = gallery;
      st.strip = strip;

      // ---------------- estado / serialización ----------------
      function writeZones() {
        const w = findWidget(node, "zonas");
        if (!w) return;
        st.writing = true;
        w.value = JSON.stringify(st.zones);
        try { w.callback?.(w.value); } catch (e) { /* no-op */ }
        st.writing = false;
      }

      function writeImages() {
        const w = findWidget(node, "imagenes");
        if (!w) return;
        st.writing = true;
        w.value = JSON.stringify(st.images);
        try { w.callback?.(w.value); } catch (e) { /* no-op */ }
        st.writing = false;
      }

      function pushUndo() {
        st.undo.push(JSON.stringify({ images: st.images, zones: st.zones }));
        if (st.undo.length > 40) st.undo.shift();
      }

      function undo() {
        if (!st.undo.length) return;
        const snap = JSON.parse(st.undo.pop());
        st.images = snap.images || [];
        st.zones = snap.zones || [];
        st.sel = -1;
        if (st.active !== WIRE && !st.images.includes(st.active)) {
          st.active = st.images[0] || (st.wireConnected ? WIRE : null);
        }
        writeImages();
        writeZones();
        renderGallery();
        renderStrip();
        loadImage(true);
        draw();
        refit();
      }

      function nextName() {
        st.nameSeq = (st.nameSeq || 0) + 1;
        return String(st.nameSeq);
      }

      // ---------------- fuentes ----------------
      function wiredSrc() {
        const idx = (node.inputs || []).findIndex((i) => i.name === "imagen");
        if (idx < 0) return null;
        const link = node.inputs[idx].link;
        if (link == null) return null;
        const l = node.graph?.links?.[link];
        const origin = l ? app.graph.getNodeById(l.origin_id) : null;
        return origin?.imgs?.[0]?.src || null;
      }

      function refreshWire() {
        st.wireConnected = !!wiredSrc() || (node.inputs || []).some(
          (i) => i.name === "imagen" && i.link != null);
        if (!st.active && st.wireConnected) st.active = WIRE;
      }

      function srcForKey(key) {
        if (key === WIRE) return wiredSrc();
        return viewUrl(key);
      }

      function getImage(src) {
        if (!src) return null;
        let im = st.imgCache.get(src);
        if (im) return im;
        im = new Image();
        im.onload = () => {
          st.thumbCache.delete(src);
          if (src === srcForKey(st.active)) {
            st.img = im; st.imgSrc = src;
            layout(); draw(); renderStrip(); refit();
          }
          renderGallery();
        };
        im.onerror = () => { st.imgCache.delete(src); renderGallery(); };
        im.src = src;
        st.imgCache.set(src, im);
        return im;
      }

      function ensureActive() {
        if (st.active === WIRE && !st.wireConnected) st.active = null;
        if (st.active && st.active !== WIRE && !st.images.includes(st.active)) st.active = null;
        if (!st.active) st.active = st.images[0] || (st.wireConnected ? WIRE : null);
      }

      function loadImage() {
        refreshWire();
        ensureActive();
        const src = srcForKey(st.active);
        if (!src) { st.img = null; st.imgSrc = null; layout(); draw(); return; }
        const im = getImage(src);
        st.imgSrc = src;
        st.img = im && im.complete && im.naturalWidth ? im : null;
        layout();
        draw();
        if (st.img) renderStrip();
        // Recalcular el alto también al cambiar de imagen (una ya cacheada no
        // dispara `onload`, así que el nodo no encogía al pasar a una más baja).
        refit();
      }

      function addImage(name) {
        if (!name) return;
        pushUndo();
        if (!st.images.includes(name)) st.images.push(name);
        st.active = name;
        const aw = findWidget(node, "archivo");
        if (aw) { aw.value = name; try { aw.callback?.(name); } catch (e) { /* no-op */ } }
        writeImages();
        renderGallery();
        st.imgSrc = null;
        loadImage(true);
        refit();
      }

      function removeImage(name) {
        if (name === WIRE) return;
        pushUndo();
        st.images = st.images.filter((n) => n !== name);
        st.zones = st.zones.filter((z) => z.img !== name);
        if (st.active === name) st.active = null;
        // Que el combo `archivo` no siga apuntando a la imagen quitada (el
        // backend la usa como fuente por defecto).
        const aw = findWidget(node, "archivo");
        if (aw && String(aw.value) === name) aw.value = "";
        writeImages();
        writeZones();
        renderGallery();
        renderStrip();
        st.imgSrc = null;
        loadImage(true);
        draw();
        refit();
      }

      function setActive(key) {
        if (st.active === key) return;
        st.active = key;
        st.sel = -1;
        renderGallery();
        renderStrip();
        st.imgSrc = null;
        loadImage(true);
      }

      // ---------------- galería ----------------
      function thumbFor(key) {
        const src = srcForKey(key);
        if (!src) return null;
        const cached = st.thumbCache.get(src);
        if (cached) return cached;
        const im = getImage(src);
        if (!im || !im.complete || !im.naturalWidth) return null;
        const c = document.createElement("canvas");
        const k = 38 / Math.max(im.naturalWidth, im.naturalHeight);
        c.width = Math.max(1, Math.round(im.naturalWidth * k));
        c.height = Math.max(1, Math.round(im.naturalHeight * k));
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
        st.thumbCache.set(src, c);
        return c;
      }

      function mkIconBtn(label, title, onClick) {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = title;
        b.style.cssText =
          "font:12px sans-serif;line-height:1;padding:2px 5px;border:1px solid var(--border-color,#444);" +
          "border-radius:3px;background:var(--comfy-input-bg,#222);color:var(--input-text,#eee);cursor:pointer;";
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        return b;
      }

      function renderGallery() {
        refreshWire();
        gallery.innerHTML = "";

        const entries = [];
        if (st.images.length) for (const n of st.images) entries.push({ key: n, label: n, removable: true });
        else if (st.wireConnected) entries.push({ key: WIRE, label: "conectada", removable: false });
        if (st.images.length && st.wireConnected) entries.push({ key: WIRE, label: "conectada", removable: false });

        for (const ent of entries) {
          const item = document.createElement("div");
          item.style.cssText = "position:relative;padding:2px;border-radius:4px;background:#1e1e1e;border:1px solid " +
            (ent.key === st.active ? "#4cc2ff" : "#444") + ";";
          const thumb = thumbFor(ent.key);
          if (thumb) {
            thumb.style.cssText = "display:block;border-radius:2px;";
            item.appendChild(thumb);
          } else {
            const ph = document.createElement("div");
            ph.style.cssText = "width:38px;height:38px;display:flex;align-items:center;justify-content:center;color:#888;font:10px sans-serif;";
            ph.textContent = "…";
            item.appendChild(ph);
          }
          item.title = ent.label;
          item.addEventListener("click", () => setActive(ent.key));
          if (ent.removable) {
            const x = document.createElement("button");
            x.textContent = "✕";
            x.title = "Quitar imagen (y sus zonas)";
            x.style.cssText =
              "position:absolute;top:-6px;right:-6px;width:16px;height:16px;line-height:0;padding:0;border-radius:8px;" +
              "border:1px solid #444;background:#111;color:#eee;font-size:10px;cursor:pointer;";
            x.addEventListener("click", (e) => { e.stopPropagation(); removeImage(ent.key); });
            item.appendChild(x);
          }
          gallery.appendChild(item);
        }
      }

      // ---------------- dibujo ----------------
      function norm(e) {
        const r = canvas.getBoundingClientRect();
        return [clamp01((e.clientX - r.left) / Math.max(1, r.width)),
                clamp01((e.clientY - r.top) / Math.max(1, r.height))];
      }

      // Ajusta el lienzo a la imagen respetando su proporción EXACTA, con un
      // tope: el lado mayor no supera el ancho del nodo, así una imagen vertical
      // no estira el nodo ni la imagen misma.
      function layout() {
        const avail = Math.max(60, root.clientWidth || (node.size?.[0] || 360) - PAD);
        let dw, dh;
        if (st.img && st.img.naturalWidth && st.img.naturalHeight) {
          const iw = st.img.naturalWidth;
          const ih = st.img.naturalHeight;
          if (iw >= ih) { dw = avail; dh = Math.round((avail * ih) / iw); }
          else { dh = avail; dw = Math.round((avail * iw) / ih); }
        } else {
          dw = avail;
          dh = Math.round(avail * 0.6);
        }
        dw = Math.max(40, dw);
        dh = Math.max(40, dh);
        stage.style.width = dw + "px";
        stage.style.height = dh + "px";
        st.dispW = dw;
        st.dispH = dh;
      }

      // El alto del nodo se mide del DOM real (computeSize usa offsetHeight);
      // como el DOM recién se reacomoda después de un cambio, se reaplica en el
      // siguiente frame y un poco después. El guardia >2px evita bucles.
      function refit() {
        const apply = () => {
          try {
            const h = Math.max(140, Math.ceil(node.computeSize()[1]));
            if (Math.abs((node.size?.[1] || 0) - h) > 2) {
              node.setSize([node.size?.[0] || 360, h]);
            }
          } catch (e) { /* no-op */ }
          app.graph?.setDirtyCanvas?.(true, true);
        };
        apply();
        requestAnimationFrame(apply);
        clearTimeout(node._mikaRefitT);
        node._mikaRefitT = setTimeout(apply, 160);
      }

      function visibleZones() {
        return st.zones.map((z, i) => ({ z, i })).filter(({ z }) => (z.img || st.active) === st.active);
      }

      function draw() {
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth || stage.clientWidth || 200;
        const cssH = canvas.clientHeight || Math.round(cssW * 0.6);
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
          canvas.width = Math.round(cssW * dpr);
          canvas.height = Math.round(cssH * dpr);
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const cs = 8;
        for (let y = 0; y < cssH; y += cs) {
          for (let x = 0; x < cssW; x += cs) {
            ctx.fillStyle = ((x / cs + y / cs) % 2) ? "#333" : "#3f3f3f";
            ctx.fillRect(x, y, cs, cs);
          }
        }
        if (st.img) {
          ctx.drawImage(st.img, 0, 0, cssW, cssH);
        } else {
          ctx.fillStyle = "#bbb";
          ctx.font = "12px sans-serif";
          ctx.textAlign = "center";
          const msg = st.active === WIRE
            ? "Imagen conectada sin vista previa todavía (ejecutá una vez)"
            : (st.active ? "Cargando imagen…" : "Cargá o pegá una imagen (📂 / 📋)");
          ctx.fillText(msg, cssW / 2, cssH / 2);
          ctx.textAlign = "left";
        }

        for (const { z, i } of visibleZones()) {
          const b = zoneBBox(z);
          const x = b[0] * cssW, y = b[1] * cssH;
          const w = b[2] * cssW, h = b[3] * cssH;
          const color = PALETTE[i % PALETTE.length];
          ctx.save();
          ctx.globalAlpha = z.hidden ? 0.25 : 1;
          ctx.lineWidth = i === st.sel ? 3 : 2;
          ctx.strokeStyle = color;
          ctx.beginPath();
          if (z.shape === "ellipse") {
            ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
          } else if (z.shape === "free" && z.points?.length) {
            z.points.forEach((p, k) => {
              const px = p[0] * cssW, py = p[1] * cssH;
              k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
            });
            ctx.closePath();
          } else {
            ctx.rect(x, y, w, h);
          }
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = color;
          ctx.font = "bold 12px sans-serif";
          ctx.fillText(String(i + 1), x + 3, Math.max(12, y + 13));
          if (i === st.sel) {
            ctx.fillStyle = "#fff";
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            for (const [hx, hy] of [[b[0], b[1]], [b[0] + b[2], b[1]], [b[0], b[1] + b[3]], [b[0] + b[2], b[1] + b[3]]]) {
              ctx.fillRect(hx * cssW - HANDLE / 2, hy * cssH - HANDLE / 2, HANDLE, HANDLE);
              ctx.strokeRect(hx * cssW - HANDLE / 2, hy * cssH - HANDLE / 2, HANDLE, HANDLE);
            }
          }
          ctx.restore();
        }

        const d = st.drag;
        if (d && d.mode === "create") {
          ctx.save();
          // Línea punteada del área en selección: roja para que se vea sobre
          // fondos claros (todas las herramientas).
          ctx.strokeStyle = "#ff2d2d";
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 3]);
          ctx.beginPath();
          if (d.shape === "free") {
            d.pts.forEach((p, k) => {
              const px = p[0] * cssW, py = p[1] * cssH;
              k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
            });
          } else {
            const x0 = Math.min(d.start[0], d.cur[0]) * cssW;
            const y0 = Math.min(d.start[1], d.cur[1]) * cssH;
            const w = Math.abs(d.cur[0] - d.start[0]) * cssW;
            const h = Math.abs(d.cur[1] - d.start[1]) * cssH;
            if (d.shape === "ellipse") ctx.ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            else ctx.rect(x0, y0, w, h);
          }
          ctx.stroke();
          ctx.restore();
        }
      }

      // ---------------- selección / edición (solo imagen activa) ----------------
      function hitZone(nx, ny) {
        const vis = visibleZones();
        for (let k = vis.length - 1; k >= 0; k--) {
          if (boxContains(zoneBBox(vis[k].z), nx, ny)) return vis[k].i;
        }
        return -1;
      }

      function handleAt(nx, ny) {
        if (st.sel < 0) return null;
        const b = zoneBBox(st.zones[st.sel]);
        const r = canvas.getBoundingClientRect();
        const rx = HANDLE / Math.max(1, r.width);
        const ry = HANDLE / Math.max(1, r.height);
        const corners = {
          tl: [b[0], b[1]], tr: [b[0] + b[2], b[1]],
          bl: [b[0], b[1] + b[3]], br: [b[0] + b[2], b[1] + b[3]],
        };
        for (const [k, p] of Object.entries(corners)) {
          if (Math.abs(nx - p[0]) <= rx && Math.abs(ny - p[1]) <= ry) return k;
        }
        return null;
      }

      function applyMove(nx, ny) {
        const d = st.drag;
        const z = st.zones[st.sel];
        const orb = zoneBBox(d.orig);
        let x = orb[0] + (nx - d.start[0]);
        let y = orb[1] + (ny - d.start[1]);
        x = Math.max(0, Math.min(1 - orb[2], x));
        y = Math.max(0, Math.min(1 - orb[3], y));
        const dx = x - orb[0], dy = y - orb[1];
        if (d.orig.shape === "free") {
          z.points = d.orig.points.map((p) => [p[0] + dx, p[1] + dy]);
          recalcRect(z);
        } else {
          z.rect = [x, y, orb[2], orb[3]];
        }
      }

      function applyResize(nx, ny) {
        const d = st.drag;
        const z = st.zones[st.sel];
        const ob = d.orig;
        const orb = zoneBBox(ob);
        const fixed = {
          tl: [orb[0] + orb[2], orb[1] + orb[3]],
          tr: [orb[0], orb[1] + orb[3]],
          bl: [orb[0] + orb[2], orb[1]],
          br: [orb[0], orb[1]],
        }[d.h];
        const x0 = clamp01(Math.min(fixed[0], nx));
        const y0 = clamp01(Math.min(fixed[1], ny));
        let x1 = clamp01(Math.max(fixed[0], nx));
        let y1 = clamp01(Math.max(fixed[1], ny));
        if (x1 - x0 < 0.01) x1 = Math.min(1, x0 + 0.01);
        if (y1 - y0 < 0.01) y1 = Math.min(1, y0 + 0.01);
        const nb = [x0, y0, x1 - x0, y1 - y0];
        if (ob.shape === "free") {
          const sx = orb[2] ? nb[2] / orb[2] : 1;
          const sy = orb[3] ? nb[3] / orb[3] : 1;
          z.points = ob.points.map((p) => [nb[0] + (p[0] - orb[0]) * sx, nb[1] + (p[1] - orb[1]) * sy]);
          recalcRect(z);
        } else {
          z.rect = nb;
        }
      }

      function finishDrag() {
        const d = st.drag;
        st.drag = null;
        if (!d) return;
        if (d.mode === "create") {
          if (d.shape === "free") {
            if (d.pts.length < 3) { draw(); return; }
            const zone = { name: nextName(), img: st.active, shape: "free", points: d.pts, rect: null };
            recalcRect(zone);
            st.zones.push(zone);
          } else {
            const x0 = Math.min(d.start[0], d.cur[0]);
            const y0 = Math.min(d.start[1], d.cur[1]);
            const w = Math.abs(d.cur[0] - d.start[0]);
            const h = Math.abs(d.cur[1] - d.start[1]);
            if (w < 0.01 || h < 0.01) { draw(); return; }
            st.zones.push({ name: nextName(), img: st.active, shape: d.shape, rect: [x0, y0, w, h], points: [] });
          }
          st.sel = st.zones.length - 1;
          writeZones();
        } else {
          writeZones();
        }
        renderStrip();
        draw();
        refit();
      }

      canvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !st.img) return;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }
        const [nx, ny] = norm(e);
        if (st.sel >= 0) {
          const h = handleAt(nx, ny);
          if (h) {
            pushUndo();
            st.drag = { mode: "resize", h, start: [nx, ny], orig: JSON.parse(JSON.stringify(st.zones[st.sel])) };
            return;
          }
        }
        const hit = hitZone(nx, ny);
        if (hit >= 0) {
          st.sel = hit;
          pushUndo();
          st.drag = { mode: "move", start: [nx, ny], orig: JSON.parse(JSON.stringify(st.zones[hit])) };
          renderStrip();
          draw();
          return;
        }
        pushUndo();
        st.sel = -1;
        if (st.shape === "free") st.drag = { mode: "create", shape: "free", pts: [[nx, ny]] };
        else st.drag = { mode: "create", shape: st.shape, start: [nx, ny], cur: [nx, ny] };
        draw();
      });

      canvas.addEventListener("pointermove", (e) => {
        if (!st.drag) return;
        const [nx, ny] = norm(e);
        const d = st.drag;
        if (d.mode === "create") {
          if (d.shape === "free") {
            const last = d.pts[d.pts.length - 1];
            if (Math.hypot(nx - last[0], ny - last[1]) > 0.004) d.pts.push([nx, ny]);
          } else {
            d.cur = [nx, ny];
          }
        } else if (d.mode === "move") {
          applyMove(nx, ny);
        } else if (d.mode === "resize") {
          applyResize(nx, ny);
        }
        draw();
      });

      const up = (e) => {
        if (!st.drag) return;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* no-op */ }
        finishDrag();
      };
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("pointercancel", up);

      // ---------------- tira de zonas ----------------
      function makeThumb(zone) {
        const c = document.createElement("canvas");
        c.style.cssText = "display:block;border:1px solid #555;border-radius:3px;background:#222;";
        const img = st.imgCache.get(srcForKey(zone.img || st.active));
        if (!img || !img.naturalWidth) return c;
        const b = zoneBBox(zone);
        const sw = Math.max(1, Math.round(b[2] * img.naturalWidth));
        const sh = Math.max(1, Math.round(b[3] * img.naturalHeight));
        const k = Math.min(42 / sw, 42 / sh);
        const tw = Math.max(1, Math.round(sw * k));
        const th = Math.max(1, Math.round(sh * k));
        c.width = tw;
        c.height = th;
        const ctx = c.getContext("2d");
        const fill = fillColor(node);
        if (fill !== "transparente") {
          ctx.fillStyle = fill === "blanco" ? "#ffffff" : "#000000";
          ctx.fillRect(0, 0, tw, th);
        }
        ctx.save();
        ctx.beginPath();
        if (zone.shape === "ellipse") {
          ctx.ellipse(tw / 2, th / 2, tw / 2, th / 2, 0, 0, Math.PI * 2);
        } else if (zone.shape === "free" && zone.points?.length) {
          zone.points.forEach((p, i) => {
            const px = b[2] ? ((p[0] - b[0]) / b[2]) * tw : 0;
            const py = b[3] ? ((p[1] - b[1]) / b[3]) * th : 0;
            i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          });
          ctx.closePath();
        } else {
          ctx.rect(0, 0, tw, th);
        }
        ctx.clip();
        ctx.drawImage(img, b[0] * img.naturalWidth, b[1] * img.naturalHeight, sw, sh, 0, 0, tw, th);
        ctx.restore();
        return c;
      }

      function imageBadge(zone) {
        const key = zone.img || st.active;
        if (key === WIRE) return "🔌";
        const idx = st.images.indexOf(key);
        return idx >= 0 ? String(idx + 1) : "?";
      }

      function renderStrip() {
        strip.innerHTML = "";
        st.zones.forEach((z, i) => {
          const chip = document.createElement("div");
          chip.style.cssText =
            "display:flex;flex-direction:column;gap:3px;padding:3px;border:1px solid " +
            (i === st.sel ? PALETTE[i % PALETTE.length] : "#444") +
            ";border-radius:4px;background:#1e1e1e;align-items:center;opacity:" + (z.hidden ? 0.45 : 1) + ";";

          const head = document.createElement("div");
          head.style.cssText = "display:flex;gap:3px;align-items:center;font:10px sans-serif;color:#bbb;";
          head.textContent = "img " + imageBadge(z);
          head.title = "Imagen de origen: " + (z.img || st.active || "-");
          chip.appendChild(head);

          const thumb = makeThumb(z);
          thumb.title = String(z.name || i + 1);
          thumb.addEventListener("click", () => {
            st.sel = i;
            if ((z.img || st.active) !== st.active) setActive(z.img || st.active);
            else { renderStrip(); draw(); }
          });
          chip.appendChild(thumb);

          const name = document.createElement("input");
          name.value = String(z.name ?? i + 1);
          name.style.cssText = "width:56px;font:11px sans-serif;text-align:center;background:#111;color:#eee;border:1px solid #444;border-radius:2px;";
          name.addEventListener("change", () => { z.name = name.value; writeZones(); });
          chip.appendChild(name);

          const row = document.createElement("div");
          row.style.cssText = "display:flex;gap:2px;";
          row.appendChild(mkIconBtn(z.hidden ? "◌" : "👁", "Mostrar/ocultar (solo visual)", () => {
            z.hidden = !z.hidden; renderStrip(); draw();
          }));
          row.appendChild(mkIconBtn("✕", "Borrar zona", () => {
            pushUndo();
            st.zones.splice(i, 1);
            st.sel = -1;
            writeZones(); renderStrip(); draw(); refit();
          }));
          row.appendChild(mkIconBtn("↑", "Subir", () => {
            if (i <= 0) return;
            pushUndo();
            [st.zones[i - 1], st.zones[i]] = [st.zones[i], st.zones[i - 1]];
            st.sel = i - 1;
            writeZones(); renderStrip(); draw();
          }));
          row.appendChild(mkIconBtn("↓", "Bajar", () => {
            if (i >= st.zones.length - 1) return;
            pushUndo();
            [st.zones[i + 1], st.zones[i]] = [st.zones[i], st.zones[i + 1]];
            st.sel = i + 1;
            writeZones(); renderStrip(); draw();
          }));
          chip.appendChild(row);

          strip.appendChild(chip);
        });
      }

      // ---------------- carga externa ----------------
      async function uploadBlob(blob, ext) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        const file = new File([blob], `mika_region_${stamp}.${ext}`, { type: blob.type || `image/${ext}` });
        const body = new FormData();
        body.append("image", file);
        body.append("type", "input");
        body.append("overwrite", "false");
        const res = await api.fetchApi("/upload/image", { method: "POST", body });
        if (!res.ok) throw new Error(`upload ${res.status}`);
        const data = await res.json();
        return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
      }

      async function withBlob(blob) {
        try {
          const ext = (blob.type || "image/png").split("/")[1]?.replace("jpeg", "jpg") || "png";
          const name = await uploadBlob(blob, ext);
          const w = findWidget(node, "archivo");
          if (w) {
            const vals = w.options?.values;
            if (Array.isArray(vals) && !vals.includes(name)) vals.push(name);
          }
          addImage(name);
        } catch (e) {
          alert("[Mika] No se pudo cargar la imagen: " + ((e && e.message) || e));
        }
      }

      function pickFile() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = true;
        input.style.display = "none";
        input.addEventListener("change", () => {
          const files = Array.from(input.files || []);
          input.value = "";
          files.forEach((file) => withBlob(file));
        });
        root.appendChild(input);
        input.click();
      }

      async function paste() {
        try {
          if (!navigator.clipboard?.read) throw new Error("el navegador no permite leer el portapapeles");
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const type = item.types.find((t) => t.startsWith("image/"));
            if (!type) continue;
            await withBlob(await item.getType(type));
            return;
          }
          alert("[Mika] No hay ninguna imagen en el portapapeles.");
        } catch (e) {
          alert("[Mika] No se pudo pegar: " + ((e && e.message) || e));
        }
      }

      // ---------------- toolbar ----------------
      const shapeBtns = {};
      for (const [id, glyph, title] of SHAPES) {
        const b = mkIconBtn(glyph, title, () => {
          st.shape = id;
          if (node.properties) node.properties.mikaRegionShape = id;
          for (const [k, btn] of Object.entries(shapeBtns)) {
            btn.style.outline = k === id ? "2px solid #4cc2ff" : "none";
          }
        });
        shapeBtns[id] = b;
        toolbar.appendChild(b);
      }
      for (const [k, btn] of Object.entries(shapeBtns)) {
        btn.style.outline = k === st.shape ? "2px solid #4cc2ff" : "none";
      }
      toolbar.appendChild(mkIconBtn("📂", "Agregar imagen (archivo)", pickFile));
      toolbar.appendChild(mkIconBtn("📋", "Pegar imagen del portapapeles", paste));
      toolbar.appendChild(mkIconBtn("↶", "Deshacer", undo));
      toolbar.appendChild(mkIconBtn("🗑", "Borrar zona seleccionada", () => {
        if (st.sel < 0) return;
        pushUndo();
        st.zones.splice(st.sel, 1);
        st.sel = -1;
        writeZones(); renderStrip(); draw(); refit();
      }));

      // ---------------- hooks ----------------
      // Envuelve `callback` una sola vez por widget (guarda el original en
      // `__mikaBase`) para que reconstruir el nodo no apile capas de callbacks.
      const hook = (w, cb) => {
        if (!w) return;
        const base = w.__mikaBase || (w.__mikaBase = w.callback);
        w.callback = function () {
          const r = base ? base.apply(this, arguments) : undefined;
          if (!node._mikaRegion) return r;
          try { cb(); } catch (e) { /* no-op */ }
          return r;
        };
      };
      hook(findWidget(node, "archivo"), () => {
        const name = String(findWidget(node, "archivo")?.value || "").trim();
        if (name && !st.images.includes(name)) addImage(name);
        else { st.imgSrc = null; loadImage(true); }
      });
      hook(findWidget(node, "relleno"), () => { renderStrip(); draw(); });
      hook(findWidget(node, "zonas"), () => {
        if (st.writing) return;
        st.zones = readZones(node);
        st.sel = -1;
        renderStrip(); draw();
      });
      hook(findWidget(node, "imagenes"), () => {
        if (st.writing) return;
        st.images = readImages(node);
        renderGallery();
        loadImage(true);
        renderStrip(); draw();
      });

      const origConn = node.onConnectionsChange;
      node.onConnectionsChange = function () {
        const r = origConn ? origConn.apply(this, arguments) : undefined;
        setTimeout(() => { refreshWire(); renderGallery(); loadImage(true); }, 80);
        return r;
      };

      node.onResize = () => { layout(); draw(); refit(); };

      node.onDragOver = (e) => {
        const dt = e?.dataTransfer;
        return !!dt && Array.from(dt.items || []).some((it) => it.kind === "file");
      };
      node.onDragDrop = (e) => {
        e?.preventDefault?.();
        const files = Array.from(e?.dataTransfer?.files || []);
        const imgs = files.filter((f) => (f.type || "").startsWith("image/"));
        (imgs.length ? imgs : files.slice(0, 1)).forEach((f) => withBlob(f));
        return imgs.length > 0 || files.length > 0;
      };

      if (node._mikaRegionKey) document.removeEventListener("keydown", node._mikaRegionKey, true);
      const onKey = (e) => {
        // Solo con este nodo seleccionado, para no robarle el Escape a la app.
        const selected = app.canvas?.selected_nodes && app.canvas.selected_nodes[node.id];
        if (!selected) return;
        if (e.key === "Escape") {
          if (st.drag) { st.drag = null; draw(); }
          else if (st.sel >= 0) { st.sel = -1; renderStrip(); draw(); }
          e.preventDefault();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
          e.preventDefault();
          undo();
        }
      };
      node._mikaRegionKey = onKey;
      document.addEventListener("keydown", onKey, true);

      // ---------------- montar ----------------
      const domWidget = node.addDOMWidget("mika_region_canvas", "div", root);
      domWidget.serialize = false;
      domWidget.computeSize = (width) => {
        const w = width ?? node.size?.[0] ?? 360;
        // Suma de los hijos (que no se encogen): así el nodo ENCOGE al pasar de
        // una imagen alta a una baja. `scrollHeight` no sirve: nunca baja del
        // alto actual del contenedor y dejaría un hueco abajo.
        const gh = gallery.offsetHeight || 0;
        const tb = toolbar.offsetHeight || 26;
        const sh = stage.offsetHeight || 0;
        const sp = strip.offsetHeight || 0;
        return [w, Math.max(140, Math.round(gh + tb + sh + sp + 3 * 6 + 12))];
      };
      node._mikaRegionDom = domWidget;

      if (!window.__mikaRegionExecListener) {
        window.__mikaRegionExecListener = true;
        api.addEventListener("execution_success", () => {
          (app.graph?._nodes || [])
            .filter((n) => n.type === NODE_NAME && n._mikaRegion)
            .forEach((n) => { n._mikaRegionRedraw?.(); });
        });
      }
      node._mikaRegionRedraw = () => { refreshWire(); renderGallery(); layout(); draw(); renderStrip(); refit(); };

      setTimeout(() => {
        // Compat: un workflow viejo guardaba la imagen en `archivo`.
        const legacyName = String(findWidget(node, "archivo")?.value || "").trim();
        if (!st.images.length && legacyName) { st.images = [legacyName]; writeImages(); }
        refreshWire();
        ensureActive();
        for (const z of st.zones) if (!z.img) z.img = st.active;  // compat: zonas viejas
        renderGallery();
        loadImage(true);
        renderStrip();
        draw();
        refit();
      }, 60);
    }

    // onNodeCreated y onConfigure se disparan seguido: programar el build con
    // debounce evita construirlo (y rearmar listeners) dos veces por carga.
    const scheduleBuild = (node) => {
      clearTimeout(node._mikaBuildTimer);
      node._mikaBuildTimer = setTimeout(() => build(node), 60);
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      scheduleBuild(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      scheduleBuild(this);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this._mikaRegionKey) {
        document.removeEventListener("keydown", this._mikaRegionKey, true);
        this._mikaRegionKey = null;
      }
      return onRemoved ? onRemoved.apply(this, arguments) : undefined;
    };
  },
});
