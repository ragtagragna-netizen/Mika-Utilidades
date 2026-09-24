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
                    normalized = base_tag.lower().replace(' ', '_').replace('-', '_') if not case_sensitive else base_tag.replace(' ', '_').replace('-', '_')

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
    normalized = base_tag.lower().replace(' ', '_').replace('-', '_') if not case_sensitive else base_tag.replace(' ', '_').replace('-', '_')

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
    escaped = False

    for char in prompt:
        if escaped:
            current += char
            escaped = False
        elif char == '\\':
            current += char
            escaped = True
        elif char == '(':
            paren_depth += 1
            current += char
        elif char == ')' and paren_depth > 0:
            paren_depth -= 1
            current += char
        elif char == ',' and paren_depth == 0:
            if current.strip():
                parsed = _parse_smart_tag(current, case_sensitive)
                if parsed:
                    tags.append(parsed)
            current = ''
        else:
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


def _mika_coerce_bool(value, default=False):
    """
    Convierte valores entrantes a bool de forma segura.
    Útil cuando los toggles vienen linkeados desde distintos tipos de nodos.
    """
    if isinstance(value, (list, tuple)):
        value = value[0] if len(value) > 0 else default

    if isinstance(value, bool):
        return value

    if value is None:
        return default

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
        return default


def _mika_decode_separator(separator):
    """Decodifica escapes del separador (\\n, \\t, \\r, \\r\\n y /n)."""
    if isinstance(separator, (list, tuple)):
        separator = separator[0] if len(separator) > 0 else ""

    if not isinstance(separator, str):
        separator = str(separator)

    return (
        separator
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\r", "\r")
        .replace("/n", "\n")
    )


# Cache de hashes de archivos: evita re-leer imágenes grandes en cada
# validación de prompt. La clave incluye mtime+size, así un cambio real
# del archivo invalida la entrada.
_FILE_HASH_CACHE = {}


def _mika_hash_file(path):
    """Hash sha256 de un archivo, cacheado por (path, mtime_ns, size)."""
    if not os.path.exists(path):
        return None

    try:
        st = os.stat(path)
        key = (os.path.normcase(path), st.st_mtime_ns, st.st_size)
        h = _FILE_HASH_CACHE.get(key)

        if h is None:
            sha = hashlib.sha256()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(4096), b""):
                    sha.update(chunk)
            h = sha.hexdigest()

            if len(_FILE_HASH_CACHE) > 128:
                _FILE_HASH_CACHE.clear()
            _FILE_HASH_CACHE[key] = h

        return h
    except Exception:
        return None


# Contador de guardado por (carpeta, prefijo, extensión). Evita escanear el
# directorio en cada ejecución; el valor cae solo si pasan 60s sin guardar.
_SAVE_COUNTERS = {}


def _mika_next_counter(directory, prefix, ext):
    key = (os.path.normcase(directory), prefix, ext)
    now = time.time()
    entry = _SAVE_COUNTERS.get(key)

    if entry is not None and now - entry[0] < 60:
        return entry[1]

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

    _SAVE_COUNTERS[key] = (now, max_n + 1)
    return max_n + 1


def _mika_bump_counter(directory, prefix, ext, value):
    key = (os.path.normcase(directory), prefix, ext)
    _SAVE_COUNTERS[key] = (time.time(), value)


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


# Cache de nombres detectados: la detección consulta comfy.samplers, que no
# cambia en caliente; hacerlo una sola vez evita trabajo repetido por nodo.
_DETECTED_NAMES = {}


def _mika_detect_names(label, fallback, sampler_attrs, scheduler_attrs):
    """Detecta samplers o schedulers instalados y cachea el resultado."""
    if label in _DETECTED_NAMES:
        return _DETECTED_NAMES[label]

    detected = []

    try:
        d = getattr(comfy.samplers.KSampler, sampler_attrs[0], None)
        if isinstance(d, dict) and d:
            detected = list(d.keys())
        elif isinstance(d, (list, tuple)) and d:
            detected = [str(x) for x in d]
    except Exception:
        detected = []

    try:
        if not detected:
            fn = getattr(comfy.samplers, sampler_attrs[1], None)
            if callable(fn):
                detected = [
                    str(x[0]) if isinstance(x, (list, tuple)) else str(x)
                    for x in fn()
                ]
    except Exception:
        pass

    try:
        if not detected:
            for attr in sampler_attrs[2:]:
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
        names = list(fallback)
        for n in detected:
            if n not in names:
                names.insert(0, n)

    print(f"[Mika] {label}: {len(names)} disponibles.")
    _DETECTED_NAMES[label] = names
    return names


def _mika_sampler_names():
    return _mika_detect_names(
        "Sampler Selector",
        _STANDARD_SAMPLERS,
        ("SAMPLERS", "samplers", "SAMPLER_NAMES", "KSAMPLER_NAMES"),
        (),
    )


# Lista de respaldo con los schedulers estándar de ComfyUI.
_STANDARD_SCHEDULERS = [
    "normal", "karras", "exponential", "sgdr_uniform", "simple",
    "ddim_uniform", "beta", "normal_beta", "lcm", "clamped",
    "linear_quadratic",
]


def _mika_scheduler_names():
    return _mika_detect_names(
        "Scheduler Selector",
        _STANDARD_SCHEDULERS,
        ("SCHEDULERS", "schedulers", "SCHEDULER_NAMES"),
        (),
    )


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
            optional[f"nombre_{i}"] = ("STRING", {"default": "", "multiline": False})
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


class PrimitiveMika:
    """
    Primitive-Mika: nodo primitivo genérico. Al conectarlo a un slot de
    otro nodo (ej. el combo "salida" de FILTROS Select-Mika) la extensión
    web copia las opciones de ese destino en su widget "value", sin
    agregar controles de seed (fixed/randomize).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    FUNCTION = "run"
    CATEGORY = "Mika Utilidades/utils"

    def run(self, value=""):
        return (value,)


class TextBoxClipboard:
    """
    Text Box-Mika: caja de texto con botones de copiar / seleccionar
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


class TextBoxPasteMika:
    """
    Text Box Paste-Mika: caja de texto con un único botón de pegar en el
    header; al pulsarlo REEMPLAZA todo el texto del nodo por el contenido
    del portapapeles.
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


class NoteMika:
    """
    Note-Mika: nota igual que el Note de ComfyUI (sin inputs ni outputs)
    pero con los botones de copiar / seleccionar todo / pegar del Text
    Box-Mika en el header.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/utils"
    OUTPUT_NODE = True

    def doit(self, text):
        return ()


# Workflow Save: el panel flotante (web/workflow_save_mika.js) guarda el
# workflow actual en la carpeta indicada. Si el nombre ya existe permite
# sobreescribir o guardar como copia con sufijo " (1)", " (2)", etc.
if PromptServer is not None and PromptServer.instance is not None:
    from aiohttp import web

    _MIKA_BAD_NAME_CHARS = re.compile(r'[\\/:*?"<>|]')

    def _mika_sanitize_name(name):
        name = _MIKA_BAD_NAME_CHARS.sub("_", str(name)).strip(" .")
        if name.lower().endswith(".json"):
            name = name[:-5]
        return name or "workflow"

    @PromptServer.instance.routes.post("/mika/save_workflow")
    async def mika_save_workflow(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"status": "error", "message": "JSON inválido"}, status=400)

        folder = str(data.get("folder") or "").strip()
        workflow = data.get("workflow")
        mode = str(data.get("mode") or "ask")

        if not folder or workflow is None:
            return web.json_response({"status": "error", "message": "Faltan carpeta o workflow"}, status=400)

        name = _mika_sanitize_name(data.get("name"))
        folder = os.path.abspath(os.path.expanduser(os.path.expandvars(folder)))
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name + ".json")

        if os.path.exists(path):
            if mode == "ask":
                return web.json_response({"status": "exists", "path": path})
            if mode == "copy":
                i = 1
                while os.path.exists(os.path.join(folder, f"{name} ({i}).json")):
                    i += 1
                name = f"{name} ({i})"
                path = os.path.join(folder, name + ".json")

        if mode not in ("ask", "overwrite", "copy"):
            return web.json_response({"status": "error", "message": "Modo inválido"}, status=400)

        import json
        with open(path, "w", encoding="utf-8") as f:
            json.dump(workflow, f, ensure_ascii=False, indent=2)

        return web.json_response({"status": "ok", "path": path, "name": name})


