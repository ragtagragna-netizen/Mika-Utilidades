import warnings

# Los detectores vendorizados emiten FutureWarnings en el import (torch.jit, skimage):
# no aportan nada y ensucian la salida de los tests.
with warnings.catch_warnings():
    warnings.simplefilter("ignore", FutureWarning)
    from .registry import PREPROCESSORS, run

__all__ = ["PREPROCESSORS", "run"]
