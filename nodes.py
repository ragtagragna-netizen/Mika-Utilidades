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
import decimal


class StringSelectorCut:
    """
    Igual que 'String Selector' de Impact-Pack:
    - Campo multilinea 'strings' con varias líneas.
    - 'select' elige una línea (con wraparound, como las flechas ◀ ▶ del original).
    La UI (ver web/cut_first_line.js) añade además un botón para cortar
    la primera línea del texto (todo hasta el primer salto de renglón).
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
    Similar al nodo 'SCORE' de JPS-Nodes: una fila numerada por cada valor.
    La cantidad de filas NO es fija: la UI (ver web/score_list.js) agrega
    botones "+ Agregar opción" / "− Quitar opción" (1..50).
    'int_out' es la suma de todas las filas presentes y 'detalle' es un
    texto con "nombre: valor" por cada fila.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, MAX_SCORES + 1):
            optional[f"nombre_{i}"] = ("STRING", {"default": f"Opción {i}", "multiline": False})
            optional[str(i)] = ("INT", {"default": 0, "min": -999999, "max": 999999, "step": 1})
        return {
            "required": {},
            "optional": optional,
        }

    RETURN_TYPES = ("INT", "STRING")
    RETURN_NAMES = ("int_out", "detalle")
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/score"

    def doit(self, **kwargs):
        keys = sorted((k for k in kwargs if k.isdigit()), key=lambda k: int(k))
        total = 0
        details = []
        for k in keys:
            value = int(kwargs[k])
            total += value
            label = str(kwargs.get(f"nombre_{k}", k)).strip() or k
            details.append(f"{label}: {value}")
        return (total, "\n".join(details))


class TextBoxClipboard:
    """
    Text Box Editor-Mika: caja de texto simple con salida STRING. La UI
    (ver web/text_box_editor_mika.js) le agrega copiar / seleccionar todo /
    pegar, disponibles expandido y colapsado.
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
    Text Box Visor-Mika: acepta CUALQUIER tipo de dato en 'valor' y muestra
    una preview legible en la caja de texto.
    """

    MAX_ITEMS = 50

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

    def doit(self, valor=None, text="", unique_id=None):
        if valor is not None:
            preview = self._format(valor)
            if PromptServer is not None and PromptServer.instance is not None and unique_id is not None:
                PromptServer.instance.send_sync(
                    "mika-visor-preview",
                    {"id": str(unique_id), "text": preview},
                )
            return (preview,)
        return (text,)

    def _format(self, v):
        if v is None:
            return "None"
        if isinstance(v, str):
            return v
        if isinstance(v, bool):
            return str(v)
        if isinstance(v, (int, float)):
            return repr(v)
        if isinstance(v, (list, tuple)):
            if len(v) == 0:
                return "[]" if isinstance(v, list) else "()"
            shown = v[: self.MAX_ITEMS]
            lines = [f"[{i}] {self._format(item)}" for i, item in enumerate(shown)]
            if len(v) > len(shown):
                lines.append(f"... (+{len(v) - len(shown)} elementos más)")
            return "\n".join(lines)
        if isinstance(v, dict):
            return "\n".join(f"{k}: {self._format(val)}" for k, val in v.items())
        if hasattr(v, "shape") and hasattr(v, "dtype"):
            base = f"Tensor(shape={tuple(v.shape)}, dtype={v.dtype})"
            try:
                if hasattr(v, "numel") and callable(v.numel) and v.numel() <= 12:
                    base += f"\n{v.tolist()}"
            except Exception:
                pass
            return base
        return str(v)


class TagFilter:
    r"""
    Tag Filter-Mika: conserva solo los primeros N segmentos de un texto
    separado por comas (p.ej. una ruta con tags).
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
    Text Replace Dynamic-Mika: reemplaza texto usando pares dinámicos
    find/replace con botones +/- en la UI (ver web/text_replace_dynamic.js).
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
    configurable. Los slots se agregan/quitan con botones +/- en la UI
    (ver web/text_concatenate_dynamic.js).
    
    Limpia el resultado automáticamente: normaliza separadores duplicados,
    quita separadores al inicio/final, y elimina espacios extras. Esto
    evita que listas muy largas de tags (con emoticones, pesos, etc.)
    rompan el parsing en nodos downstream.
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
        texts = []
        keys = sorted(
            (k for k in kwargs if k.startswith("text_")),
            key=lambda k: int(k.split("_")[1])
        )
        for key in keys:
            value = kwargs.get(key, "")
            if value and value.strip():  # Ignorar vacíos y solo espacios
                # Strip cada entrada para evitar espacios al inicio/final
                texts.append(value.strip())
        
        # Concatenar todas las entradas con el separador
        result = separator.join(texts)
        
        if clean_output and result:
            # 1. Normalizar separadores duplicados
            #    Ej: ", , " → ", "   o   ", , , " → ", "
            if separator:
                sep_escaped = re.escape(separator)
                result = re.sub(f'({sep_escaped})\\s*', separator, result)
                
                # 2. Quitar separador al inicio y al final
                while result.startswith(separator):
                    result = result[len(separator):]
                while result.endswith(separator):
                    result = result[:-len(separator)]
            
            # 3. Normalizar espacios múltiples a uno solo
            #    (no dentro de tags con paréntesis/pesos)
            result = re.sub(r' {2,}', ' ', result)
            
            # 4. Limpiar espacios alrededor del separador
            if separator and separator.strip():
                sep_stripped = separator.strip()
                sep_escaped = re.escape(sep_stripped)
                # Quita espacios antes/después del separador
                result = re.sub(f'\\s*{sep_escaped}\\s*', separator, result)
        
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
        if image_path.startswith('http'):
            i = self.download_image(image_path)
            i = ImageOps.exif_transpose(i)
        else:
            try:
                i = Image.open(image_path)
                i = ImageOps.exif_transpose(i)
            except OSError:
                print(f"Load Image-Mika: La imagen '{image_path.strip()}' no existe!")
                i = Image.new(mode='RGB', size=(512, 512), color=(0, 0, 0))

        if not i:
            return None

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


