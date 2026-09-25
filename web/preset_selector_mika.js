import { app } from "/scripts/app.js";

// Prompt Preset Selector-Mika / Stepper: si absolute_path apunta a una
// carpeta, el dropdown preset_file se rellena con los archivos (.txt,
// .yaml, .yml, recursivo) de esa carpeta. Vacío -> carpeta dedicada
// presets/ (lo que devuelve el backend por defecto).
app.registerExtension({
    name: "Comfy.PresetSelectorMika",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (
            nodeData.name !== "PromptPresetSelectorMika" &&
            nodeData.name !== "PromptPresetStepperMika"
        ) return;

        const NO_FILES = "(No preset files found)";

        async function refreshOptions(node, keepValue = true) {
            const folderWidget = node.widgets.find((w) => w.name === "absolute_path");
            const fileWidget = node.widgets.find((w) => w.name === "preset_file");
            if (!folderWidget || !fileWidget) return;

            const folder = (folderWidget.value ?? "").trim().replace(/["']/g, "");
            if (folder && /[.][\w]+$/.test(folder)) return; // es un archivo suelto

            try {
                const resp = await fetch(
                    "/mika/preset_selector/list?folder=" + encodeURIComponent(folder)
                );
                const data = await resp.json();
                const files =
                    data.files && data.files.length ? data.files : [NO_FILES];

                fileWidget.options = Object.assign({}, fileWidget.options, {
                    values: files,
                });

                if (!keepValue || !files.includes(fileWidget.value)) {
                    fileWidget.value = files[0];
                }

                node.setDirtyCanvas(true, true);
            } catch (err) {
                console.error("PresetSelectorMika:", err);
            }
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            const folderWidget = this.widgets.find((w) => w.name === "absolute_path");
            if (folderWidget) {
                const oldCallback = folderWidget.callback;
                folderWidget.callback = (value) => {
                    if (oldCallback) oldCallback(value);
                    refreshOptions(this, false);
                };
            }

            setTimeout(() => refreshOptions(this, true), 0);

            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            setTimeout(() => refreshOptions(this, true), 0);
            return r;
        };

        // El Stepper devuelve el próximo start_index en el mensaje ui;
        // hay que aplicarlo al widget para que el auto-avance funcione
        // (igual que en Text Line Stepper-Mika).
        if (nodeData.name === "PromptPresetStepperMika") {
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                onExecuted?.apply(this, arguments);
                const next = message?.start_index?.[0];
                if (next === undefined) return;
                const widget = this.widgets?.find((w) => w.name === "start_index");
                if (widget) {
                    widget.value = next;
                    if (widget.callback) widget.callback(widget.value);
                    this.setDirtyCanvas(true, true);
                }
            };
        }
    },
});
