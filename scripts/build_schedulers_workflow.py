"""Genera workflows/custom_samplers_schedulers_mika.json.

Un workflow de comparación: un Custom Sampler Scheduler-Mika por cada
scheduler del menú (los 7 del core + beta_1_1 y shifted_tangent de este
paquete), todos con sus valores por default, alimentados por una única
Sigma Curve-Mika conectada a los 7 inputs de la curva de cada uno.

Uso (desde la raíz del paquete):
  python scripts\\build_schedulers_workflow.py
"""

import json
import os

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                        "workflows", "custom_samplers_schedulers_mika.json")

CHECKPOINT = "anima_baseV10.safetensors"
SCHEDULERS = [
    "normal", "karras", "exponential", "sgm_uniform", "simple",
    "ddim_uniform", "beta", "beta_1_1", "shifted_tangent",
]

#: Valores por default de los widgets del Custom Sampler Scheduler-Mika,
#: en orden de widgets (seed, control, steps, cfg, sampler, scheduler,
#: denoise, add_noise, los 7 de la curva y el combo de preset).
SAMPLER_WIDGETS = [
    0, "randomize", 25, 4.0, "euler_ancestral", None, 1.0, True,
    1.0, 0.55, 0.0, 0.4, 0.55, 0.2, 0.2, "personalizado",
]
CURVE_WIDGETS = [1.0, 0.55, 0.0, 0.4, 0.55, 0.2, 0.2]

#: Nombre y tipo de cada widget-input del sampler (después de las 5
#: conexiones fijas). La curva entra por los 7 del medio; el preset queda
#: como widget sin conectar ("personalizado").
SAMPLER_WIDGET_INPUTS = [
    ("seed", "INT"), ("steps", "INT"), ("cfg", "FLOAT"),
    ("sampler_name", "COMBO"), ("scheduler", "COMBO"), ("denoise", "FLOAT"),
    ("add_noise", "BOOLEAN"), ("start", "FLOAT"), ("middle", "FLOAT"),
    ("end", "FLOAT"), ("pivot_1", "FLOAT"), ("pivot_2", "FLOAT"),
    ("slope_1", "FLOAT"), ("slope_2", "FLOAT"), ("preset", "COMBO"),
]
CURVE_KEYS = ["start", "middle", "end", "pivot_1", "pivot_2", "slope_1", "slope_2"]


def _widget_input(name, kind):
    # El frontend serializa los widgets como inputs con marcador "widget";
    # así un link puede caer sobre el valor sin perder el widget.
    return {"name": name, "type": kind, "widget": {"name": name}, "link": None}