# -----------------------------------------------------------------------
# Parser inteligente de tags COMPARTE entre SmartTagFilter, TagIf y TagRemover.
# -----------------------------------------------------------------------

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
        escaped = emote.replace("(", "\\(").replace(")", "\\)").replace(":", "\\:")
        text = re.sub(r'(?<!\\)' + re.escape(emote), escaped, text)
    return text


def _unescape_emoticones(text):
    for emote in _EMOTICONES:
        escaped = emote.replace("(", "\\(").replace(")", "\\)").replace(":", "\\:")
        text = text.replace(escaped, emote)
    return text


def _strip_color_prefix(tag_base):
    parts = tag_base.split("_")
    if len(parts) >= 3 and parts[0] in _COLOR_MODIFIERS and parts[1] in _COLORS:
        return "_".join(parts[2:])
    if len(parts) >= 2 and parts[0] in _COLORS:
        return "_".join(parts[1:])
    return tag_base


def _parse_smart_tag(tag_text, case_sensitive=False):
    """Parsea un tag y devuelve dict {original, base, weight, has_weight}."""
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
                    return {'original': original, 'base': normalized, 'weight': weight,
                            'has_weight': True, 'weight_syntax': 'explicit'}
                except ValueError:
                    pass
        stripped = inner.strip()

    paren_pairs = min(opening_parens, closing_parens)
    weight = 1.0 + (paren_pairs * 0.1) if paren_pairs > 0 else 1.0
    base_tag = stripped
    normalized = base_tag.lower().replace(' ', '_') if not case_sensitive else base_tag.replace(' ', '_')
    return {'original': original, 'base': normalized, 'weight': weight,
            'has_weight': paren_pairs > 0,
            'weight_syntax': 'parentheses' if paren_pairs > 0 else 'none'}


def _parse_prompt(prompt, case_sensitive=False):
    """Parsea un prompt completo en una lista de dicts {original, base, weight, ...}."""
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
    """Compara si dos tags coinciden, considerando opciones."""
    base1 = tag1['base']
    base2 = tag2['base']
    if base1 == base2:
        if ignore_weight:
            return True
        return abs(tag1['weight'] - tag2['weight']) < 0.01
    if ignore_color_prefix:
        s1 = _strip_color_prefix(base1)
        s2 = _strip_color_prefix(base2)
        if s1 == base2 or s2 == base1:
            if ignore_weight or abs(tag1['weight'] - tag2['weight']) < 0.01:
                return True
    return False


