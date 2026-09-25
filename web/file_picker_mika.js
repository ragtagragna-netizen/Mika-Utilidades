import { app } from "/scripts/app.js";

app.registerExtension({
    name: "Comfy.FilePickerMika",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "FilePickerMika") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            const folderWidget = this.widgets.find((w) => w.name === "folder");
            const filenameWidget = this.widgets.find((w) => w.name === "filename");
            const node = this;

            const openPicker = async () => {
                const folder = (folderWidget?.value ?? "").trim();
                const resp = await fetch(
                    "/mika/file_picker/list?folder=" + encodeURIComponent(folder)
                );
                const data = await resp.json();
                const files = data.files || [];

                const isImage = (f) =>
                    /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f);
                // cached=1: la ventana solo lee la caché en disco, sin
                // generar miniaturas al vuelo (evita el pico de RAM).
                const thumbUrl = (f) =>
                    "/mika/file_picker/thumb?folder=" +
                    encodeURIComponent(folder) +
                    "&name=" + encodeURIComponent(f) +
                    "&size=192" +
                    "&cached=1";

                // Overlay
                const overlay = document.createElement("div");
                overlay.style.cssText =
                    "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center";

                const box = document.createElement("div");
                box.style.cssText =
                    "background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:8px;width:95vw;height:88vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.6)";

                const header = document.createElement("div");
                header.style.cssText =
                    "display:flex;align-items:center;gap:12px;padding:10px";

                const filter = document.createElement("input");
                filter.placeholder = `Buscar en ${files.length} archivos...`;
                filter.style.cssText =
                    "flex:1;padding:6px 8px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px";

                const imgOnlyLabel = document.createElement("label");
                imgOnlyLabel.style.cssText =
                    "display:flex;align-items:center;gap:5px;white-space:nowrap;cursor:pointer;user-select:none";
                const imgOnly = document.createElement("input");
                imgOnly.type = "checkbox";
                imgOnly.checked = true;
                imgOnlyLabel.appendChild(imgOnly);
                imgOnlyLabel.appendChild(document.createTextNode("Solo imágenes"));

                // Selector de extensión, construido con los formatos que hay
                // realmente en la carpeta.
                const extSel = document.createElement("select");
                extSel.style.cssText =
                    "padding:6px 4px;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px";
                const exts = [...new Set(
                    files
                        .filter((f) => f.includes("."))
                        .map((f) => f.slice(f.lastIndexOf(".")).toLowerCase())
                )].sort();
                extSel.appendChild(new Option("Todos", ""));
                for (const e of exts) extSel.appendChild(new Option(e, e));

                header.appendChild(filter);
                header.appendChild(extSel);
                header.appendChild(imgOnlyLabel);

                const list = document.createElement("div");
                list.style.cssText =
                    "overflow-y:auto;padding:0 10px;flex:1;position:relative";

                // Grid virtualizada: solo existen en el DOM (y decodificadas)
                // las celdas visibles. Con carpetas de miles de imágenes la
                // RAM se mantiene plana.
                const COLS = 7, GAP = 10, LABEL_H = 20, PAD = 4;
                const spacer = document.createElement("div");
                spacer.style.cssText = "position:relative;width:100%";
                list.appendChild(spacer);

                let filtered = [];
                const refreshFiltered = () => {
                    const t = filter.value.toLowerCase();
                    const ext = extSel.value;
                    const imgOnlyOn = imgOnly.checked;
                    filtered = files.filter((f) =>
                        (!t || f.toLowerCase().includes(t)) &&
                        (!ext || f.toLowerCase().endsWith(ext)) &&
                        (!imgOnlyOn || isImage(f))
                    );
                };

                const closePicker = () => overlay.remove();

                const renderWindow = () => {
                    const width = list.clientWidth - 20; // padding lateral
                    if (width <= 0) return;
                    const cellW = Math.floor((width - GAP * (COLS - 1)) / COLS);
                    const cellH = cellW + LABEL_H + PAD * 2;
                    const rowH = cellH + GAP;
                    const rows = Math.ceil(filtered.length / COLS);
                    spacer.style.height = rows * rowH - GAP + "px";
                    spacer.innerHTML = "";

                    if (filtered.length === 0) {
                        const empty = document.createElement("div");
                        empty.textContent = data.error
                            ? `⚠ ${data.error}`
                            : "Sin resultados";
                        empty.style.cssText = "padding:10px;color:#999";
                        spacer.appendChild(empty);
                        return;
                    }

                    const firstRow = Math.max(
                        0, Math.floor(list.scrollTop / rowH) - 1);
                    const visRows = Math.ceil(list.clientHeight / rowH) + 2;
                    const start = firstRow * COLS;
                    const end = Math.min(
                        filtered.length, (firstRow + visRows) * COLS);

                    for (let i = start; i < end; i++) {
                        const f = filtered[i];
                        const col = i % COLS;
                        const row = Math.floor(i / COLS);
                        const item = document.createElement("div");
                        item.title = f;
                        item.style.cssText =
                            "position:absolute;cursor:pointer;border-radius:4px;background:#2a2a2a;padding:4px;text-align:center;" +
                            `left:${col * (cellW + GAP)}px;top:${row * rowH}px;` +
                            `width:${cellW}px;height:${cellH}px;box-sizing:border-box`;
                        item.onmouseenter = () => (item.style.background = "#3a3a3a");
                        item.onmouseleave = () => (item.style.background = "#2a2a2a");

                        if (isImage(f)) {
                            const img = document.createElement("img");
                            img.src = thumbUrl(f);
                            img.loading = "lazy";
                            // Sin caché aún: quita la miniatura rota, queda
                            // solo el nombre (precachear primero con ⚡).
                            img.onerror = () => img.remove();
                            // contain + fondo cuadriculado = imagen completa
                            // sin recortar, transparente donde el PNG tenga alfa.
                            img.style.cssText =
                                `width:100%;height:${cellW}px;object-fit:contain;border-radius:3px;display:block;` +
                                "background:repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50%/16px 16px";
                            item.appendChild(img);
                        }

                        const label = document.createElement("div");
                        label.textContent = f;
                        label.style.cssText =
                            "font-size:11px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
                        item.appendChild(label);

                        item.onclick = () => {
                            if (filenameWidget) {
                                filenameWidget.value = f;
                                if (typeof filenameWidget.callback === "function") {
                                    filenameWidget.callback(f);
                                }
                            }
                            node.setDirtyCanvas(true, true);
                            closePicker();
                        };
                        spacer.appendChild(item);
                    }
                };

                let rafId = 0;
                const requestRender = () => {
                    if (rafId) return;
                    rafId = requestAnimationFrame(() => {
                        rafId = 0;
                        renderWindow();
                    });
                };
                list.addEventListener("scroll", requestRender);

                // Recuerda la posición del scroll por carpeta.
                const scrollKey = "FilePickerMika.scroll." + folder;
                let scrollSaveTimer = null;
                list.addEventListener("scroll", () => {
                    if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
                    scrollSaveTimer = setTimeout(() => {
                        localStorage.setItem(scrollKey, String(list.scrollTop));
                    }, 150);
                });

                const refresh = () => { refreshFiltered(); requestRender(); };
                filter.oninput = refresh;
                imgOnly.onchange = refresh;
                extSel.onchange = refresh;

                overlay.onclick = (e) => {
                    if (e.target === overlay) closePicker();
                };

                box.appendChild(header);
                box.appendChild(list);
                overlay.appendChild(box);
                document.body.appendChild(overlay);

                // Con el overlay ya en el DOM, renderiza y restaura el scroll.
                refreshFiltered();
                renderWindow();
                const saved = parseFloat(localStorage.getItem(scrollKey)) || 0;
                if (saved > 0) {
                    list.scrollTop = saved;
                    renderWindow();
                }
                filter.focus();
            };

            this.addWidget("button", "📁 Elegir archivo", null, () => {
                openPicker().catch((err) => console.error("FilePickerMika:", err));
            });

            let caching = false;
            this.addWidget("button", "⚡ Precachear carpeta", null, async () => {
                if (caching) return;
                caching = true;
                const btn = node.widgets.find(
                    (w) => w.type === "button" && w.name.startsWith("⚡")
                );
                const setLabel = (t) => {
                    if (btn) { btn.name = t; node.setDirtyCanvas(true, true); }
                };
                const folder = (folderWidget?.value ?? "").trim();
                try {
                    // Lanza el precacheo en el servidor y muestra progreso.
                    const job = fetch(
                        "/mika/file_picker/cache?folder=" +
                        encodeURIComponent(folder)
                    );
                    const poll = setInterval(async () => {
                        try {
                            const s = await (
                                await fetch(
                                    "/mika/file_picker/cache_status?folder=" +
                                    encodeURIComponent(folder)
                                )
                            ).json();
                            if (s.total > 0) {
                                setLabel(`⚡ Cacheando ${s.done}/${s.total}...`);
                            }
                        } catch (_) { /* reintenta */ }
                    }, 500);
                    await job;
                    clearInterval(poll);
                    setLabel("⚡ Precachear carpeta");
                } catch (err) {
                    console.error("FilePickerMika:", err);
                    setLabel("⚡ Precachear carpeta (error)");
                } finally {
                    caching = false;
                }
            });

            return r;
        };
    },
});
