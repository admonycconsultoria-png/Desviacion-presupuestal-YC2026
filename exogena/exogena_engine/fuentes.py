"""Normaliza el balance de prueba por tercero de Alegra / Siigo / Dataico al esquema canónico.

Esquema canónico del balance (una fila por cuenta auxiliar + tercero):
    cuenta, nombre_cuenta, nit, dv_fuente, nombre_tercero,
    saldo_inicial, debito, credito, saldo_final   (saldos: débito positivo)
"""
from __future__ import annotations

import pandas as pd

from .config import Config
from .dv import separar_dv
from .utils import a_numero, a_texto, clave, leer_tabla, renombrar, solo_digitos, ubicar_encabezado

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

    # NIT: puede venir "900123456-8"
    separado = df["nit"].map(a_texto).map(separar_dv)
    df["nit"] = separado.map(lambda t: t[0])
    df["dv_fuente"] = separado.map(lambda t: t[1] or "")
    df["nombre_tercero"] = df["nombre_tercero"].map(a_texto)
    df["nombre_cuenta"] = df["nombre_cuenta"].map(a_texto)

    filtro = spec.get("filtro_filas", {}) or {}
    if filtro.get("excluir_nivel") and "nivel" in df.columns:
        df = df[~df["nivel"].map(clave).str.contains(clave(filtro["excluir_nivel"]))].copy()
    if filtro.get("modo") == "jerarquia_nivel" and "nivel" in df.columns:
        df = _por_jerarquia(df, alertas)

    # Movimiento con tercero en cuentas sin código contable (Alegra permite crearlas): no se puede
    # parametrizar y se perdería en silencio.
    sin_codigo = df[(df["cuenta"] == "") & (df["nit"] != "")]
    for nombre, g in sin_codigo.groupby("nombre_cuenta"):
        alertas.append(("ERROR", "Cuenta sin código contable", nombre or "(sin nombre)",
                        f"'{nombre}' tiene {len(g)} filas con tercero (débitos ${g['debito'].sum():,.0f}, "
                        f"créditos ${g['credito'].sum():,.0f}) y no tiene código PUC: asígnele código en el "
                        f"software o esos valores quedan por fuera de la exógena"))
    df = df[df["cuenta"] != ""].copy()

    # Correcciones de NIT registradas por empresa (p. ej. NIT con el DV pegado)
    remap = {str(k): str(v["nit_correcto"]) for k, v in (cfg.parametros.get("correcciones_terceros") or {}).items()
             if isinstance(v, dict) and v.get("nit_correcto")}
    if remap:
        df["nit"] = df["nit"].map(lambda n: remap.get(n, n))

    # Filtro de filas de totales
    if filtro.get("modo") == "jerarquia_nivel" and "nivel" in df.columns:
        pass  # ya filtrado por jerarquía
    elif filtro.get("columna") and filtro["columna"] in df.columns:
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


def _por_jerarquia(df: pd.DataFrame, alertas: list) -> pd.DataFrame:
    """Lee el árbol de la columna Nivel (">" = profundidad). Las filas con tercero son el detalle.
    Una fila sin tercero abre un bloque: filas más profundas o terceros con su mismo código y nivel.
    Su valor es el total del bloque, así que solo se conserva el residuo (total − elementos directos
    del bloque), que es movimiento sin tercero. Si el bloque está vacío, la fila completa es residuo."""
    df = df[df["nivel"].fillna("").astype(str).str.strip() != ""].reset_index(drop=True)
    n = len(df)
    prof = df["nivel"].astype(str).str.count(">").tolist()
    cuenta, nit = df["cuenta"].tolist(), df["nit"].tolist()
    cols = ("saldo_inicial", "debito", "credito", "saldo_final")
    vals = df[list(cols)].to_numpy(dtype=float)
    fin = [0] * n
    for i in range(n - 1, -1, -1):
        if nit[i] != "":
            fin[i] = i + 1
            continue
        j = i + 1
        while j < n and (prof[j] > prof[i] or (prof[j] == prof[i] and cuenta[j] == cuenta[i] and nit[j] != "")):
            j = fin[j] if nit[j] == "" and prof[j] > prof[i] else j + 1
        fin[i] = j
    conservar, filas_residuo = [], []
    for i in range(n):
        if nit[i] != "":
            conservar.append(i)
            continue
        resto = vals[i].copy()
        j = i + 1
        while j < fin[i]:
            resto -= vals[j]
            j = fin[j] if nit[j] == "" else j + 1
        if max(abs(resto[1]), abs(resto[2]), abs(resto[3])) >= 1:
            fila = df.iloc[i].copy()
            fila[list(cols)] = resto
            filas_residuo.append((i, fila))
    salida = [df.iloc[i] for i in conservar] + [f for _, f in filas_residuo]
    orden = conservar + [i for i, _ in filas_residuo]
    return pd.DataFrame(salida, index=orden).sort_index().reset_index(drop=True) if salida else df.iloc[0:0]


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
            alertas.append(("ALERTA", "Movimiento sin tercero", cuenta,
                            f"Cuenta {cuenta} tiene movimiento sin tercero además de movimiento con tercero"))
    return df.drop(index=quitar)


def cargar_terceros(ruta: str | None, fuente: str, cfg: Config) -> pd.DataFrame:
    """Maestro de terceros normalizado. Columnas canónicas (las que no vengan quedan vacías)."""
    canon = ["nit", "dv", "tipo_documento", "tipo_persona", "razon_social", "primer_nombre",
             "otros_nombres", "primer_apellido", "segundo_apellido", "direccion", "ciudad",
             "departamento", "pais", "codigo_municipio_dane", "email", "sucursal"]
    if not ruta:
        return pd.DataFrame(columns=canon)
    alias = cfg.fuentes[fuente]["terceros"]
    df = renombrar(ubicar_encabezado(leer_tabla(ruta), alias), alias)
    for c in canon:
        if c not in df.columns:
            df[c] = ""
    df = df[canon].map(a_texto) if hasattr(df, "map") else df[canon].applymap(a_texto)
    separado = df["nit"].map(separar_dv)
    df["nit"] = separado.map(lambda t: t[0])
    df["dv"] = [d if d.strip() else (s[1] or "") for d, s in zip(df["dv"].map(solo_digitos), separado)]
    return df[df["nit"] != ""].reset_index(drop=True)
