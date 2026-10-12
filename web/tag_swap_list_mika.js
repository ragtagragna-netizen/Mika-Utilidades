import { app } from "/scripts/app.js";

// -----------------------------------------------------------------------
// Mika · Tag Swap List-Mika
// -----------------------------------------------------------------------
// La lista de reemplazos (repl_1..N) se expande manualmente con
// replacement_count: solo los primeros N visibles cuentan en el
// backend. Los ocultos conservan su valor serializado.
// Igual patrón que TextReplaceDynamic (pares) pero con items simples.
// -----------------------------------------------------------------------

const DEFAULT_VISIBLE = 3;
const MAX_ITEMS = 30;

app.registerExtension({
	name: "Mika.TagSwapList",

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name !== "TagSwapListMika") return;

		function clampCount(value) {
			if (Array.isArray(value)) {
				value = value.length ? value[0] : DEFAULT_VISIBLE;
			}

			let n = parseInt(value, 10);

			if (Number.isNaN(n)) {
				n = DEFAULT_VISIBLE;
			}

			return Math.max(1, Math.min(MAX_ITEMS, n));
		}

		function relayout(node) {
			try {
				const size = node.computeSize();
				node.setSize([node.size[0], size[1]]);
			} catch (e) {
				/* no-op */
			}

			try {
				if (typeof node.onResize === "function") node.onResize(node.size);
			} catch (e) {
				/* no-op */
			}

			try {
				node.setDirtyCanvas(true, true);
			} catch (e) {
				/* no-op */
			}

			try {
				app.graph?.setDirtyCanvas?.(true, true);
			} catch (e) {
				/* no-op */
			}

			try {
				app.canvas?.setDirty?.(true, true);
			} catch (e) {
				/* no-op */
			}

			try {
				node.graph?.change?.();
			} catch (e) {
				/* no-op */
			}
		}

		function sortPool(node) {
			node.hiddenRepl.sort((a, b) => a.index - b.index);
		}

		function anchorIndex(node) {
			const countIdx = node.widgets.indexOf(node.countWidget);

			if (countIdx !== -1) return countIdx;

			return node.widgets.length;
		}

		function setVisibleCount(node, target, syncWidget = true) {
			target = clampCount(target);

			sortPool(node);

			while (
				node.visibleRepl.length < target &&
				node.hiddenRepl.length > 0
			) {
				const item = node.hiddenRepl.shift();

				node.widgets.splice(anchorIndex(node), 0, item.widget);
				node.visibleRepl.push(item);
			}

			while (
				node.visibleRepl.length > target &&
				node.visibleRepl.length > 1
			) {
				const item = node.visibleRepl.pop();
				const idx = node.widgets.indexOf(item.widget);

				if (idx !== -1) {
					node.widgets.splice(idx, 1);
				}

				node.hiddenRepl.push(item);
			}

			sortPool(node);

			if (syncWidget && node.countWidget) {
				node.countWidget.value = node.visibleRepl.length;
			}

			relayout(node);
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;

		nodeType.prototype.onNodeCreated = function () {
			const r = onNodeCreated
				? onNodeCreated.apply(this, arguments)
				: undefined;

			this.countWidget =
				this.widgets.find((w) => w.name === "replacement_count") ?? null;

			if (this.countWidget) {
				this.countWidget.label = "replacement_count";
				this.countWidget.options = Object.assign(
					{},
					this.countWidget.options,
					{
						min: 1,
						max: MAX_ITEMS,
						step: 1,
					}
				);
			}

			const items = this.widgets
				.filter((w) => w.name && /^repl_\d+$/.test(w.name))
				.map((w) => ({
					index: parseInt(w.name.split("_")[1], 10),
					widget: w,
				}))
				.sort((a, b) => a.index - b.index);

			const initial = clampCount(
				this.countWidget?.value ?? DEFAULT_VISIBLE
			);

			this.visibleRepl = items.slice(0, initial);
			this.hiddenRepl = items.slice(initial);

			for (const item of this.hiddenRepl) {
				const idx = this.widgets.indexOf(item.widget);

				if (idx !== -1) {
					this.widgets.splice(idx, 1);
				}
			}

			const oldCallback = this.countWidget?.callback;

			this._mikaSwapChanging = false;

			if (this.countWidget) {
				this.countWidget.callback = (value) => {
					if (oldCallback) {
						try {
							oldCallback(value);
						} catch (e) {
							/* no-op */
						}
					}

					if (this._mikaSwapChanging) return;

					this._mikaSwapChanging = true;

					try {
						const count = clampCount(value);

						if (this.countWidget.value !== count) {
							this.countWidget.value = count;
						}

						setVisibleCount(this, count, false);
					} finally {
						this._mikaSwapChanging = false;
					}
				};
			}

			setVisibleCount(this, initial, true);

			return r;
		};

		const onSerialize = nodeType.prototype.onSerialize;

		nodeType.prototype.onSerialize = function (o) {
			const r = onSerialize
				? onSerialize.apply(this, arguments)
				: undefined;

			sortPool(this);

			const count = this.countWidget
				? clampCount(this.countWidget.value)
				: this.visibleRepl.length;

			o.replacement_count = count;
			o.visibleSwapCount = count;

			const vals = {};

			for (const item of [...this.visibleRepl, ...this.hiddenRepl]) {
				vals[`repl_${item.index}`] = item.widget.value;
			}

			o.mikaSwapValues = vals;

			return r;
		};

		const onConfigure = nodeType.prototype.onConfigure;

		nodeType.prototype.onConfigure = function (info) {
			const r = onConfigure
				? onConfigure.apply(this, arguments)
				: undefined;

			if (info.mikaSwapValues) {
				for (const item of [...this.visibleRepl, ...this.hiddenRepl]) {
					const key = `repl_${item.index}`;

					if (key in info.mikaSwapValues) {
						item.widget.value = info.mikaSwapValues[key];
					}
				}
			} else {
				const sv = info.widgets_values || [];

				for (
					let i = 0;
					i < this.widgets.length && i < sv.length;
					i++
				) {
					this.widgets[i].value = sv[i];
				}
			}

			const target =
				info.replacement_count ??
				info.visibleSwapCount ??
				this.countWidget?.value ??
				DEFAULT_VISIBLE;

			setVisibleCount(this, target, true);

			return r;
		};
	},
});