class SmartTagFilterMika:
    r"""
    Smart Tag Filter-Mika (slots tipo switch con "*"): filtra tags con
    soporte de pesos, caracteres especiales y prefijos de color.
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
                found = any(_tags_match(ptag, ftag, ignore_weight, ignore_color_prefix)
                            for ftag in filter_list)
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
    find/output agregables con botones +/- (ver web/tag_if_mika.js).
    Cada output_N se activa solo si su find_N está presente.
    'combined' junta todos los outputs activos.
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
    Tag Remover-Mika: remueve tags de un prompt. Usa la misma lógica
    simple que TagRemover de sugarkwork: compara tags normalizados
    (lowercase + underscores) por defecto.
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
                "ignore_color_prefix": ("BOOLEAN", {"default": False}),
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
    def _normalize_tag(tag_text, case_sensitive=False):
        """
        Normaliza un tag: extrae el nombre base, lowercase, espacios/guiones a underscore.
        Ejemplos:
        - "(fat:1.1)" → "fat"
        - "blue eyes" → "blue_eyes"
        - "high-resolution" → "high_resolution"
        - "smile =)" → "smile_=)" (con ignore_weight=True, el emoticón se mantiene)
        """
        original = tag_text.strip()
        if not original:
            return ""

        # Escapar emoticones primero
        original = _escape_emoticones(original)

        # Remover paréntesis de peso
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

        # Normalizar
        normalized = stripped.lower().replace(' ', '_').replace('-', '_') if not case_sensitive else stripped.replace(' ', '_').replace('-', '_')
        return _unescape_emoticones(normalized)

    def tag(self, tags, exclude_tags, case_sensitive=False,
            ignore_weight=True, ignore_color_prefix=False):
        tags_text = self._to_text(tags)
        exclude_text = self._to_text(exclude_tags)

        # Parsear ambos prompts
        tag_list = _parse_prompt(tags_text, case_sensitive)
        exclude_list = _parse_prompt(exclude_text, case_sensitive)

        if not exclude_list:
            return (tags_text, "", 0)

        # Crear set de tags a excluir normalizados (comparación rápida)
        exclude_normalized = set()
        for ftag in exclude_list:
            norm = self._normalize_tag(ftag['original'], case_sensitive)
            exclude_normalized.add(norm)
            if ignore_color_prefix:
                stripped = _strip_color_prefix(norm)
                exclude_normalized.add(stripped)

        kept = []
        removed = []

        for ptag in tag_list:
            norm = self._normalize_tag(ptag['original'], case_sensitive)
            should_remove = norm in exclude_normalized

            if not should_remove and ignore_color_prefix:
                stripped = _strip_color_prefix(norm)
                if stripped in exclude_normalized:
                    should_remove = True

            if should_remove:
                removed.append(ptag)
            else:
                kept.append(ptag)

        result = ", ".join([t['original'] for t in kept])
        removed_str = ", ".join([t['original'] for t in removed])
        return (result, removed_str, len(removed))


class FloatOutputList:
    """
    Float OutputList: convierte una lista de números en texto a una
    OutputList de FLOAT (OUTPUT_IS_LIST), compatible con
    ComfyUI-outputlists-combiner.
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
    Nodo de configuración para "Mika · Tiempos de Ejecución"
    (ver web/execution_timer.js). Envía la configuración por websocket.
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
    Prompt Edit (Loop)-Mika: nodo único de edición de prompt con memoria
    entre ejecuciones (funciona en bucle), sin guardado en disco.
    En cada ejecución del workflow:
    1. El cuadro editable contiene el prompt que quedó de la ejecución
       ANTERIOR (ya editado a mano si se quiso).
    2. Llega el prompt nuevo de la generación actual por 'input_text'.
    3. El cuadro editable se refresca automáticamente con ese prompt nuevo,
       quedando listo para que lo edites antes de la SIGUIENTE ejecución.
    Salidas: 'prompt_anterior' (lo que había editado en el cuadro) y
    'prompt_generacion_actual' (el recién llegado).
    La UI (ver web/prompt_edit_loop_mika.js) mantiene el refresco tras cada
    ejecución y agrega resaltado inline de tags similares mientras escribís.
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
}