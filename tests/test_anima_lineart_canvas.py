import base64
import importlib.util
import os
import sys
from io import BytesIO

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)

# Fuera de un servidor ComfyUI, PromptServer.instance no existe y nodes.py
# asume que sí. Neutralizarlo deja las guardas de rutas en False y permite
# importar el módulo para probar el helper puro.
try:
    from server import PromptServer as _PS
    _PS.instance = None
except Exception:
    pass

_spec = importlib.util.spec_from_file_location(
    "mika_nodes", os.path.join(os.path.dirname(__file__), "..", "nodes.py"))
mika = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mika)

from PIL import Image


def _b64_png(size, color):
    img = Image.new("RGB", size, color)
    buf = BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_empty_returns_white_canvas():
    t = mika._mika_lineart_to_tensor("", 64, 48)
    assert tuple(t.shape) == (1, 48, 64, 3), t.shape
    assert float(t.min()) == 1.0 and float(t.max()) == 1.0


def test_decodes_png_anchored_top_left():
    t = mika._mika_lineart_to_tensor(_b64_png((10, 10), (0, 0, 0)), 20, 20)
    assert tuple(t.shape) == (1, 20, 20, 3), t.shape
    assert float(t[0, 0, 0, 0]) == 0.0
    assert float(t[0, 19, 19, 0]) == 1.0


def test_invalid_base64_returns_white():
    t = mika._mika_lineart_to_tensor("no-es-base64!!", 8, 8)
    assert float(t.min()) == 1.0


def test_data_url_prefix_stripped():
    data = "data:image/png;base64," + _b64_png((4, 4), (0, 0, 0))
    t = mika._mika_lineart_to_tensor(data, 4, 4)
    assert float(t.max()) == 0.0


def test_transparent_png_shows_bg():
    img = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
    buf = BytesIO()
    img.save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    t = mika._mika_lineart_to_tensor(b64, 4, 4, (255, 255, 255))
    assert float(t.min()) == 1.0, t.min()


def test_transparent_bg_keeps_stroke():
    img = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
    img.putpixel((0, 0), (255, 255, 255, 255))
    buf = BytesIO()
    img.save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    t = mika._mika_lineart_to_tensor(b64, 4, 4, (0, 0, 0))
    assert float(t[0, 0, 0, 0]) == 1.0
    assert float(t[0, 3, 3, 0]) == 0.0


def test_bg_black_for_lineart():
    t = mika._mika_lineart_to_tensor("", 8, 8, (0, 0, 0))
    assert float(t.max()) == 0.0


def test_render_lineart_mode_uses_black_bg():
    img, w, h, nombre = mika.AnimaLineartCanvasMika().render("832x1216 (5:8)", "lineart", "")
    assert tuple(img.shape) == (1, 1216, 832, 3), img.shape
    assert (w, h) == (832, 1216)
    assert float(img.max()) == 0.0
    assert nombre == ""


def test_render_normal_mode_uses_white_bg():
    img, w, h, _nombre = mika.AnimaLineartCanvasMika().render("832x1216 (5:8)", "dibujo normal", "")
    assert float(img.min()) == 1.0


def test_render_passes_filename_through():
    _img, _w, _h, nombre = mika.AnimaLineartCanvasMika().render("832x1216 (5:8)", "lineart", "", "lineart.png")
    assert nombre == "lineart.png"


if __name__ == "__main__":
    count = 0
    for name in sorted(list(globals())):
        fn = globals()[name]
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
            count += 1
    print(f"ALL PASSED ({count})")
