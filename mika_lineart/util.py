"""Utilidades de preprocesamiento vendoreadas de comfyui_controlnet_aux (Apache-2.0).

Ver ATTRIBUTION.md. Solo se copian las funciones que usan los detectores de lineart.
"""

import os
import warnings

import cv2
import numpy as np

# models/lineart vive en la raíz del paquete Mika-Utilidades (subimos desde mika_lineart/)
models_dir = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "lineart")


def HWC3(x):
    assert x.dtype == np.uint8
    if x.ndim == 2:
        x = x[:, :, None]
    assert x.ndim == 3
    H, W, C = x.shape
    assert C == 1 or C == 3 or C == 4
    if C == 3:
        return x
    if C == 1:
        return np.concatenate([x, x, x], axis=2)
    if C == 4:
        color = x[:, :, 0:3].astype(np.float32)
        alpha = x[:, :, 3:4].astype(np.float32) / 255.0
        y = color * alpha + 255.0 * (1.0 - alpha)
        y = y.clip(0, 255).astype(np.uint8)
        return y


def safer_memory(x):
    # Fix many MAC/AMD problems
    return np.ascontiguousarray(x.copy()).copy()


UPSCALE_METHODS = ["INTER_NEAREST", "INTER_LINEAR", "INTER_AREA", "INTER_CUBIC", "INTER_LANCZOS4"]


def get_upscale_method(method_str):
    assert method_str in UPSCALE_METHODS, f"Method {method_str} not found in {UPSCALE_METHODS}"
    return getattr(cv2, method_str)


def pad64(x):
    return int(np.ceil(float(x) / 64.0) * 64 - x)


def resize_image_with_pad(input_image, resolution, upscale_method="", skip_hwc3=False, mode="edge"):
    if skip_hwc3:
        img = input_image
    else:
        img = HWC3(input_image)
    H_raw, W_raw, _ = img.shape
    if resolution == 0:
        return img, lambda x: x
    k = float(resolution) / float(min(H_raw, W_raw))
    H_target = int(np.round(float(H_raw) * k))
    W_target = int(np.round(float(W_raw) * k))
    img = cv2.resize(img, (W_target, H_target),
                     interpolation=get_upscale_method(upscale_method) if k > 1 else cv2.INTER_AREA)
    H_pad, W_pad = pad64(H_target), pad64(W_target)
    img_padded = np.pad(img, [[0, H_pad], [0, W_pad], [0, 0]], mode=mode)

    def remove_pad(x):
        return safer_memory(x[:H_target, :W_target, ...])

    return safer_memory(img_padded), remove_pad


def common_input_validate(input_image, output_type, **kwargs):
    if "img" in kwargs:
        warnings.warn("img is deprecated, please use `input_image=...` instead.", DeprecationWarning)
        input_image = kwargs.pop("img")

    if "return_pil" in kwargs:
        warnings.warn("return_pil is deprecated. Use output_type instead.", DeprecationWarning)
        output_type = "pil" if kwargs["return_pil"] else "np"

    if type(output_type) is bool:
        warnings.warn("Passing `True` or `False` to `output_type` is deprecated and will raise an error in future versions")
        if output_type:
            output_type = "pil"

    if input_image is None:
        raise ValueError("input_image must be defined.")

    if not isinstance(input_image, np.ndarray):
        input_image = np.array(input_image, dtype=np.uint8)
        output_type = output_type or "pil"
    else:
        output_type = output_type or "np"

    return (input_image, output_type)


def safe_step(x, step=2):
    y = x.astype(np.float32) * float(step + 1)
    y = y.astype(np.int32).astype(np.float32) / float(step)
    return y


def download_hf(repo_id, filename, subfolder=""):
    """Ruta local del peso, bajándolo de HuggingFace si falta."""
    local_dir = os.path.join(models_dir, *repo_id.split("/"))
    path = os.path.join(local_dir, *([p for p in subfolder.split("/") if p] + [filename]))
    if not os.path.exists(path):
        from huggingface_hub import hf_hub_download
        os.makedirs(local_dir, exist_ok=True)
        print(f"[mika_lineart] bajando {repo_id}/{subfolder}/{filename} ...")
        path = hf_hub_download(repo_id=repo_id, filename=filename, subfolder=subfolder, local_dir=local_dir)
    return path
