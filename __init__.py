from functools import partial

import comfy.samplers
from comfy.samplers import SchedulerHandler, SCHEDULER_HANDLERS, SCHEDULER_NAMES

# beta_1_1: beta_scheduler con alpha=1.0, beta=1.0 (mismo patron que
# RES4LYF usa para "beta57"). Aparece en todos los KSampler del core.
if "beta_1_1" not in SCHEDULER_HANDLERS:
    SCHEDULER_HANDLERS["beta_1_1"] = SchedulerHandler(
        handler=partial(comfy.samplers.beta_scheduler, alpha=1.0, beta=1.0),
        use_ms=True,
    )
    SCHEDULER_NAMES.append("beta_1_1")

from .nodes import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
    _mika_tangent_schedule,
)

# shifted_tangent: el scheduler del sampler tangent. Se registra en el menú de
# schedulers de ComfyUI con la matemática del propio paquete, así los KSampler
# lo tienen aunque was-node-suite no esté instalado. Si ya está registrado (lo
# hace WAS), se respeta el que haya cargado primero: la curva es la misma.
if "shifted_tangent" not in SCHEDULER_HANDLERS:
    SCHEDULER_HANDLERS["shifted_tangent"] = SchedulerHandler(
        handler=_mika_tangent_schedule,
    )
    if "shifted_tangent" not in SCHEDULER_NAMES:
        SCHEDULER_NAMES.append("shifted_tangent")

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