class TextBoxVisor:
    """
    Visor-Mika: muestra CUALQUIER tipo de valor (str, int, float, bool,
    list, tuple, set, dict, Tensor, ndarray, bytes) como una preview
    legible. Botones en el header (copiar / seleccionar todo / pegar) vía
    text_box_visor_mika.js. Preview en vivo por websocket. El input `text`
    es socketless: solo el slot `valor` recibe links.

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
                "text": ("STRING", {"multiline": True, "default": "", "socketless": True}),
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

    RETURN_TYPES = ("STRING", "INT", "STRING")
    RETURN_NAMES = ("text", "tags_count", "rest")
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/string"

    def doit(self, text, max_tags, separator=","):
        sep = separator if separator else ","
        parts = [p.strip() for p in (text or "").split(sep) if p.strip() != ""]
        kept = parts[:max_tags] if max_tags > 0 else []
        rest = parts[max_tags:] if max_tags > 0 else parts
        joiner = sep.strip() + " " if sep.strip() else sep

        return (joiner.join(kept), len(kept), joiner.join(rest))


MAX_REPLACES = 30
DEFAULT_REPLACES_VISIBLE = 3


class TextReplaceDynamic:
    """
    Text Replace Dynamic-Mika: reemplaza texto con pares dinámicos
    find/replace, controlados por pair_count.

    - text entra por SLOT (forceInput), no como caja de texto.
    - pair_count controla cuántos pares find/replace se usan.
    - find_i y replace_i mantienen el mismo comportamiento.
    """

    @staticmethod
    def _scalar(value, default=None):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}

        for i in range(1, MAX_REPLACES + 1):
            optional[f"find_{i}"] = ("STRING", {"default": "", "multiline": False})
            optional[f"replace_{i}"] = ("STRING", {"default": "", "multiline": False})

        optional["use_regex"] = ("BOOLEAN", {"default": False})

        optional["pair_count"] = (
            "INT",
            {
                "default": DEFAULT_REPLACES_VISIBLE,
                "min": 1,
                "max": MAX_REPLACES,
                "step": 1,
                "display": "number",
            },
        )

        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
            },
            "optional": optional,
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/string"

    def doit(
        self,
        text="",
        use_regex=False,
        pair_count=DEFAULT_REPLACES_VISIBLE,
        unique_id=None,
        **kwargs,
    ):
        text = self._scalar(text, "")

        if not isinstance(text, str):
            text = str(text)

        use_regex = self._scalar(use_regex, False)
        use_regex = _mika_coerce_bool(use_regex)

        pair_count = self._scalar(pair_count, DEFAULT_REPLACES_VISIBLE)

        try:
            count = int(pair_count)
        except Exception:
            count = DEFAULT_REPLACES_VISIBLE

        count = max(1, min(MAX_REPLACES, count))

        unique_id = self._scalar(unique_id, None)

        if (
            PromptServer is not None
            and PromptServer.instance is not None
            and unique_id is not None
        ):
            PromptServer.instance.send_sync(
                "mika-text-replace-count",
                {
                    "id": str(unique_id),
                    "count": count,
                },
            )

        result = text

        keys = sorted(
            (k for k in kwargs if re.fullmatch(r"find_\d+", k)),
            key=lambda k: int(k.split("_")[1]),
        )

        for find_key in keys:
            idx = int(find_key.split("_")[1])

            if idx > count:
                break

            find_str = self._scalar(kwargs.get(find_key, ""), "")
            replace_str = self._scalar(kwargs.get(f"replace_{idx}", ""), "")

            if not isinstance(find_str, str):
                find_str = str(find_str)

            if not isinstance(replace_str, str):
                replace_str = str(replace_str)

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
DEFAULT_CONCAT_SLOTS = 3


class TextConcatenateDynamic:
    """
    Text Concatenate Dynamic-Mika.

    Slots dinámicos controlados por text_count.

    Cada slot es una caja de texto editable:
    - text_1
    - text_2
    - text_3
    ...

    separator acepta escapes:
    - \n
    - \t
    - \r
    - \r\n
    - /n alias opcional

    clean_output=True limpia textos vacíos, espacios y duplicados.
    """

    @staticmethod
    def _scalar(value, default=None):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}

        for i in range(1, MAX_CONCAT_SLOTS + 1):
            optional[f"text_{i}"] = ("STRING", {"default": "", "multiline": False})

        optional["separator"] = ("STRING", {"default": ""})
        optional["clean_output"] = ("BOOLEAN", {"default": False})

        optional["text_count"] = (
            "INT",
            {
                "default": DEFAULT_CONCAT_SLOTS,
                "min": 1,
                "max": MAX_CONCAT_SLOTS,
                "step": 1,
                "display": "number",
            },
        )

        return {
            "required": {},
            "optional": optional,
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/string"

    def doit(
        self,
        separator="",
        clean_output=False,
        text_count=DEFAULT_CONCAT_SLOTS,
        **kwargs,
    ):
        separator = self._scalar(separator, "")
        text_count = self._scalar(text_count, DEFAULT_CONCAT_SLOTS)
        clean_output = _mika_coerce_bool(clean_output, False)

        try:
            count = int(text_count)
        except Exception:
            count = DEFAULT_CONCAT_SLOTS

        count = max(1, min(MAX_CONCAT_SLOTS, count))

        sep = _mika_decode_separator(separator)

        texts = []

        for i in range(1, count + 1):
            value = None

            # Compatibilidad con versiones previas que hayan usado text_i_text.
            for key in (f"text_{i}", f"text_{i}_text"):
                if key in kwargs:
                    candidate = self._scalar(kwargs.get(key), None)
                    if candidate is not None:
                        value = candidate
                        break

            if value is None:
                value = ""

            if not isinstance(value, str):
                value = str(value)

            if clean_output:
                value = value.strip()

            if value == "":
                continue

            texts.append(value)

        if not texts:
            result = ""
        elif len(texts) == 1:
            result = texts[0]
        else:
            result = sep.join(texts)

            if clean_output and result:
                if sep:
                    parts = [p.strip() for p in result.split(sep)]
                    parts = [p for p in parts if p != ""]
                    result = sep.join(parts)

                result = re.sub(r" {2,}", " ", result)

        # El separador también se agrega al final del último tag.
        if texts and sep:
            result = result + sep

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
            response = requests.get(url, timeout=30)
            response.raise_for_status()

            if len(response.content) > 200 * 1024 * 1024:
                print(f"Load Image-Mika: descarga demasiado grande ({url}): {len(response.content)} bytes")
                return None

            img = Image.open(BytesIO(response.content))
            img.load()
            return img
        except requests.exceptions.HTTPError as errh:
            print(f"Load Image-Mika HTTP Error ({url}): {errh}")
        except requests.exceptions.ConnectionError as errc:
            print(f"Load Image-Mika Connection Error ({url}): {errc}")
        except requests.exceptions.Timeout as errt:
            print(f"Load Image-Mika Timeout ({url}): {errt}")
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


_IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tif", ".tiff", ".jfif")


def _mika_list_images(directory):
    """Lista de rutas de imágenes válidas en un directorio, ordenada."""
    if not directory or not os.path.isdir(directory):
        return []

    try:
        files = [
            os.path.join(directory, f)
            for f in os.listdir(directory)
            if os.path.isfile(os.path.join(directory, f))
            and f.lower().endswith(_IMAGE_EXTENSIONS)
        ]
    except OSError:
        return []

    return sorted(files)


class LoadImageDirMika:
    """
    Load Image from Dir-Mika: carga una imagen desde un directorio,
    seleccionándola por nombre de archivo o por índice dentro de la lista
    ordenada de imágenes del directorio.

    Modos de carga (load_mode):
    - by_name: usa "image_name" (nombre de archivo, con o sin extensión).
    - by_index: usa "image_index" (índice 0-based sobre la lista ordenada).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "directory": ("STRING", {"default": "./ComfyUI/input", "multiline": False}),
                "load_mode": (["by_name", "by_index"], {"default": "by_name"}),
            },
            "optional": {
                "image_name": ("STRING", {"default": "", "multiline": False}),
                "image_index": ("INT", {"default": 0, "min": 0, "max": 1000000}),
                "RGBA": ("BOOLEAN", {"default": False}),
                "output_dimensions": ("BOOLEAN", {"default": True}),
                "filename_text_extension": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "filename_text", "width", "height")
    FUNCTION = "load_image"
    CATEGORY = "Mika Utilidades/image"

    @staticmethod
    def _unwrap_scalar(value, default=None):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    def _resolve_path(self, directory, load_mode, image_name, image_index):
        directory = os.path.abspath(os.path.expanduser((directory or "").strip()))

        files = _mika_list_images(directory)

        if load_mode == "by_index":
            idx = self._unwrap_scalar(image_index, 0)
            try:
                idx = int(idx)
            except (TypeError, ValueError):
                idx = 0

            if idx < 0 or idx >= len(files):
                print(f"Load Image from Dir-Mika: índice {idx} fuera de rango (0..{max(len(files)-1, 0)}).")
                idx = 0

            if not files:
                return None, ""

            return files[idx], os.path.basename(files[idx])

        name = self._unwrap_scalar(image_name, "")
        name = str(name).strip()

        if not name:
            if not files:
                return None, ""
            return files[0], os.path.basename(files[0])

        # Si la ruta ya existe tal cual, se usa directamente.
        if os.path.isfile(name):
            return name, os.path.basename(name)

        # Buscar por nombre con o sin extensión, case-insensitive.
        base = os.path.splitext(os.path.basename(name))[0].lower()

        for f in files:
            fname = os.path.basename(f)
            fbase = os.path.splitext(fname)[0].lower()

            if fname.lower() == name.lower() or fbase == base:
                return f, fname

        print(f"Load Image from Dir-Mika: no se encontró '{name}' en '{directory}'.")
        return None, name

    def load_image(self, directory, load_mode="by_name", image_name="",
                   image_index=0, RGBA=False, output_dimensions=True,
                   filename_text_extension=True):
        image_path, filename = self._resolve_path(
            directory, load_mode, image_name, image_index
        )

        i = None

        if image_path:
            try:
                i = Image.open(image_path)
                i = ImageOps.exif_transpose(i)
            except OSError:
                i = None

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
            filename = os.path.basename(filename) if filename else ""
        else:
            filename = os.path.splitext(os.path.basename(filename))[0] if filename else ""

        return (image, mask, filename, width, height)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        directory = kwargs.get('directory', '')
        load_mode = kwargs.get('load_mode', 'by_name')
        image_name = kwargs.get('image_name', '')
        image_index = kwargs.get('image_index', 0)

        inst = cls()
        image_path, _ = inst._resolve_path(
            directory, load_mode, image_name, image_index
        )

        if not image_path or not os.path.exists(image_path):
            return None

        return _mika_hash_file(image_path) or None


class SmartTagFilterMika:
    r"""
    Smart Tag Filter-Mika: filtra tags con soporte de pesos, caracteres
    especiales y prefijos de color. Modo include/exclude.

    Opción nueva:
    - add_comma_space_end: si está activa, agrega ", " al final del
      texto filtrado.
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
                "add_comma_space_end": ("BOOLEAN", {"default": False}),
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

    @staticmethod
    def _scalar(value, default=None):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    @staticmethod
    def _ensure_trailing_comma_space(text):
        """
        Agrega ', ' al final del texto, normalizando si ya termina
        con coma, espacios o coma+espacio.
        """
        if not isinstance(text, str):
            text = str(text)

        if not text.strip():
            return text

        # Elimina comas y espacios sobrantes al final.
        clean = re.sub(r"[,\s]*$", "", text.rstrip())

        if not clean:
            return ""

        return clean + ", "

    def filter_tags(
        self,
        prompt,
        filter_tags,
        mode="include",
        case_sensitive=False,
        ignore_weight=False,
        ignore_color_prefix=False,
        add_comma_space_end=False,
    ):
        prompt = self._to_text(prompt)
        filter_tags = self._to_text(filter_tags)

        mode = self._scalar(mode, "include")
        if mode not in ("include", "exclude"):
            mode = "include"

        case_sensitive = _mika_coerce_bool(self._scalar(case_sensitive, False))
        ignore_weight = _mika_coerce_bool(self._scalar(ignore_weight, False))
        ignore_color_prefix = _mika_coerce_bool(
            self._scalar(ignore_color_prefix, False)
        )
        add_comma_space_end = _mika_coerce_bool(
            self._scalar(add_comma_space_end, False)
        )

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

        filtered = ", ".join([t["original"] for t in result_tags])
        matched_str = ", ".join([t["original"] for t in matched])
        unmatched_str = ", ".join([t["original"] for t in unmatched])

        if add_comma_space_end:
            filtered = self._ensure_trailing_comma_space(filtered)

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
        escaped = False

        for char in tag_string:
            if escaped:
                current += char
                escaped = False
            elif char == '\\':
                current += char
                escaped = True
            elif char == '(':
                paren_depth += 1
                current += char
            elif char == ')' and paren_depth > 0:
                paren_depth -= 1
                current += char
            elif char == ',' and paren_depth == 0:
                if current.strip():
                    parsed = self.parse_smart_tag(current)
                    if parsed:
                        tags.append(parsed)
                current = ''
            else:
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
        escaped = False

        for char in text:
            if escaped:
                current += char
                escaped = False
            elif char == '\\':
                current += char
                escaped = True
            elif char == '(':
                depth += 1
                current += char
            elif char == ')' and depth > 0:
                depth -= 1
                current += char
            elif char == ',' and depth == 0:
                if current.strip():
                    tags.append(current.strip())
                current = ''
            else:
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

    def doit(self, separator, values):
        sep = _mika_decode_separator(separator) if separator else "\n"
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
    En cada ejecución selecciona `steps` líneas empezando en `start_index`
    (índice base) y avanza ese mismo bloque hacia el siguiente.
    `start_index` se actualiza solo tras cada ejecución; `steps` (cantidad de
    líneas por generación) queda FIJO.

    Con auto_advance=False `start_index` queda FIJO (se detiene el avance) y
    cada ejecución devuelve el mismo bloque.

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
                "steps": ("INT", {"default": 1, "min": 1, "max": 999999}),
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

    def run(self, text, start_index, steps,
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
                },
                "result": ([], str(start_index)),
            }

        start = start_index % total_lines
        count = min(steps, total_lines)
        selected = [lines[(start + i) % total_lines] for i in range(count)]
        current_end = (start + count - 1) % total_lines

        if auto_advance:
            next_start = (start + count) % total_lines
        else:
            next_start = start_index

        return {
            "ui": {
                "text": [text],
                "start_index": [next_start],
            },
            "result": (selected, str(current_end)),
        }

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

        array = 255. * images.cpu().numpy()
        array = np.clip(array, 0, 255).astype(np.uint8)

        image_hash = hashlib.sha256(array.tobytes()).hexdigest()[:16]

        for idx in range(array.shape[0]):
            img = Image.fromarray(array[idx])

            filename = f"mika_preview_{image_hash}_{idx}_{int(time.time())}.png"

            temp_dir = folder_paths.get_temp_directory()
            filepath = os.path.join(temp_dir, filename)

            img.save(filepath, 'PNG')

            results.append({
                "filename": filename,
                "subfolder": "",
                "type": "temp"
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
        parts = []
        for key, value in kwargs.items():
            if key.startswith("group_") or key == "groups_filter":
                parts.append(f"{key}={value}")
        return hashlib.md5("|".join(sorted(parts)).encode("utf-8")).hexdigest()


MAX_NODE_SLOTS = 20


class FastNodesBypasserMika:
    """
    Fast Nodes Bypasser-Mika.
    Los inputs input_i se declaran hasta MAX_NODE_SLOTS para que el backend
    acepte conexiones dinámicas. El frontend muestra/oculta los slots.
    Los toggle_i son widgets BOOLEAN que el frontend muestra con el nombre
    del nodo conectado en cada input_i.
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
    Los toggle_i son widgets BOOLEAN que el frontend muestra con el nombre
    del nodo conectado en cada input_i.
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
        samplers_dict = getattr(comfy.samplers.KSampler, "SAMPLERS", {})

        # En ComfyUI recientes SAMPLERS es una lista de nombres y el
        # objeto se construye con comfy.samplers.sampler_object().
        if isinstance(samplers_dict, dict):
            sampler_fn = samplers_dict.get(sampler_name)
            if sampler_fn is not None:
                try:
                    return sampler_fn()
                except TypeError:
                    return sampler_fn

        sampler_object = getattr(comfy.samplers, "sampler_object", None)
        if callable(sampler_object):
            return sampler_object(sampler_name)

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

        counter = _mika_next_counter(save_path, prefix, ext) if add_counter else None

        saved_paths = []
        preview_results = []

        array = 255. * images.cpu().numpy()
        array = np.clip(array, 0, 255).astype(np.uint8)

        preview_hash = hashlib.sha256(array.tobytes()).hexdigest()[:16]

        for idx in range(array.shape[0]):
            img = Image.fromarray(array[idx])

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
                prev_name = f"mika_preview_{preview_hash}_{idx}_{int(time.time())}.png"
                prev_path = os.path.join(folder_paths.get_temp_directory(), prev_name)
                img.save(prev_path, "PNG")
                preview_results.append({
                    "filename": prev_name,
                    "subfolder": "",
                    "type": "temp",
                })

        if add_counter:
            _mika_bump_counter(save_path, prefix, ext, counter)

        print(f"Image Save Auto-Mika: {len(saved_paths)} imagen(es) guardadas en '{save_path}'.")

        if show_preview and preview_results:
            return {
                "ui": {"images": preview_results},
                "result": (saved_paths, len(saved_paths)),
            }

        return (saved_paths, len(saved_paths))


