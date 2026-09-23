"""Motor: balance por tercero + reglas -> partidas -> filas de cada formato."""
from __future__ import annotations

import pandas as pd

from .config import Config

RETENCIONES = ("ret_renta", "ret_asumida", "ret_iva_comun", "ret_iva_no_dom", "retencion")


def valor_base(fila, base: str) -> float:
    return {
        "neto_deb": fila.debito - fila.credito,
        "neto_cred": fila.credito - fila.debito,
        "debito": fila.debito,
        "credito": fila.credito,
        "saldo_deb": fila.saldo_final,
        "saldo_cred": -fila.saldo_final,
    }[base]


def generar_partidas(balance: pd.DataFrame, cfg: Config, hallazgos: list) -> pd.DataFrame:
    """Una partida por (formato, cuenta, tercero) con su concepto y columna destino.
    Incluye las partidas descartadas con el motivo, para la trazabilidad y el cuadre."""
    salida = []
    formatos = [f for f, d in cfg.formatos.items() if d["modo"] in ("por_tercero", "sin_tercero")]
    for fila in balance.itertuples(index=False):
        for fmt in formatos:
            regla = cfg.regla_para(fmt, fila.cuenta)
            if regla is None or regla.concepto == "EXCLUIR":
                continue
            valor = valor_base(fila, regla.base)
            if abs(valor) < 0.5:
                continue
            modo = cfg.formatos[fmt]["modo"]
            motivo = ""
            if modo == "por_tercero":
                if not fila.nit:
                    motivo = "sin_tercero"
                elif fila.nit in cfg.nits_excluidos(fmt):
                    motivo = "nit_excluido"
            salida.append({
                "formato": fmt, "cuenta": fila.cuenta, "nombre_cuenta": fila.nombre_cuenta,
                "nit": fila.nit if modo == "por_tercero" else "", "concepto": regla.concepto,
                "columna": regla.columna, "base": regla.base, "prefijo_regla": regla.prefijo,
                "valor": valor, "descartado": motivo,
            })
    partidas = pd.DataFrame(salida, columns=["formato", "cuenta", "nombre_cuenta", "nit", "concepto",
                                             "columna", "base", "prefijo_regla", "valor", "descartado"])
    sin_t = partidas[partidas["descartado"] == "sin_tercero"]
    for (fmt, cuenta), g in sin_t.groupby(["formato", "cuenta"]):
        hallazgos.append(("ERROR", "Movimiento sin tercero", cuenta,
                          f"Formato {fmt}: ${g['valor'].sum():,.0f} en la cuenta {cuenta} sin NIT; "
                          f"no se puede reportar hasta asignarle tercero"))
    return partidas


def _prorratear(p: pd.DataFrame, cfg: Config) -> pd.DataFrame:
    """Reparte las partidas con concepto PRORRATA entre los conceptos del mismo tercero
    en proporción a los pagos."""
    pr = p[p["concepto"] == "PRORRATA"]
    if pr.empty:
        return p
    resto = p[p["concepto"] != "PRORRATA"]
    nuevas = []
    for (fmt, nit, columna), g in pr.groupby(["formato", "nit", "columna"]):
        total = g["valor"].sum()
        pagos = resto[(resto["formato"] == fmt) & (resto["nit"] == nit) &
                      resto["columna"].isin(["pago_deducible", "pago_no_deducible"])]
        pesos = pagos.groupby("concepto")["valor"].sum()
        pesos = pesos[pesos > 0]
        if pesos.empty:
            defecto = (cfg.parametros.get("concepto_prorrata_defecto") or {}).get(fmt)
            pesos = pd.Series({defecto: 1.0})
        for concepto, peso in pesos.items():
            nuevas.append({**g.iloc[0].to_dict(), "concepto": concepto,
                           "valor": total * peso / pesos.sum(), "prefijo_regla": "PRORRATA"})
    return pd.concat([resto, pd.DataFrame(nuevas)], ignore_index=True)


