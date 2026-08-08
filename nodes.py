try:
    from server import PromptServer
except Exception:
    PromptServer = None

from PIL import Image, ImageOps
from io import BytesIO
import numpy as np
import torch
import os
import hashlib
import requests
import re
import folder_paths
import time
import random as random_module
import comfy.samplers


# ======================================================================
# HELPERS DE PARSEO DE TAGS (compartidos por SmartTagFilter, TagIf, etc.)
# ======================================================================

_EMOTICONES = [
    "=)", "=(", ":D", ":P", ":3", ";)", ";d", ";D", ":)", ":(",
    ":/", ":|", ":o", ":O", ":*", ":'(", ":')", "XD", "xd",
    "D:", ">:(", ">:)", ":>", ":<", ":^)", ":-)", ":-(",
]

_COLORS = {
    "red", "blue", "green", "yellow", "purple", "pink", "orange", "brown",
    "black", "white", "gray", "grey", "cyan", "magenta", "gold", "silver",
    "aqua", "teal", "navy", "maroon", "olive", "lime", "turquoise", "violet",
    "indigo", "beige", "cream", "tan", "coral", "salmon", "crimson", "scarlet",
    "azure", "cobalt", "emerald", "jade", "lavender", "lilac", "peach", "rose",
    "ruby", "sapphire", "amber", "bronze", "copper", "platinum", "blonde",
    "brunette", "auburn", "ivory", "khaki", "charcoal", "fuchsia",
}

_COLOR_MODIFIERS = {
    "light", "dark", "pale", "deep", "bright", "vivid", "muted", "soft",
    "neon", "pastel", "rich", "dull",
}


def _escape_emoticones(text):
    for emote in _EMOTICONES:
        escaped = emote.replace("(", r"\(").replace(")", r"\)").replace(":", r"\:")
        text = re.sub(r'(?<!\\)' + re.escape(emote), lambda m: escaped, text)
    return text


def _unescape_emoticones(text):
    for emote in _EMOTICONES:
        escaped = emote.replace("(", r"\(").replace(")", r"\)").replace(":", r"\:")
        text = text.replace(escaped, emote)
    return text


def strip_color_prefix(tag_base):
    parts = tag_base.split("_")

    if len(parts) >= 3 and parts[0] in _COLOR_MODIFIERS and parts[1] in _COLORS:
        return "_".join(parts[2:])

    if len(parts) >= 2 and parts[0] in _COLORS:
        return "_".join(parts[1:])

    return tag_base


def _parse_smart_tag(tag_text, case_sensitive=False):
    original = tag_text.strip()
    if not original:
        return None

    opening_parens = 0
    closing_parens = 0

    for char in original:
        if char == '(':
            opening_parens += 1
        elif char == ')':
            closing_parens += 1
        elif char not in ' \t':
            break

    for char in reversed(original):
        if char == ')':
            closing_parens += 1
        elif char == '(':
            opening_parens += 1
        elif char not in ' \t':
            break

    stripped = original.strip()

    while stripped.startswith('(') and stripped.endswith(')'):
        inner = stripped[1:-1].strip()

        if ':' in inner:
            parts = inner.rsplit(':', 1)
            if len(parts) == 2:
                try:
                    weight = float(parts[1])
                    base_tag = parts[0].strip()
                    normalized = base_tag.lower().replace(' ', '_') if not case_sensitive else base_tag.replace(' ', '_')

                    return {
                        'original': original,
                        'base': normalized,
                        'weight': weight,
                        'has_weight': True,
                        'weight_syntax': 'explicit'
                    }
                except ValueError:
                    pass

        stripped = inner.strip()

    paren_pairs = min(opening_parens, closing_parens)
    weight = 1.0 + (paren_pairs * 0.1) if paren_pairs > 0 else 1.0
    base_tag = stripped
    normalized = base_tag.lower().replace(' ', '_') if not case_sensitive else base_tag.replace(' ', '_')

    return {
        'original': original,
        'base': normalized,
        'weight': weight,
        'has_weight': paren_pairs > 0,
        'weight_syntax': 'parentheses' if paren_pairs > 0 else 'none'
    }


def _parse_prompt(prompt, case_sensitive=False):
    if not prompt or not prompt.strip():
        return []

    prompt = _escape_emoticones(prompt)

    tags = []
    current = ''
    paren_depth = 0

    for char in prompt:
        if char == '(':
            paren_depth += 1
        elif char == ')':
            paren_depth -= 1
        elif char == ',' and paren_depth == 0:
            if current.strip():
                parsed = _parse_smart_tag(current, case_sensitive)
                if parsed:
                    tags.append(parsed)
            current = ''
            continue

        current += char

    if current.strip():
        parsed = _parse_smart_tag(current, case_sensitive)
        if parsed:
            tags.append(parsed)

    for tag in tags:
        tag['original'] = _unescape_emoticones(tag['original'])

    return tags


def _tags_match(tag1, tag2, ignore_weight=False, ignore_color_prefix=False):
    base1 = tag1['base']
    base2 = tag2['base']

    if base1 == base2:
        if ignore_weight:
            return True
        return abs(tag1['weight'] - tag2['weight']) < 0.01

    if ignore_color_prefix:
        s1 = strip_color_prefix(base1)
        s2 = strip_color_prefix(base2)

        if s1 == base2 or s2 == base1:
            if ignore_weight or abs(tag1['weight'] - tag2['weight']) < 0.01:
                return True

    return False


def _mika_coerce_bool(value):
    """
    Convierte valores entrantes a bool de forma segura.
    Útil cuando los toggles vienen linkeados desde distintos tipos de nodos.
    """
    if isinstance(value, bool):
        return value

    if value is None:
        return False

    if isinstance(value, (int, float)):
        return value != 0

    if isinstance(value, str):
        return value.strip().lower() in (
            "true",
            "1",
            "yes",
            "on",
            "si",
            "sí",
            "enabled",
        )

    try:
        return bool(value)
    except Exception:
        return False


# ======================================================================
# SAMPLER NAMES — detección multi-fuente + fallback
# ======================================================================

_STANDARD_SAMPLERS = [
    "euler", "euler_ancestral", "euler_ancestral_cfg_pp", "euler_cfg_pp",
    "heun", "heunpp2",
    "dpm_2", "dpm_2_ancestral", "dpm_fast", "dpm_adaptive",
    "dpmpp_2s_ancestral", "dpmpp_2s_ancestral_cfg_pp",
    "dpmpp_sde", "dpmpp_sde_gpu",
    "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_2m_sde_gpu",
    "dpmpp_3m_sde", "dpmpp_3m_sde_gpu",
    "ddpm", "ddim", "uni_pc", "uni_pc_bh2",
    "lcm", "ipndm", "ipndm_v", "deis",
    "res_multistep", "res_multistep_cfg_pp",
    "er_sde", "seeds_2", "seeds_3",
]


def _mika_sampler_names():
    """
    Lee todos los samplers instalados (nativos + los que agreguen
    extensiones). Prueba varias fuentes según la versión de ComfyUI;
    si todas fallan, usa la lista estándar de respaldo.
    """
    detected = []

    # Fuente 1: KSampler.SAMPLERS (dict)
    try:
        d = getattr(comfy.samplers.KSampler, "SAMPLERS", None)
        if isinstance(d, dict) and d:
            detected = list(d.keys())
    except Exception:
        detected = []

    # Fuente 2: comfy.samplers.samplers() -> [(nombre, fn), ...]
    try:
        if not detected:
            fn = getattr(comfy.samplers, "samplers", None)
            if callable(fn):
                detected = [str(x[0]) for x in fn()]
    except Exception:
        pass

    # Fuente 3: listas/dicts a nivel de módulo
    try:
        if not detected:
            for attr in ("SAMPLER_NAMES", "KSAMPLER_NAMES", "SAMPLERS"):
                obj = getattr(comfy.samplers, attr, None)
                if isinstance(obj, dict) and obj:
                    detected = list(obj.keys())
                    break
                if isinstance(obj, (list, tuple)) and obj:
                    detected = [str(x) for x in obj]
                    break
    except Exception:
        pass

    if len(detected) > 1:
        names = detected
    else:
        names = list(_STANDARD_SAMPLERS)
        for n in detected:
            if n not in names:
                names.insert(0, n)

    print(f"[Mika] Sampler Selector: {len(names)} samplers disponibles.")
    return names