class IndexIntMika:
    """
    Index Int-Mika: índice INT con 3 modos de operación.

    - fixed:     devuelve siempre el valor de 'index' (cacheable).
    - increment: devuelve 'index' y luego lo auto-incrementa en 'step',
                 reflejando el avance en el widget 'index' para la próxima
                 ejecución (con wrap opcional entre min_value y max_value).
    - random:    sortea un valor entre min_value y max_value en cada
                 ejecución, ignorando 'index'.

    'index' es conectable: si se enlaza un nodo externo, su valor manda
    sobre el widget.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["fixed", "increment", "random"], {"default": "fixed"}),
                "index": ("INT", {"default": 0, "min": -9999999, "max": 9999999, "step": 1}),
                "step": ("INT", {"default": 1, "min": -999999, "max": 999999, "step": 1}),
                "min_value": ("INT", {"default": 0, "min": -9999999, "max": 9999999, "step": 1}),
                "max_value": ("INT", {"default": 999999, "min": -9999999, "max": 9999999, "step": 1}),
            },
            "optional": {
                "wrap": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("INT", "STRING")
    RETURN_NAMES = ("index", "index_text")
    FUNCTION = "run"
    CATEGORY = "Mika Utilidades/index"
    OUTPUT_NODE = True

    def run(self, mode, index, step, min_value, max_value, wrap=False):
        index = int(index)
        step = int(step)
        lo = min(int(min_value), int(max_value))
        hi = max(int(min_value), int(max_value))

        # Lectura defensiva del boolean
        if isinstance(wrap, str):
            wrap = wrap.strip().lower() in ("true", "1", "yes", "on")
        else:
            wrap = bool(wrap)

        if mode == "increment":
            out = index
            nxt = index + step
            if wrap:
                if nxt > hi:
                    nxt = lo
                elif nxt < lo:
                    nxt = hi
            return {
                "ui": {"value": [nxt]},
                "result": (out, str(out)),
            }

        if mode == "random":
            out = random_module.randint(lo, hi)
        else:  # fixed
            out = index

        return {
            "result": (out, str(out)),
        }

    @classmethod
    def IS_CHANGED(cls, mode="fixed", index=0, **kwargs):
        # fixed → cacheable; increment/random → re-ejecuta siempre.
        if mode in ("increment", "random"):
            return float("nan")
        return index


class IndexStepperMika:
    """
    Index Stepper-Mika: escalona índices de forma ESCALONADA (auto-avanza),
    igual que el Text Line Stepper. En cada ejecución selecciona `steps`
    índices empezando en `start_index` (índice base) y avanza ese mismo
    bloque hacia el siguiente, dentro del dominio 0..max_index (cíclico).
    `start_index` se actualiza solo tras cada ejecución; `steps` queda FIJO.

    Con auto_advance=False `start_index` queda FIJO (se detiene el avance) y
    cada ejecución devuelve el mismo bloque.

    Salidas:
    - index_list: LISTA de INT con los índices del bloque actual.
    - current_start / current_end: INT con los límites del bloque actual.
    - range_text: STRING "4-6".
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "start_index": ("INT", {"default": 0, "min": 0, "max": 999999}),
                "steps": ("INT", {"default": 1, "min": 1, "max": 999999}),
            },
            "optional": {
                "auto_advance": ("BOOLEAN", {"default": True}),
                "max_index": ("INT", {"default": 999999, "min": 0, "max": 999999, "step": 1}),
            },
        }

    RETURN_TYPES = ("INT", "INT", "INT", "STRING")
    RETURN_NAMES = ("index_list", "current_start", "current_end", "range_text")
    OUTPUT_IS_LIST = (True, False, False, False)
    FUNCTION = "run"
    CATEGORY = "Mika Utilidades/index"
    OUTPUT_NODE = True

    def run(self, start_index, steps, auto_advance=True, max_index=999999):
        auto_advance = _mika_coerce_bool(auto_advance)

        total = max(1, int(max_index) + 1)
        steps = max(1, int(steps))

        start = int(start_index) % total
        count = min(steps, total)
        index_list = [((start + i) % total) for i in range(count)]

        current_start = index_list[0] if index_list else start
        current_end = index_list[-1] if index_list else start

        if auto_advance:
            next_start = (start + count) % total
        else:
            next_start = int(start_index)

        return {
            "ui": {
                "start_index": [next_start],
            },
            "result": (index_list, current_start, current_end, f"{current_start}-{current_end}"),
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


class LoadImageNameMika:
    """
    Load Image + Name-Mika: similar al Load Image nativo de ComfyUI,
    pero además devuelve el nombre de la imagen seleccionada.

    Compatible con imágenes editadas en inpaint / mask editor,
    que suelen usar rutas temporales o anotadas.
    """

    @staticmethod
    def _get_image_list():
        files = []

        # ComfyUI moderno.
        try:
            files = folder_paths.get_filename_list("input")
        except TypeError:
            try:
                files = folder_paths.get_filename_list()
            except Exception:
                files = []
        except Exception:
            files = []

        # Fallback manual por si get_filename_list falla.
        if not files:
            try:
                input_dir = folder_paths.get_input_directory()
                files = [
                    f
                    for f in os.listdir(input_dir)
                    if os.path.isfile(os.path.join(input_dir, f))
                ]
            except Exception:
                files = []

        if not files:
            return [""]

        return sorted(files)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (cls._get_image_list(), {"image_upload": True}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "image_name")
    FUNCTION = "load_image"
    CATEGORY = "Mika Utilidades/image"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        """
        Evita que ComfyUI rechaze valores temporales/anotados que
        pueden aparecer al usar inpaint o mask editor.
        """
        return True

    @staticmethod
    def _unwrap_scalar(value, default=None):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    @classmethod
    def _resolve_path(cls, image):
        image = cls._unwrap_scalar(image, "")

        if not isinstance(image, str):
            image = str(image)

        image = image.strip()

        if not image:
            return None, ""

        path = None

        # 1) Intentar resolución anotada. Ej:
        #    "foto.png [input]"
        #    "clipspace/clipspace-mask.png [temp]"
        try:
            path = folder_paths.get_annotated_filepath(image)
            if path and os.path.exists(path):
                return path, os.path.basename(path)
        except TypeError:
            try:
                path = folder_paths.get_annotated_filepath(
                    image,
                    folder_paths.get_input_directory()
                )
                if path and os.path.exists(path):
                    return path, os.path.basename(path)
            except Exception:
                path = None
        except Exception:
            path = None

        # 2) Intentar resolución anotada usando input como carpeta default.
        try:
            path = folder_paths.get_annotated_filepath(
                image,
                folder_paths.get_input_directory()
            )
            if path and os.path.exists(path):
                return path, os.path.basename(path)
        except Exception:
            pass

        # 3) Buscar como input normal.
        try:
            path = folder_paths.get_full_path("input", image)
            if path and os.path.exists(path):
                return path, os.path.basename(path)
        except Exception:
            pass

        # 4) Por si ya viene como ruta directa.
        if os.path.exists(image):
            return image, os.path.basename(image)

        # 5) Buscar por nombre base en input/temp/output.
        base_clean = image.split(" [")[0].strip()
        base = os.path.basename(base_clean)

        search_dirs = []

        for fn in ("get_input_directory", "get_temp_directory", "get_output_directory"):
            try:
                d = getattr(folder_paths, fn)()
                if d:
                    search_dirs.append(d)
            except Exception:
                pass

        for d in search_dirs:
            candidate = os.path.join(d, base)
            if os.path.exists(candidate):
                return candidate, base

            candidate2 = os.path.join(d, base_clean)
            if os.path.exists(candidate2):
                return candidate2, os.path.basename(candidate2)

        return None, base

    def load_image(self, image):
        image_path, filename = self._resolve_path(image)

        # Nombre sin extensión.
        image_name = os.path.splitext(filename)[0]

        if not image_path or not os.path.exists(image_path):
            print(f"Load Image + Name-Mika: no se encontró la imagen '{image}'.")

            black = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            mask = torch.zeros((1, 64, 64), dtype=torch.float32)

            return (black, mask, image_name)

        try:
            img = Image.open(image_path)
            img = ImageOps.exif_transpose(img)

            # Modo 1-bit / máscara simple.
            try:
                if img.getbands()[0] == "M":
                    img = img.convert("RGB")
            except Exception:
                img = img.convert("RGB")

            # Convierto a RGBA para extraer alpha.
            # Si la imagen no tiene alpha, el canal A queda todo en 255,
            # por lo tanto la máscara queda en 0.
            try:
                rgba = img.convert("RGBA")
            except Exception:
                rgba = img.convert("RGB").convert("RGBA")

            alpha_np = np.array(rgba.getchannel("A")).astype(np.float32) / 255.0
            mask = 1.0 - torch.from_numpy(alpha_np)

            # La máscara queda batcheada: (1, H, W)
            mask = mask.unsqueeze(0)

            rgb = rgba.convert("RGB")
            image_np = np.array(rgb).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(image_np)[None, ]

            return (image_tensor, mask, image_name)

        except Exception as e:
            print(f"Load Image + Name-Mika: error cargando '{image_path}': {e}")

            black = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            mask = torch.zeros((1, 64, 64), dtype=torch.float32)

            return (black, mask, image_name)

    @classmethod
    def IS_CHANGED(cls, image):
        """
        Hash del archivo para detectar cambios, útil cuando el inpaint
        sobreescribe o reemplaza una imagen temporal.
        """
        image_path, _ = cls._resolve_path(image)

        if not image_path:
            return None

        return _mika_hash_file(image_path) or None


class IfAnyMika:
    """
    If Any-Mika: evalúa una entrada ANY y devuelve un valor/texto si
    cumple la condición, u otro valor/texto si no cumple.

    Modos:
    - auto:
        * Si "find" está vacío → detecta que exista un valor no vacío.
        * Si "find" tiene texto → busca ese texto dentro del input.
    - exists:
        * True si el input no es None.
    - not_empty:
        * True si el input no está vacío.
    - boolean_true:
        * True si el input se puede interpretar como verdadero.
    - contains:
        * True si el input contiene el texto de "find".
    - equals:
        * True si el input es igual al texto de "find".
    - starts_with:
        * True si el input empieza con el texto de "find".
    - ends_with:
        * True si el input termina con el texto de "find".
    - regex:
        * True si el input matchea la expresión regular de "find".
    """

    INPUT_IS_LIST = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input": ("*", {"forceInput": True}),
                "mode": (
                    [
                        "auto",
                        "exists",
                        "not_empty",
                        "boolean_true",
                        "contains",
                        "equals",
                        "starts_with",
                        "ends_with",
                        "regex",
                    ],
                    {"default": "auto"},
                ),
            },
            "optional": {
                "find": ("STRING", {"default": "", "multiline": False}),
                "case_sensitive": ("BOOLEAN", {"default": False}),
                "value_if_found": ("*", {"forceInput": True}),
                "value_if_not_found": ("*", {"forceInput": True}),
                "text_if_found": ("STRING", {"default": "true", "multiline": True}),
                "text_if_not_found": ("STRING", {"default": "false", "multiline": True}),
            },
        }

    RETURN_TYPES = ("*", "BOOLEAN", "STRING")
    RETURN_NAMES = ("result", "matched", "result_text")
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/condicional"

    def doit(
        self,
        input=None,
        mode="auto",
        find="",
        case_sensitive=False,
        value_if_found=None,
        value_if_not_found=None,
        text_if_found="true",
        text_if_not_found="false",
    ):
        input_value = self._unwrap_any(input)
        mode = self._unwrap_scalar(mode, "auto")
        find = self._unwrap_scalar(find, "")
        case_sensitive = _mika_coerce_bool(self._unwrap_scalar(case_sensitive, False))

        value_if_found = self._unwrap_any(value_if_found)
        value_if_not_found = self._unwrap_any(value_if_not_found)

        text_if_found = self._unwrap_scalar(text_if_found, "")
        text_if_not_found = self._unwrap_scalar(text_if_not_found, "")

        matched = self._matches(
            value=input_value,
            mode=mode,
            find=find,
            case_sensitive=case_sensitive,
        )

        if matched:
            if value_if_found is not None:
                result = value_if_found
            else:
                result = text_if_found
        else:
            if value_if_not_found is not None:
                result = value_if_not_found
            else:
                result = text_if_not_found

        result_text = self._to_text(result)

        return (result, matched, result_text)

    @staticmethod
    def _unwrap_scalar(value, default=None):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    @staticmethod
    def _unwrap_any(value):
        if value is None:
            return None

        if isinstance(value, (list, tuple)):
            if len(value) == 0:
                return None
            if len(value) == 1:
                return value[0]
            return list(value)

        return value

    @staticmethod
    def _is_empty(value):
        if value is None:
            return True

        if isinstance(value, str):
            return value.strip() == ""

        if isinstance(value, bool):
            return False

        if isinstance(value, (int, float)):
            return False

        if isinstance(value, (list, tuple, set, dict)):
            return len(value) == 0

        if torch.is_tensor(value):
            try:
                return value.numel() == 0
            except Exception:
                return True

        if isinstance(value, np.ndarray):
            try:
                return value.size == 0
            except Exception:
                return True

        return False

    def _collect_texts(self, value, depth=0):
        """
        Junta representaciones de texto del valor para poder buscar
        texto dentro de strings, listas, dicts, tensors simples, etc.
        """
        if depth > 3:
            return [str(value)]

        if value is None:
            return [""]

        if isinstance(value, str):
            return [value]

        if isinstance(value, bool):
            return ["true" if value else "false"]

        if isinstance(value, (int, float)):
            return [str(value)]

        if isinstance(value, (list, tuple, set)):
            out = []
            try:
                items = list(value)[:200]
            except Exception:
                items = []

            for item in items:
                out.extend(self._collect_texts(item, depth + 1))

            return out if out else [""]

        if isinstance(value, dict):
            out = []
            try:
                items = list(value.items())[:200]
            except Exception:
                items = []

            for k, v in items:
                out.extend(self._collect_texts(k, depth + 1))
                out.extend(self._collect_texts(v, depth + 1))

            return out if out else [""]

        if torch.is_tensor(value):
            try:
                if value.numel() == 1:
                    return [str(value.item())]

                if value.numel() <= 16:
                    return [str(value.tolist())]

                return [f"Tensor(shape={tuple(value.shape)}, dtype={value.dtype})"]
            except Exception:
                return [str(value)]

        if isinstance(value, np.ndarray):
            try:
                if value.size == 1:
                    return [str(value.item())]

                if value.size <= 16:
                    return [str(value.tolist())]

                return [f"ndarray(shape={tuple(value.shape)}, dtype={value.dtype})"]
            except Exception:
                return [str(value)]

        return [str(value)]

    def _to_text(self, value, depth=0):
        """
        Convierte el resultado a texto legible para la salida STRING.
        """
        if depth > 3:
            return str(value)

        if value is None:
            return ""

        if isinstance(value, str):
            return value

        if isinstance(value, bool):
            return "true" if value else "false"

        if isinstance(value, (int, float)):
            return str(value)

        if torch.is_tensor(value):
            try:
                if value.numel() == 1:
                    return str(value.item())

                if value.numel() <= 16:
                    return str(value.tolist())

                return f"Tensor(shape={tuple(value.shape)}, dtype={value.dtype})"
            except Exception:
                return str(value)

        if isinstance(value, np.ndarray):
            try:
                if value.size == 1:
                    return str(value.item())

                if value.size <= 16:
                    return str(value.tolist())

                return f"ndarray(shape={tuple(value.shape)}, dtype={value.dtype})"
            except Exception:
                return str(value)

        if isinstance(value, (list, tuple, set)):
            try:
                items = list(value)
            except Exception:
                items = []

            shown = items[:20]
            parts = [self._to_text(x, depth + 1) for x in shown]

            if len(items) > len(shown):
                parts.append(f"... +{len(items) - len(shown)} elementos")

            return "[" + ", ".join(parts) + "]"

        if isinstance(value, dict):
            try:
                items = list(value.items())
            except Exception:
                items = []

            shown = items[:20]
            parts = [
                f"{self._to_text(k, depth + 1)}: {self._to_text(v, depth + 1)}"
                for k, v in shown
            ]

            if len(items) > len(shown):
                parts.append(f"... +{len(items) - len(shown)} elementos")

            return "{" + ", ".join(parts) + "}"

        return str(value)

    def _matches(self, value, mode, find, case_sensitive):
        if mode == "exists":
            return value is not None

        if mode == "not_empty":
            return not self._is_empty(value)

        if mode == "boolean_true":
            return _mika_coerce_bool(value)

        find_text = "" if find is None else str(find)

        if mode == "auto":
            if find_text.strip() == "":
                return not self._is_empty(value)
            mode = "contains"

        texts = self._collect_texts(value)

        if mode == "regex":
            flags = 0 if case_sensitive else re.IGNORECASE

            for text in texts:
                try:
                    if re.search(find_text, text, flags) is not None:
                        return True
                except re.error:
                    return False

            return False

        if case_sensitive:
            find_cmp = find_text
            texts_cmp = texts
        else:
            find_cmp = find_text.lower()
            texts_cmp = [t.lower() for t in texts]

        if mode == "equals":
            return any(t == find_cmp for t in texts_cmp)

        if mode == "contains":
            return any(find_cmp in t for t in texts_cmp)

        if mode == "starts_with":
            return any(t.startswith(find_cmp) for t in texts_cmp)

        if mode == "ends_with":
            return any(t.endswith(find_cmp) for t in texts_cmp)

        # Fallback.
        return not self._is_empty(value)


