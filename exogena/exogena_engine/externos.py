"""Formatos que NO salen del balance: 1010 (libro de accionistas) y 2276 (nómina electrónica)."""
from __future__ import annotations

import pandas as pd

from .config import Config
from .motor import _redondear
from .terceros import depurar
from .utils import a_numero, a_texto, clave, leer_tabla, renombrar

ALIAS_PERSONA = {
    "nit": ["nit", "identificacion", "numero identificacion", "documento", "cedula"],
    "dv": ["dv"],
    "tipo_documento": ["tipo documento", "tipo de documento", "tipo identificacion"],
    "tipo_persona": ["tipo persona"],
    "razon_social": ["nombre", "razon social", "nombre completo", "empleado", "socio", "accionista"],
    "primer_apellido": ["primer apellido"], "segundo_apellido": ["segundo apellido"],
    "primer_nombre": ["primer nombre"], "otros_nombres": ["otros nombres", "segundo nombre"],
    "direccion": ["direccion"], "ciudad": ["ciudad", "municipio"], "departamento": ["departamento"],
    "pais": ["pais"], "codigo_municipio_dane": ["codigo dane", "codigo municipio"],
}


def _personas(df: pd.DataFrame, cfg: Config, hallazgos: list) -> pd.DataFrame:
    df = renombrar(df, ALIAS_PERSONA)
    for c in ALIAS_PERSONA:
        if c not in df.columns:
            df[c] = ""
    df = df.apply(lambda s: s.map(a_texto))
    df["nit"] = df["nit"].str.replace(r"\D", "", regex=True)
    pseudo_balance = pd.DataFrame({"nit": df["nit"], "nombre_tercero": df["razon_social"], "dv_fuente": df["dv"]})
    return depurar(pseudo_balance, df[list(ALIAS_PERSONA)], cfg, hallazgos), df


def porcentaje_dian(p: float) -> tuple[int, int]:
    """49.5 -> (495, 1); 50 -> (50, 0); 33.3333 -> (333333, 4). Sin puntos ni comas + posición decimal."""
    txt = f"{round(float(p), 4):.4f}".rstrip("0").rstrip(".")
    ent, _, dec = txt.partition(".")
    return int(ent + dec), len(dec)


def formato_1010(ruta: str, balance: pd.DataFrame, cfg: Config, hallazgos: list) -> pd.DataFrame:
    """Libro de accionistas: nit, nombre, ..., porcentaje (o acciones), y opcionalmente valor_nominal y prima.
    Art. 1.3.5.1.1: valor nominal de la acción o aporte y valor pagado por prima en colocación, por accionista."""
    campos = [c for c, _ in cfg.formatos["1010"]["columnas"]]
    crudo = leer_tabla(ruta)
    terceros, df = _personas(crudo, cfg, hallazgos)
    cols = {clave(c): c for c in crudo.columns}
    if "porcentaje" in cols:
        pct = crudo[cols["porcentaje"]].map(a_numero)
    elif "acciones" in cols:
        acc = crudo[cols["acciones"]].map(a_numero)
        pct = acc / acc.sum() * 100
    else:
        raise ValueError("accionistas: se requiere columna 'porcentaje' o 'acciones'")
    if abs(pct.sum() - 100) > 0.0001:
        hallazgos.append(("ERROR", "1010 participación", "", f"Los porcentajes suman {pct.sum():.4f}%, no 100%"))

    capital = -balance.loc[balance["cuenta"].str.startswith("31"), "saldo_final"].sum()
    col_nom = next((cols[k] for k in ("valor nominal", "valor_nominal", "capital") if k in cols), None)
    col_prima = next((cols[k] for k in ("prima", "prima en colocacion") if k in cols), None)
    prima_balance = -balance.loc[balance["cuenta"].str.startswith("3205"), "saldo_final"].sum()
    if prima_balance > 0.5 and col_prima is None:
        hallazgos.append(("ALERTA", "1010 prima en colocación", "",
                          f"El balance tiene prima en colocación de acciones (${prima_balance:,.0f}) y el libro de "
                          f"accionistas no trae la columna 'prima'. Asígnela por accionista según las actas; "
                          f"no la reparta a prorrata"))
    if col_nom is None:
        hallazgos.append(("INFO", "1010 valor nominal estimado", "",
                          f"Sin columna 'valor nominal': se usa capital (cuenta 31, ${capital:,.0f}) x participación"))
    filas = []
    for i, (nit, p) in enumerate(zip(df["nit"], pct)):
        t = terceros.loc[nit].to_dict()
        if t.get("pais") not in ("", "169", None):
            t = {**t, "direccion": "", "codigo_departamento": "", "codigo_municipio": ""}
        num, pos = porcentaje_dian(p)
        nominal = a_numero(crudo.iloc[i][col_nom]) if col_nom else capital * p / 100
        prima = a_numero(crudo.iloc[i][col_prima]) if col_prima else 0.0
        filas.append({**t, "valor_nominal": nominal, "prima": prima, "porcentaje": num, "posicion_decimal": pos})
    return _redondear(pd.DataFrame(filas)[campos], ["valor_nominal", "prima"])


def formato_2276(ruta: str, balance: pd.DataFrame, cfg: Config, hallazgos: list) -> pd.DataFrame:
    """nomina.csv: consolidado anual por empleado (reporte de nómina electrónica)
    con columnas iguales a los campos del formato 2276 en config/formatos.yaml."""
    campos = [c for c, _ in cfg.formatos["2276"]["columnas"]]
    crudo = leer_tabla(ruta)
    terceros, df = _personas(crudo, cfg, hallazgos)
    crudo.columns = [clave(c).replace(" ", "_") for c in crudo.columns]
    valores = [c for c in campos if c.startswith(("pagos_", "cesantias", "pensiones", "total_", "aporte",
                                                    "retencion")) or c == "otros_pagos"]
    for c in valores:
        crudo[c] = crudo[c].map(a_numero) if c in crudo.columns else 0.0
    pagos = [c for c in valores if c.startswith(("pagos_", "cesantias", "pensiones")) or c == "otros_pagos"]
    if (crudo["total_ingresos"] == 0).all():
        crudo["total_ingresos"] = crudo[pagos].sum(axis=1)

    filas = []
    for i, nit in enumerate(df["nit"]):
        t = terceros.loc[nit].to_dict()
        filas.append({**t, "entidad_informante": "1", **{c: crudo.at[i, c] for c in valores}})
    cfg.marcar_uso("2276: código de 'entidad informante'")
    out = _redondear(pd.DataFrame(filas)[campos], valores)

    # Cruce con contabilidad: salarios de nómina vs cuentas 5105/5205/7205 subcuenta 06 (sueldos)
    sueldos = balance[balance["cuenta"].str.match(r"^(5105|5205|7205)(06|03)")]
    contable = (sueldos["debito"] - sueldos["credito"]).sum()
    nomina = out["pagos_salarios"].sum()
    tol = cfg.parametros["validacion"]["tolerancia_cuadre"]
    if contable and abs(contable - nomina) > tol:
        hallazgos.append(("ALERTA", "2276 vs contabilidad", "",
                          f"Salarios nómina ${nomina:,.0f} vs sueldos contables ${contable:,.0f} "
                          f"(dif. ${nomina - contable:,.0f})"))
    return out
