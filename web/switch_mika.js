import { app } from "/scripts/app.js";

// Inputs dinámicos para SwitchMika.
// Adaptado de ComfyUI-EZ-AF-Nodes (a su vez basado en Bjornulf nodes).

app.registerExtension({
    name: "Comfy.SwitchMika",
    async nodeCreated(node) {
        if (node.comfyClass !== "SwitchMika") return;

        const updateInputs = () => {
            const initialWidth = node.size[0];
            const numInputsWidget = node.widgets.find(w => w.name === "number_of_inputs");
            if (!numInputsWidget) return;

            const numInputs = numInputsWidget.value;

            if (!node.inputs) node.inputs = [];

            const existingInputs = node.inputs.filter(i => i.name.startsWith("input_"));

            if (existingInputs.length < numInputs) {
                for (let i = existingInputs.length + 1; i <= numInputs; i++) {
                    const inputName = `input_${i}`;
                    if (!node.inputs.find(i2 => i2.name === inputName)) {
                        node.addInput(inputName, "*");
                    }
                }
            } else {
                node.inputs = node.inputs.filter(
                    i => !i.name.startsWith("input_") ||
                        parseInt(i.name.split("_")[1]) <= numInputs
                );
            }

            node.setSize(node.computeSize());
            node.size[0] = initialWidth; // ancho fijo
        };

        const numInputsWidget = node.widgets.find(w => w.name === "number_of_inputs");
        if (numInputsWidget) {
            node.widgets = [numInputsWidget, ...node.widgets.filter(w => w !== numInputsWidget)];
            numInputsWidget.callback = () => {
                updateInputs();
                app.graph.setDirtyCanvas(true);
            };
        }

        setTimeout(updateInputs, 0);
    },
});
