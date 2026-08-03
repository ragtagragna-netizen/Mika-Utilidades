try:
    # Disponible dentro del proceso de ComfyUI. Se protege con try/except
    # para que el archivo se pueda importar (p.ej. para tests) fuera de él.
    from server import PromptServer
except ImportError:
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
    "FloatOutputList": FloatOutputList,
    "ExecutionTimerConfig": ExecutionTimerConfig,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "StringSelectorCut": "String Selector (Cut First Line)",
    "ScoreListExtendable": "Score List",
    "TextBoxClipboard": "Text Box Editor-Mika",
    "FloatOutputList": "Float OutputList",
    "ExecutionTimerConfig": "⏱ Tiempos de Ejecución (config)",
}