def build():
    nodes = []
    links = []
    next_link = [1]

    def add_link(origin_id, origin_slot, target_id, target_slot, kind):
        link_id = next_link[0]
        next_link[0] += 1
        links.append([link_id, origin_id, origin_slot, target_id, target_slot, kind])
        return link_id

    # --- Carga y condiciones ---
    nodes.append({
        "id": 1, "type": "CheckpointLoaderSimple", "pos": [-1750, 180],
        "size": [340, 100], "flags": {}, "order": 0, "mode": 0,
        "inputs": [],
        "outputs": [
            {"name": "MODEL", "type": "MODEL", "links": []},
            {"name": "CLIP", "type": "CLIP", "links": []},
            {"name": "VAE", "type": "VAE", "links": []},
        ],
        "properties": {"Node name for S&R": "CheckpointLoaderSimple",
                       "cnr_id": "comfy-core", "ver": "0.44.2"},
        "widgets_values": [CHECKPOINT],
    })
    for nid, pos_y, title in ((2, 60, "positive"), (3, 380, "negative")):
        nodes.append({
            "id": nid, "type": "CLIPTextEncode", "pos": [-1340, pos_y],
            "size": [400, 180], "flags": {}, "order": 1, "mode": 0,
            "inputs": [{"name": "clip", "type": "CLIP", "link":
                        add_link(1, 1, nid, 0, "CLIP")}],
            "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING",
                         "links": []}],
            "properties": {"Node name for S&R": "CLIPTextEncode",
                           "cnr_id": "comfy-core", "ver": "0.44.2"},
            "widgets_values": [""],
            "title": title,
        })
    nodes.append({
        "id": 4, "type": "EmptyLatentImage", "pos": [-1340, 640],
        "size": [320, 110], "flags": {}, "order": 2, "mode": 0,
        "inputs": [],
        "outputs": [{"name": "LATENT", "type": "LATENT", "links": []}],
        "properties": {"Node name for S&R": "EmptyLatentImage",
                       "cnr_id": "comfy-core", "ver": "0.44.2"},
        "widgets_values": [512, 512, 1],
    })

    # --- La curva única ---
    curve_out_links = [[] for _ in CURVE_KEYS]
    nodes.append({
        "id": 5, "type": "SigmaCurveMika", "pos": [-1750, 420],
        "size": [300, 260], "flags": {}, "order": 3, "mode": 0,
        "inputs": [],
        "outputs": [{"name": name, "type": "FLOAT", "links": curve_out_links[i]}
                    for i, name in enumerate(CURVE_KEYS)],
        "properties": {"Node name for S&R": "SigmaCurveMika"},
        "widgets_values": list(CURVE_WIDGETS),
        "widgets_values_named": dict(zip(CURVE_KEYS, CURVE_WIDGETS)),
    })

    def out_links(node_id, slot):
        for n in nodes:
            if n["id"] == node_id:
                return n["outputs"][slot]["links"]
        raise KeyError(node_id)

    # --- Un sampler por scheduler + su preview ---
    first_id = 10
    for i, sched in enumerate(SCHEDULERS):
        col, row = i % 3, i // 3
        x = -820 + col * 640
        y = 60 + row * 900
        sid = first_id + i
        pid = 20 + i

        widgets = list(SAMPLER_WIDGETS)
        widgets[5] = sched  # el scheduler es lo único que cambia por nodo
        # Sockets (0..4) y widget-inputs en orden de declaración (5..18).
        # Los links se crean con el slot final ya conocido.
        widgets_inputs = [_widget_input(name, kind)
                          for name, kind in SAMPLER_WIDGET_INPUTS]
        curve_start_slot = 5 + 7  # después de seed..add_noise
        curve_links = {}
        for off, key in enumerate(CURVE_KEYS):
            curve_links[key] = add_link(5, off, sid, curve_start_slot + off, "FLOAT")
            curve_out_links[off].append(curve_links[key])
        img_link = add_link(sid, 0, pid, 0, "IMAGE")

        inputs = [
            {"name": "model", "type": "MODEL",
             "link": add_link(1, 0, sid, 0, "MODEL")},
            {"name": "positive", "type": "CONDITIONING",
             "link": add_link(2, 0, sid, 1, "CONDITIONING")},
            {"name": "negative", "type": "CONDITIONING",
             "link": add_link(3, 0, sid, 2, "CONDITIONING")},
            {"name": "latent_image", "type": "LATENT",
             "link": add_link(4, 0, sid, 3, "LATENT")},
            {"name": "vae", "type": "VAE",
             "link": add_link(1, 2, sid, 4, "VAE")},
        ]
        for j, (name, _kind) in enumerate(SAMPLER_WIDGET_INPUTS):
            inp = widgets_inputs[j]
            inp["link"] = curve_links.get(name)  # solo los 7 de la curva
            inputs.append(inp)

        nodes.append({
            "id": sid, "type": "CustomSamplerSchedulerMika",
            "pos": [x, y], "size": [320, 560], "flags": {}, "order": 4 + i,
            "mode": 0, "inputs": inputs,
            "outputs": [
                {"name": "image", "type": "IMAGE", "links": [img_link]},
                {"name": "latent", "type": "LATENT", "links": None},
            ],
            "properties": {"Node name for S&R": "CustomSamplerSchedulerMika"},
            "widgets_values": widgets,
            "widgets_values_named": dict(zip(
                ["seed", "control_after_generate", "steps", "cfg",
                 "sampler_name", "scheduler", "denoise", "add_noise",
                 *CURVE_KEYS, "preset"], widgets)),
            "title": f"Scheduler: {sched}",
        })
        nodes.append({
            "id": pid, "type": "PreviewImage", "pos": [x + 30, y + 640],
            "size": [280, 246], "flags": {}, "order": 13 + i, "mode": 0,
            "inputs": [{"name": "images", "type": "IMAGE", "link": img_link}],
            "outputs": [],
            "properties": {"Node name for S&R": "PreviewImage",
                           "cnr_id": "comfy-core", "ver": "0.44.2"},
            "widgets_values": [],
            "title": f"Preview: {sched}",
        })

    # Sanity: cada salida de la curva debe tener 9 links.
    for i, key in enumerate(CURVE_KEYS):
        assert len(curve_out_links[i]) == len(SCHEDULERS), (key, curve_out_links[i])

    return {
        "id": "b2f4c1a0-0000-4000-8000-schedulers",
        "revision": 0,
        "last_node_id": 20 + len(SCHEDULERS) - 1,
        "last_link_id": next_link[0] - 1,
        "nodes": nodes,
        "links": links,
        "groups": [],
        "definitions": {"subgraphs": []},
        "config": {},
        "extra": {"frontendVersion": "1.57.6"},
        "version": 0.4,
    }


def main():
    workflow = build()
    out = os.path.abspath(OUT_PATH)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(workflow, f, ensure_ascii=False, indent=2)
    print(f"{len(SCHEDULERS)} samplers -> {out}")


if __name__ == "__main__":
    main()
