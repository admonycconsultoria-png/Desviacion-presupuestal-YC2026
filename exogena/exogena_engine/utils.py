"""Utilidades de normalización de texto y números."""
from __future__ import annotations

import math
import re
import unicodedata

import pandas as pd


def sin_tildes(texto: str) -> str:
    """Quita tildes conservando la Ñ (la DIAN la acepta en nombres)."""
    texto = texto.replace("ñ", "\0").replace("Ñ", "\1")
    texto = "".join(c for c in unicodedata.normalize("NFD", texto) if unicodedata.category(c) != "Mn")
    return texto.replace("\0", "ñ").replace("\1", "Ñ")


def clave(texto) -> str:
    """Clave de comparación: minúsculas, sin tildes, sin signos, espacios simples."""
    if texto is None or (isinstance(texto, float) and math.isnan(texto)):
        return ""
    t = sin_tildes(str(texto)).lower().replace("ñ", "n")
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def texto_dian(texto) -> str:
    """Texto en mayúsculas, sin tildes ni caracteres especiales que rechaza el prevalidador."""
    if texto is None or (isinstance(texto, float) and math.isnan(texto)):
        return ""
    t = sin_tildes(str(texto)).upper()
    t = re.sub(r"[^A-Z0-9Ñ #\-\.]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def solo_digitos(valor) -> str:
    if valor is None or (isinstance(valor, float) and math.isnan(valor)):
        return ""
    if isinstance(valor, float) and valor.is_integer():
        valor = int(valor)
    return re.sub(r"\D", "", str(valor))


def a_numero(valor) -> float:
    """Convierte '1.234.567,89', '1,234,567.89', '(1.000)', '-1000' o números a float."""
    if valor is None:
        return 0.0
    if isinstance(valor, (int, float)):
        return 0.0 if (isinstance(valor, float) and math.isnan(valor)) else float(valor)
    s = str(valor).strip().replace("$", "").replace(" ", "")
    if not s or s in {"-", "--"}:
        return 0.0
    negativo = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    if "," in s and "." in s:
        # el separador que aparece de último es el decimal
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        partes = s.split(",")
        s = s.replace(",", ".") if len(partes) == 2 and len(partes[1]) != 3 else s.replace(",", "")
    elif s.count(".") > 1 or (s.count(".") == 1 and len(s.split(".")[1]) == 3 and len(s.split(".")[0].lstrip("-")) <= 3):
        s = s.replace(".", "")
    try:
        n = float(s)
    except ValueError:
        return 0.0
    return -n if negativo else n


def leer_tabla(ruta: str) -> pd.DataFrame:
    """Lee CSV (detectando separador y codificación) o Excel, todo como texto."""
    ruta_l = str(ruta).lower()
    if ruta_l.endswith((".xlsx", ".xlsm", ".xls")):
        return pd.read_excel(ruta, dtype=str)
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(ruta, dtype=str, sep=None, engine="python", encoding=enc)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"No se pudo leer {ruta}")


def ubicar_encabezado(df: pd.DataFrame, alias: dict[str, list[str]]) -> pd.DataFrame:
    """Los exports traen títulos arriba de la tabla. Busca la fila que más alias contiene
    y la usa como encabezado."""
    todos = {clave(a) for lista in alias.values() for a in lista}
    actual = sum(clave(c) in todos for c in df.columns)
    mejor, mejor_i = actual, None
    for i in range(min(len(df), 30)):
        n = sum(clave(v) in todos for v in df.iloc[i].tolist())
        if n > mejor:
            mejor, mejor_i = n, i
    if mejor_i is None:
        return df
    nuevo = df.iloc[mejor_i + 1:].copy()
    nuevo.columns = [str(v) for v in df.iloc[mejor_i].tolist()]
    return nuevo.reset_index(drop=True)


def renombrar(df: pd.DataFrame, alias: dict[str, list[str]]) -> pd.DataFrame:
    """Renombra columnas del export a nombres canónicos según alias (primer alias que coincida)."""
    cols = {clave(c): c for c in df.columns}
    mapeo = {}
    for canonico, opciones in alias.items():
        for op in opciones:
            original = cols.get(clave(op))
            if original is not None and original not in mapeo:
                mapeo[original] = canonico
                break
    return df.rename(columns=mapeo)
