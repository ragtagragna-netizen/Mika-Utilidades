import { app } from "/scripts/app.js";

const DEFAULT_VISIBLE = 6;

app.registerExtension({
    name: "Comfy.ScoreListExtendable",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ScoreListExtendable") return;

        function resize(node) {
            const size = node.computeSize();
            node.setSize([node.size[0], size[1]]);
            node.setDirtyCanvas(true, true);
        }

        function sortPool(node) {
            node.hiddenScorePairs.sort((a, b) => a.index - b.index);
        }

        function defaultLabel(index) {
            return `Opción ${index}`;
        }

        function showNext(node) {
            sortPool(node);
            const pair = node.hiddenScorePairs.shift();
            if (!pair) return null;

            // Insertar justo antes de los botones +/-, para que estos
            // siempre queden abajo de todo. El widget de nombre va
            // primero, y justo debajo el widget numérico.
            const buttonsIdx = node.widgets.indexOf(node.addButtonWidget);
            const insertAt = buttonsIdx === -1 ? node.widgets.length : buttonsIdx;
            node.widgets.splice(insertAt, 0, pair.name, pair.value);
            node.visibleScorePairs.push(pair);
            return pair;
        }

        function hideLast(node) {
            if (node.visibleScorePairs.length <= 1) return;
            const pair = node.visibleScorePairs.pop();

            for (const w of [pair.name, pair.value]) {
                const idx = node.widgets.indexOf(w);
                if (idx !== -1) node.widgets.splice(idx, 1);
            }

            // Al ocultar una fila la dejamos "en blanco" (valor 0, nombre
            // por defecto), así si se vuelve a mostrar más adelante
            // arranca de cero en vez de con datos viejos.
            pair.value.value = 0;
            pair.name.value = defaultLabel(pair.index);

            node.hiddenScorePairs.push(pair);
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            // ComfyUI ya creó automáticamente, por cada entrada opcional
            // declarada en Python, un campo de texto "nombre_N" seguido de
            // un campo numérico "N" (N = 1..50). Los agrupamos en pares
            // nombre+valor y dejamos visibles solo los primeros
            // DEFAULT_VISIBLE.
            const valueWidgets = this.widgets.filter((w) => /^\d+$/.test(w.name));
            const pairs = valueWidgets
                .map((valueWidget) => {
                    const index = parseInt(valueWidget.name, 10);
                    const nameWidget = this.widgets.find((w) => w.name === `nombre_${index}`);
                    return nameWidget ? { index, name: nameWidget, value: valueWidget } : null;
                })
                .filter(Boolean)
                .sort((a, b) => a.index - b.index);

            this.visibleScorePairs = pairs.slice(0, DEFAULT_VISIBLE);
            this.hiddenScorePairs = pairs.slice(DEFAULT_VISIBLE);

            for (const pair of this.hiddenScorePairs) {
                for (const w of [pair.name, pair.value]) {
                    const idx = this.widgets.indexOf(w);
                    if (idx !== -1) this.widgets.splice(idx, 1);
                }
            }

            this.addButtonWidget = this.addWidget(
                "button",
                "+ Agregar opción",
                null,
                () => {
                    showNext(this);
                    resize(this);
                }
            );

            this.removeButtonWidget = this.addWidget(
                "button",
                "− Quitar opción",
                null,
                () => {
                    hideLast(this);
                    resize(this);
                }
            );

            resize(this);

            return r;
        };

        // Guarda cuántas filas quedaron visibles.
        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            const r = onSerialize ? onSerialize.apply(this, arguments) : undefined;
            o.visibleScoreCount = this.visibleScorePairs.length;
            return r;
        };

        // Al recargar el workflow: primero reconstruye la cantidad de filas
        // visibles guardada, y luego reasigna los valores guardados
        // (litegraph ya había intentado asignarlos antes, con menos widgets
        // de los que hacían falta).
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;

            const target = info.visibleScoreCount ?? DEFAULT_VISIBLE;

            while (this.visibleScorePairs.length < target && this.hiddenScorePairs.length > 0) {
                showNext(this);
            }
            while (this.visibleScorePairs.length > target && this.visibleScorePairs.length > 1) {
                hideLast(this);
            }

            const savedValues = info.widgets_values || [];
            for (let i = 0; i < this.widgets.length && i < savedValues.length; i++) {
                this.widgets[i].value = savedValues[i];
            }

            resize(this);

            return r;
        };
    },
});
