"""Facturas electrónicas DIAN (UBL 2.1) como fuente de datos de terceros.

Cada factura, nota crédito o nota débito trae al emisor (AccountingSupplierParty) y al adquirente
(AccountingCustomerParty) con los datos que validó la DIAN: NIT, DV, tipo de documento, razón social,
dirección y código DIVIPOLA del municipio. Se usan para completar el maestro de terceros, sin tocar lo
que el maestro ya trae bien.

Se aceptan .xml sueltos, .zip (XML + PDF, como llegan al correo de recepción) y el AttachedDocument
que envuelve la factura en un CDATA.
"""
from __future__ import annotations

import io
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import pandas as pd

from .utils import clave, solo_digitos, texto_dian

ROLES = (("AccountingSupplierParty", "emisor"), ("AccountingCustomerParty", "adquirente"))
CAMPOS = ["nit", "dv", "tipo_documento", "tipo_persona", "razon_social", "primer_apellido", "segundo_apellido",
          "primer_nombre", "otros_nombres", "direccion", "ciudad", "departamento", "codigo_municipio_dane",
          "pais", "fuente"]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _hijo(el, nombre: str):
    return next((h for h in el if _local(h.tag) == nombre), None) if el is not None else None


def _desc(el, nombre: str):
    return next((h for h in el.iter() if _local(h.tag) == nombre), None) if el is not None else None