def construir_formato(fmt: str, partidas: pd.DataFrame, terceros: pd.DataFrame,
                      balance: pd.DataFrame, cfg: Config, hallazgos: list) -> pd.DataFrame:
    spec = cfg.formatos[fmt]
    campos = [c for c, _ in spec["columnas"]]
    valores = [c for c in campos if c not in _CAMPOS_TERCERO and c != "concepto"]
    p = partidas[(partidas["formato"] == fmt) & (partidas["descartado"] == "")].copy()
    p = _prorratear(p, cfg)
    if p.empty:
        return pd.DataFrame(columns=campos)

    if spec["modo"] == "sin_tercero":
        t = p.groupby(["concepto", "columna"])["valor"].sum().unstack(fill_value=0).reset_index()
        for c in valores:
            if c not in t.columns:
                t[c] = 0
        return _redondear(t[campos], valores)

    tabla = (p.groupby(["concepto", "nit", "columna"])["valor"].sum()
             .unstack(fill_value=0).reset_index())
    for c in valores:
        if c not in tabla.columns:
            tabla[c] = 0.0

    if fmt == "1003":
        tabla = _base_1003(tabla, balance, hallazgos)

    # Negativos: la DIAN no los acepta -> alerta y se llevan a cero
    for c in valores:
        neg = tabla[tabla[c] < -0.5]
        for r in neg.itertuples():
            hallazgos.append(("ALERTA", "Valor negativo", r.nit,
                              f"Formato {fmt} concepto {r.concepto} columna {c}: {getattr(r, c):,.0f} "
                              f"(naturaleza contraria o reversión); se reporta en cero"))
        tabla[c] = tabla[c].clip(lower=0)
    tabla = tabla[(tabla[valores].abs() > 0.5).any(axis=1)]

    tabla = _cuantias_menores(fmt, tabla, valores, cfg)

    # Datos del tercero
    filas = []
    cm = cfg.parametros["cuantias_menores"]
    emp = cfg.parametros["empresa"]
    for r in tabla.to_dict("records"):
        if r["nit"] == cm["nit"]:
            t = {"tipo_documento": cm["tipo_documento"], "numero_identificacion": cm["nit"], "dv": "",
                 "primer_apellido": "", "segundo_apellido": "", "primer_nombre": "", "otros_nombres": "",
                 "razon_social": cm["razon_social"], "direccion": emp.get("direccion", ""),
                 "codigo_departamento": emp.get("codigo_departamento", ""),
                 "codigo_municipio": emp.get("codigo_municipio", ""), "pais": "169"}
        else:
            t = terceros.loc[r["nit"]].to_dict()
            for req in spec.get("requiere", []):
                if not t.get(req):
                    hallazgos.append(("ERROR", f"Falta {req}", r["nit"],
                                      f"Formato {fmt}: el tercero no tiene {req} y el prevalidador lo exige"))
        filas.append({**{c: t.get(c, "") for c in campos if c in _CAMPOS_TERCERO}, **r})
    out = pd.DataFrame(filas)
    if not spec.get("concepto"):
        out["concepto"] = ""
    out = out.sort_values(["concepto", "numero_identificacion"]) if "concepto" in out else out
    return _redondear(out[campos], valores)


_CAMPOS_TERCERO = {"tipo_documento", "numero_identificacion", "dv", "primer_apellido", "segundo_apellido",
                   "primer_nombre", "otros_nombres", "razon_social", "direccion", "codigo_departamento",
                   "codigo_municipio", "pais"}


def _redondear(df: pd.DataFrame, valores: list[str]) -> pd.DataFrame:
    df = df.copy()
    for c in valores:
        df[c] = df[c].astype(float).round(0).astype("int64")
    return df.reset_index(drop=True)


def _base_1003(tabla: pd.DataFrame, balance: pd.DataFrame, hallazgos: list) -> pd.DataFrame:
    """La base sujeta a retención no está en la cuenta 1355: se estima con los ingresos (clase 4)
    del mismo tercero y se reparte entre sus conceptos según el valor retenido."""
    ing = balance[balance["cuenta"].str.startswith("4")]
    ing = (ing["credito"] - ing["debito"]).groupby(ing["nit"]).sum()
    tabla["base_retencion"] = 0.0
    for nit, g in tabla.groupby("nit"):
        base = float(ing.get(nit, 0.0))
        total_ret = g["retencion"].sum()
        if base <= 0:
            hallazgos.append(("ALERTA", "Base 1003 no encontrada", nit,
                              "Le practicaron retención pero no hay ingresos con ese tercero; "
                              "tomar la base del certificado de retención"))
            continue
        tabla.loc[g.index, "base_retencion"] = base * g["retencion"] / total_ret if total_ret else 0
        hallazgos.append(("INFO", "Base 1003 estimada", nit,
                          f"Base estimada con ingresos del tercero (${base:,.0f}); validar contra certificados"))
    return tabla


def _cuantias_menores(fmt: str, tabla: pd.DataFrame, valores: list[str], cfg: Config) -> pd.DataFrame:
    tope = (cfg.parametros.get("topes") or {}).get(fmt) or {}
    if not tope.get("valor"):
        return tabla
    cfg.marcar_uso(f"Tope cuantías menores formato {fmt}") if not tope.get("verificado") else None
    cols = tope["columna"].split("+")
    metrica = tabla[cols].sum(axis=1)
    menores = metrica < tope["valor"]
    if cfg.parametros.get("no_agrupar_si_retencion", True):
        rets = [c for c in valores if c in RETENCIONES]
        if rets:
            menores &= ~(tabla[rets].abs().sum(axis=1) > 0.5)
    if not menores.any():
        return tabla
    nit_cm = cfg.parametros["cuantias_menores"]["nit"]
    agrupado = tabla[menores].groupby("concepto")[valores].sum().reset_index()
    agrupado["nit"] = nit_cm
    return pd.concat([tabla[~menores], agrupado], ignore_index=True)
