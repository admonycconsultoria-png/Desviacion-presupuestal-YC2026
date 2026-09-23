"""Normaliza el balance de prueba por tercero de Alegra / Siigo / Dataico al esquema canónico.

Esquema canónico del balance (una fila por cuenta auxiliar + tercero):
    cuenta, nombre_cuenta, nit, dv_fuente, nombre_tercero,
    saldo_inicial, debito, credito, saldo_final   (saldos: débito positivo)
"""
from __future__ import annotations

import pandas as pd

from .config import Config
from .dv import separar_dv
from .utils import a_numero, clave, leer_tabla, renombrar, solo_digitos, ubicar_encabezado

NATURALEZA_CREDITO = ("2", "3", "4")


def cargar_balance(ruta: str, fuente: str, cfg: Config, alertas: list) -> pd.DataFrame:
    spec = cfg.fuentes[fuente]
    alias = spec["balance"]
    df = ubicar_encabezado(leer_tabla(ruta), alias)
    df = renombrar(df, alias)
    faltan = [c for c in ("cuenta", "debito", "credito") if c not in df.columns]
    if faltan:
        raise ValueError(f"El balance no trae columnas {faltan}. Encabezados leídos: {list(df.columns)}. "
                         f"Agregue el alias en config/fuentes.yaml -> {fuente}.balance")

    for col in ("nombre_cuenta", "nit", "nombre_tercero"):
        if col not in df.columns:
            df[col] = ""
    for col in ("saldo_inicial", "debito", "credito", "saldo_final"):
        df[col] = df[col].map(a_numero) if col in df.columns else 0.0

    df["cuenta"] = df["cuenta"].map(solo_digitos)
    df = df[df["cuenta"] != ""].copy()

    # NIT: puede venir "900123456-8"
    separado = df["nit"].fillna("").map(separar_dv)
    df["nit"] = separado.map(lambda t: t[0])
    df["dv_fuente"] = separado.map(lambda t: t[1] or "")
    df["nombre_tercero"] = df["nombre_tercero"].fillna("").astype(str).str.strip()

    # Filtro de filas de totales
    filtro = spec.get("filtro_filas", {}) or {}
    if filtro.get("columna") and filtro["columna"] in df.columns:
        validos = {clave(v) for v in filtro["valores_validos"]}
        df = df[df[filtro["columna"]].map(clave).isin(validos)].copy()
    else:
        df = _solo_hojas(df, alertas)

    if spec.get("signo_saldo") == "natural":
        cred = df["cuenta"].str[0].isin(NATURALEZA_CREDITO)
        df.loc[cred, ["saldo_inicial", "saldo_final"]] *= -1

    # Si la fuente no trae saldo final, se calcula
    if (df["saldo_final"] == 0).all() and ((df["debito"] != 0) | (df["credito"] != 0)).any():
        df["saldo_final"] = df["saldo_inicial"] + df["debito"] - df["credito"]

    cols = ["cuenta", "nombre_cuenta", "nit", "dv_fuente", "nombre_tercero",
            "saldo_inicial", "debito", "credito", "saldo_final"]
    return df[cols].reset_index(drop=True)


def _solo_hojas(df: pd.DataFrame, alertas: list) -> pd.DataFrame:
    """Conserva solo cuentas auxiliares (que no son prefijo de otra cuenta del archivo) y
    elimina la fila de subtotal sin tercero cuando coincide con la suma de sus terceros."""
    cuentas = sorted(set(df["cuenta"]))
    padres = set()
    for i, c in enumerate(cuentas[:-1]):
        for otra in cuentas[i + 1:]:
            if not otra.startswith(c):
                break
            if otra != c:
                padres.add(c)
                break
    df = df[~df["cuenta"].isin(padres)].copy()

    sin_nit = df["nit"] == ""
    quitar = []
    for cuenta, grupo in df.groupby("cuenta"):
        g_sin, g_con = grupo[sin_nit.loc[grupo.index]], grupo[~sin_nit.loc[grupo.index]]
        if g_sin.empty or g_con.empty:
            continue
        iguales = all(abs(g_sin[c].sum() - g_con[c].sum()) < 1 for c in ("debito", "credito", "saldo_final"))
        if iguales:
            quitar.extend(g_sin.index)
        else:
            alertas.append(("BALANCE", "Movimiento sin tercero", cuenta,
                            f"Cuenta {cuenta} tiene movimiento sin tercero además de movimiento con tercero"))
    return df.drop(index=quitar)


def cargar_terceros(ruta: str | None, fuente: str, cfg: Config) -> pd.DataFrame:
    """Maestro de terceros normalizado. Columnas canónicas (las que no vengan quedan vacías)."""
    canon = ["nit", "dv", "tipo_documento", "tipo_persona", "razon_social", "primer_nombre",
             "otros_nombres", "primer_apellido", "segundo_apellido", "direccion", "ciudad",
             "departamento", "pais", "codigo_municipio_dane", "email"]
    if not ruta:
        return pd.DataFrame(columns=canon)
    alias = cfg.fuentes[fuente]["terceros"]
    df = renombrar(ubicar_encabezado(leer_tabla(ruta), alias), alias)
    for c in canon:
        if c not in df.columns:
            df[c] = ""
    df = df[canon].fillna("").astype(str)
    separado = df["nit"].map(separar_dv)
    df["nit"] = separado.map(lambda t: t[0])
    df["dv"] = [d if d.strip() else (s[1] or "") for d, s in zip(df["dv"].map(solo_digitos), separado)]
    return df[df["nit"] != ""].reset_index(drop=True)
