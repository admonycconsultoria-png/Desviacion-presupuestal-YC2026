"""Motor: balance por tercero + reglas -> partidas -> filas de cada formato."""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

from .config import Config
from .dv import calcular_dv
from .utils import clave, texto_dian

RETENCIONES = ("ret_renta", "ret_asumida", "ret_iva_comun", "ret_iva_no_dom", "retencion")


def valor_base(fila, base: str) -> float:
    return {
        "neto_deb": fila.debito - fila.credito,
        "neto_cred": fila.credito - fila.debito,
        "debito": fila.debito,
        "credito": fila.credito,
        "saldo_deb": fila.saldo_final,
        "saldo_cred": -fila.saldo_final,
        # Compras netas de devoluciones: débito − crédito solo del tercero que tiene débitos (el proveedor).
        # Los créditos de terceros sin débitos son salidas al costo de ventas y no se restan.
        "compras_netas": max(fila.debito - fila.credito, 0.0) if fila.debito > 0 else 0.0,
    }[base]


def generar_partidas(balance: pd.DataFrame, cfg: Config, hallazgos: list) -> pd.DataFrame:
    """Una partida por (formato, cuenta, tercero) con su concepto y columna destino.
    Incluye las partidas descartadas con el motivo, para la trazabilidad y el cuadre."""
    salida = []
    formatos = [f for f, d in cfg.formatos.items() if d["modo"] in ("por_tercero", "sin_tercero")]
    for fila in balance.itertuples(index=False):
        for fmt in formatos:
            regla = cfg.regla_para(fmt, fila.cuenta)
            if regla is None or regla.concepto == "EXCLUIR" or regla.base.endswith("_cuenta"):
                continue
            valor = valor_base(fila, regla.base)
            if abs(valor) < 0.5:
                continue
            modo = cfg.formatos[fmt]["modo"]
            motivo = ""
            nit = fila.nit
            if modo == "por_tercero" and regla.tercero:
                nit = cfg.tercero_fijo(regla.tercero)   # la norma fija el NIT (p. ej. diferencia en cambio)
            elif modo == "por_tercero":
                if not fila.nit:
                    motivo = "sin_tercero"
                elif fila.nit in cfg.nits_excluidos(fmt):
                    motivo = "nit_excluido"
            salida.append({
                "formato": fmt, "cuenta": fila.cuenta, "nombre_cuenta": fila.nombre_cuenta,
                "nit": nit if modo == "por_tercero" else "", "concepto": regla.concepto,
                "columna": regla.columna, "base": regla.base, "prefijo_regla": regla.prefijo,
                "valor": valor, "descartado": motivo,
            })
    salida.extend(_partidas_por_cuenta(balance, formatos, cfg, hallazgos))
    partidas = pd.DataFrame(salida, columns=["formato", "cuenta", "nombre_cuenta", "nit", "concepto",
                                             "columna", "base", "prefijo_regla", "valor", "descartado"])
    # (las cuentas bancarias sin entidad ya tienen su propio hallazgo)
    sin_t = partidas[(partidas["descartado"] == "sin_tercero") & ~partidas["base"].str.endswith("_cuenta")]
    for (fmt, cuenta), g in sin_t.groupby(["formato", "cuenta"]):
        hallazgos.append(("ERROR", "Movimiento sin tercero", cuenta,
                          f"Formato {fmt}: ${g['valor'].sum():,.0f} en la cuenta {cuenta} sin NIT; "
                          f"no se puede reportar hasta asignarle tercero"))
    return partidas


PATRON_ENTIDAD = re.compile(r"\b(BANCO|BANCOLOMBIA|DAVIVIENDA|BBVA|COLPATRIA|SCOTIABANK|ITAU|AV VILLAS|"
                            r"CAJA SOCIAL|OCCIDENTE|POPULAR|AGRARIO|BANCAMIA|FALABELLA|PICHINCHA|SERFINANZA|"
                            r"NEQUI|DAVIPLATA|LULO|NU COLOMBIA|MOVII|CONFIAR|COTRAFA|JFK|COOPERATIVA|"
                            r"FIDUCIARIA|FONDO)\b")
SECUNDARIAS = re.compile(r"\b(FIDUCIARIA|FONDO|COMISIONISTA|VALORES)\b")


