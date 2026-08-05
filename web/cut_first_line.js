import { app } from "/scripts/app.js";

app.registerExtension({
    name: "Comfy.StringSelectorCut",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "StringSelectorCut") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            const stringsWidget = this.widgets.find((w) => w.name === "strings");

            const copyToClipboard = (text) => {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).catch((err) => {
                        console.error("No se pudo copiar al portapapeles:", err);
                    });
                } else {
                    // Fallback para contextos sin permisos de portapapeles / sin HTTPS.
                    const ta = document.createElement("textarea");
                    ta.value = text;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    try {
                        document.execCommand("copy");
                    } catch (err) {
                        console.error("No se pudo copiar al portapapeles (fallback):", err);
                    }
                    document.body.removeChild(ta);
                }
            };

            this.addWidget(
                "button",
                "✂ Cortar primera línea",
                null,
                () => {
                    if (!stringsWidget) return;

                    const value = stringsWidget.value ?? "";
                    const idx = value.indexOf("\n");

                    // Línea que se corta y texto que queda en el campo.
                    let cutLine, newValue;
                    if (idx === -1) {
                        cutLine = value;
                        newValue = "";
                    } else {
                        cutLine = value.slice(0, idx);
                        newValue = value.slice(idx + 1);
                    }

                    // Se añade el salto de línea al final de lo copiado, así al pegar
                    // en otro nodo (por ejemplo un acumulador de lista) ya queda como
                    // renglón propio, sin tener que presionar Enter.
                    const clipboardText = cutLine + "\n";

                    stringsWidget.value = newValue;

                    if (typeof stringsWidget.callback === "function") {
                        stringsWidget.callback(newValue);
                    }

                    this.setDirtyCanvas(true, true);

                    copyToClipboard(clipboardText);
                }
            );

            return r;
        };
    },
});
