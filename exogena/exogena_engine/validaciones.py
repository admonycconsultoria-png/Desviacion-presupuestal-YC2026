"""Cuadres formato vs. balance y análisis de inconsistencias contables."""
from __future__ import annotations

import pandas as pd

from .config import Config


def cuadres(partidas: pd.DataFrame, generados: dict[str, pd.DataFrame], cfg: Config) -> pd.DataFrame:
    """Por formato y columna: total según reglas en el balance vs total en el archivo,
    explicando la diferencia (NIT excluidos, sin tercero, negativos llevados a cero)."""
    tol = cfg.parametros["validacion"]["tolerancia_cuadre"]
    filas = []
    for (fmt, col), g in partidas.groupby(["formato", "columna"]):
        if fmt not in generados:
            continue
        total = g["valor"].sum()
        excl = g.loc[g["descartado"] == "nit_excluido", "valor"].sum()
        sin_t = g.loc[g["descartado"] == "sin_tercero", "valor"].sum()
        en_archivo = generados[fmt][col].sum() if col in generados[fmt] else 0
        validas = g[g["descartado"] == ""]
        por_linea = validas.groupby(["concepto", "nit"])["valor"].sum()
        negativos = por_linea[por_linea < -0.5].sum()
        no_explicado = total - excl - sin_t - negativos - en_archivo
        filas.append({
            "formato": fmt, "columna": col, "total_balance_segun_reglas": round(total),
            "excluido_por_nit": round(excl), "sin_tercero": round(sin_t),
            "negativos_llevados_a_cero": round(negativos),
            "total_en_formato": round(en_archivo),
            "diferencia_no_explicada": round(no_explicado),
            "estado": "OK" if abs(no_explicado) <= tol else "REVISAR",
        })
    return pd.DataFrame(filas)


def inconsistencias(balance: pd.DataFrame, cfg: Config, hallazgos: list) -> None:
    val = cfg.parametros["validacion"]

    # 1. Cuentas de resultado sin regla en 1001/1007 (gasto o ingreso que no se reporta en ninguna parte)
    for cuenta, g in balance.groupby("cuenta"):
        mov = g["debito"].sum() + g["credito"].sum()
        if mov == 0:
            continue
        if cuenta[0] in "567" and cfg.regla_para("1001", cuenta) is None:
            hallazgos.append(("ALERTA", "Cuenta sin parametrizar", cuenta,
                              f"Gasto/costo {cuenta} sin regla en 1001 (mov. ${mov:,.0f})"))
        if cuenta[0] == "4" and cfg.regla_para("1007", cuenta) is None:
            hallazgos.append(("ALERTA", "Cuenta sin parametrizar", cuenta, f"Ingreso {cuenta} sin regla en 1007"))

    # 2. ¿Balance exportado con el comprobante de cierre?
    res = balance[balance["cuenta"].str[0].isin(list("4567"))]
    if not res.empty:
        mov = res["debito"].sum() + res["credito"].sum()
        saldo = res["saldo_final"].abs().sum()
        if mov > 0 and saldo / mov < 0.01:
            hallazgos.append(("ERROR", "Cierre incluido", "",
                              "Las cuentas de resultado quedan en cero: el balance parece incluir el comprobante "
                              "de cierre. Exportarlo excluyéndolo o los valores netos saldrán en cero"))

    # 3. Débitos en ingresos (anulaciones mal hechas / notas crédito en la cuenta equivocada)
    ing = balance[balance["cuenta"].str.match(r"^4[12]") & ~balance["cuenta"].str.startswith("4175")]
    if ing["credito"].sum() > 0:
        pct = ing["debito"].sum() / ing["credito"].sum() * 100
        if pct > val["alerta_debitos_ingresos_pct"]:
            hallazgos.append(("ALERTA", "Débitos en ingresos", "",
                              f"Débitos en 41/42 = {pct:.1f}% de los créditos: revisar si son devoluciones "
                              f"que debían ir a 4175 (afecta columna de devoluciones del 1007)"))

    # 4. Naturaleza contraria en CxC y CxP
    for pref, esperado, nombre in (("13", 1, "CxC con saldo crédito"), ("22", -1, "Proveedores con saldo débito"),
                                   ("23", -1, "CxP con saldo débito")):
        g = balance[balance["cuenta"].str.startswith(pref) & ~balance["cuenta"].str.match(r"^236[578]")]
        malos = g[g["saldo_final"] * esperado < -1000]
        for r in malos.itertuples():
            hallazgos.append(("ALERTA", nombre, r.nit or r.cuenta,
                              f"Cuenta {r.cuenta} saldo {r.saldo_final:,.0f}: reclasificar antes de 1008/1009"))

    # 5. Cuadre del balance
    dif = balance["debito"].sum() - balance["credito"].sum()
    if abs(dif) > 1:
        hallazgos.append(("ERROR", "Balance descuadrado", "", f"Débitos - créditos = {dif:,.2f}"))