# Lista de respaldo con los schedulers estándar de ComfyUI.
_STANDARD_SCHEDULERS = [
    "normal", "karras", "exponential", "sgdr_uniform", "simple",
    "ddim_uniform", "beta", "normal_beta", "lcm", "clamped",
    "linear_quadratic",
]


def _mika_scheduler_names():
    """
    Lee todos los schedulers instalados (nativos + los que agreguen
    extensiones). Prueba varias fuentes según la versión de ComfyUI;
    si todas fallan, usa la lista estándar de respaldo.
    """
    detected = []

    # Fuente 1: KSampler.SCHEDULERS (lista o dict)
    try:
        d = getattr(comfy.samplers.KSampler, "SCHEDULERS", None)
        if isinstance(d, dict) and d:
            detected = list(d.keys())
        elif isinstance(d, (list, tuple)) and d:
            detected = [str(x) for x in d]
    except Exception:
        detected = []

    # Fuente 2: comfy.samplers.schedulers() si existe como función
    try:
        if not detected:
            fn = getattr(comfy.samplers, "schedulers", None)
            if callable(fn):
                detected = [
                    str(x[0]) if isinstance(x, (list, tuple)) else str(x)
                    for x in fn()
                ]
    except Exception:
        pass

    # Fuente 3: listas a nivel de módulo
    try:
        if not detected:
            for attr in ("SCHEDULER_NAMES", "SCHEDULERS"):
                obj = getattr(comfy.samplers, attr, None)
                if isinstance(obj, dict) and obj:
                    detected = list(obj.keys())
                    break
                if isinstance(obj, (list, tuple)) and obj:
                    detected = [str(x) for x in obj]
                    break
    except Exception:
        pass

    if len(detected) > 1:
        names = detected
    else:
        names = list(_STANDARD_SCHEDULERS)
        for n in detected:
            if n not in names:
                names.insert(0, n)

    print(f"[Mika] Scheduler Selector: {len(names)} schedulers disponibles.")
    return names


# ======================================================================
# NODOS
# ======================================================================

class StringSelectorCut:
    """
    Igual que 'String Selector' de Impact-Pack: selecciona una línea por
    índice con wraparound. La UI agrega botón para cortar la primera línea.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "strings": ("STRING", {"multiline": True, "default": ""}),
                "select": ("INT", {"default": 0, "min": 0, "max": 999999}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("string",)
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/string"

    def doit(self, strings, select):
        lines = [s for s in strings.split("\n") if s.strip() != ""]

        if len(lines) == 0:
            return ("",)

        idx = select % len(lines)
        return (lines[idx],)


MAX_SCORES = 50


class ScoreListExtendable:
    """
    Similar al nodo 'SCORE' de JPS-Nodes: filas numeradas con nombre y valor.
    Filas dinámicas (1..50) controladas por num_rows.
    La UI (score_list_mika.js) dibuja nombre y valor en la misma fila,
    con el valor ocupando 1/3 del ancho.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}

        for i in range(1, MAX_SCORES + 1):
            optional[f"nombre_{i}"] = ("STRING", {"default": f"Opción {i}", "multiline": False})
            optional[str(i)] = ("INT", {"default": 0, "min": -999999, "max": 999999, "step": 1})

        optional["num_rows"] = ("INT", {"default": 5, "min": 1, "max": MAX_SCORES, "step": 1})

        return {
            "required": {},
            "optional": optional,
        }

    RETURN_TYPES = ("INT", "STRING")
    RETURN_NAMES = ("int_out", "detalle")
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/score"

    def doit(self, num_rows=5, **kwargs):
        try:
            rows = max(1, min(MAX_SCORES, int(num_rows)))
        except Exception:
            rows = MAX_SCORES

        total = 0
        details = []

        for i in range(1, rows + 1):
            k = str(i)

            if k not in kwargs:
                continue

            value = int(kwargs[k])
            total += value
            label = str(kwargs.get(f"nombre_{k}", k)).strip() or k
            details.append(f"{label}: {value}")

        return (total, "\n".join(details))


class TextBoxClipboard:
    """
    Text Box Editor-Mika: caja de texto con botones de copiar / seleccionar
    todo / pegar en el header (expandido y colapsado).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/string"

    def doit(self, text):
        return (text,)


class TextBoxVisor:
    """
    Text Box Visor-Mika: muestra CUALQUIER tipo de valor (str, int, float,
    bool, list, tuple, set, dict, Tensor, ndarray, bytes) como una preview
    legible. Botones en el header (copiar / seleccionar todo / pegar) vía
    text_box_visor_mika.js. Preview en vivo por websocket.

    El límite de elementos mostrados por lista es MAX_ITEMS (fijo, no
    aparece en la interfaz).
    """

    MAX_ITEMS = 50  # ← límite interno, sin widget visible

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "valor": ("*", {}),
                "text": ("STRING", {"multiline": True, "default": ""}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "doit"
    OUTPUT_NODE = True
    CATEGORY = "Mika Utilidades/string"

    # Recibir las listas COMPLETAS sin que ComfyUI las expanda.
    INPUT_IS_LIST = True

    def doit(self, valor=None, text="", unique_id=None):
        valor = self._unwrap_list_input(valor)
        text = self._unwrap_scalar(text, "")
        unique_id = self._unwrap_scalar(unique_id, None)

        if valor is not None:
            preview = self._format(valor, 0, self.MAX_ITEMS)
        else:
            preview = text if isinstance(text, str) else str(text)

        if PromptServer is not None and PromptServer.instance is not None and unique_id is not None:
            PromptServer.instance.send_sync(
                "mika-visor-preview",
                {"id": str(unique_id), "text": preview},
            )

        return (preview,)

    @staticmethod
    def _unwrap_scalar(v, default):
        if isinstance(v, (list, tuple)):
            return v[0] if len(v) > 0 else default
        return v if v is not None else default

    @staticmethod
    def _unwrap_list_input(v):
        if v is None:
            return None

        if isinstance(v, (list, tuple)):
            if len(v) == 0:
                return None

            if len(v) == 1:
                inner = v[0]
                if not isinstance(inner, (list, tuple)):
                    return inner
                return list(inner)

            return list(v)

        return v

    def _format(self, v, depth=0, max_items=50):
        pad = "    " * depth

        if v is None:
            return "None"

        if isinstance(v, bool):
            return "True" if v else "False"

        if isinstance(v, (int, float)):
            return repr(v)

        if isinstance(v, str):
            return v if depth == 0 else v.replace("\n", "\\n")

        if isinstance(v, (list, tuple, set)):
            items = list(v)

            if not items:
                return "[]" if isinstance(v, list) else ("()" if isinstance(v, tuple) else "set()")

            shown = items[:max_items]
            lines = [
                f"{pad}[{i}] {self._format(item, depth + 1, max_items)}"
                for i, item in enumerate(shown)
            ]

            if len(items) > len(shown):
                lines.append(f"{pad}... (+{len(items) - len(shown)} elementos más)")

            if depth == 0 and isinstance(v, set):
                return "set(\n" + "\n".join(lines) + "\n)"

            return "\n".join(lines)

        if isinstance(v, dict):
            if not v:
                return "{}"

            items = list(v.items())
            shown = items[:max_items]
            lines = [
                f"{pad}{k}: {self._format(val, depth + 1, max_items)}"
                for k, val in shown
            ]

            if len(items) > len(shown):
                lines.append(f"{pad}... (+{len(items) - len(shown)} más)")

            return "\n".join(lines)

        if isinstance(v, (bytes, bytearray)):
            return f"bytes(len={len(v)})"

        if isinstance(v, np.ndarray):
            base = f"ndarray(shape={tuple(v.shape)}, dtype={v.dtype})"
            try:
                if v.size <= 12:
                    base += f"\n{pad}{v.tolist()}"
            except Exception:
                pass
            return base

        if hasattr(v, "shape") and hasattr(v, "dtype"):
            base = f"Tensor(shape={tuple(v.shape)}, dtype={v.dtype})"
            try:
                if hasattr(v, "numel") and callable(v.numel) and v.numel() <= 12:
                    base += f"\n{pad}{v.tolist()}"
            except Exception:
                pass
            return base

        return str(v)


class TagFilter:
    r"""
    Tag Filter-Mika: conserva solo los primeros N segmentos de un texto
    separado por comas.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
                "max_tags": ("INT", {"default": 1, "min": 0, "max": 999999}),
            },
            "optional": {
                "separator": ("STRING", {"default": ","}),
            },
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("text", "tags_count")
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/string"

    def doit(self, text, max_tags, separator=","):
        sep = separator if separator else ","
        parts = [p.strip() for p in (text or "").split(sep) if p.strip() != ""]
        kept = parts[:max_tags] if max_tags > 0 else []
        joiner = sep.strip() + " " if sep.strip() else sep

        return (joiner.join(kept), len(kept))


