"""Carga de la parametrización (config/)."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import json

import pandas as pd
import yaml

from .prevalidador import campos_obligatorios, estado_columnas, longitud_minima_direccion
from .utils import clave

RAIZ = Path(__file__).resolve().parent.parent
CONFIG_DIR = RAIZ / "config"

BASES_VALIDAS = {"neto_deb", "neto_cred", "debito", "credito", "saldo_deb", "saldo_cred", "compras_netas",
                 # saldo de toda la cuenta asignado a un solo tercero (bancos, DIAN, fondos)
                 "saldo_deb_cuenta", "saldo_cred_cuenta"}


@dataclass
class Regla:
    formato: str
    prefijo: str
    concepto: str
    columna: str
    base: str
    notas: str
    tercero: str = ""   # "" = el del movimiento | "informante" | NIT fijo


@dataclass
class Config:
    parametros: dict
    formatos: dict
    reglas: dict[str, list[Regla]]
    conceptos: pd.DataFrame
    fuentes: dict
    tipos_doc: pd.DataFrame
    paises: pd.DataFrame
    divipola: pd.DataFrame
    prevalidadores: list = field(default_factory=list)
    sin_verificar_usados: set = field(default_factory=set)

    # ------------------------------------------------------------------ helpers
    @property
    def nit_empresa(self) -> str:
        return str(self.parametros["empresa"]["nit"])

    def nits_excluidos(self, formato: str) -> set[str]:
        ex = self.parametros.get("nits_excluidos", {}) or {}
        nits = list(ex.get("global", [])) + list(ex.get(formato, []) or [])
        return {self.nit_empresa if n == "{empresa}" else str(n) for n in nits}

    def tope(self, formato: str) -> float | None:
        """Tope de cuantías menores en pesos: uvt x UVT del año gravable (o `valor` fijo si se da)."""
        t = (self.parametros.get("topes") or {}).get(formato) or {}
        if t.get("valor"):
            return float(t["valor"])
        if not t.get("uvt"):
            return None
        uvt = (self.parametros.get("uvt") or {}).get(int(self.parametros["anio_gravable"]))
        if not uvt:
            raise ValueError(f"No hay valor de UVT para el año {self.parametros['anio_gravable']} en parametros.uvt")
        return float(t["uvt"]) * float(uvt)

    def tercero_fijo(self, valor: str) -> str:
        v = str(valor or "").strip()
        return self.nit_empresa if v == "informante" else "".join(c for c in v if c.isdigit())

    def columnas(self, formato: str) -> list[tuple[str, str]]:
        return self.formatos[formato]["columnas"]

    def regla_para(self, formato: str, cuenta: str) -> Regla | None:
        """Prefijo más largo gana."""
        mejor = None
        for r in self.reglas.get(formato, []):
            if cuenta.startswith(r.prefijo) and (mejor is None or len(r.prefijo) > len(mejor.prefijo)):
                mejor = r
        return mejor

    def marcar_uso(self, etiqueta: str) -> None:
        self.sin_verificar_usados.add(etiqueta)


def _aplanar(columnas: list) -> list[tuple[str, str]]:
    salida = []
    for c in columnas:
        if c and isinstance(c[0], list):
            salida.extend(tuple(x) for x in c)
        else:
            salida.append(tuple(c))
    return salida


def cargar(config_dir: Path | str = CONFIG_DIR) -> Config:
    d = Path(config_dir)
    parametros = yaml.safe_load((d / "parametros.yaml").read_text(encoding="utf-8"))
    formatos_raw = yaml.safe_load((d / "formatos.yaml").read_text(encoding="utf-8"))
    formatos = {k: v for k, v in formatos_raw.items() if not k.startswith("_")}
    anio = int(parametros.get("anio_gravable", 0))
    for f in formatos.values():
        f["columnas"] = _aplanar(f["columnas"])
        f["version"] = (f.get("version_por_anio") or {}).get(anio, f["version"])
    # Orden de columnas: se verifica contra los prevalidadores DIAN guardados de la misma versión
    prevalidadores = cargar_prevalidadores(d)
    for k, f in formatos.items():
        f["verificacion_columnas"] = estado_columnas(k, f, prevalidadores)
        f["columnas_verificadas"] = f["verificacion_columnas"]["verificado"]
        f["obligatorios"] = campos_obligatorios(k, f, prevalidadores)
        f["direccion_minima"] = longitud_minima_direccion(k, f, prevalidadores)

    mapeo = pd.read_csv(d / "mapeo_cuentas.csv", dtype=str, comment="#").fillna("")
    if "tercero" not in mapeo.columns:
        mapeo["tercero"] = ""
    reglas: dict[str, list[Regla]] = {}
    for _, r in mapeo.iterrows():
        regla = Regla(r.formato.strip(), r.prefijo.strip(), r.concepto.strip(),
                      r.columna.strip(), r.base.strip(), r.notas.strip(), r.tercero.strip())
        if regla.concepto != "EXCLUIR" and regla.base not in BASES_VALIDAS:
            raise ValueError(f"Base inválida en mapeo_cuentas.csv: {regla}")
        if regla.formato not in formatos:
            raise ValueError(f"Formato desconocido en mapeo_cuentas.csv: {regla.formato}")
        if regla.concepto != "EXCLUIR":
            campos = {c for c, _ in formatos[regla.formato]["columnas"]}
            if regla.columna not in campos:
                raise ValueError(f"Columna '{regla.columna}' no existe en formato {regla.formato}")
        reglas.setdefault(regla.formato, []).append(regla)

    fuentes = yaml.safe_load((d / "fuentes.yaml").read_text(encoding="utf-8"))
    fuentes = {k: v for k, v in fuentes.items() if not k.startswith("alias_")}

    tipos = pd.read_csv(d / "tipos_documento.csv", dtype=str).fillna("")
    paises = pd.read_csv(d / "paises.csv", dtype=str).fillna("")
    divipola = pd.read_csv(d / "divipola.csv", dtype=str).fillna("")
    divipola["k_mpio"] = divipola["municipio"].map(clave)
    divipola["k_dpto"] = divipola["departamento"].map(clave)

    return Config(parametros, formatos, reglas,
                  pd.read_csv(d / "conceptos.csv", dtype=str).fillna(""),
                  fuentes, tipos, paises, divipola, prevalidadores)


def cargar_prevalidadores(d: Path) -> list[dict]:
    """Layouts de los prevalidadores DIAN guardados (solo nombre, versión y columnas por formato)."""
    carpeta = Path(d) / "prevalidadores"
    if not carpeta.exists():
        carpeta = CONFIG_DIR / "prevalidadores"
    salida = []
    for ruta in sorted(carpeta.glob("*.json")) if carpeta.exists() else []:
        p = json.loads(ruta.read_text(encoding="utf-8"))
        salida.append({"nombre": p["nombre"], "formatos": {k: {"version": v["version"], "columnas": v["columnas"]}
                                                           for k, v in p["formatos"].items()}})
    return salida
