"""El motor JavaScript del aplicativo debe producir exactamente lo mismo que el motor Python."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from app.construir import config_por_defecto  # noqa: E402
from exogena_engine.__main__ import ejecutar  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="requiere Node.js")


def test_paridad_python_js(tmp_path):
    ej = RAIZ / "ejemplos"
    subprocess.run([sys.executable, str(ej / "generar_ejemplo.py")], check=True, capture_output=True)
    archivos = [str(ej / f) for f in ("siigo_balance_por_tercero.xlsx", "siigo_terceros.xlsx", "accionistas.csv", "nomina.csv")]
    cfg = tmp_path / "cfg.json"
    cfg.write_text(json.dumps(config_por_defecto(), default=str), encoding="utf-8")
    js = json.loads(subprocess.run(["node", str(RAIZ / "app" / "paridad.js"), str(cfg), "siigo", *archivos],
                                   capture_output=True, text=True, check=True).stdout)
    py = ejecutar("siigo", *archivos[:2], str(tmp_path / "out"), archivos[2], archivos[3])

    assert set(js["generados"]) == set(py["generados"])
    for fmt, df in py["generados"].items():
        a = df.astype(str).sort_values(list(df.columns)).reset_index(drop=True)
        b = pd.DataFrame(js["generados"][fmt])[df.columns].astype(str).sort_values(list(df.columns)).reset_index(drop=True)
        pd.testing.assert_frame_equal(a, b, obj=f"formato {fmt}")
    assert {tuple(map(str, h[:3])) for h in py["hallazgos"]} == {tuple(map(str, h[:3])) for h in js["hallazgos"]}
    assert sorted(py["sin_verificar"]) == sorted(js["sinVerificar"])