def _partidas_por_cuenta(balance: pd.DataFrame, formatos: list[str], cfg: Config, hallazgos: list) -> list:
    """Cuentas bancarias e inversiones: en muchos software el tercero de cada movimiento es la
    contraparte (cliente/proveedor), no el banco. El saldo se toma por cuenta y se asigna a la entidad
    configurada en parametros.cuentas_bancarias o, si no está, a la entidad financiera que aparezca
    como tercero en la cuenta."""
    fijos = {str(k): str(v) for k, v in (cfg.parametros.get("cuentas_bancarias") or {}).items()}
    salida = []
    for cuenta, g in balance.groupby("cuenta"):
        for fmt in formatos:
            regla = cfg.regla_para(fmt, cuenta)
            if regla is None or regla.concepto == "EXCLUIR" or not regla.base.endswith("_cuenta"):
                continue
            valor = g["saldo_final"].sum() * (-1 if regla.base == "saldo_cred_cuenta" else 1)
            if abs(valor) < 0.5:
                continue
            nit = cfg.tercero_fijo(regla.tercero) if regla.tercero else fijos.get(cuenta, "")
            if not nit and regla.base == "saldo_cred_cuenta":
                hallazgos.append(("ERROR", "Tercero de la cuenta sin definir", cuenta,
                                  f"Formato {fmt}: el saldo de la cuenta {cuenta} (${valor:,.0f}) se reporta a un solo "
                                  f"acreedor; configúrelo en Cuentas con tercero fijo"))
            elif not nit:
                nombres = g.loc[g["nit"] != "", ["nit", "nombre_tercero"]].drop_duplicates("nit")
                cand = nombres[nombres["nombre_tercero"].map(lambda n: bool(PATRON_ENTIDAD.search(texto_dian(n))))]
                if len(cand) > 1:
                    prim = cand[~cand["nombre_tercero"].map(lambda n: bool(SECUNDARIAS.search(texto_dian(n))))]
                    cand = prim if not prim.empty else cand
                if len(cand) == 1:
                    nit = cand.iloc[0]["nit"]
                    hallazgos.append(("ALERTA", "Entidad financiera inferida", cuenta,
                                      f"Formato {fmt}: saldo de la cuenta {cuenta} (${valor:,.0f}) asignado a "
                                      f"'{cand.iloc[0]['nombre_tercero']}' ({nit}). Confirmar y fijarlo en "
                                      f"parametros.cuentas_bancarias"))
                else:
                    hallazgos.append(("ERROR", "Entidad financiera sin definir", cuenta,
                                      f"Formato {fmt}: no se pudo determinar la entidad de la cuenta {cuenta}; "
                                      f"configurar parametros.cuentas_bancarias"))
            salida.append({
                "formato": fmt, "cuenta": cuenta, "nombre_cuenta": g["nombre_cuenta"].iloc[0], "nit": nit,
                "concepto": regla.concepto, "columna": regla.columna, "base": regla.base,
                "prefijo_regla": regla.prefijo, "valor": valor, "descartado": "" if nit else "sin_tercero",
            })
    return salida


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
        t.columns.name = None
        for c in valores:
            if c not in t.columns:
                t[c] = 0
            for r in t[t[c] < -0.5].itertuples():
                hallazgos.append(("ALERTA", "Valor negativo", r.concepto,
                                  f"Formato {fmt} concepto {r.concepto}: {getattr(r, c):,.0f}; se reporta en cero"))
            t[c] = t[c].clip(lower=0)
        t = t[(t[valores].abs() > 0.5).any(axis=1)]
        return _redondear(t[campos], valores)

    tabla = (p.groupby(["concepto", "nit", "columna"])["valor"].sum()
             .unstack(fill_value=0).reset_index())
    for c in valores:
        if c not in tabla.columns:
            tabla[c] = 0.0

    if fmt == "1003":
        tabla = _base_1003(tabla, balance, hallazgos)

    # Régimen Simple / no contribuyentes: todo en "no deducible" (art. 1.3.5.2.1 par. 9 y 14)
    if fmt == "1001" and cfg.parametros.get("forzar_no_deducible"):
        for d, nd in (("pago_deducible", "pago_no_deducible"), ("iva_deducible", "iva_no_deducible")):
            if d in tabla and nd in tabla:
                tabla[nd] = tabla[nd] + tabla[d]
                tabla[d] = 0.0

    # Negativos: la DIAN no los acepta -> alerta y se llevan a cero
    for c in valores:
        neg = tabla[tabla[c] < -0.5]
        for r in neg.itertuples():
            hallazgos.append(("ALERTA", "Valor negativo", r.nit,
                              f"Formato {fmt} concepto {r.concepto} columna {c}: {getattr(r, c):,.0f} "
                              f"(naturaleza contraria o reversión); se reporta en cero"))
        tabla[c] = tabla[c].clip(lower=0)
    tabla = tabla[(tabla[valores].abs() > 0.5).any(axis=1)]

    tabla = _retenciones_huerfanas(fmt, tabla, valores, hallazgos)
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
            t = terceros.loc[r["nit"]].to_dict() if r["nit"] in terceros.index else {"numero_identificacion": r["nit"]}
            if r["nit"] == cfg.nit_empresa:
                t = {**t, **_datos_informante(cfg)}
            exterior = t.get("pais") not in ("", "169", None)
            if exterior:
                # exterior: no se registran dirección, departamento ni municipio (p. ej. art. 1.3.5.2.1 par. 6)
                t = {**t, "direccion": "", "codigo_departamento": "", "codigo_municipio": ""}
            for req in spec.get("requiere", []):
                if exterior and req in ("direccion", "codigo_departamento", "codigo_municipio"):
                    continue  # el prevalidador solo exige dpto/municipio para Colombia
                if not t.get(req):
                    # ERROR solo si el prevalidador rechaza la columna vacía; si no, dato que la norma pide y falta
                    if req in spec.get("obligatorios", [req]):
                        hallazgos.append(("ERROR", f"Falta {req}", r["nit"],
                                          f"Formato {fmt}: el tercero no tiene {req} y el prevalidador lo exige"))
                    else:
                        hallazgos.append(("ALERTA", f"Falta {req}", r["nit"],
                                          f"Formato {fmt}: el tercero no tiene {req}. El prevalidador acepta la "
                                          f"columna vacía, pero repórtela si la conoce"))
            minimo = spec.get("direccion_minima", 0)
            if not exterior and t.get("direccion") and len(str(t["direccion"])) < minimo:
                es_ciudad = clave(t["direccion"]) in set(cfg.divipola["k_mpio"])
                hallazgos.append(("ERROR", "Dirección muy corta", r["nit"],
                                  f"Formato {fmt}: '{t['direccion']}' tiene menos de {minimo} caracteres; "
                                  f"el prevalidador la rechaza"
                                  + (" (es el nombre de un municipio, no una dirección)" if es_ciudad else "")))
        filas.append({**{c: t.get(c, "") for c in campos if c in _CAMPOS_TERCERO}, **r})
    out = pd.DataFrame(filas)
    if not spec.get("concepto"):
        out["concepto"] = ""
    out = out.sort_values(["concepto", "numero_identificacion"]) if "concepto" in out else out
    return _redondear(out[campos], valores)


