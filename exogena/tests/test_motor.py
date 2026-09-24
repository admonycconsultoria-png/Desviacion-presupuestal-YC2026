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
    ("0.005", 0.005), ("-0.004", -0.004), ("4.656612873077393e-10", 4.656612873077393e-10),
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


def test_1010_valor_nominal_y_porcentaje(resultado):
    f = resultado["generados"]["1010"].set_index("numero_identificacion")
    assert f.loc["71234567", "valor_nominal"] == 60_000_000          # capital 100M x 60%
    assert f.loc["43111222", "porcentaje"] == 40 and f.loc["43111222", "posicion_decimal"] == 0


@pytest.mark.parametrize("p,esperado", [(49.5, (495, 1)), (50, (50, 0)), (0.5, (5, 1)), (33.3333, (333333, 4))])
def test_porcentaje_dian(p, esperado):
    from exogena_engine.externos import porcentaje_dian
    assert porcentaje_dian(p) == esperado


def test_departamento_con_cero_a_la_izquierda(resultado):
    f = resultado["generados"]["1008"].set_index("numero_identificacion")
    assert f.loc["890900608", "codigo_departamento"] == "05"
    assert f.loc["890900608", "codigo_municipio"] == "266"


def test_no_se_declara_listo_con_parametros_sin_verificar(resultado):
    assert resultado["sin_verificar"]


def test_correcciones_de_terceros(tmp_path):
    """Las correcciones por empresa quitan los errores sin crear otros (el NIT corregido hereda el maestro)."""
    import shutil
    import yaml
    ej = RAIZ / "ejemplos"
    cfgdir = tmp_path / "config"
    shutil.copytree(RAIZ / "config", cfgdir)
    p = yaml.safe_load((cfgdir / "parametros.yaml").read_text(encoding="utf-8"))
    p["correcciones_terceros"] = {
        "8605012347": {"nit_correcto": "860501234"},
        "860501234": {"dv": "7"},
        "830045123": {"dv": "2"},
        "79555111": {"direccion": "CL 10 20 30", "codigo_departamento": "05", "codigo_municipio": "001",
                     "primer_apellido": "RAMIREZ", "primer_nombre": "PEDRO", "otros_nombres": "ANTONIO"},
    }
    (cfgdir / "parametros.yaml").write_text(yaml.safe_dump(p, allow_unicode=True), encoding="utf-8")
    r = ejecutar("siigo", str(ej / "siigo_balance_por_tercero.xlsx"), str(ej / "siigo_terceros.xlsx"),
                 str(tmp_path / "out"), config_dir=str(cfgdir))
    cats = {(h[1], str(h[2])) for h in r["hallazgos"] if h[0] == "ERROR"}
    assert not any(n in ("8605012347", "860501234", "830045123", "79555111") for _, n in cats), cats
    f = r["generados"]["1009"].set_index("numero_identificacion")
    assert f.loc["860501234", "codigo_municipio"] == "001" and f.loc["860501234", "dv"] == "7"
    f1 = r["generados"]["1001"]
    ped = f1[f1["numero_identificacion"] == "79555111"].iloc[0]
    assert ped["primer_apellido"] == "RAMIREZ" and ped["codigo_departamento"] == "05"


# ---------------------------------------------------------------- prevalidador DIAN
def _cfg(anio):
    from exogena_engine import config as config_mod
    import shutil, tempfile
    d = Path(tempfile.mkdtemp())
    shutil.copytree(config_mod.CONFIG_DIR, d, dirs_exist_ok=True)
    txt = (d / "parametros.yaml").read_text(encoding="utf-8")
    (d / "parametros.yaml").write_text(txt.replace("anio_gravable: 2026", f"anio_gravable: {anio}"), encoding="utf-8")
    return config_mod.cargar(d)


def test_columnas_verificadas_contra_prevalidador_de_la_misma_version():
    cfg = _cfg(2026)
    # misma versión en AG 2025 y AG 2026 -> verificadas con el prevalidador AG 2025
    for fmt in ("1003", "1006", "1007", "1008", "1009", "1010", "1011", "1012", "2276"):
        assert cfg.formatos[fmt]["columnas_verificadas"], fmt
    # 1001 v11 y 1005 v9 (AG 2026) no tienen prevalidador de esa versión todavía
    assert not cfg.formatos["1001"]["columnas_verificadas"]
    assert not cfg.formatos["1005"]["columnas_verificadas"]
    assert cfg.formatos["2276"]["columnas"][13][0] == "pagos_bonos" and len(cfg.formatos["2276"]["columnas"]) == 45


def test_ag2025_verifica_1001_v10_y_1005_v8_con_opcional_omitida():
    cfg = _cfg(2025)
    assert cfg.formatos["1001"]["version"] == 10 and cfg.formatos["1001"]["columnas_verificadas"]
    v = cfg.formatos["1005"]["verificacion_columnas"]
    assert cfg.formatos["1005"]["version"] == 8 and v["verificado"]
    assert v["omitidas"] == ["IVA tratado como mayor valor del costo o gasto (Art.490 E.T)"]


def test_estado_columnas_detecta_orden_distinto():
    from exogena_engine.prevalidador import estado_columnas
    cfg = _cfg(2026)
    spec = dict(cfg.formatos["1008"])
    cols = list(spec["columnas"])
    cols[3], cols[4] = cols[4], cols[3]
    e = estado_columnas("1008", {**spec, "columnas": cols}, cfg.prevalidadores)
    assert not e["verificado"] and len(e["diferencias"]) == 2


