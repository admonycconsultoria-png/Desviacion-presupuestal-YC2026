"""Depuración de la base de terceros: tipo de documento, DV, nombres, DIVIPOLA y hallazgos."""
from __future__ import annotations

import re

import pandas as pd

from .config import Config
from .dv import calcular_dv
from .utils import clave, solo_digitos, texto_dian

PARTICULAS = {"DE", "DEL", "LA", "LAS", "LOS", "SAN", "SANTA", "VAN", "VON", "Y"}
NITS_GENERICOS = {"222222222", "999999999", "111111111", "0", "1", "123456789"}
SUFIJOS_JURIDICA = ("SAS", "S A S", "LTDA", "S A", "SA", "E U", "EU", "S EN C", "SCA", "ESP", "E S P",
                    "CORP", "BIC")
PREFIJOS_JURIDICA = ("BANCO", "FONDO", "FUNDACION", "ASOCIACION", "COOPERATIVA", "CORPORACION",
                     "CAJA DE COMPENSACION", "EPS", "UNIVERSIDAD", "COLEGIO", "CLINICA", "MUNICIPIO",
                     "DEPARTAMENTO", "DIRECCION DE IMPUESTOS")


def _es_juridica_por_nombre(nombre: str) -> bool:
    n = " " + re.sub(r"[.\s]+", " ", texto_dian(nombre)).strip() + " "
    return any(f" {s} " in n for s in SUFIJOS_JURIDICA) or n.strip().startswith(PREFIJOS_JURIDICA)


def _tipo_documento(valor: str, cfg: Config) -> str:
    v = texto_dian(valor)
    if not v:
        return ""
    if solo_digitos(v) == v and v in set(cfg.tipos_doc["codigo"]):
        return v
    for _, t in cfg.tipos_doc.iterrows():
        if v in t["alias"].split("|") or clave(v) == clave(t["descripcion"]):
            return t["codigo"]
    return ""


def _agrupar_particulas(tokens: list[str]) -> list[str]:
    salida, pendiente = [], []
    for t in tokens:
        if t in PARTICULAS:
            pendiente.append(t)
        else:
            salida.append(" ".join(pendiente + [t]))
            pendiente = []
    if pendiente:
        salida.append(" ".join(pendiente))
    return salida


def partir_nombre(nombre: str, orden: str) -> tuple[dict, bool]:
    """Devuelve ({primer_apellido,...}, es_heuristico_ambiguo)."""
    tokens = _agrupar_particulas(texto_dian(nombre).split())
    ap1 = ap2 = n1 = n2 = ""
    ambiguo = len(tokens) not in (2, 4)
    if orden == "apellidos_nombres":
        if len(tokens) >= 4:
            ap1, ap2, n1, n2 = tokens[0], tokens[1], tokens[2], " ".join(tokens[3:])
        elif len(tokens) == 3:
            ap1, ap2, n1 = tokens
        elif len(tokens) == 2:
            ap1, n1 = tokens
        elif tokens:
            ap1 = tokens[0]
    else:
        if len(tokens) >= 4:
            n1, n2, ap1, ap2 = tokens[0], " ".join(tokens[1:-2]), tokens[-2], tokens[-1]
        elif len(tokens) == 3:
            n1, ap1, ap2 = tokens
        elif len(tokens) == 2:
            n1, ap1 = tokens
        elif tokens:
            ap1 = tokens[0]
    return {"primer_apellido": ap1, "segundo_apellido": ap2, "primer_nombre": n1, "otros_nombres": n2}, ambiguo


def _ubicar(ciudad: str, dpto: str, cod_dane: str, cfg: Config) -> tuple[str, str]:
    cod = solo_digitos(cod_dane)
    if len(cod) == 5:
        return cod[:2], cod[2:]
    if len(cod) == 4:          # Excel se come el cero de Antioquia/Atlántico: 5001 -> 05001
        cod = "0" + cod
        return cod[:2], cod[2:]
    k = clave(ciudad)
    if not k:
        return "", ""
    dv = cfg.divipola
    cand = dv[(dv["k_mpio"] == k) | dv["k_mpio"].map(lambda m: k.startswith(m + " "))]
    if len(cand) > 1 and dpto:
        kd = clave(dpto)
        f = cand[cand["k_dpto"].map(lambda d: d == kd or kd.startswith(d) or d.startswith(kd))]
        cand = f if not f.empty else cand
    if len(cand) >= 1:
        fila = cand.iloc[0]
        return fila["codigo_departamento"], fila["codigo_municipio"]
    return "", ""