class BypassDetectorMika:
    """
    Bypass Detector-Mika: detecta si el nodo indicado (por título o id)
    está en modo bypass y devuelve el texto configurado según el estado.
    La detección la hace el frontend (el bypass es solo visual y nunca
    llega al backend); el estado se comunica vía el widget is_bypassed.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "target": ("STRING", {"default": "", "multiline": False}),
                "text_on_bypass": ("STRING", {"default": "", "multiline": True}),
                "text_on_active": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "is_bypassed": ("BOOLEAN", {"default": False}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING", "BOOLEAN", "STRING")
    RETURN_NAMES = ("text", "bypassed", "state")
    FUNCTION = "detect"
    CATEGORY = "Mika Utilidades/utils"

    def detect(self, target="", text_on_bypass="", text_on_active="", is_bypassed=False, unique_id=None):
        if is_bypassed:
            return (text_on_bypass, True, "bypass")
        return (text_on_active, False, "active")

    @classmethod
    def IS_CHANGED(cls, is_bypassed=False, **kwargs):
        return is_bypassed


class TextSaveMika:
    """
    Text Save-Mika: guarda texto en un archivo local.

    write_mode:
    - overwrite: reemplaza el contenido del archivo.
    - append:    agrega el texto al final del archivo.
    - prepend:   agrega el texto al inicio del archivo.

    El texto puede venir por SLOT (text, forceInput) o escribirse en la
    caja editable si el slot no está conectado.
    """

    @staticmethod
    def _scalar(value, default=None):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "save_path": ("STRING", {"default": "./ComfyUI/output/text", "multiline": False}),
                "filename": ("STRING", {"default": "mika_text.txt", "multiline": False}),
                "write_mode": (["overwrite", "append", "prepend"], {"default": "overwrite"}),
                "file_format": (
                    [".txt", ".log", ".md", ".csv", ".json", ".html", ".xml", ".yaml", ".yml", ".ini", ".cfg", ".css", ".py"],
                    {"default": ".txt"},
                ),
            },
            "optional": {
                "text": ("STRING", {"multiline": True, "default": "", "forceInput": True}),
                "separator": ("STRING", {"default": "\\n", "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("filepath", "char_count")
    FUNCTION = "save"
    CATEGORY = "Mika Utilidades/string"
    OUTPUT_NODE = True

    def save(self, save_path, filename, write_mode="overwrite", file_format=".txt", text="", separator="\\n"):
        save_path = os.path.abspath(os.path.expanduser((save_path or "").strip()))
        filename = (filename or "").strip()

        if not filename:
            raise ValueError("Text Save-Mika: filename no puede estar vacío.")

        try:
            os.makedirs(save_path, exist_ok=True)
        except Exception as e:
            raise RuntimeError(f"Text Save-Mika: no se pudo crear la carpeta '{save_path}': {e}")

        if not isinstance(text, str):
            text = str(text)

        ext = (file_format or ".txt").strip().lower()
        if not ext.startswith("."):
            ext = "." + ext

        if not filename.lower().endswith(ext):
            filename += ext

        filepath = os.path.join(save_path, filename)
        sep = _mika_decode_separator(separator)

        if write_mode == "append":
            existing = ""
            if os.path.isfile(filepath):
                with open(filepath, "r", encoding="utf-8") as f:
                    existing = f.read()
            content = existing + sep + text
        elif write_mode == "prepend":
            existing = ""
            if os.path.isfile(filepath):
                with open(filepath, "r", encoding="utf-8") as f:
                    existing = f.read()
            content = text + sep + existing
        else:
            content = text

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)

        print(f"Text Save-Mika: {len(content)} caracteres guardados en '{filepath}' (modo: {write_mode}).")

        return (filepath, len(content))


# ======================================================================
# ANIMA PROMPT ORGANIZER (migrado desde Mika_Anima_Order)
# ======================================================================

HARD_NORMALIZE = True
HARD_DEDUPE = True
HARD_AUTO_AT_PREFIX = True
HARD_SERIES_FROM_CHARACTER = True
HARD_ARTIST_POLICY_KEEP_FIRST = True

NEG_NO_SCORE = ("worst quality, low quality, artist name, blurry, "
                "jpeg artifacts, chromatic aberration")
NEG_WITH_SCORE = ("worst quality, low quality, score_1, score_2, score_3, "
                  "artist name, blurry, jpeg artifacts, chromatic aberration")

QUALITY_HUMAN = {
    "masterpiece", "best quality", "high quality", "good quality",
    "normal quality", "low quality", "worst quality", "very aesthetic",
    "aesthetic",
}

SCORE_RE = re.compile(r"^score_\d(_up)?$")
YEAR_RE = re.compile(r"^year\s+\d{3,4}$")

PERIOD = {"newest", "recent", "mid", "early", "old"}

SAFETY = {"safe", "sensitive", "nsfw", "explicit", "general", "questionable"}

META = {
    "highres", "absurdres", "incredibly absurdres", "lowres",
    "anime screenshot", "anime screencap", "screencap",
    "jpeg artifacts", "official art", "official alternate costume",
    "artist name", "watermark", "signature", "web address", "dated",
    "scan", "game cg", "promotional art", "key visual", "logo",
    "commentary", "commentary request", "english commentary",
    "translated", "traditional media", "photoshop (medium)",
    "bad id", "bad pixiv id", "md5 mismatch", "revision",
    "third-party edit", "chromatic aberration",
}

COUNT_RE = re.compile(r"^\d+\+?(girl|boy|other)s?$")
COUNT_EXTRA = {
    "solo", "solo focus", "multiple girls", "multiple boys",
    "multiple others", "no humans", "1other", "6+girls", "6+boys",
}

PAREN_NOT_CHARACTER = {
    "photoshop (medium)", "painting (medium)", "watercolor (medium)",
    "marker (medium)", "pencil (medium)", "ink (medium)",
    "sword (weapon)", "heart (symbol)", "spoken heart (symbol)",
}

DATASET_HEADERS = {"ye-pop", "deviantart"}

BUCKETS = ["quality", "meta", "year", "safety", "count",
           "character", "series", "artist", "general", "nl"]


def _anima_split_tags(text):
    """Corta por comas y saltos de linea respetando parentesis y escapes."""
    parts, buf, depth, i = [], [], 0, 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            buf.append(ch)
            buf.append(text[i + 1])
            i += 2
            continue
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth = max(0, depth - 1)
        if (ch == "," or ch == "\n") and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return [p.strip() for p in parts if p.strip()]


_WEIGHT_RE = re.compile(r"^\((.*):\s*-?\d*\.?\d+\s*\)$", re.DOTALL)


def _anima_core(tag):
    """Devuelve el tag sin sintaxis de peso ni parentesis de enfasis."""
    t = tag.strip()
    for _ in range(8):
        m = _WEIGHT_RE.match(t)
        if m:
            t = m.group(1).strip()
            continue
        if len(t) >= 2 and t[0] in "([" and t[-1] in ")]" and "\\" not in (t[0] + t[-1]):
            inner = t[1:-1]
            if inner.count("(") == inner.count(")"):
                t = inner.strip()
                continue
        break
    return t


def _anima_normalize(tag):
    """Minusculas, guiones bajos a espacios (salvo score_N), espacios limpios."""
    def repl(m):
        w = m.group(0)
        if w.startswith("score_"):
            return w
        return w.replace("_", " ")

    t = re.sub(r"[^\s,()\[\]:]+", repl, tag.lower())
    return re.sub(r"\s+", " ", t).strip()


def _anima_is_natural_language(text):
    c = _anima_core(text)
    if re.search(r"[.!?](\s|$)", c):
        return True
    return len(c.split()) >= 7


_CHAR_PAREN_RE = re.compile(r"^(.+?)\s*\\?\((.+?)\\?\)$")

_AT_IN_NL_RE = re.compile(r"@([A-Za-z0-9][A-Za-z0-9 _'\-]*?)(?=\s*[,.;!?]|$)")


class AnimaPromptOrganizer:
    """Reordena un prompt libre al formato de tags de Anima."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "quality_tags": ("STRING", {
                    "multiline": True,
                    "dynamicPrompts": False,
                    "default": "masterpiece, best quality",
                    "placeholder": ("tags de calidad / meta / year / safety, en el "
                                    "orden que quieras (100% custom, no se auto-generan)"),
                }),
                "prompt": ("STRING", {
                    "multiline": True,
                    "dynamicPrompts": False,
                    "default": "1girl, smile, standing, simple background",
                    "placeholder": "escena, pose, fondo, y cualquier tag suelto",
                }),
                "character": ("STRING", {
                    "multiline": True,
                    "dynamicPrompts": False,
                    "default": "",
                    "placeholder": ("una linea por personaje, orden fijo: "
                                    "personaje, serie, rasgo, rasgo, ...\n"
                                    "ej: clementine \\(overlord\\), overlord \\(maruyama\\), "
                                    "red eyes, blonde hair, short hair"),
                }),
                "style": ("STRING", {
                    "multiline": True,
                    "dynamicPrompts": False,
                    "default": "",
                    "placeholder": "una linea por estilo, ej: @wlop  o  @wlop, anime coloring",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("positive", "negative", "report")
    FUNCTION = "organize"
    CATEGORY = "Mika Utilidades/prompt"
    DESCRIPTION = ("Reordena al formato de Anima: [quality/meta/year/safety] "
                   "[count] [character] [series] @artist [general]. "
                   "'quality_tags' es literal/custom; 'character' separa "
                   "personaje/serie/rasgos por posicion (una linea por "
                   "personaje); 'style' detecta el/los @artista.")

    @staticmethod
    def _lines(block):
        """Bloque multilinea -> lista de lineas no vacias, en orden."""
        if not block:
            return []
        return [ln for ln in block.split("\n") if ln.strip()]

    def _classify(self, tag, known_artists, known_chars, known_series):
        c = _anima_normalize(_anima_core(tag))

        if c.startswith("@"):
            return "artist", c[1:].strip()
        if c.startswith("by ") and len(c) > 3:
            return "artist", c[3:].strip()
        if c in known_artists:
            return "artist", c

        if c in QUALITY_HUMAN or SCORE_RE.match(c):
            return "quality", c
        if YEAR_RE.match(c) or c in PERIOD:
            return "year", c
        if c in SAFETY:
            return "safety", c
        if c in META:
            return "meta", c
        if COUNT_RE.match(c) or c in COUNT_EXTRA:
            return "count", c

        if c in known_chars:
            return "character", c
        if c in known_series:
            return "series", c

        if c not in PAREN_NOT_CHARACTER:
            m = _CHAR_PAREN_RE.match(c)
            if m and not re.match(r"^-?\d*\.?\d+$", m.group(2).strip()):
                return "character", c

        return "general", c

    def organize(self, quality_tags, prompt, character, style):
        notes = []
        raw = prompt or ""

        head_lines = raw.split("\n")
        if head_lines and head_lines[0].strip().lower() in DATASET_HEADERS:
            report = ("=== Anima Prompt Organizer ===\n"
                      "Prompt con dataset tag ('%s'): se pasa tal cual, sin "
                      "reordenar, porque ese formato depende de los saltos de "
                      "linea." % head_lines[0].strip())
            return (raw.strip(), NEG_NO_SCORE, report)

        buckets = {b: [] for b in BUCKETS}
        seen = set()
        dropped = []

        for t in _anima_split_tags(quality_tags or ""):
            key = _anima_normalize(_anima_core(t)) if HARD_NORMALIZE else t.strip()
            if HARD_DEDUPE and key in seen:
                dropped.append("%s (duplicado en quality_tags)" % key)
                continue
            seen.add(key)
            buckets["quality"].append(key)

        char_lines = self._lines(character)
        style_lines = self._lines(style)

        known_chars, known_series, known_artists = set(), set(), set()
        for ln in char_lines:
            items = _anima_split_tags(ln)
            if items:
                known_chars.add(_anima_normalize(_anima_core(items[0])))
            if len(items) > 1:
                known_series.add(_anima_normalize(_anima_core(items[1])))
        for ln in style_lines:
            for it in _anima_split_tags(ln):
                c = _anima_normalize(_anima_core(it))
                if c.startswith("@"):
                    known_artists.add(c[1:])
                elif c.startswith("by ") and len(c) > 3:
                    known_artists.add(c[3:])

        slot_segments = []
        for ln in char_lines:
            items = _anima_split_tags(ln)
            if not items:
                continue

            char_txt = _anima_normalize(_anima_core(items[0])) if HARD_NORMALIZE else items[0].strip()
            if not (HARD_DEDUPE and char_txt in seen):
                seen.add(char_txt)
                buckets["character"].append(char_txt)

            if len(items) > 1:
                ser_txt = _anima_normalize(_anima_core(items[1])) if HARD_NORMALIZE else items[1].strip()
                if not (HARD_DEDUPE and ser_txt in seen):
                    seen.add(ser_txt)
                    buckets["series"].append(ser_txt)
            else:
                notes.append("Una linea de 'character' no trae serie "
                             "(2a posicion vacia): %s" % ln.strip())

            if len(items) > 2:
                slot_segments += items[2:]

        style_segments = []
        any_artist_tag = False
        for ln in style_lines:
            items = _anima_split_tags(ln)
            style_segments += items
            if any(_anima_normalize(_anima_core(it)).startswith(("@", "by ")) for it in items):
                any_artist_tag = True
        if style_lines and not any_artist_tag:
            notes.append("El campo 'style' no trae ningun tag con '@' o 'by '; "
                         "no se reconocera como artista.")

        segments = slot_segments + style_segments + _anima_split_tags(raw)

        for seg in segments:
            if _anima_is_natural_language(seg):
                found = _AT_IN_NL_RE.findall(seg)
                for name in found:
                    key = "@" + _anima_normalize(name)
                    if HARD_DEDUPE and key in seen:
                        continue
                    seen.add(key)
                    buckets["artist"].append(key)
                if found:
                    seg = _AT_IN_NL_RE.sub("", seg)
                seg = re.sub(r"\s+", " ", seg).strip(" ,.")
                if seg:
                    buckets["nl"].append(seg)
                continue

            bucket, key = self._classify(seg, known_artists, known_chars, known_series)
            text = _anima_normalize(seg) if HARD_NORMALIZE else seg.strip()

            if bucket == "artist":
                base = key
                if HARD_AUTO_AT_PREFIX or _anima_normalize(_anima_core(seg)).startswith("@"):
                    text = "@" + base
                else:
                    text = base
                    notes.append(
                        "'%s' quedo sin '@'; sin el prefijo el efecto del "
                        "artista es muy debil." % base)
                key = "@" + base

            if HARD_DEDUPE:
                if key in seen:
                    continue
                seen.add(key)

            buckets[bucket].append(text)

            if bucket == "character" and HARD_SERIES_FROM_CHARACTER:
                m = _CHAR_PAREN_RE.match(_anima_normalize(_anima_core(seg)))
                if m:
                    ser = m.group(2).strip()
                    if ser and ser not in seen and ser not in known_artists:
                        buckets["series"].append(ser)
                        seen.add(ser)
                        notes.append(
                            "Serie '%s' inferida de '%s' (verifica que sea la "
                            "serie y no una variante del personaje)." % (ser, m.group(1)))

        if buckets["artist"]:
            if HARD_ARTIST_POLICY_KEEP_FIRST and len(buckets["artist"]) > 1:
                extra = buckets["artist"][1:]
                buckets["artist"] = buckets["artist"][:1]
                dropped += ["%s (multi-artista)" % a for a in extra]
                notes.append(
                    "Se conservo solo el primer artista. Apilar artistas diluye "
                    "el estilo hacia ilustracion plana.")
            name = buckets["artist"][0].lstrip("@")
            if len(name.split()) == 1 and len(name) <= 6:
                notes.append(
                    "'%s' es un nombre corto (pocos tokens) y tiende a ser "
                    "menos estable entre prompts." % name)
        else:
            notes.append("No hay tag de artista: el estilo quedara al gusto "
                         "por defecto del modelo.")

        head = (buckets["quality"] + buckets["meta"] + buckets["year"] +
                buckets["safety"])
        tags_body = (buckets["count"] + buckets["character"] +
                     buckets["series"] + buckets["general"])
        body = (buckets["count"] + buckets["character"] + buckets["series"] +
                buckets["artist"] + buckets["general"])

        nl = ""
        for piece in buckets["nl"]:
            if not nl:
                nl = piece
            elif nl[-1] in ".!?":
                nl += " " + piece
            else:
                nl += ", " + piece
        nl = nl.strip()

        pure_nl = not tags_body and bool(nl)

        if nl and pure_nl:
            lead_txt = ", ".join(head + buckets["artist"])
            positive = (lead_txt + ". " if lead_txt else "") + nl
            if tags_body:
                positive += ", " + ", ".join(tags_body)
        else:
            positive = ", ".join(head + body)
            if nl:
                positive = (positive + ", " if positive else "") + nl

        has_score = any(SCORE_RE.match(t) for t in buckets["quality"])
        negative = NEG_WITH_SCORE if has_score else NEG_NO_SCORE

        total_tags = sum(len(buckets[b]) for b in BUCKETS if b != "nl")
        if total_tags < 8 and not nl:
            notes.append("Prompt corto: Anima rellena huecos por su cuenta y "
                         "aparece mas sangrado de estilo. Agrega pelo, ojos, "
                         "ropa, pose y fondo.")
        if len(buckets["character"]) > 1:
            notes.append("Varios personajes: dale a cada uno al menos un rasgo "
                         "distintivo no compartido o el modelo los fusiona.")

        report_lines = ["=== Anima Prompt Organizer ==="]
        for b in BUCKETS:
            if buckets[b]:
                val = nl if b == "nl" else ", ".join(buckets[b])
                report_lines.append("%-10s : %s" % (b, val))
        if dropped:
            report_lines.append("%-10s : %s" % ("removidos", ", ".join(dropped)))
        if notes:
            report_lines.append("--- avisos ---")
            report_lines += ["* " + n for n in dict.fromkeys(notes)]

        return (positive, negative, "\n".join(report_lines))


class PromptCleanDedupeMika:
    """
    Prompt Clean & Dedupe-Mika: une las funciones de AnimaPromptFormatter y
    Remove Duplicate Tags [LP] en un solo nodo.

    1. Formata el prompt: quita saltos de línea, separa por comas, limpia
       espacios y descarta tags vacíos.
    2. Elimina tags repetidos conservando solo la primera aparición.

    Ejemplo: "tag1\\ntag2 ,, tag1" -> "tag1, tag2"
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "display": "prompt",
                }),
            },
            "optional": {
                "trailing_comma": ("BOOLEAN", {
                    "default": False,
                    "label_on": "coma final",
                    "label_off": "sin coma final",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "Mika Utilidades/prompt"

    def run(self, text, trailing_comma=False):
        if not text:
            return ("",)

        text = text.replace("\r\n", " ").replace("\r", " ").replace("\n", " ")

        seen = set()
        unique_tags = []
        for tag in text.split(","):
            tag = tag.strip()
            if tag and tag not in seen:
                seen.add(tag)
                unique_tags.append(tag)

        result = ", ".join(unique_tags)
        if trailing_comma and result:
            result += ","

        return (result,)


# ======================================================================
# FILTROS-MIKA (versión sólida del subgrafo "FILTROS")
# ======================================================================

class FiltrosMika:
    """
    FILTROS-Mika: nodo sólido equivalente al subgrafo "FILTROS".

    Entradas (todas linkeables):
    - prompt: prompt general completo.
    - filtro_gen / filtro_cara / filtro_ropa / filtro_lugar: tags a
      seleccionar del prompt (modo include).
    - all_gen / all_lugar: listas completas de categorías que se excluyen
      del prompt en la salida TEXTO SIN FILTRO.
    - per_f_extra / per_m_extra (opcionales): textos multilínea con un
      personaje por línea. Si no hay nada conectado cuentan como vacíos.
      Según los tags "Ngirls"/"Nboys" del filtro GEN se añaden N-1
      personajes del sexo correspondiente.

    - min_palabras: frases del filtro GEN con ese número de palabras o más
      se separan como "lenguaje natural" (0 = sin separación). Ej: con 4
      pasan a TAGS NATURAL frases como "boy standing on flor".
    - concatenar_natural: si está activo, las frases de TAGS NATURAL se
      concatenan también en F GEN y sus combinaciones.

    Salidas: combinaciones F GEN + extras con CARA/ROPA/LUGAR, más los
    filtros individuales, los TAGS SIN FILTRO y el PROMPT SIN FILTRO.
    """

    @classmethod
    def INPUT_TYPES(cls):
        slot = ("*", {"forceInput": True})
        return {
            "required": {
                "prompt": slot,
                "filtro_gen": slot,
                "filtro_cara": slot,
                "filtro_ropa": slot,
                "filtro_lugar": slot,
                "all_gen": slot,
                "all_lugar": slot,
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "min_palabras": ("INT", {"default": 0, "min": 0, "max": 20}),
                "concatenar_natural": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "per_f_extra": slot,
                "per_m_extra": slot,
                "ignore_color_prefix": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = tuple(["STRING"] * 14)
    RETURN_NAMES = (
        "F GEN",
        "F GEN + CARA",
        "F GEN + ROPA",
        "F GEN + ROPA + CARA",
        "F GEN + ROPA + CARA + LUGAR",
        "F GEN + CARA + LUGAR",
        "F GEN + LUGAR",
        "TAGS SIN FILTRO",
        "TAGS NATURAL",
        "FILTRO GENERAL",
        "FILTRO ROPA",
        "FILTRO CARA",
        "FILTRO LUGAR",
        "PROMPT SIN FILTRO",
    )
    FUNCTION = "execute"
    CATEGORY = "Mika Utilidades/tags"

    @staticmethod
    def _scalar(value, default=""):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    @staticmethod
    def _join(*parts):
        clean = [re.sub(r"[,\s]*$", "", str(p)) for p in parts]
        return ", ".join([p for p in clean if p])

    @staticmethod
    def _pick_lines(text, count, rng):
        lines = [ln for ln in str(text).splitlines() if ln.strip()]
        if not lines or count <= 0:
            return ""
        count = min(count, len(lines))
        return ", ".join(rng.sample(lines, count))

    def execute(
        self,
        prompt,
        filtro_gen,
        filtro_cara,
        filtro_ropa,
        filtro_lugar,
        all_gen,
        all_lugar,
        seed=0,
        min_palabras=0,
        concatenar_natural=False,
        per_f_extra="",
        per_m_extra="",
        ignore_color_prefix=True,
    ):
        scalar = self._scalar
        prompt = str(scalar(prompt, ""))
        ignore_color_prefix = _mika_coerce_bool(scalar(ignore_color_prefix, True))

        filtros = {}
        for nombre, tags_in, icp in (
            ("gen", filtro_gen, False),
            ("ropa", filtro_ropa, ignore_color_prefix),
            ("cara", filtro_cara, False),
            ("lugar", filtro_lugar, False),
        ):
            filtro = SmartTagFilterMika()
            filtros[nombre] = filtro.filter_tags(
                prompt,
                scalar(tags_in, ""),
                mode="include",
                case_sensitive=False,
                ignore_weight=True,
                ignore_color_prefix=icp,
                add_comma_space_end=True,
            )[0]

        # Extras por cantidad de personajes, detectados sobre el filtro GEN
        # (antes del filtro por largo de frase, para que "2girls" siga
        # contando aunque min_palabras > 1).
        tag_list = TagIfMika().parse_tags_list(filtros["gen"])

        def _max_count(genero):
            mejor = 0
            for t in tag_list:
                m = re.fullmatch(r"(\d+)\+?" + genero, t)
                if m:
                    mejor = max(mejor, int(m.group(1)))
            return mejor

        rng = random_module.Random(scalar(seed, 0))
        n_girls = _max_count("girls")
        n_boys = _max_count("boys")
        extra_f = self._pick_lines(per_f_extra, n_girls - 1 if n_girls >= 2 else 0, rng)
        extra_m = self._pick_lines(per_m_extra, n_boys - 1 if n_boys >= 2 else 0, rng)
        extras = self._join(extra_f, extra_m)

        # Detección de frases en lenguaje natural sobre el prompt completo:
        # los fragmentos con min_palabras palabras o más van a TAGS NATURAL
        # (0 = apagado). El filtro GEN nunca se modifica; las frases solo se
        # concatenan al resultado si concatenar_natural está activo.
        min_palabras = int(scalar(min_palabras, 0) or 0)
        concatenar_natural = _mika_coerce_bool(scalar(concatenar_natural, False))
        tags_natural = ""
        naturales = []
        if min_palabras > 0:
            frases = [f.strip() for f in prompt.split(",") if f.strip()]
            naturales = [f for f in frases if len(f.split()) >= min_palabras]
            tags_natural = (", ".join(naturales) + ", ") if naturales else ""

        if concatenar_natural and naturales:
            gen_clean = filtros["gen"].rstrip(" ,")
            presentes = {t.strip().lower() for t in gen_clean.split(",") if t.strip()}
            extras_natural = [t for t in naturales if t.lower() not in presentes]
            base = self._join(filtros["gen"], ", ".join(extras_natural), extras)
        else:
            base = self._join(filtros["gen"], extras)

        union_exclusion = self._join(
            scalar(all_gen, ""),
            scalar(filtro_ropa, ""),
            scalar(all_lugar, ""),
            scalar(filtro_cara, ""),
        )
        texto_sin_filtro = TagRemoverMika().tag(
            prompt,
            union_exclusion,
            case_sensitive=False,
            ignore_weight=True,
        )[0]

        prompt_sin_filtro = self._join(prompt, extras)

        return (
            base,
            self._join(base, filtros["cara"]),
            self._join(base, filtros["ropa"]),
            self._join(base, filtros["ropa"], filtros["cara"]),
            self._join(base, filtros["ropa"], filtros["cara"], filtros["lugar"]),
            self._join(base, filtros["cara"], filtros["lugar"]),
            self._join(base, filtros["lugar"]),
            texto_sin_filtro,
            tags_natural,
            filtros["gen"],
            filtros["ropa"],
            filtros["cara"],
            filtros["lugar"],
            prompt_sin_filtro,
        )


class FiltrosMikaSelect:
    """
    FILTROS Select-Mika: misma lógica que FILTROS-Mika pero con una sola
    salida elegida con el selector "salida" (equivalente a FILTROS + switch
    de 8 opciones por índice).
    """

    OPCIONES = [
        "1 F GEN",
        "2 F GEN + CARA",
        "3 F GEN + ROPA",
        "4 F GEN + ROPA + CARA",
        "5 F GEN + ROPA + CARA + LUGAR",
        "6 F GEN + CARA + LUGAR",
        "7 F GEN + LUGAR",
        "8 SIN FILTRO",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        base = FiltrosMika.INPUT_TYPES()
        base["required"]["salida"] = (cls.OPCIONES, {"default": cls.OPCIONES[0]})
        return base

    RETURN_TYPES = ("STRING",) * 7
    RETURN_NAMES = (
        "prompt filtro",
        "FILTRO GENERAL",
        "FILTRO ROPA",
        "FILTRO CARA",
        "FILTRO LUGAR",
        "TAGS SIN FILTRO",
        "TAGS NATURAL",
    )
    FUNCTION = "execute"
    CATEGORY = "Mika Utilidades/tags"

    def execute(self, salida="1 F GEN", **kwargs):
        resultados = FiltrosMika().execute(**kwargs)
        # "8 SIN FILTRO" corresponde a la salida PROMPT SIN FILTRO (índice 13),
        # igual que en el switch original; 1-7 son las salidas 0-6.
        idx = self.OPCIONES.index(salida) if salida in self.OPCIONES else 0
        if idx == 7:
            idx = 13
        return (
            resultados[idx],
            resultados[9],
            resultados[10],
            resultados[11],
            resultados[12],
            resultados[7],
            resultados[8],
        )


class PromptReorganizeMika:
    """
    Prompt Reorganize-Mika: reorganiza el prompt en secciones con un orden
    elegido manualmente.

    Cada fragmento del prompt se asigna a UNA sola sección por cascada:
    1) si aparece en all_gen → GEN; 2) en filtro_ropa → ROPA;
    3) en filtro_cara → CARA; 4) en all_lugar → LUGAR; 6) el resto → SIN
    FILTRO. La sección NATURAL recibe solo las frases de min_palabras
    palabras o más que NO coinciden con ningún filtro.

    Dentro de cada sección, las frases de min_palabras o más se mueven al
    final (así "looking at viewer, 1boy, 2girls" queda
    "1boy, 2girls, looking at viewer") sin que el filtro natural afecte a
    los otros filtros.

    Los widgets orden_1..orden_6 eligen qué sección va en cada posición.
    Repetir una sección la imprime dos veces; omitirla la descarta.
    """

    SECCIONES = ["GEN", "ROPA", "CARA", "LUGAR", "NATURAL", "SIN FILTRO"]

    @classmethod
    def INPUT_TYPES(cls):
        slot = ("*", {"forceInput": True})
        orden = {
            f"orden_{i}": (cls.SECCIONES, {"default": cls.SECCIONES[i - 1]})
            for i in range(1, len(cls.SECCIONES) + 1)
        }
        return {
            "required": {
                "prompt": slot,
                "filtro_cara": slot,
                "filtro_ropa": slot,
                "all_gen": slot,
                "all_lugar": slot,
                "min_palabras": ("INT", {"default": 3, "min": 0, "max": 20}),
                "add_comma_space_end": ("BOOLEAN", {"default": True}),
                "agrupar_similares": ("BOOLEAN", {"default": False}),
                **orden,
            },
            "optional": {
                "ignore_color_prefix": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "execute"
    CATEGORY = "Mika Utilidades/tags"

    @staticmethod
    def _scalar(value, default=""):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    _STOPWORDS = {
        "a", "an", "the", "of", "on", "in", "at", "to", "and", "with",
        "el", "la", "los", "las", "un", "una", "de", "del", "en", "y", "o",
        "esta", "este", "estan", "su", "sus", "its", "is",
    }

    @classmethod
    def _agrupar_similares(cls, fragmentos):
        """
        Agrupa tags que comparten palabras: cada grupo ocupa la posición
        de su primer miembro, los grupos se ordenan alfabéticamente por la
        palabra que comparten y los miembros por número de palabras.
        Ej: "1girl, solo, shirt, ass, white shirt, huge ass, standing"
            → "1girl, solo, ass, huge ass, shirt, white shirt, standing".
        """
        por_palabra = {}
        palabras_de = []
        for i, texto in enumerate(fragmentos):
            palabras = {
                p for p in re.findall(r"[\w]+", texto.lower())
                if len(p) > 1 and p not in cls._STOPWORDS
            }
            palabras_de.append(palabras)
            for p in palabras:
                por_palabra.setdefault(p, []).append(i)

        # Componentes conexos por palabra compartida (union-find simple).
        padre = list(range(len(fragmentos)))

        def raiz(i):
            while padre[i] != i:
                padre[i] = padre[padre[i]]
                i = padre[i]
            return i

        for indices in por_palabra.values():
            for j in indices[1:]:
                ri, rj = raiz(indices[0]), raiz(j)
                if ri != rj:
                    padre[rj] = ri

        grupos = {}
        for i in range(len(fragmentos)):
            grupos.setdefault(raiz(i), []).append(i)

        items = []
        for miembros in grupos.values():
            pos = miembros[0]
            if len(miembros) > 1:
                comunes = set(palabras_de[miembros[0]])
                for m in miembros[1:]:
                    comunes &= palabras_de[m]
                clave = sorted(comunes)[0] if comunes else ""
                ordenados = sorted(
                    miembros,
                    key=lambda m: (len(fragmentos[m].split()), fragmentos[m].lower()),
                )
                items.append([pos, True, clave, [fragmentos[m] for m in ordenados]])
            else:
                items.append([pos, False, "", [fragmentos[miembros[0]]]])

        # Los grupos forman un bloque en la posición de su miembro más
        # temprano y entre ellos se ordenan alfabéticamente por la palabra
        # que comparten; los tags sueltos conservan su orden original.
        clusters = [it for it in items if it[1]]
        if clusters:
            pos_bloque = min(it[0] for it in clusters)
            clusters.sort(key=lambda it: it[2])
            for orden_g, it in enumerate(clusters):
                it[0] = pos_bloque
                it[2] = orden_g
        items.sort(key=lambda it: (it[0], 0 if it[1] else 1, it[2]))

        resultado = []
        for it in items:
            resultado.extend(it[3])
        return resultado

    def execute(
        self,
        prompt,
        filtro_cara,
        filtro_ropa,
        all_gen,
        all_lugar,
        min_palabras=3,
        add_comma_space_end=True,
        agrupar_similares=False,
        orden_1="GEN",
        orden_2="ROPA",
        orden_3="CARA",
        orden_4="LUGAR",
        orden_5="NATURAL",
        orden_6="SIN FILTRO",
        ignore_color_prefix=True,
    ):
        scalar = self._scalar
        prompt = str(scalar(prompt, ""))
        icp = _mika_coerce_bool(scalar(ignore_color_prefix, True))
        min_palabras = int(scalar(min_palabras, 3) or 0)

        fragmentos = [t for t in _parse_prompt(prompt, False)]

        listas = {}
        for nombre, tags_in, usar_icp in (
            ("GEN", all_gen, False),
            ("ROPA", filtro_ropa, icp),
            ("CARA", filtro_cara, False),
            ("LUGAR", all_lugar, False),
        ):
            listas[nombre] = (_parse_prompt(str(scalar(tags_in, "")), False), usar_icp)

        secciones = {clave: [] for clave in self.SECCIONES}
        for frag in fragmentos:
            asignado = None
            # Los filtros mandan: el filtro natural no les quita fragmentos.
            for clave in ("GEN", "ROPA", "CARA", "LUGAR"):
                lista, usar_icp = listas[clave]
                if any(
                    _tags_match(frag, ft, ignore_weight=True, ignore_color_prefix=usar_icp)
                    for ft in lista
                ):
                    asignado = clave
                    break

            if asignado is None and min_palabras > 0:
                if len(frag["original"].split()) >= min_palabras:
                    asignado = "NATURAL"

            secciones[asignado or "SIN FILTRO"].append(frag["original"])

        orden = [
            scalar(o, d) for o, d in (
                (orden_1, "GEN"), (orden_2, "ROPA"), (orden_3, "CARA"),
                (orden_4, "LUGAR"), (orden_5, "NATURAL"), (orden_6, "SIN FILTRO"),
            )
        ]

        agrupar = _mika_coerce_bool(scalar(agrupar_similares, False))
        partes = []
        for clave in orden:
            if clave in secciones and secciones[clave]:
                # Con similitud activa se agrupa cada sección por separado,
                # respetando el orden de secciones y sin mezclar secciones
                # (los tags sin filtro se agrupan solo entre ellos).
                contenido = secciones[clave]
                if agrupar:
                    contenido = self._agrupar_similares(contenido)
                # Las frases naturales (min_palabras o más) van al final de
                # cada sección, sin cambiar a qué sección pertenecen.
                if min_palabras > 0:
                    cortos = [t for t in contenido if len(t.split()) < min_palabras]
                    largos = [t for t in contenido if len(t.split()) >= min_palabras]
                    contenido = cortos + largos
                partes.append(", ".join(contenido))

        resultado = ", ".join(partes)
        if _mika_coerce_bool(scalar(add_comma_space_end, True)):
            resultado = SmartTagFilterMika._ensure_trailing_comma_space(resultado)

        return (resultado,)


class TextCleanOrganizeMika:
    """
    Text Clean & Organize-Mika: procesa listas o párrafos de texto en
    general (no depende de filtros). Puede eliminar elementos repetidos,
    eliminar palabras de color ("black", "white", etc. de cada elemento)
    y agrupar por similitud, respetando el formato original del texto
    (comas y saltos de línea de cada elemento se conservan).

    Muestra dentro del nodo cuántos elementos entraron y cuántos salieron.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True, "forceInput": True}),
                "eliminar_repetidos": ("BOOLEAN", {"default": True}),
                "eliminar_colores": ("BOOLEAN", {"default": False}),
                "agrupar_similares": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "execute"
    CATEGORY = "Mika Utilidades/tags"

    @staticmethod
    def _scalar(value, default=""):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    @staticmethod
    def _sin_colores(seg):
        """Quita las palabras de color de un elemento p. ej.
        "white shirt" → "shirt", "black_hair" → "hair"."""
        partes = re.split(r"([_\s]+)", seg)
        palabras = partes[0::2]
        delims = partes[1::2] + [""]

        conservados = [
            (i, w) for i, w in enumerate(palabras)
            if w and w.lower() not in _COLORS
        ]
        if not conservados:
            return ""

        resultado = conservados[0][1]
        for (prev, _), (_, w) in zip(conservados, conservados[1:]):
            resultado += delims[prev] + w

        return resultado.strip(" _")

    @classmethod
    def _split_items(cls, text):
        """Divide texto en segmentos conservando su separador original."""
        partes = re.split(r"(\s*(?:,\s*|\n)+)", text)
        items = []  # (texto visible, separador siguiente original)
        for i in range(0, len(partes), 2):
            seg = partes[i]
            sep = partes[i + 1] if i + 1 < len(partes) else ""
            if seg.strip():
                items.append((seg.strip(), sep))
        return items

    @classmethod
    def _reconstruir(cls, items):
        # Si al reordenar un elemento sin separador original queda en medio,
        # usa el separador dominante del texto (salto de línea o coma).
        con_nueva_linea = [sep for _, sep in items if "\n" in sep]
        sep_dominante = con_nueva_linea[0] if con_nueva_linea else ", "
        reconstruido = ""
        for i, (seg, sep) in enumerate(items):
            if not sep and i < len(items) - 1:
                sep = sep_dominante
            reconstruido += seg + sep
        return reconstruido

    @classmethod
    def _procesar(cls, items, eliminar_colores, eliminar_repetidos, agrupar_similares):
        """Pipeline sobre items (seg, sep): colores, repetidos, similares."""
        if _mika_coerce_bool(eliminar_colores, False):
            items = [(cls._sin_colores(seg), sep) for seg, sep in items]
            items = [(seg, sep) for seg, sep in items if seg]

        if _mika_coerce_bool(eliminar_repetidos, True):
            vistos = set()
            unicos = []
            for seg, sep in items:
                clave = seg.lower()
                if clave not in vistos:
                    vistos.add(clave)
                    unicos.append((seg, sep))
            items = unicos

        if _mika_coerce_bool(agrupar_similares, False):
            orden = PromptReorganizeMika._agrupar_similares([seg for seg, _ in items])
            por_texto = {seg: i for i, (seg, _) in enumerate(items)}
            items = [items[por_texto[seg]] for seg in orden if seg in por_texto]

        return items

    def execute(self, text, eliminar_repetidos=True, eliminar_colores=False, agrupar_similares=False):
        text = str(self._scalar(text, ""))
        if not text.strip():
            return {"ui": {"text": ["IN (0):", "OUT (0):"]}, "result": (text,)}

        items = self._split_items(text)
        if not items:
            return {"ui": {"text": ["IN (0):", "OUT (0):"]}, "result": (text,)}

        cantidad_in = len(items)
        items = self._procesar(items, eliminar_colores, eliminar_repetidos, agrupar_similares)
        reconstruido = self._reconstruir(items)

        info = f"in: {cantidad_in} | out: {len(items)}"
        return {"ui": {"text": [info]}, "result": (reconstruido,)}


