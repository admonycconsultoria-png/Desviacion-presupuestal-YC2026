"""Formatos que NO salen del balance: 1010 (libro de accionistas) y 2276 (nómina electrónica)."""
from __future__ import annotations

import pandas as pd

from .config import Config
from .motor import _redondear
from .terceros import depurar
from .utils import a_numero, clave, leer_tabla, renombrar

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
    df = df.fillna("")
    df["nit"] = df["nit"].astype(str).str.replace(r"\D", "", regex=True)
    pseudo_balance = pd.DataFrame({"nit": df["nit"], "nombre_tercero": df["razon_social"], "dv_fuente": df["dv"]})
    return depurar(pseudo_balance, df[list(ALIAS_PERSONA)], cfg, hallazgos), df


def formato_1010(ruta: str, balance: pd.DataFrame, cfg: Config, hallazgos: list) -> pd.DataFrame:
    """accionistas.csv: nit, nombre, ..., porcentaje (o acciones). Valor patrimonial =
    patrimonio contable (clase 3) x % de participación."""
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
    if abs(pct.sum() - 100) > 0.01:
        hallazgos.append(("ERROR", "1010 participación", "", f"Los porcentajes suman {pct.sum():.4f}%, no 100%"))

    patrimonio = -balance.loc[balance["cuenta"].str.startswith("3"), "saldo_final"].sum()
    filas = []
    for nit, p in zip(df["nit"], pct):
        t = terceros.loc[nit].to_dict()
        entero = int(p)
        decimal = int(round((p - entero) * 10000))
        filas.append({**t, "valor_patrimonial": patrimonio * p / 100,
                      "porcentaje_entero": entero, "porcentaje_decimal": decimal})
    cfg.marcar_uso("1010: forma de partir el % en entero/decimal (4 posiciones)")
    return _redondear(pd.DataFrame(filas)[campos], ["valor_patrimonial"])


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