def _datos_informante(cfg: Config) -> dict:
    emp = cfg.parametros["empresa"]
    return {"tipo_documento": "31", "numero_identificacion": cfg.nit_empresa, "dv": _dv_seguro(cfg.nit_empresa),
            "primer_apellido": "", "segundo_apellido": "", "primer_nombre": "", "otros_nombres": "",
            "razon_social": texto_dian(emp.get("razon_social", "")), "direccion": texto_dian(emp.get("direccion", "")),
            "codigo_departamento": emp.get("codigo_departamento", ""), "codigo_municipio": emp.get("codigo_municipio", ""),
            "pais": "169"}


def _dv_seguro(nit: str) -> str:
    try:
        return str(calcular_dv(nit))
    except ValueError:
        return ""


_CAMPOS_TERCERO = {"tipo_documento", "numero_identificacion", "dv", "primer_apellido", "segundo_apellido",
                   "primer_nombre", "otros_nombres", "razon_social", "direccion", "codigo_departamento",
                   "codigo_municipio", "pais"}


def _redondear(df: pd.DataFrame, valores: list[str]) -> pd.DataFrame:
    df = df.copy()
    for c in valores:
        x = df[c].astype(float)
        # redondeo comercial (0,5 hacia arriba), no el de banquero que usa round() de Python
        df[c] = (np.sign(x) * np.floor(x.abs() + 0.5)).astype("int64")
    return df.reset_index(drop=True)