def _txt(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def _direccion(addr) -> dict:
    if addr is None:
        return {}
    linea = _hijo(addr, "AddressLine")
    return {"direccion": " ".join(_txt(l) for l in (linea if linea is not None else []) if _local(l.tag) == "Line"),
            "ciudad": _txt(_hijo(addr, "CityName")), "departamento": _txt(_hijo(addr, "CountrySubentity")),
            "codigo_municipio_dane": solo_digitos(_txt(_hijo(addr, "ID"))),
            "pais": _txt(_hijo(_hijo(addr, "Country"), "IdentificationCode"))}


def _parte(party, fuente: str) -> dict | None:
    tax = _desc(party, "PartyTaxScheme")
    legal = _desc(party, "PartyLegalEntity")
    cid = _hijo(tax, "CompanyID") if tax is not None else None
    if cid is None or not _txt(cid):
        cid = _hijo(legal, "CompanyID") if legal is not None else None
    nit = solo_digitos(_txt(cid))
    if not nit:
        return None
    razon = _txt(_hijo(tax, "RegistrationName")) or _txt(_hijo(legal, "RegistrationName")) \
        or _txt(_desc(_hijo(party, "PartyName"), "Name"))
    # Dirección del RUT (RegistrationAddress) antes que la física: algunos proveedores tecnológicos ponen la
    # razón social en la línea de la dirección física.
    candidatas = [_direccion(_hijo(tax, "RegistrationAddress")) if tax is not None else {},
                  _direccion(_hijo(_hijo(party, "PhysicalLocation"), "Address"))]
    candidatas = [c for c in candidatas if c]
    buenas = [c for c in candidatas if c.get("direccion") and clave(c["direccion"]) != clave(razon)]
    ubic = (buenas or candidatas or [{}])[0]
    if ubic.get("direccion") and clave(ubic["direccion"]) == clave(razon):
        ubic = {**ubic, "direccion": ""}
    persona = _desc(party, "Person")
    return {
        "nit": nit, "dv": solo_digitos(cid.attrib.get("schemeID", "")), "tipo_documento": cid.attrib.get("schemeName", ""),
        "tipo_persona": "", "razon_social": texto_dian(razon),
        "primer_apellido": texto_dian(_txt(_hijo(persona, "FamilyName"))) if persona is not None else "",
        "segundo_apellido": "",
        "primer_nombre": texto_dian(_txt(_hijo(persona, "FirstName"))) if persona is not None else "",
        "otros_nombres": texto_dian(_txt(_hijo(persona, "MiddleName"))) if persona is not None else "",
        **{k: ubic.get(k, "") for k in ("direccion", "ciudad", "departamento", "codigo_municipio_dane", "pais")},
        "fuente": fuente,
    }


def leer_xml(texto: bytes | str, nombre: str = "") -> list[dict]:
    """Terceros (emisor y adquirente) de un documento UBL. Devuelve [] si no es una factura o nota."""
    try:
        raiz = ET.fromstring(texto)
    except ET.ParseError:
        return []
    if _local(raiz.tag) == "AttachedDocument":
        interno = _desc(_desc(raiz, "ExternalReference"), "Description")
        return leer_xml(_txt(interno).encode("utf-8"), nombre) if interno is not None else []
    if _local(raiz.tag) not in ("Invoice", "CreditNote", "DebitNote"):
        return []
    numero = _txt(_hijo(raiz, "ID")) or nombre
    salida = []
    for rol, etiqueta in ROLES:
        cont = _hijo(raiz, rol)
        party = _hijo(cont, "Party")
        if party is None:
            continue
        t = _parte(party, f"FE {numero} ({etiqueta})")
        if t:
            tipo = _txt(_hijo(cont, "AdditionalAccountID"))
            t["tipo_persona"] = {"1": "juridica", "2": "natural"}.get(tipo, "")
            salida.append(t)
    return salida


def leer_facturas(rutas: list[str | Path]) -> list[dict]:
    """Lee .xml y .zip (también carpetas con ellos)."""
    salida = []
    archivos = []
    for r in rutas:
        p = Path(r)
        archivos.extend(sorted(p.rglob("*")) if p.is_dir() else [p])
    for p in archivos:
        if p.suffix.lower() == ".xml":
            salida.extend(leer_xml(p.read_bytes(), p.name))
        elif p.suffix.lower() == ".zip":
            with zipfile.ZipFile(p) as z:
                for n in z.namelist():
                    if n.lower().endswith(".xml"):
                        salida.extend(leer_xml(z.read(n), n))
    return salida


def _direccion_valida(d: str, divipola_mpios: set[str]) -> bool:
    return len(texto_dian(d)) >= 8 and clave(d) not in divipola_mpios


def completar_maestro(maestro: pd.DataFrame, balance: pd.DataFrame, registros: list[dict],
                      cfg, hallazgos: list) -> pd.DataFrame:
    """Completa el maestro con las facturas: solo campos vacíos, y la dirección si es inválida (menos de
    8 caracteres o el nombre de un municipio). Agrega los terceros del balance que no están en el maestro."""
    if not registros:
        return maestro
    usados = set(balance["nit"]) - {""}
    mpios = set(cfg.divipola["k_mpio"])
    mejor: dict[str, dict] = {}
    for r in registros:
        if r["nit"] not in usados:
            continue
        previo = mejor.get(r["nit"])
        puntos = (bool(r["direccion"]) and _direccion_valida(r["direccion"], mpios)) * 2 + bool(r["codigo_municipio_dane"])
        if previo is None or puntos > previo[0]:
            mejor[r["nit"]] = (puntos, r)
    if not mejor:
        return maestro
    m = maestro.copy()
    for c in CAMPOS[:-1]:
        if c not in m.columns:
            m[c] = ""
    m = m.fillna("")
    cambios: dict[str, list[str]] = {}
    for i, fila in m.iterrows():
        par = mejor.get(fila["nit"])
        if not par:
            continue
        fe = par[1]
        hechos = []
        for c in ("dv", "tipo_documento", "tipo_persona", "razon_social", "primer_apellido", "primer_nombre",
                  "otros_nombres", "pais"):
            if not str(fila[c]).strip() and fe[c]:
                m.at[i, c] = fe[c]
                hechos.append(c)
        if fe["direccion"] and _direccion_valida(fe["direccion"], mpios) \
                and not _direccion_valida(str(fila["direccion"]), mpios):
            m.at[i, "direccion"] = fe["direccion"]
            hechos.append("direccion")
        if fe["codigo_municipio_dane"] and not solo_digitos(str(fila["codigo_municipio_dane"])):
            m.at[i, "codigo_municipio_dane"] = fe["codigo_municipio_dane"]
            m.at[i, "ciudad"], m.at[i, "departamento"] = fe["ciudad"], fe["departamento"]
            hechos.append("municipio")
        if hechos:
            cambios[fila["nit"]] = hechos
    nuevos = [par[1] for nit, par in mejor.items() if nit not in set(m["nit"])]
    if nuevos:
        m = pd.concat([m, pd.DataFrame([{c: r[c] for c in CAMPOS[:-1]} for r in nuevos])], ignore_index=True)
        for r in nuevos:
            cambios[r["nit"]] = ["tercero completo"]
    for nit, hechos in cambios.items():
        hallazgos.append(("INFO", "Completado con factura electrónica", nit,
                          f"{', '.join(hechos)} tomados de {mejor[nit][1]['fuente']}"))
    return m
