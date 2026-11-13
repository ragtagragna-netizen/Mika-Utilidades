"""AnyLine Lineart (AnyLineArtPreprocessor_aux) — vendorizado de comfyui_controlnet_aux.

Combina TED (`MTEED.pth`) con Standard Lineart (el `merge_with_lineart="lineart_standard"`
que usa el workflow por defecto). Parámetros fijos, como en el workflow.
"""

import numpy as np
from PIL import Image

from .teed import TEDDetector
from .lineart_standard import LineartStandardDetector
from .util import common_input_validate


def get_intensity_mask(image_array, lower_bound, upper_bound):
    mask = image_array[:, :, 0]
    mask = np.where((mask >= lower_bound) & (mask <= upper_bound), mask, 0)
    mask = np.expand_dims(mask, 2).repeat(3, axis=2)
    return mask


def combine_layers(base_layer, top_layer):
    mask = top_layer.astype(bool)
    temp = 1 - (1 - top_layer) * (1 - base_layer)
    result = base_layer * (~mask) + temp * mask
    return result


class AnyLinePreprocessor:
    def __init__(self, mteed, lineart_standard):
        self.mteed = mteed
        self.lineart_standard = lineart_standard
        self.device = "cpu"

    @classmethod
    def from_pretrained(cls):
        return cls(
            TEDDetector.from_pretrained("TheMistoAI/MistoLine", "MTEED.pth", subfolder="Anyline"),
            LineartStandardDetector(),
        )

    def to(self, device):
        self.mteed.to(device)
        self.device = device
        return self

    def __call__(self, input_image, detect_resolution=512, output_type="pil", upscale_method="INTER_CUBIC",
                 lineart_lower_bound=0, lineart_upper_bound=1, object_min_size=36, object_connectivity=1, **kwargs):
        from skimage import morphology

        input_image, output_type = common_input_validate(input_image, output_type, **kwargs)

        mteed_result = np.asarray(self.mteed(input_image, detect_resolution=detect_resolution)).astype(np.float32) / 255.0
        lineart_result = np.asarray(self.lineart_standard(
            input_image, guassian_sigma=2, intensity_threshold=3,
            detect_resolution=detect_resolution)).astype(np.float32) / 255.0

        _lineart_result = get_intensity_mask(lineart_result, lower_bound=lineart_lower_bound, upper_bound=lineart_upper_bound)
        _cleaned = morphology.remove_small_objects(_lineart_result.astype(bool), min_size=object_min_size, connectivity=object_connectivity)
        _lineart_result = _lineart_result * _cleaned

        result = combine_layers(mteed_result, _lineart_result)
        out = (np.clip(result, 0.0, 1.0) * 255.0).astype(np.uint8)

        if output_type == "pil":
            return Image.fromarray(out[..., :3])
        return out