def _base_1003(tabla: pd.DataFrame, balance: pd.DataFrame, hallazgos: list) -> pd.DataFrame:
    """La base sujeta a retención no está en la cuenta 1355: se estima con los ingresos (clase 4)
    del mismo tercero y se reparte entre sus conceptos según el valor retenido."""
    ing = balance[balance["cuenta"].str.startswith("4")]
    ing = (ing["credito"] - ing["debito"]).groupby(ing["nit"]).sum()
    tabla["base_retencion"] = 0.0
    iva = tabla["concepto"] == "1309"
    if iva.any():
        # Res. 233/2025: en el 1309 la base es el valor del IVA; se estima con la tarifa general de reteIVA (15%)
        tabla.loc[iva, "base_retencion"] = tabla.loc[iva, "retencion"] / 0.15
        for nit in tabla.loc[iva, "nit"]:
            hallazgos.append(("INFO", "Base 1309 estimada", nit,
                              "Base del 1309 = valor del IVA, estimada como retención / 15%; validar contra certificados"))
    for nit, g in tabla[~iva].groupby("nit"):
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


def _retenciones_huerfanas(fmt: str, tabla: pd.DataFrame, valores: list[str], hallazgos: list) -> pd.DataFrame:
    """Retención causada en un concepto donde el tercero no tiene pago (p. ej. retención por compras
    de un bien que se llevó al gasto): se traslada al concepto con mayor pago del mismo tercero."""
    pagos = [c for c in ("pago_deducible", "pago_no_deducible") if c in valores]
    rets = [c for c in valores if c in RETENCIONES]
    if not pagos or not rets:
        return tabla
    tabla = tabla.reset_index(drop=True)
    total_pago = tabla[pagos].sum(axis=1)
    huerfanas = tabla[(total_pago < 0.5) & (tabla[rets].sum(axis=1) > 0.5)]
    quitar = []
    for i, r in huerfanas.iterrows():
        mismos = tabla[(tabla["nit"] == r["nit"]) & (total_pago > 0.5)]
        if mismos.empty:
            hallazgos.append(("ALERTA", "Retención sin pago", r["nit"],
                              f"Formato {fmt} concepto {r['concepto']}: hay retención pero ningún pago o abono "
                              f"al tercero; revisar la causación"))
            continue
        destino = total_pago[mismos.index].idxmax()
        for c in rets:
            tabla.at[destino, c] += r[c]
        quitar.append(i)
        hallazgos.append(("INFO", "Retención reasignada", r["nit"],
                          f"Formato {fmt}: retención del concepto {r['concepto']} trasladada al concepto "
                          f"{tabla.at[destino, 'concepto']}, donde está el pago"))
    return tabla.drop(index=quitar)


def _cuantias_menores(fmt: str, tabla: pd.DataFrame, valores: list[str], cfg: Config) -> pd.DataFrame:
    """El tope se evalúa POR TERCERO SUMANDO TODO EL FORMATO (art. 1.3.5.2.1 par. 1: "acumulados por
    beneficiario por todo concepto"; 1008/1009: "saldo acumulado por deudor/acreedor"). Si el total del
    tercero es menor, todas sus filas pasan a 222222222 en su concepto. Un tercero con retención nunca
    se agrupa (todas las retenciones se reportan identificando al tercero)."""
    t = (cfg.parametros.get("topes") or {}).get(fmt) or {}
    tope = cfg.tope(fmt)
    if not tope:
        return tabla
    if not t.get("verificado"):
        cfg.marcar_uso(f"Tope cuantías menores formato {fmt}")
    cols = t["columna"].split("+")
    por_tercero = tabla[cols].sum(axis=1).groupby(tabla["nit"]).sum()
    menores_nit = set(por_tercero[por_tercero < tope].index)
    rets = [c for c in valores if c in RETENCIONES]
    if cfg.parametros.get("no_agrupar_si_retencion", True) and rets:
        menores_nit -= set(tabla.loc[tabla[rets].abs().sum(axis=1) > 0.5, "nit"])
    menores_nit.discard(cfg.nit_empresa)
    menores = tabla["nit"].isin(menores_nit)
    if not menores.any():
        return tabla
    nit_cm = cfg.parametros["cuantias_menores"]["nit"]
    agrupado = tabla[menores].groupby("concepto")[valores].sum().reset_index()
    agrupado["nit"] = nit_cm
    return pd.concat([tabla[~menores], agrupado], ignore_index=True)