def test_2276_layout_prevalidador(resultado):
    f = resultado["generados"]["2276"]
    assert len(f.columns) == 45
    assert (f["entidad_informante"] == "1").all()
    fila = f.iloc[0]
    assert fila["total_ingresos"] == fila["pagos_salarios"] + fila["pagos_prestaciones"] + fila["cesantias_fondo"]


def test_plantilla_nomina_cubre_el_2276():
    import yaml
    from exogena_engine import config as config_mod
    cfg = config_mod.cargar()
    plantilla = yaml.safe_load((config_mod.CONFIG_DIR / "plantilla_nomina.yaml").read_text(encoding="utf-8"))["columnas"]
    enc = [e for c, e in cfg.formatos["2276"]["columnas"] if c != "entidad_informante"]
    dian = [c["dian"] for c in plantilla]
    assert sorted(dian) == sorted(enc)            # todas las columnas del prevalidador, sin sobrantes
    assert dian[10:] == enc[10:]                  # valores en el mismo orden del prevalidador


def test_direccion_exigida_para_colombia_segun_macros_del_prevalidador(resultado):
    cfg = _cfg(2026)
    for fmt in ("1001", "1003", "1008", "1009", "1010", "2276"):
        assert {"direccion", "codigo_departamento", "codigo_municipio"} <= set(cfg.formatos[fmt]["obligatorios"]), fmt
        assert cfg.formatos[fmt]["direccion_minima"] == 8, fmt
    # el tercero sembrado sin dirección ni ciudad queda como ERROR en el 1001
    assert any(h[0] == "ERROR" and h[1] == "Falta direccion" and h[2] == "79555111" for h in resultado["hallazgos"])


def test_facturas_zip_de_zips(tmp_path):
    """Una carpeta de Google Drive descargada llega como un ZIP que contiene los ZIP de las facturas."""
    import zipfile
    from exogena_engine.facturas import leer_facturas
    subprocess.run([sys.executable, str(RAIZ / "ejemplos" / "generar_ejemplo.py")], check=True, capture_output=True)
    fe = RAIZ / "ejemplos" / "facturas"
    drive = tmp_path / "drive.zip"
    with zipfile.ZipFile(drive, "w") as z:
        z.write(fe / "FE_DEMO_0002.zip", "Facturas/FE_DEMO_0002.zip")
        z.write(fe / "FE_DEMO_0001.xml", "Facturas/FE_DEMO_0001.xml")
    orden = lambda l: sorted(l, key=lambda r: (r["nit"], r["fuente"]))  # noqa: E731
    assert orden(leer_facturas([drive])) == orden(leer_facturas([fe]))
    assert {r["nit"] for r in leer_facturas([drive])} == {"79555111", "830045123", "900123456"}


def test_nit_repetido_usa_sucursal_principal_o_fila_mas_completa():
    import pandas as pd
    from exogena_engine.terceros import depurar
    cfg = _cfg(2026)
    bal = pd.DataFrame({"nit": ["900555111", "71234567"], "nombre_tercero": ["EPS DEMO SAS", "PEREZ JUAN"],
                        "dv_fuente": ["", ""]})
    maestro = pd.DataFrame([
        # Siigo: una fila por sucursal; la 1 viene primero pero la principal es la 0
        {"nit": "900555111", "razon_social": "EPS DEMO SAS SEDE NORTE", "direccion": "CL 80 10 20", "ciudad": "Bogotá", "sucursal": "1"},
        {"nit": "900555111", "razon_social": "EPS DEMO SAS", "direccion": "CR 50 30 40", "ciudad": "Medellín", "sucursal": "0"},
        # sin sucursal: la fila más completa, aunque venga segunda
        {"nit": "71234567", "razon_social": "PEREZ JUAN", "direccion": "", "ciudad": "", "sucursal": ""},
        {"nit": "71234567", "razon_social": "PEREZ JUAN", "direccion": "CL 1 2 34", "ciudad": "Itagüí", "sucursal": ""},
    ])
    h = []
    t = depurar(bal, maestro, cfg, h)
    assert t.loc["900555111", "direccion"] == "CR 50 30 40" and t.loc["900555111", "codigo_municipio"] == "001"
    assert t.loc["71234567", "direccion"] == "CL 1 2 34"
    textos = {x[2]: x[3] for x in h if x[1] == "Duplicado en maestro"}
    assert "sucursales 1, 0" in textos["900555111"] and "principal (0)" in textos["900555111"]
    assert "más completa" in textos["71234567"]


def test_retencion_asumida_cruza_con_gasto_5315(resultado):
    f = resultado["generados"]["1001"]
    a = f[f["numero_identificacion"] == "900888777"]
    assert a["ret_asumida"].sum() == 440_000 and a["ret_renta"].sum() == 0
    assert a["pago_no_deducible"].sum() == 0 and a["pago_deducible"].sum() == 4_000_000   # el 5315 no es pago
    b = f[f["numero_identificacion"] == "79555111"]
    assert b["ret_asumida"].sum() == 0 and b["pago_no_deducible"].sum() == 300_000        # no cruza: sigue como gasto
    h = resultado["hallazgos"]
    assert any(x[0] == "INFO" and x[1] == "Retención asumida" and x[2] == "900888777" for x in h)
    assert any(x[0] == "ALERTA" and x[1] == "Posible retención asumida" and x[2] == "79555111" for x in h)