class TextCleanOrganizeConcatMika:
    """
    Text Clean & Organize Concat-Mika: igual que Text Clean & Organize-Mika
    pero con varios slots linkeables (text_1..N): concatena las listas o
    párrafos de todos los nodos conectados, luego elimina colores, repeti-
    dos y agrupa por similares. Muestra in/out en el propio nodo.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            f"text_{i}": ("STRING", {"default": "", "multiline": False})
            for i in range(1, MAX_CONCAT_SLOTS + 1)
        }
        optional["eliminar_repetidos"] = ("BOOLEAN", {"default": True})
        optional["eliminar_colores"] = ("BOOLEAN", {"default": False})
        optional["agrupar_similares"] = ("BOOLEAN", {"default": False})
        optional["text_count"] = (
            "INT",
            {
                "default": DEFAULT_CONCAT_SLOTS,
                "min": 1,
                "max": MAX_CONCAT_SLOTS,
                "step": 1,
                "display": "number",
            },
        )
        return {"required": {}, "optional": optional}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "execute"
    CATEGORY = "Mika Utilidades/tags"

    def execute(
        self,
        eliminar_repetidos=True,
        eliminar_colores=False,
        agrupar_similares=False,
        text_count=DEFAULT_CONCAT_SLOTS,
        **kwargs,
    ):
        scalar = TextCleanOrganizeMika._scalar
        count = max(1, min(MAX_CONCAT_SLOTS, int(scalar(text_count, DEFAULT_CONCAT_SLOTS))))

        items = []
        for i in range(1, count + 1):
            value = scalar(kwargs.get(f"text_{i}"), "")
            if not isinstance(value, str):
                value = str(value)
            if value.strip():
                items.extend(TextCleanOrganizeMika._split_items(value))

        if not items:
            return {"ui": {"text": ["IN (0):", "OUT (0):"]}, "result": ("",)}

        cantidad_in = len(items)
        items = TextCleanOrganizeMika._procesar(
            items, eliminar_colores, eliminar_repetidos, agrupar_similares
        )
        reconstruido = TextCleanOrganizeMika._reconstruir(items)

        info = f"in: {cantidad_in} | out: {len(items)}"
        return {"ui": {"text": [info]}, "result": (reconstruido,)}


class TextCleanerCompareMika:
    """
    Text Cleaner Compare-Mika: elimina de una lista o grupo de tags los
    elementos que se repiten en otra lista base, respetando el formato
    (comas / saltos de línea) del texto de entrada.

    - base: lista/grupo que sirve de referencia.
    - tags_in: lista/grupo a la que se le quitan los repetidos de base.
    - eliminar_repetidos: además quita duplicados dentro de tags_in.
    - eliminar_colores / agrupar_similares: opciones del Clean & Organize.

    Muestra en el nodo cuántos entraron, cuántos se quitaron y cuántos
    salieron.
    """

    @classmethod
    def INPUT_TYPES(cls):
        slot = ("STRING", {"default": "", "multiline": True, "forceInput": True})
        return {
            "required": {
                "base": slot,
                "tags_in": slot,
            },
            "optional": {
                "eliminar_repetidos": ("BOOLEAN", {"default": True}),
                "eliminar_colores": ("BOOLEAN", {"default": False}),
                "agrupar_similares": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("text", "eliminados")
    FUNCTION = "execute"
    CATEGORY = "Mika Utilidades/tags"

    @staticmethod
    def _scalar(value, default=""):
        if isinstance(value, (list, tuple)):
            return value[0] if len(value) > 0 else default
        return value if value is not None else default

    def execute(
        self,
        base,
        tags_in,
        eliminar_repetidos=True,
        eliminar_colores=False,
        agrupar_similares=False,
    ):
        scalar = self._scalar
        base = str(scalar(base, ""))
        tags_in = str(scalar(tags_in, ""))

        tco = TextCleanOrganizeMika
        items = tco._split_items(tags_in)
        if not items:
            vacio = {"text": ["IN (0):", "QUITADOS (0):", "OUT (0):"]}
            return {"ui": vacio, "result": ("", "")}

        base_set = {
            TagRemoverMika._normalize_for_compare(seg, False, True)
            for seg, _ in tco._split_items(base)
        }
        base_set.discard("")

        cantidad_in = len(items)
        quitados = []

        if _mika_coerce_bool(scalar(eliminar_colores, False), False):
            items = [(tco._sin_colores(seg), sep) for seg, sep in items]
            items = [(seg, sep) for seg, sep in items if seg]

        filtrados = []
        for seg, sep in items:
            clave = TagRemoverMika._normalize_for_compare(seg, False, True)
            if clave and clave in base_set:
                quitados.append(seg)
            else:
                filtrados.append((seg, sep))
        items = filtrados

        if _mika_coerce_bool(scalar(eliminar_repetidos, True), True):
            vistos = set()
            unicos = []
            for seg, sep in items:
                clave = seg.lower()
                if clave not in vistos:
                    vistos.add(clave)
                    unicos.append((seg, sep))
            items = unicos

        if _mika_coerce_bool(scalar(agrupar_similares, False), False):
            orden = PromptReorganizeMika._agrupar_similares([s for s, _ in items])
            por_texto = {s: i for i, (s, _) in enumerate(items)}
            items = [items[por_texto[s]] for s in orden if s in por_texto]

        reconstruido = tco._reconstruir(items)

        info = [
            f"IN ({cantidad_in}):",
            f"QUITADOS ({len(quitados)}):",
            f"OUT ({len(items)}):",
        ]
        return {
            "ui": {"text": info},
            "result": (reconstruido, ", ".join(quitados)),
        }


# ======================================================================
# MAPPINGS
# ======================================================================

NODE_CLASS_MAPPINGS = {
    "StringSelectorCut": StringSelectorCut,
    "ScoreListExtendable": ScoreListExtendable,
    "PrimitiveMika": PrimitiveMika,
    "TextBoxClipboard": TextBoxClipboard,
    "NoteMika": NoteMika,
    "TextBoxPasteMika": TextBoxPasteMika,
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
    "IndexIntMika": IndexIntMika,
    "IndexStepperMika": IndexStepperMika,
    "LoadImageNameMika": LoadImageNameMika,
    "LoadImageDirMika": LoadImageDirMika,
    "IfAnyMika": IfAnyMika,
    "BypassDetectorMika": BypassDetectorMika,
    "TextSaveMika": TextSaveMika,
    "AnimaPromptOrganizer": AnimaPromptOrganizer,
    "PromptCleanDedupeMika": PromptCleanDedupeMika,
    "FiltrosMika": FiltrosMika,
    "FiltrosMikaSelect": FiltrosMikaSelect,
    "PromptReorganizeMika": PromptReorganizeMika,
    "TextCleanOrganizeMika": TextCleanOrganizeMika,
    "TextCleanOrganizeConcatMika": TextCleanOrganizeConcatMika,
    "TextCleanerCompareMika": TextCleanerCompareMika,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "StringSelectorCut": "String Selector (Cut First Line)",
    "ScoreListExtendable": "Score List",
    "PrimitiveMika": "Primitive-Mika",
    "TextBoxClipboard": "Text Box-Mika",
    "NoteMika": "Note-Mika",
    "TextBoxPasteMika": "Text Box Paste-Mika",
    "TextBoxVisor": "Visor-Mika",
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
    "IndexIntMika": "Index Int-Mika",
    "IndexStepperMika": "Index Stepper-Mika",
    "LoadImageNameMika": "Load Image + Name-Mika",
    "LoadImageDirMika": "Load Image from Dir-Mika",
    "IfAnyMika": "If Any-Mika",
    "BypassDetectorMika": "Bypass Detector-Mika",
    "TextSaveMika": "Text Save-Mika",
    "AnimaPromptOrganizer": "Anima Prompt Organizer",
    "PromptCleanDedupeMika": "Prompt Clean & Dedupe-Mika",
    "FiltrosMika": "FILTROS-Mika",
    "FiltrosMikaSelect": "FILTROS Select-Mika",
    "PromptReorganizeMika": "Prompt Reorganize-Mika",
    "TextCleanOrganizeMika": "Text Clean & Organize-Mika",
    "TextCleanOrganizeConcatMika": "Text Clean & Organize Concat-Mika",
    "TextCleanerCompareMika": "Text Cleaner Compare-Mika",
}