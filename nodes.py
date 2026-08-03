try:
    from server import PromptServer
except Exception:
    PromptServer = None


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


# Tope máximo de filas que se pueden llegar a agregar con el botón "+".
MAX_SCORES = 50


class ScoreListExtendable:
    """
    Similar al nodo 'SCORE' de JPS-Nodes: una fila numerada por cada valor
    (1, 2, 3, ...), cada una con su propio INT y flechas ◀ ▶.
    A diferencia del original, la cantidad de filas NO es fija: la UI
    (ver web/score_list.js) agrega botones "+ Agregar opción" / "− Quitar
    opción" para ir creando más filas manualmente (1,2,3,...,50).

    Cada fila trae además un campo de texto editable con el nombre de la
    opción (por defecto "Opción 1", "Opción 2", etc.); se puede renombrar
    con un click, igual que cualquier otro campo de texto de ComfyUI.

    Todas las filas son entradas opcionales en Python (para que el nodo
    funcione sin importar cuántas filas haya creado el usuario en la UI);
    'int_out' es la suma de todas las filas presentes y 'detalle' es un
    texto con "nombre: valor" por cada fila, en el orden en que aparecen.
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
    (ver web/text_box_editor_mika.js) le agrega 3 funciones portadas y
    adaptadas de ComfyUI_Text_Tools_SG
    (https://github.com/ShammiG/ComfyUI_Text_Tools_SG):
    📋 copiar al portapapeles (o la selección), ☑ seleccionar todo y
    📄 pegar del portapapeles en la posición del cursor — disponibles
    incluso con el nodo colapsado (como iconos al lado del título), y
    también en el menú del click derecho como respaldo. A diferencia de
    la versión original, el pegado soluciona los problemas de texto
    nuevo / saltos de línea: inserta en el cursor en vez de reemplazar
    todo, y sincroniza correctamente el textarea con el widget.
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
    Text Box Visor-Mika: acepta CUALQUIER tipo de dato en 'valor'
    (INT, FLOAT, STRING, BOOLEAN, listas, dicts, tensores torch/numpy...)
    y muestra una preview legible en la caja de texto. Tiene las mismas
    funciones de portapapeles que Text Box Editor-Mika
    (ver web/text_box_visor_mika.js).
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
        # Tensor-like (torch, numpy, etc.)
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
    Tag Filter-Mika: filtra un texto separado por comas (típicamente una
    ruta con tags, p.ej. "\Escritorio\Promps nice\umbreon, pokemon,
    pokemon (creature), red sclera, black fur") conservando solamente los
    primeros N segmentos:
    - max_tags=1 → "\Escritorio\Promps nice\umbreon"
    - max_tags=2 → "\Escritorio\Promps nice\umbreon, pokemon"
    - max_tags=3 → "\Escritorio\Promps nice\umbreon, pokemon, pokemon (creature)"
    El separador por defecto es "," pero puede cambiarse (por ej. ";").
    Los espacios alrededor de cada tag se limpian solos, y las comas
    dobles o al final del texto se ignoran. Devuelve el texto filtrado
    y cuántos tags se conservaron.
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


# Tope máximo de pares find/replace que se pueden agregar con el botón "+".
MAX_REPLACES = 30


class TextReplaceDynamic:
    """
    Text Replace Dynamic-Mika: reemplaza texto en una cadena usando pares
    dinámicos de "find" y "replace". Similar a CR Text Replace pero con
    la capacidad de agregar/quitar pares manualmente desde la UI (ver
    web/text_replace_dynamic.js): botones "+ Agregar reemplazo" y
    "− Quitar reemplazo" permiten crear hasta 30 pares.
    
    Cada par tiene:
    - find_N: el texto a buscar
    - replace_N: el texto con el que reemplazarlo
    
    Los reemplazos se aplican en orden (1, 2, 3, ...). Si find_N está
    vacío, ese par se ignora. Opcionalmente se puede usar regex
    (expresiones regulares) en lugar de búsqueda literal.
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
        import re
        
        result = text or ""
        keys = sorted(
            (k for k in kwargs if k.startswith("find_")),
            key=lambda k: int(k.split("_")[1])
        )
        
        for find_key in keys:
            idx = find_key.split("_")[1]
            replace_key = f"replace_{idx}"
            find_str = kwargs.get(find_key, "")
            replace_str = kwargs.get(replace_key, "")
            
            # Saltar pares vacíos
            if not find_str:
                continue
            
            try:
                if use_regex:
                    result = re.sub(find_str, replace_str, result)
                else:
                    result = result.replace(find_str, replace_str)
            except re.error:
                # Si la regex es inválida, ignorar este reemplazo
                pass
        
        return (result,)