def _pais(valor: str, tiene_mpio: bool, cfg: Config) -> str:
    v = texto_dian(valor)
    if not v:
        return "169"  # sin país en el maestro se asume Colombia
    if solo_digitos(v) == v:
        return v.zfill(3)
    for _, p in cfg.paises.iterrows():
        if v == p["nombre"] or v in p["alias"].split("|"):
            return p["codigo"]
    return ""


def depurar(balance: pd.DataFrame, maestro: pd.DataFrame, cfg: Config, hallazgos: list) -> pd.DataFrame:
    """Construye la tabla única de terceros (una fila por NIT) lista para los formatos."""
    orden = cfg.parametros.get("validacion", {}).get("orden_nombre_completo", "apellidos_nombres")

    # Nombres vistos en el balance por NIT (para detectar el mismo NIT con nombres distintos)
    nombres_balance = (balance[balance["nit"] != ""].groupby("nit")["nombre_tercero"]
                       .agg(lambda s: sorted({texto_dian(x) for x in s if str(x).strip()})))
    dv_balance = balance[balance["dv_fuente"] != ""].groupby("nit")["dv_fuente"].first()

    maestro = maestro.copy()
    dup_maestro = maestro[maestro.duplicated("nit", keep=False)]
    for nit, g in dup_maestro.groupby("nit"):
        hallazgos.append(("ALERTA", "Duplicado en maestro", nit,
                          f"NIT repetido {len(g)} veces en el maestro de terceros; se usa el primero"))
    maestro = maestro.drop_duplicates("nit").set_index("nit")

    nits = sorted(set(balance.loc[balance["nit"] != "", "nit"]))
    cm = cfg.parametros["cuantias_menores"]
    emp = cfg.parametros["empresa"]
    filas = []
    for nit in nits:
        if nit == cm["nit"]:
            hallazgos.append(("ERROR", "NIT genérico", nit,
                              "Se contabilizó con el NIT de cuantías menores; la agrupación la hace el motor, "
                              "reclasificar al tercero real"))
            filas.append({"nit": nit, "tipo_documento": cm["tipo_documento"], "numero_identificacion": nit,
                          "dv": "", "persona": "juridica", "primer_apellido": "", "segundo_apellido": "",
                          "primer_nombre": "", "otros_nombres": "", "razon_social": cm["razon_social"],
                          "direccion": texto_dian(emp.get("direccion", "")),
                          "codigo_departamento": emp.get("codigo_departamento", ""),
                          "codigo_municipio": emp.get("codigo_municipio", ""), "pais": "169"})
            continue
        m = maestro.loc[nit] if nit in maestro.index else None
        get = (lambda c: str(m[c]).strip()) if m is not None else (lambda c: "")
        if m is None:
            hallazgos.append(("ALERTA", "Tercero sin maestro", nit,
                              "Aparece en el balance pero no en el maestro de terceros: sin dirección ni ubicación"))

        nombre_bal = (nombres_balance.get(nit) or [""])[0]
        if len(nombres_balance.get(nit) or []) > 1:
            hallazgos.append(("ALERTA", "Mismo NIT, nombres distintos", nit,
                              " | ".join(nombres_balance[nit])))
        razon = texto_dian(get("razon_social")) or nombre_bal

        if nit in NITS_GENERICOS:
            hallazgos.append(("ERROR", "NIT genérico", nit,
                              f"'{razon}' usa un NIT genérico en la contabilidad; reclasificar al tercero real"))

        tipo = _tipo_documento(get("tipo_documento"), cfg)
        juridica_nombre = _es_juridica_por_nombre(razon)
        tp = clave(get("tipo_persona"))
        if "juridic" in tp:
            juridica = True
        elif "natural" in tp:
            juridica = False
        else:
            juridica = juridica_nombre or (len(nit) == 9 and nit[0] in "89")
        if not tipo:
            tipo = "31" if juridica else "13"
            hallazgos.append(("INFO", "Tipo de documento inferido", nit,
                              f"Sin tipo en maestro; se asignó {tipo}"))
        if juridica and tipo != "31":
            hallazgos.append(("ERROR", "Tipo documento incoherente", nit,
                              f"'{razon}' parece persona jurídica pero tiene tipo {tipo}"))

        # ---- DV
        dv_fuente = solo_digitos(get("dv")) or dv_balance.get(nit, "")
        dv_calc = ""
        if tipo == "31":
            try:
                dv_calc = str(calcular_dv(nit))
            except ValueError as e:
                hallazgos.append(("ERROR", "NIT inválido", nit, str(e)))
            if dv_fuente and dv_calc and dv_fuente != dv_calc:
                hallazgos.append(("ERROR", "DV errado", nit,
                                  f"DV registrado {dv_fuente}, DV correcto {dv_calc}"))
        # NIT con DV pegado: 9001234568 (10 dígitos) donde el último = DV de los 9 primeros
        if len(nit) == 10 and nit[0] in "89":
            try:
                if str(calcular_dv(nit[:9])) == nit[-1]:
                    hallazgos.append(("ERROR", "NIT con DV pegado", nit,
                                      f"Probablemente es {nit[:9]}-{nit[-1]}"))
            except ValueError:
                pass
        if tipo in ("13", "31") and not (5 <= len(nit) <= 10):
            hallazgos.append(("ERROR", "Longitud de identificación", nit, f"{len(nit)} dígitos"))

        # ---- Nombres
        if tipo == "31" and juridica:
            nom = {"primer_apellido": "", "segundo_apellido": "", "primer_nombre": "", "otros_nombres": ""}
            razon_out = razon
        else:
            separados = {k: texto_dian(get(k)) for k in ("primer_apellido", "segundo_apellido",
                                                         "primer_nombre", "otros_nombres")}
            if separados["primer_apellido"] and separados["primer_nombre"]:
                nom = separados
            else:
                nom, ambiguo = partir_nombre(razon, orden)
                if ambiguo:
                    hallazgos.append(("ALERTA", "Nombre partido por heurística", nit,
                                      f"'{razon}' -> {nom['primer_apellido']} / {nom['segundo_apellido']} / "
                                      f"{nom['primer_nombre']} / {nom['otros_nombres']}"))
            razon_out = ""
            if not nom["primer_apellido"] or not nom["primer_nombre"]:
                hallazgos.append(("ERROR", "Nombre incompleto", nit,
                                  "Persona natural sin primer apellido o primer nombre"))

        # ---- Ubicación
        dpto, mpio = _ubicar(get("ciudad"), get("departamento"), get("codigo_municipio_dane"), cfg)
        pais = _pais(get("pais"), bool(mpio), cfg)
        if pais == "169" and not mpio:
            hallazgos.append(("ALERTA", "Municipio no identificado", nit,
                              f"Ciudad '{get('ciudad')}' / dpto '{get('departamento')}' no se encontró en DIVIPOLA"))
        if not pais:
            hallazgos.append(("ERROR", "País no identificado", nit, f"'{get('pais')}' no está en config/paises.csv"))
        direccion = texto_dian(get("direccion"))
        if not direccion and m is not None:
            hallazgos.append(("ALERTA", "Sin dirección", nit, "Requerida en 1001/1003/1008/1009/1010"))

        filas.append({
            "nit": nit, "tipo_documento": tipo, "numero_identificacion": nit,
            "dv": dv_calc or dv_fuente, "persona": "juridica" if juridica else "natural",
            **nom, "razon_social": razon_out, "direccion": direccion,
            "codigo_departamento": dpto, "codigo_municipio": mpio, "pais": pais,
        })

    terceros = pd.DataFrame(filas)
    if not terceros.empty:
        # Posibles duplicados: mismo nombre, NIT distinto
        terceros["_k"] = (terceros["razon_social"] + " " + terceros["primer_apellido"] + " " +
                          terceros["segundo_apellido"] + " " + terceros["primer_nombre"]).map(clave)
        for k, g in terceros[terceros["_k"] != ""].groupby("_k"):
            if len(g) > 1:
                hallazgos.append(("ALERTA", "Posible tercero duplicado", ", ".join(g["nit"]),
                                  f"Mismo nombre '{k.upper()}' con {len(g)} identificaciones"))
        terceros = terceros.drop(columns="_k")
    return terceros.set_index("nit", drop=False) if not terceros.empty else terceros