MAX_REPLACES = 30


class TextReplaceDynamic:
    """
    Text Replace Dynamic-Mika: reemplaza texto con pares dinámicos
    find/replace (botones +/-, hasta 30 pares). Regex opcional.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}

        for i in range(1, MAX_REPLACES + 1):
            optional[f"find_{i}"] = ("STRING", {"default": "", "multiline": False})
            optional[f"replace_{i}"] = ("STRING", {"default": "", "multiline": False})

        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
            },
            "optional": {
                **optional,
                "use_regex": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/string"

    def doit(self, text, use_regex=False, **kwargs):
        result = text or ""

        keys = sorted(
            (k for k in kwargs if k.startswith("find_")),
            key=lambda k: int(k.split("_")[1])
        )

        for find_key in keys:
            idx = find_key.split("_")[1]
            find_str = kwargs.get(find_key, "")
            replace_str = kwargs.get(f"replace_{idx}", "")

            if not find_str:
                continue

            try:
                if use_regex:
                    result = re.sub(find_str, replace_str, result)
                else:
                    result = result.replace(find_str, replace_str)
            except re.error:
                pass

        return (result,)


MAX_CONCAT_SLOTS = 30


class TextConcatenateDynamic:
    """
    Text Concatenate Dynamic-Mika: concatena múltiples textos con separador
    configurable. Slots dinámicos (hasta 30) con botones +/-.

    clean_output=True  → recorta cada texto, descarta vacíos, colapsa
                          separadores duplicados y espacios múltiples.

    clean_output=False → concatena tal cual, sin modificar nada.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}

        for i in range(1, MAX_CONCAT_SLOTS + 1):
            optional[f"text_{i}"] = ("STRING", {"default": "", "multiline": False})

        return {
            "required": {},
            "optional": {
                **optional,
                "separator": ("STRING", {"default": ", "}),
                "clean_output": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/string"

    def doit(self, separator=", ", clean_output=True, **kwargs):
        if isinstance(clean_output, str):
            clean_output = clean_output.strip().lower() in ("true", "1", "yes", "on")
        else:
            clean_output = bool(clean_output)

        keys = sorted(
            (k for k in kwargs if k.startswith("text_")),
            key=lambda k: int(k.split("_")[1])
        )

        texts = []

        for key in keys:
            value = kwargs.get(key, "")

            if value is None:
                value = ""

            if clean_output:
                value = value.strip()

            if value == "":
                continue

            texts.append(value)

        result = separator.join(texts)

        if clean_output and result:
            if separator:
                parts = [p.strip() for p in result.split(separator)]
                parts = [p for p in parts if p]
                result = separator.join(parts)

            result = re.sub(r' {2,}', ' ', result)

        return (result,)


class LoadImageMika:
    """
    Load Image-Mika: carga una imagen desde ruta local o URL, con opción
    RGBA, máscara de alfa, dimensiones opcionales y nombre de archivo.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_path": ("STRING", {"default": "./ComfyUI/input/example.png", "multiline": False}),
                "RGBA": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "output_dimensions": ("BOOLEAN", {"default": True}),
                "filename_text_extension": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "filename_text", "width", "height")
    FUNCTION = "load_image"
    CATEGORY = "Mika Utilidades/image"

    def load_image(self, image_path, RGBA=False, output_dimensions=True, filename_text_extension=True):
        i = None

        if image_path.startswith('http'):
            i = self.download_image(image_path)
            if i is not None:
                i = ImageOps.exif_transpose(i)
        else:
            try:
                i = Image.open(image_path)
                i = ImageOps.exif_transpose(i)
            except OSError:
                print(f"Load Image-Mika: La imagen '{image_path.strip()}' no existe!")

        if i is None:
            i = Image.new(mode='RGB', size=(512, 512), color=(0, 0, 0))

        if output_dimensions:
            width, height = i.size
        else:
            width, height = 0, 0

        image = i

        if not RGBA:
            image = image.convert('RGB')

        image = np.array(image).astype(np.float32) / 255.0
        image = torch.from_numpy(image)[None,]

        if 'A' in i.getbands():
            mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
            mask = 1. - torch.from_numpy(mask)
        else:
            mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")

        if filename_text_extension:
            filename = os.path.basename(image_path)
        else:
            filename = os.path.splitext(os.path.basename(image_path))[0]

        return (image, mask, filename, width, height)

    def download_image(self, url):
        try:
            response = requests.get(url)
            response.raise_for_status()
            img = Image.open(BytesIO(response.content))
            return img
        except requests.exceptions.HTTPError as errh:
            print(f"Load Image-Mika HTTP Error ({url}): {errh}")
        except requests.exceptions.ConnectionError as errc:
            print(f"Load Image-Mika Connection Error ({url}): {errc}")
        except Exception as e:
            print(f"Load Image-Mika Error: {e}")

        return None

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        image_path = kwargs.get('image_path', '')

        if image_path.startswith('http'):
            return float("NaN")

        if not os.path.exists(image_path):
            return None

        try:
            sha256_hash = hashlib.sha256()
            with open(image_path, 'rb') as f:
                for chunk in iter(lambda: f.read(4096), b''):
                    sha256_hash.update(chunk)
            return sha256_hash.hexdigest()
        except Exception:
            return float("NaN")


class SmartTagFilterMika:
    r"""
    Smart Tag Filter-Mika: filtra tags con soporte de pesos, caracteres
    especiales y prefijos de color. Modo include/exclude.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("*",),
                "filter_tags": ("*",),
                "mode": (["include", "exclude"],),
            },
            "optional": {
                "case_sensitive": ("BOOLEAN", {"default": False}),
                "ignore_weight": ("BOOLEAN", {"default": False}),
                "ignore_color_prefix": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("filtered", "matched", "unmatched")
    FUNCTION = "filter_tags"
    CATEGORY = "Mika Utilidades/tags"

    @staticmethod
    def _to_text(value):
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        return str(value)

    def filter_tags(self, prompt, filter_tags, mode="include", case_sensitive=False,
                    ignore_weight=False, ignore_color_prefix=False):
        prompt = self._to_text(prompt)
        filter_tags = self._to_text(filter_tags)

        prompt_tags = _parse_prompt(prompt, case_sensitive)
        filter_list = _parse_prompt(filter_tags, case_sensitive)

        if not filter_list:
            matched = []
            unmatched = prompt_tags
        else:
            matched = []
            unmatched = []

            for ptag in prompt_tags:
                found = any(
                    _tags_match(ptag, ftag, ignore_weight, ignore_color_prefix)
                    for ftag in filter_list
                )

                if found:
                    matched.append(ptag)
                else:
                    unmatched.append(ptag)

        result_tags = matched if mode == "include" else unmatched

        filtered = ", ".join([t['original'] for t in result_tags])
        matched_str = ", ".join([t['original'] for t in matched])
        unmatched_str = ", ".join([t['original'] for t in unmatched])

        return (filtered, matched_str, unmatched_str)


MAX_TAGIF_SLOTS = 6


class TagIfMika:
    """
    Tag If-Mika: condicional por presencia de tags. Hasta 6 pares
    find/output dinámicos con botones +/-.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}

        for i in range(1, MAX_TAGIF_SLOTS + 1):
            optional[f"find_{i}"] = ("STRING", {"default": "", "multiline": False})
            optional[f"output_{i}"] = ("STRING", {"default": "", "multiline": False})

        return {
            "required": {
                "tags": ("STRING",),
            },
            "optional": optional,
        }

    RETURN_TYPES = tuple(["STRING"] * (MAX_TAGIF_SLOTS + 1))
    RETURN_NAMES = tuple([f"output_{i}" for i in range(1, MAX_TAGIF_SLOTS + 1)] + ["combined"])
    FUNCTION = "tag"
    CATEGORY = "Mika Utilidades/tags"
    OUTPUT_NODE = True

    def parse_smart_tag(self, tag_text):
        original = tag_text.strip()
        if not original:
            return None

        original = _escape_emoticones(original)
        stripped = original.strip()

        while stripped.startswith('(') and stripped.endswith(')'):
            inner = stripped[1:-1].strip()

            if ':' in inner:
                parts = inner.rsplit(':', 1)
                if len(parts) == 2:
                    try:
                        float(parts[1])
                        stripped = parts[0].strip()
                        break
                    except ValueError:
                        pass

            stripped = inner.strip()

        normalized = stripped.lower().replace(' ', '_').replace('-', '_')
        return _unescape_emoticones(normalized)

    def parse_tags_list(self, tag_string):
        if not tag_string or not tag_string.strip():
            return []

        tag_string = _escape_emoticones(tag_string)

        tags = []
        current = ''
        paren_depth = 0

        for char in tag_string:
            if char == '(':
                paren_depth += 1
            elif char == ')':
                paren_depth -= 1
            elif char == ',' and paren_depth == 0:
                if current.strip():
                    parsed = self.parse_smart_tag(current)
                    if parsed:
                        tags.append(parsed)
                current = ''
                continue

            current += char

        if current.strip():
            parsed = self.parse_smart_tag(current)
            if parsed:
                tags.append(parsed)

        return tags

    def tag(self, tags, **kwargs):
        tag_list = self.parse_tags_list(tags)
        outputs = []

        for i in range(1, MAX_TAGIF_SLOTS + 1):
            find_val = kwargs.get(f"find_{i}", "")
            out_val = kwargs.get(f"output_{i}", "")

            matched = bool(find_val.strip()) and (self.parse_smart_tag(find_val) in tag_list)
            outputs.append(out_val if matched else "")

        combined = ", ".join([o for o in outputs if o])

        return tuple(outputs + [combined])


class TagRemoverMika:
    """
    Tag Remover-Mika: remueve tags de un prompt usando el algoritmo simple
    de LevelPixel extendido con manejo de pesos, paréntesis anidados y
    tags escapados.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "tags": ("*",),
                "exclude_tags": ("*",),
            },
            "optional": {
                "case_sensitive": ("BOOLEAN", {"default": False}),
                "ignore_weight": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "INT")
    RETURN_NAMES = ("result", "removed_tags", "removed_count")
    FUNCTION = "tag"
    CATEGORY = "Mika Utilidades/tags"
    OUTPUT_NODE = True

    @staticmethod
    def _to_text(value):
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        return str(value)

    @staticmethod
    def _split_tags(text):
        tags = []
        current = ''
        depth = 0

        for char in text:
            if char == '(':
                depth += 1
            elif char == ')':
                depth -= 1
            elif char == ',' and depth == 0:
                if current.strip():
                    tags.append(current.strip())
                current = ''
                continue

            current += char

        if current.strip():
            tags.append(current.strip())

        return tags

    @staticmethod
    def _normalize_for_compare(tag, case_sensitive=False, ignore_weight=True):
        tag = tag.strip()

        if not tag:
            return ""

        if ignore_weight:
            while tag.startswith('(') and tag.endswith(')'):
                inner = tag[1:-1].strip()

                if ':' in inner:
                    parts = inner.rsplit(':', 1)
                    try:
                        float(parts[1])
                        tag = parts[0].strip()
                        break
                    except ValueError:
                        tag = inner
                else:
                    tag = inner

        tag = tag.replace('\\(', '(').replace('\\)', ')').replace('\\,', ',').replace('\\:', ':')

        if not case_sensitive:
            tag = tag.lower()

        tag = tag.replace('-', '_').replace(' ', '_')

        return tag

    def tag(self, tags, exclude_tags, case_sensitive=False, ignore_weight=True):
        tags_text = self._to_text(tags)
        exclude_text = self._to_text(exclude_tags)

        tag_list = self._split_tags(tags_text)
        exclude_list = self._split_tags(exclude_text)

        if not exclude_list:
            return (tags_text, "", 0)

        exclude_set = set()

        for t in exclude_list:
            norm = self._normalize_for_compare(t, case_sensitive, ignore_weight)
            if norm:
                exclude_set.add(norm)

        kept = []
        removed = []

        for tag in tag_list:
            norm = self._normalize_for_compare(tag, case_sensitive, ignore_weight)

            if norm and norm in exclude_set:
                removed.append(tag)
            else:
                kept.append(tag)

        result = ", ".join(kept)
        removed_str = ", ".join(removed)

        return (result, removed_str, len(removed))


class FloatOutputList:
    """
    Float OutputList: convierte una lista de números en texto a una
    OutputList de FLOAT (OUTPUT_IS_LIST).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "separator": ("STRING", {"default": "\n"}),
                "values": ("STRING", {"multiline": True, "default": "1.0\n2.0\n3.0"}),
            }
        }

    RETURN_TYPES = ("FLOAT", "INT", "INT")
    RETURN_NAMES = ("value", "index", "count")
    OUTPUT_IS_LIST = (True, True, False)
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/lista"

    @staticmethod
    def _decode_separator(separator):
        return (
            separator.replace("\\r\\n", "\n")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
            .replace("\\r", "\r")
        )

    def doit(self, separator, values):
        sep = self._decode_separator(separator) if separator else "\n"
        raw_items = values.strip("\r\n").split(sep)

        floats = []

        for raw in raw_items:
            item = raw.strip()

            if item == "":
                continue

            try:
                floats.append(float(item))
            except ValueError:
                raise ValueError(
                    f"Float OutputList: no se pudo convertir '{item}' a un número decimal."
                )

        if not floats:
            floats = [0.0]

        indices = list(range(len(floats)))

        return (floats, indices, len(floats))


class ExecutionTimerConfig:
    """
    Nodo de configuración para "Mika · Tiempos de Ejecución".
    Envía la configuración por websocket.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mostrar_panel_flotante": ("BOOLEAN", {"default": True}),
                "mostrar_etiquetas_en_nodos": ("BOOLEAN", {"default": True}),
                "decimales": ("INT", {"default": 2, "min": 0, "max": 4}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/tiempos"
    OUTPUT_NODE = True

    def doit(self, mostrar_panel_flotante, mostrar_etiquetas_en_nodos, decimales):
        if PromptServer is not None and PromptServer.instance is not None:
            PromptServer.instance.send_sync(
                "mika-timer-config",
                {
                    "showPanel": bool(mostrar_panel_flotante),
                    "showBadges": bool(mostrar_etiquetas_en_nodos),
                    "decimals": int(decimales),
                },
            )

        return {}


class PromptEditLoopMika:
    """
    Prompt Edit (Loop)-Mika: edición de prompt con memoria entre ejecuciones
    (bucle), sin guardado en disco. Retiene el prompt anterior y el actual.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_text": ("STRING", {"forceInput": True, "default": ""}),
                "editable_text_widget": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt_anterior", "prompt_generacion_actual")
    FUNCTION = "run"
    CATEGORY = "Mika Utilidades/prompt"
    OUTPUT_NODE = True

    def run(self, input_text, editable_text_widget):
        prompt_anterior = editable_text_widget
        prompt_actual = input_text

        return {
            "ui": {"text": [prompt_actual]},
            "result": (prompt_anterior, prompt_actual),
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


class TextLineSelectorMika:
    """
    Text Line Selector-Mika: selecciona un rango de líneas de la caja de
    texto y las devuelve como LISTA. Con 'delete_selected_lines' controlás
    si se eliminan del cuadro tras cada ejecución.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
                "start_index": ("INT", {"default": 0, "min": 0, "max": 999999}),
                "end_index": ("INT", {"default": 0, "min": 0, "max": 999999}),
                "delete_selected_lines": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "skip_empty_lines": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("selected_lines", "remaining_text")
    OUTPUT_IS_LIST = (True, False)
    FUNCTION = "run"
    CATEGORY = "Mika Utilidades/prompt"
    OUTPUT_NODE = True

    def run(self, text, start_index, end_index, delete_selected_lines=True, skip_empty_lines=True):
        all_lines = text.split("\n")

        if skip_empty_lines:
            lines = [line for line in all_lines if line.strip() != ""]
        else:
            lines = all_lines

        total_lines = len(lines)

        if total_lines == 0:
            return {
                "ui": {"text": [text]},
                "result": ([], text),
            }

        start = max(0, min(start_index, total_lines - 1))
        end = max(0, min(end_index, total_lines - 1))

        if start > end:
            start, end = end, start

        selected = lines[start:end + 1]

        if delete_selected_lines:
            remaining_lines = lines[:start] + lines[end + 1:]
        else:
            remaining_lines = lines

        remaining_text = "\n".join(remaining_lines)

        return {
            "ui": {"text": [remaining_text]},
            "result": (selected, remaining_text),
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


class TextLineStepperMika:
    """
    Text Line Stepper-Mika: selecciona líneas de forma ESCALONADA (auto-avanza).
    En cada ejecución selecciona el rango actual y avanza al siguiente bloque.
    Los índices se actualizan solos pero pueden editarse manualmente.

    Con auto_advance=False los índices quedan FIJOS en el rango elegido
    (se detienen los saltos) y cada ejecución devuelve el mismo bloque.

    Salidas:
    - selected_lines: LISTA de strings con las líneas del bloque actual.
    - current_end: STRING con el índice final usado en esta ejecución.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
                "start_index": ("INT", {"default": 0, "min": 0, "max": 999999}),
                "end_index": ("INT", {"default": 2, "min": 0, "max": 999999}),
            },
            "optional": {
                "auto_advance": ("BOOLEAN", {"default": True}),
                "skip_empty_lines": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("selected_lines", "current_end")
    OUTPUT_IS_LIST = (True, False)
    FUNCTION = "run"
    CATEGORY = "Mika Utilidades/prompt"
    OUTPUT_NODE = True

    def run(self, text, start_index, end_index,
            auto_advance=True, skip_empty_lines=True):
        all_lines = text.split("\n")

        if skip_empty_lines:
            lines = [line for line in all_lines if line.strip() != ""]
        else:
            lines = all_lines

        total_lines = len(lines)

        if total_lines == 0:
            return {
                "ui": {
                    "text": [text],
                    "start_index": [start_index],
                    "end_index": [end_index],
                },
                "result": ([], str(end_index)),
            }

        start = min(start_index, end_index)
        end = max(start_index, end_index)
        chunk_size = end - start + 1

        if start >= total_lines:
            if auto_advance:
                next_start, next_end = self._next_range(end, chunk_size, total_lines)
            else:
                next_start, next_end = start_index, end_index

            return {
                "ui": {
                    "text": [text],
                    "start_index": [next_start],
                    "end_index": [next_end],
                },
                "result": ([], str(end)),
            }

        actual_end = min(end, total_lines - 1)
        selected = lines[start:actual_end + 1]

        if auto_advance:
            next_start, next_end = self._next_range(actual_end, chunk_size, total_lines)
        else:
            next_start, next_end = start_index, end_index

        return {
            "ui": {
                "text": [text],
                "start_index": [next_start],
                "end_index": [next_end],
            },
            "result": (selected, str(actual_end)),
        }

    @staticmethod
    def _next_range(current_end, chunk_size, total_lines):
        next_start = current_end + 1
        next_end = next_start + chunk_size - 1
        return next_start, next_end

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


class ImagePreviewCleanMika:
    """
    Image Preview Clean-Mika: muestra una preview de imagen con botón para
    copiar al portapapeles SIN metadata, SIN workflow. Solo la imagen pura.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "preview"
    CATEGORY = "Mika Utilidades/image"
    OUTPUT_NODE = True

    def preview(self, images):
        results = []

        for idx, image in enumerate(images):
            i = 255. * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

            image_hash = hashlib.sha256(image.cpu().numpy().tobytes()).hexdigest()[:16]
            filename = f"mika_preview_{image_hash}_{int(time.time())}.png"

            output_dir = folder_paths.get_output_directory()
            filepath = os.path.join(output_dir, filename)

            img.save(filepath, 'PNG')

            results.append({
                "filename": filename,
                "subfolder": "",
                "type": "output"
            })

        return {"ui": {"images": results}}


MAX_GROUP_SLOTS = 20


class FastGroupsBypasserMika:
    """
    Fast Groups Bypasser-Mika: genera un toggle BOOLEAN linkeable por cada
    grupo detectado. Soporta control desde FUERA del subgrafo vía WebSocket.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "groups_filter": ("STRING", {"default": "", "multiline": False}),
        }

        for i in range(1, MAX_GROUP_SLOTS + 1):
            optional[f"group_{i}"] = ("BOOLEAN", {"default": False})

        return {
            "required": {},
            "optional": optional,
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "pass_through"
    CATEGORY = "Mika Utilidades/utils"
    OUTPUT_NODE = True

    def pass_through(self, groups_filter="", unique_id=None, **kwargs):
        bypass_state = {}

        for key, value in kwargs.items():
            if key.startswith("group_") and isinstance(value, bool):
                bypass_state[key] = value

        if PromptServer is not None and PromptServer.instance is not None:
            PromptServer.instance.send_sync(
                "mika-bypasser-state",
                {
                    "node_id": str(unique_id) if unique_id else None,
                    "bypass_state": bypass_state,
                },
            )

        return {"ui": {"bypass_state": [bypass_state]}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        state = str(sorted(
            [(k, v) for k, v in kwargs.items() if k.startswith("group_")]
        ))
        return hashlib.md5(state.encode()).hexdigest()


class FastGroupsMuterMika:
    """
    Fast Groups Muter-Mika: genera un toggle BOOLEAN linkeable por cada
    grupo detectado. Al activarlo hace MUTE (mode=2 / Never) a todos los
    nodos del grupo, en lugar de bypass. Soporta control desde FUERA del
    subgrafo.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "groups_filter": ("STRING", {"default": "", "multiline": False}),
        }

        for i in range(1, MAX_GROUP_SLOTS + 1):
            optional[f"group_{i}"] = ("BOOLEAN", {"default": False})

        return {
            "required": {},
            "optional": optional,
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "pass_through"
    CATEGORY = "Mika Utilidades/utils"
    OUTPUT_NODE = True

    def pass_through(self, groups_filter="", unique_id=None, **kwargs):
        mute_state = {}

        for key, value in kwargs.items():
            if key.startswith("group_") and isinstance(value, bool):
                mute_state[key] = value

        if PromptServer is not None and PromptServer.instance is not None:
            PromptServer.instance.send_sync(
                "mika-muter-state",
                {
                    "node_id": str(unique_id) if unique_id else None,
                    "mute_state": mute_state,
                },
            )

        return {"ui": {"mute_state": [mute_state]}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


MAX_NODE_SLOTS = 20


class FastNodesBypasserMika:
    """
    Fast Nodes Bypasser-Mika.
    Los inputs input_i se declaran hasta MAX_NODE_SLOTS para que el backend
    acepte conexiones dinámicas. El frontend muestra/oculta los slots.
    Los toggle_i tienen defaultInput=True para poder ser promovidos en subgrafos.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}

        for i in range(MAX_NODE_SLOTS):
            optional[f"input_{i}"] = ("*", {"forceInput": True})

        for i in range(MAX_NODE_SLOTS):
            optional[f"toggle_{i}"] = (
                "BOOLEAN",
                {
                    "default": False,
                    "defaultInput": True,
                    "label_on": "bypass",
                    "label_off": "off",
                }
            )

        return {
            "required": {},
            "optional": optional,
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "pass_through"
    CATEGORY = "Mika Utilidades/utils"
    OUTPUT_NODE = True

    def pass_through(self, unique_id=None, **kwargs):
        toggle_state = {}

        for i in range(MAX_NODE_SLOTS):
            toggle_state[f"toggle_{i}"] = False

        for key, value in kwargs.items():
            if key.startswith("toggle_"):
                toggle_state[key] = _mika_coerce_bool(value)

        if PromptServer is not None and PromptServer.instance is not None:
            PromptServer.instance.send_sync(
                "mika-fast-nodes-bypasser",
                {
                    "node_id": str(unique_id) if unique_id is not None else None,
                    "toggle_state": toggle_state,
                },
            )

        return {"ui": {"toggle_state": [toggle_state]}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


class FastNodesMuterMika:
    """
    Fast Nodes Muter-Mika.
    Los inputs input_i se declaran hasta MAX_NODE_SLOTS para que el backend
    acepte conexiones dinámicas. El frontend muestra/oculta los slots.
    Los toggle_i tienen defaultInput=True para poder ser promovidos en subgrafos.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}

        for i in range(MAX_NODE_SLOTS):
            optional[f"input_{i}"] = ("*", {"forceInput": True})

        for i in range(MAX_NODE_SLOTS):
            optional[f"toggle_{i}"] = (
                "BOOLEAN",
                {
                    "default": False,
                    "defaultInput": True,
                    "label_on": "mute",
                    "label_off": "off",
                }
            )

        return {
            "required": {},
            "optional": optional,
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "pass_through"
    CATEGORY = "Mika Utilidades/utils"
    OUTPUT_NODE = True

    def pass_through(self, unique_id=None, **kwargs):
        toggle_state = {}

        for i in range(MAX_NODE_SLOTS):
            toggle_state[f"toggle_{i}"] = False

        for key, value in kwargs.items():
            if key.startswith("toggle_"):
                toggle_state[key] = _mika_coerce_bool(value)

        if PromptServer is not None and PromptServer.instance is not None:
            PromptServer.instance.send_sync(
                "mika-fast-nodes-muter",
                {
                    "node_id": str(unique_id) if unique_id is not None else None,
                    "toggle_state": toggle_state,
                },
            )

        return {"ui": {"toggle_state": [toggle_state]}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


MAX_UNPACK_SLOTS = 50


class ListUnpackMika:
    """
    List Unpack-Mika: recibe una lista, tupla, batch o colección y la
    separa en múltiples salidas.

    IMPORTANTE: INPUT_IS_LIST = True evita que ComfyUI expanda la lista
    y ejecute el nodo una vez por elemento (que era el bug).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "list_input": ("*", {"forceInput": True}),
                "output_count": (
                    "INT",
                    {
                        "default": 2,
                        "min": 1,
                        "max": MAX_UNPACK_SLOTS,
                        "step": 1,
                        "display": "number",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = tuple(["*"] * MAX_UNPACK_SLOTS)
    RETURN_NAMES = tuple([f"output_{i}" for i in range(MAX_UNPACK_SLOTS)])

    FUNCTION = "unpack"
    CATEGORY = "Mika Utilidades/lista"
    OUTPUT_NODE = False

    # CLAVE: recibir la lista completa, sin expansión por elemento.
    INPUT_IS_LIST = True

    def unpack(self, list_input, output_count, unique_id=None):
        # Con INPUT_IS_LIST, algunos valores pueden llegar envueltos en lista.
        if isinstance(unique_id, (list, tuple)):
            unique_id = unique_id[0] if unique_id else None

        count = self._clamp_count(output_count)
        items = self._normalize_to_list(list_input)

        outputs = []

        for i in range(MAX_UNPACK_SLOTS):
            if i < count and i < len(items):
                outputs.append(items[i])
            else:
                outputs.append(None)

        if PromptServer is not None and PromptServer.instance is not None and unique_id is not None:
            PromptServer.instance.send_sync(
                "mika-list-unpack",
                {
                    "node_id": str(unique_id),
                    "output_count": count,
                },
            )

        return tuple(outputs)

    def _clamp_count(self, value):
        if isinstance(value, (list, tuple)):
            value = value[0] if len(value) > 0 else 2

        try:
            count = int(value)
        except Exception:
            count = 2

        return max(1, min(MAX_UNPACK_SLOTS, count))

    def _normalize_to_list(self, value):
        """
        Con INPUT_IS_LIST, list_input siempre llega como lista.
        Hay dos casos:
        - Lista expandida (fuente OUTPUT_IS_LIST): [elem0, elem1, ...]
        - Valor único envuelto: [valor]
        """
        if isinstance(value, (list, tuple)):
            if len(value) == 1:
                inner = value[0]
                # Un solo objeto que a su vez es lista/tupla.
                if isinstance(inner, (list, tuple)):
                    return list(inner)
                # Un solo objeto: puede ser batch, dict, tensor, string, etc.
                return self._split_single(inner)

            # Lista real con varios elementos.
            return list(value)

        return self._split_single(value)

    def _split_single(self, value):
        """
        Convierte un objeto individual en lista de elementos.
        Soporta LATENT batch, tensors 4D, numpy 4D, dict, list, etc.
        """
        if value is None:
            return []

        if isinstance(value, (list, tuple)):
            return list(value)

        if isinstance(value, set):
            return list(value)

        # Soporte para LATENT batch: {"samples": tensor, ...}
        if isinstance(value, dict):
            samples = value.get("samples", None)

            if torch.is_tensor(samples) and samples.ndim == 4 and samples.shape[0] > 1:
                unpacked = []

                for i in range(samples.shape[0]):
                    item = dict(value)
                    item["samples"] = samples[i : i + 1]
                    unpacked.append(item)

                return unpacked

            return [value]

        # Tensors batch 4D, por ejemplo IMAGE: [B, H, W, C]
        if isinstance(value, torch.Tensor):
            if value.ndim == 4 and value.shape[0] > 1:
                return [value[i : i + 1] for i in range(value.shape[0])]

            return [value]

        # Numpy arrays batch 4D.
        if isinstance(value, np.ndarray):
            if value.ndim == 4 and value.shape[0] > 1:
                return [value[i : i + 1] for i in range(value.shape[0])]

            return [value]

        # Cualquier otra cosa es un único elemento.
        return [value]


class AnimaResolutionsMika:
    """
    Anima Resolutions-Mika: selecciona resoluciones compatibles con Anima
    en diferentes proporciones de aspecto.
    Basado en https://github.com/cyberdelailAI/ComfyUI-anima-Resolutions

    Con random=True, selecciona una resolución aleatoria de la lista.
    Con random=False, usa el ratio seleccionado manualmente.
    """

    RESOLUTIONS = {
        "1024": [
            "1024x1024 (1:1)",
            "1152x896 (9:7)",
            "896x1152 (7:9)",
            "1152x864 (4:3)",
            "864x1152 (3:4)",
            "1344x896 (3:2)",
            "1248x832 (3:2)",
            "896x1344 (2:3)",
            "832x1248 (2:3)",
            "1280x720 (16:9)",
            "720x1280 (9:16)",
            "1344x576 (21:9)",
            "576x1344 (9:21)",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        ratios = list(cls.RESOLUTIONS["1024"])

        return {
            "required": {
                "ratio": (ratios, {"default": "1024x1024 (1:1)"}),
                "random": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "get_dimensions"
    CATEGORY = "Mika Utilidades/resolucion"

    def get_dimensions(self, ratio, random=False):
        ratios = self.RESOLUTIONS["1024"]

        # Lectura defensiva del boolean (por si viene linkeado como string)
        if isinstance(random, str):
            random = random.strip().lower() in ("true", "1", "yes", "on")
        else:
            random = bool(random)

        if random:
            selected_ratio = random_module.choice(ratios)
        else:
            selected_ratio = ratio

        dimensions = selected_ratio.split(" ")[0]
        width, height = dimensions.split("x")

        return (int(width), int(height))

    @classmethod
    def IS_CHANGED(cls, ratio, random=False):
        """
        Cuando random=True, devuelve NaN para que ComfyUI NO cachee el
        resultado y re-ejecute el nodo en cada generación, obteniendo
        una resolución aleatoria nueva cada vez.

        Cuando random=False, el resultado es determinista y cacheable.
        """
        if isinstance(random, str):
            random = random.strip().lower() in ("true", "1", "yes", "on")
        else:
            random = bool(random)

        if random:
            return float("nan")

        return ratio


class SamplerSelectorMika:
    """
    Sampler Selector-Mika: lista todos los samplers instalados en ComfyUI
    y permite seleccionar uno.

    Salidas:
    - sampler_name: nombre del sampler elegido. Es tipo "*" (wildcard) para
      que conecte SIEMPRE al sampler_name del KSampler, aunque otras
      extensiones agreguen samplers y las listas combo no coincidan.
    - sampler: objeto SAMPLER, conectable a SamplerCustomAdvanced /
      custom sampling.
    - sampler_name_text: el nombre del sampler elegido como STRING.
    """

    @classmethod
    def INPUT_TYPES(cls):
        names = _mika_sampler_names()
        return {
            "required": {
                "sampler_name": (names, {"default": names[0]}),
            },
        }

    # CLAVE: la primera salida es "*" (comodín). Si acá congeláramos la
    # lista combo exacta, ComfyUI tira "Invalid connection" cuando alguna
    # extensión registra samplers nuevos después de nuestro import.
    RETURN_TYPES = ("*", "SAMPLER", "STRING")
    RETURN_NAMES = ("sampler_name", "sampler", "sampler_name_text")
    FUNCTION = "get_sampler"
    CATEGORY = "Mika Utilidades/sampling"

    def get_sampler(self, sampler_name):
        sampler_obj = self._get_sampler_object(sampler_name)
        return (sampler_name, sampler_obj, str(sampler_name))

    def _get_sampler_object(self, sampler_name):
        """
        Obtiene el objeto SAMPLER de forma compatible con diferentes
        versiones de ComfyUI. En versiones modernas KSampler() requiere
        más argumentos (steps, device...), por eso NO instanciamos directo.
        """
        # Intento 1: KSampler.SAMPLERS como diccionario de funciones/objetos
        try:
            samplers_dict = getattr(comfy.samplers.KSampler, "SAMPLERS", {})
            if sampler_name in samplers_dict:
                sampler_fn = samplers_dict[sampler_name]

                if callable(sampler_fn):
                    try:
                        return sampler_fn()
                    except TypeError:
                        return sampler_fn
                else:
                    return sampler_fn
        except Exception as e:
            print(f"[Mika] Sampler Selector: error desde KSampler.SAMPLERS: {e}")

        # Intento 2: función sampler_object si existe
        try:
            if hasattr(comfy.samplers, "sampler_object"):
                return comfy.samplers.sampler_object(sampler_name)
        except Exception as e:
            print(f"[Mika] Sampler Selector: error desde sampler_object: {e}")

        # Intento 3: buscar en otras ubicaciones comunes del módulo
        try:
            for attr in ("samplers", "SAMPLERS"):
                obj = getattr(comfy.samplers, attr, None)
                if isinstance(obj, dict) and sampler_name in obj:
                    sampler_fn = obj[sampler_name]
                    if callable(sampler_fn):
                        try:
                            return sampler_fn()
                        except TypeError:
                            return sampler_fn
                    return sampler_fn
        except Exception as e:
            print(f"[Mika] Sampler Selector: error desde módulo: {e}")

        # Fallback: devolver el nombre como string
        print(f"[Mika] Sampler Selector: no se pudo obtener objeto SAMPLER para '{sampler_name}', devolviendo nombre")
        return sampler_name


class SchedulerSelectorMika:
    """
    Scheduler Selector-Mika: lista todos los schedulers instalados en
    ComfyUI y permite seleccionar uno.

    Salidas:
    - scheduler: nombre del scheduler elegido. Es tipo "*" (wildcard) para
      que conecte SIEMPRE al input scheduler del KSampler, aunque otras
      extensiones agreguen schedulers y las listas combo no coincidan.
    - scheduler_name_text: el nombre del scheduler elegido como STRING.
    """

    @classmethod
    def INPUT_TYPES(cls):
        names = _mika_scheduler_names()
        return {
            "required": {
                "scheduler_name": (names, {"default": names[0]}),
            },
        }

    # CLAVE: la primera salida es "*" (comodín) por la misma razón que en
    # el Sampler Selector: evita "Invalid connection" por listas combo
    # desactualizadas entre nuestro nodo y el KSampler.
    RETURN_TYPES = ("*", "STRING")
    RETURN_NAMES = ("scheduler", "scheduler_name_text")
    FUNCTION = "get_scheduler"
    CATEGORY = "Mika Utilidades/sampling"

    def get_scheduler(self, scheduler_name):
        # En ComfyUI el scheduler es un string: no hay objeto que crear,
        # así que no puede fallar como KSampler().
        return (scheduler_name, str(scheduler_name))


class ImageSaveAutoMika:
    """
    Image Save Auto-Mika: igual que Image Preview Clean-Mika (preview
    limpio SIN metadata), pero además guarda AUTOMÁTICAMENTE las imágenes
    en la ruta local que indiques en save_path. Si la carpeta no existe,
    la crea. Devuelve la lista de rutas guardadas.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "save_path": ("STRING", {"default": "./ComfyUI/output/mika_autosave", "multiline": False}),
            },
            "optional": {
                "filename_prefix": ("STRING", {"default": "mika_img"}),
                "format": (["png", "jpg", "webp"], {"default": "png"}),
                "add_counter": ("BOOLEAN", {"default": True}),
                "add_timestamp": ("BOOLEAN", {"default": False}),
                "show_preview": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("saved_paths", "saved_count")
    OUTPUT_IS_LIST = (True, False)
    FUNCTION = "save_auto"
    CATEGORY = "Mika Utilidades/image"
    OUTPUT_NODE = True

    def save_auto(self, images, save_path, filename_prefix="mika_img",
                  format="png", add_counter=True, add_timestamp=False,
                  show_preview=True):

        # Resolver ruta: ~ → home; relativa → relativa al directorio de ComfyUI.
        save_path = os.path.abspath(os.path.expanduser((save_path or "").strip()))
        if not save_path:
            save_path = folder_paths.get_output_directory()

        try:
            os.makedirs(save_path, exist_ok=True)
        except Exception as e:
            print(f"Image Save Auto-Mika: no se pudo crear la carpeta '{save_path}': {e}")
            save_path = folder_paths.get_output_directory()
            os.makedirs(save_path, exist_ok=True)

        prefix = (filename_prefix or "mika_img").strip() or "mika_img"
        ext = (format or "png").strip().lower()
        if ext not in ("png", "jpg", "webp"):
            ext = "png"

        save_fmt = {"png": "PNG", "jpg": "JPEG", "webp": "WEBP"}[ext]

        counter = self._next_counter(save_path, prefix, ext) if add_counter else None

        saved_paths = []
        preview_results = []

        for idx, image in enumerate(images):
            arr = 255. * image.cpu().numpy()
            img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

            if ext == "jpg":
                img = img.convert("RGB")

            name = prefix
            if add_counter:
                name += f"_{counter:05d}"
                counter += 1
            if add_timestamp:
                name += f"_{int(time.time())}"
            if len(images) > 1:
                name += f"_{idx:02d}"
            name += f".{ext}"

            filepath = os.path.join(save_path, name)
            img.save(filepath, save_fmt)
            saved_paths.append(filepath)

            # Copia limpia para el preview de la UI de ComfyUI (sin metadata).
            if show_preview:
                image_hash = hashlib.sha256(image.cpu().numpy().tobytes()).hexdigest()[:16]
                prev_name = f"mika_preview_{image_hash}_{int(time.time())}.png"
                prev_path = os.path.join(folder_paths.get_output_directory(), prev_name)
                Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(prev_path, "PNG")
                preview_results.append({
                    "filename": prev_name,
                    "subfolder": "",
                    "type": "output",
                })

        print(f"Image Save Auto-Mika: {len(saved_paths)} imagen(es) guardadas en '{save_path}'.")

        if show_preview and preview_results:
            return {
                "ui": {"images": preview_results},
                "result": (saved_paths, len(saved_paths)),
            }

        return (saved_paths, len(saved_paths))

    @staticmethod
    def _next_counter(directory, prefix, ext):
        """Busca el mayor contador existente en la carpeta y devuelve el siguiente."""
        max_n = 0
        pattern = re.compile(rf"^{re.escape(prefix)}_(\d+)")
        try:
            for f in os.listdir(directory):
                if f.lower().endswith(f".{ext}"):
                    m = pattern.match(f)
                    if m:
                        max_n = max(max_n, int(m.group(1)))
        except Exception:
            pass
        return max_n + 1


# ======================================================================
# MAPPINGS
# ======================================================================

NODE_CLASS_MAPPINGS = {
    "StringSelectorCut": StringSelectorCut,
    "ScoreListExtendable": ScoreListExtendable,
    "TextBoxClipboard": TextBoxClipboard,
    "TextBoxVisor": TextBoxVisor,
    "TagFilter": TagFilter,
    "TextReplaceDynamic": TextReplaceDynamic,
    "TextConcatenateDynamic": TextConcatenateDynamic,
    "LoadImageMika": LoadImageMika,
    "SmartTagFilterMika": SmartTagFilterMika,
    "TagIfMika": TagIfMika,
    "TagRemoverMika": TagRemoverMika,
    "FloatOutputList": FloatOutputList,
    "ExecutionTimerConfig": ExecutionTimerConfig,
    "PromptEditLoopMika": PromptEditLoopMika,
    "TextLineSelectorMika": TextLineSelectorMika,
    "TextLineStepperMika": TextLineStepperMika,
    "ImagePreviewCleanMika": ImagePreviewCleanMika,
    "FastGroupsBypasserMika": FastGroupsBypasserMika,
    "FastGroupsMuterMika": FastGroupsMuterMika,
    "FastNodesBypasserMika": FastNodesBypasserMika,
    "FastNodesMuterMika": FastNodesMuterMika,
    "ListUnpackMika": ListUnpackMika,
    "AnimaResolutionsMika": AnimaResolutionsMika,
    "SamplerSelectorMika": SamplerSelectorMika,
    "SchedulerSelectorMika": SchedulerSelectorMika,
    "ImageSaveAutoMika": ImageSaveAutoMika,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "StringSelectorCut": "String Selector (Cut First Line)",
    "ScoreListExtendable": "Score List",
    "TextBoxClipboard": "Text Box Editor-Mika",
    "TextBoxVisor": "Text Box Visor-Mika",
    "TagFilter": "Tag Filter-Mika",
    "TextReplaceDynamic": "Text Replace Dynamic-Mika",
    "TextConcatenateDynamic": "Text Concatenate Dynamic-Mika",
    "LoadImageMika": "Load Image-Mika",
    "SmartTagFilterMika": "Smart Tag Filter-Mika",
    "TagIfMika": "Tag If-Mika",
    "TagRemoverMika": "Tag Remover-Mika",
    "FloatOutputList": "Float OutputList",
    "ExecutionTimerConfig": "⏱ Tiempos de Ejecución (config)",
    "PromptEditLoopMika": "Prompt Edit (Loop)-Mika",
    "TextLineSelectorMika": "Text Line Selector-Mika",
    "TextLineStepperMika": "Text Line Stepper-Mika",
    "ImagePreviewCleanMika": "Image Preview Clean-Mika",
    "FastGroupsBypasserMika": "Fast Groups Bypasser-Mika",
    "FastGroupsMuterMika": "Fast Groups Muter-Mika",
    "FastNodesBypasserMika": "Fast Nodes Bypasser-Mika",
    "FastNodesMuterMika": "Fast Nodes Muter-Mika",
    "ListUnpackMika": "List Unpack-Mika",
    "AnimaResolutionsMika": "Anima Resolutions-Mika",
    "SamplerSelectorMika": "Sampler Selector-Mika",
    "SchedulerSelectorMika": "Scheduler Selector-Mika",
    "ImageSaveAutoMika": "Image Save Auto-Mika",
}