# Tope máximo de slots de texto que se pueden agregar con el botón "+".
MAX_CONCAT_SLOTS = 30


class TextConcatenateDynamic:
    """
    Text Concatenate Dynamic-Mika: concatena múltiples textos en uno solo,
    con separador configurable. Similar a CR Text Concatenate pero con la
    capacidad de agregar/quitar slots manualmente desde la UI (ver
    web/text_concatenate_dynamic.js): botones "+ Agregar texto" y
    "− Quitar texto" permiten crear hasta 30 slots.
    
    Los textos vacíos se ignoran automáticamente. El separador por defecto
    es ", " pero puede ser cualquier string (espacio, salto de línea, etc.).
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
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "doit"
    CATEGORY = "Mika Utilidades/string"

    def doit(self, separator=", ", **kwargs):
        texts = []
        keys = sorted(
            (k for k in kwargs if k.startswith("text_")),
            key=lambda k: int(k.split("_")[1])
        )
        
        for key in keys:
            value = kwargs.get(key, "")
            if value:  # Ignorar textos vacíos
                texts.append(value)
        
        return (separator.join(texts),)


class FloatOutputList:
    """
    Igual que 'String OutputList' de la extensión ComfyUI-outputlists-combiner
    (https://github.com/geroldmeisinger/ComfyUI-outputlists-combiner), pero
    convierte cada elemento a FLOAT en vez de dejarlo como texto.

    Se escribe un valor numérico por línea (o separados por 'separator') en
    el campo 'values', y el nodo los separa en una OutputList: cualquier
    nodo conectado a 'value' se va a ejecutar una vez por cada número de la
    lista, en orden (gracias a OUTPUT_IS_LIST=True). Es compatible con los
    otros nodos de esa extensión (OutputLists Combinations, XYZ-GridPlot,
    Formatted String, etc.) porque sigue el mismo patrón.
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
        # 'separator' es un campo de UNA sola línea: si el usuario escribe
        # "\n" ahí, ComfyUI guarda literalmente los 2 caracteres "\" y "n"
        # (no puede generar un salto de línea real en un campo de una
        # línea). En cambio 'values' SÍ es multilínea y genera saltos de
        # línea reales al apretar Enter. Por eso hay que "traducir" las
        # secuencias de escape más comunes antes de usar el separador.
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
    (ver web/execution_timer.js).

    El registro y dibujado de los tiempos de ejecución de cada nodo del
    workflow funciona SOLO, sin necesidad de agregar este nodo al grafo:
    se activa apenas se instala el paquete. Este nodo es opcional y sirve
    únicamente para cambiar su comportamiento por defecto (mostrar/ocultar
    el panel flotante, mostrar/ocultar las etiquetas sobre cada nodo,
    cantidad de decimales).

    No hace falta conectarlo a nada: al ser un OUTPUT_NODE, ComfyUI lo
    ejecuta igual aunque esté suelto en el canvas. En cuanto corre, envía
    la configuración elegida a la extensión JS por websocket.
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


NODE_CLASS_MAPPINGS = {
    "StringSelectorCut": StringSelectorCut,
    "ScoreListExtendable": ScoreListExtendable,
    "TextBoxClipboard": TextBoxClipboard,
    "TextBoxVisor": TextBoxVisor,
    "TagFilter": TagFilter,
    "TextReplaceDynamic": TextReplaceDynamic,
    "TextConcatenateDynamic": TextConcatenateDynamic,
    "FloatOutputList": FloatOutputList,
    "ExecutionTimerConfig": ExecutionTimerConfig,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "StringSelectorCut": "String Selector (Cut First Line)",
    "ScoreListExtendable": "Score List",
    "TextBoxClipboard": "Text Box Editor-Mika",
    "TextBoxVisor": "Text Box Visor-Mika",
    "TagFilter": "Tag Filter-Mika",
    "TextReplaceDynamic": "Text Replace Dynamic-Mika",
    "TextConcatenateDynamic": "Text Concatenate Dynamic-Mika",
    "FloatOutputList": "Float OutputList",
    "ExecutionTimerConfig": "⏱ Tiempos de Ejecución (config)",
}