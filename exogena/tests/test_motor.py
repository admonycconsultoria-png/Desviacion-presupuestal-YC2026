import subprocess
import sys
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from exogena_engine.__main__ import ejecutar  # noqa: E402
from exogena_engine.dv import calcular_dv, separar_dv  # noqa: E402
from exogena_engine.terceros import partir_nombre  # noqa: E402
from exogena_engine.utils import a_numero  # noqa: E402


@pytest.mark.parametrize("nit,dv", [("800197268", 4), ("860034313", 7), ("890900608", 9)])
def test_dv_nits_reales(nit, dv):
    assert calcular_dv(nit) == dv


def test_separar_dv():
    assert separar_dv("900.123.456-8") == ("900123456", "8")
    assert separar_dv("79555111") == ("79555111", None)


@pytest.mark.parametrize("texto,valor", [
    ("1.234.567,89", 1234567.89), ("1,234,567.89", 1234567.89), ("(1.000)", -1000.0),
    ("-2500", -2500.0), ("1.000", 1000.0), ("0,5", 0.5), ("", 0.0), (1500, 1500.0),
])
def test_a_numero(texto, valor):
    assert a_numero(texto) == pytest.approx(valor)


def test_partir_nombre_con_particulas():
    nom, ambiguo = partir_nombre("DE LA HOZ PEREZ MARIA JOSE", "apellidos_nombres")
    assert nom == {"primer_apellido": "DE LA HOZ", "segundo_apellido": "PEREZ",
                   "primer_nombre": "MARIA", "otros_nombres": "JOSE"}
    assert not ambiguo


@pytest.fixture(scope="module")
def resultado(tmp_path_factory):
    ej = RAIZ / "ejemplos"
    subprocess.run([sys.executable, str(ej / "generar_ejemplo.py")], check=True, capture_output=True)
    out = tmp_path_factory.mktemp("salida")
    return ejecutar("siigo", str(ej / "siigo_balance_por_tercero.xlsx"), str(ej / "siigo_terceros.xlsx"),
                    str(out), accionistas=str(ej / "accionistas.csv"), nomina=str(ej / "nomina.csv"))


def _hay(res, categoria, ident=""):
    return any(h[1] == categoria and ident in str(h[2]) for h in res["hallazgos"])


def test_detecta_errores_sembrados(resultado):
    assert _hay(resultado, "DV errado", "830045123")
    assert _hay(resultado, "NIT con DV pegado", "8605012347")
    assert _hay(resultado, "Posible tercero duplicado", "71234567")
    assert _hay(resultado, "NIT genérico", "222222222")
    assert _hay(resultado, "Movimiento sin tercero", "511025")
    assert _hay(resultado, "Falta direccion", "79555111")
    assert _hay(resultado, "CxC con saldo crédito", "900777888")


def test_cuadres_explican_todas_las_diferencias(resultado):
    assert (resultado["cuadres"]["estado"] == "OK").all(), resultado["cuadres"].to_string()


def test_1001_excluye_dian_y_propio_nit_y_prorratea_iva(resultado):
    f = resultado["generados"]["1001"]
    assert "800197268" not in set(f["numero_identificacion"])
    assert "900123456" not in set(f["numero_identificacion"])
    serv = f[(f["numero_identificacion"] == "901234567") & (f["concepto"] == "5004")].iloc[0]
    assert serv["ret_iva_comun"] == 570000 and serv["ret_renta"] == 800000
    # arrendamiento de $60.000 < tope -> cuantías menores con tipo 43
    cm = f[f["numero_identificacion"] == "222222222"].iloc[0]
    assert cm["tipo_documento"] == "43" and cm["pago_deducible"] == 60000


def test_1007_ingresos_y_devoluciones(resultado):
    f = resultado["generados"]["1007"].set_index("numero_identificacion")
    assert f.loc["890900608", "ingreso_bruto"] == 200_000_000
    assert f.loc["890900608", "devoluciones"] == 4_000_000


def test_1005_1006_sin_dian(resultado):
    assert "800197268" not in set(resultado["generados"]["1005"]["numero_identificacion"])
    assert resultado["generados"]["1006"]["iva_generado"].sum() == 38_120_000


def test_1010_valor_patrimonial(resultado):
    f = resultado["generados"]["1010"].set_index("numero_identificacion")
    assert f.loc["71234567", "valor_patrimonial"] == 60_000_000
    assert f.loc["43111222", "porcentaje_entero"] == 40


def test_departamento_con_cero_a_la_izquierda(resultado):
    f = resultado["generados"]["1008"].set_index("numero_identificacion")
    assert f.loc["890900608", "codigo_departamento"] == "05"
    assert f.loc["890900608", "codigo_municipio"] == "266"


def test_no_se_declara_listo_con_parametros_sin_verificar(resultado):
    assert resultado["sin_verificar"]
