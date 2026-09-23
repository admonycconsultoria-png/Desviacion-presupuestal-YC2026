"""CLI:  python -m exogena_engine --fuente siigo --balance bal.xlsx --terceros ter.xlsx --salida out/"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from . import config as config_mod
from .exportar import escribir_formato, escribir_informe
from .externos import formato_1010, formato_2276
from .fuentes import cargar_balance, cargar_terceros
from .motor import construir_formato, generar_partidas
from .terceros import depurar
from .validaciones import cuadres, inconsistencias


def ejecutar(fuente: str, balance: str, terceros: str | None, salida: str,
             accionistas: str | None = None, nomina: str | None = None,
             config_dir: str | None = None, formatos: list[str] | None = None) -> dict:
    cfg = config_mod.cargar(config_dir or config_mod.CONFIG_DIR)
    if fuente not in cfg.fuentes:
        raise SystemExit(f"Fuente '{fuente}' no configurada. Opciones: {', '.join(cfg.fuentes)}")
    out = Path(salida)
    out.mkdir(parents=True, exist_ok=True)
    hallazgos: list = []

    bal = cargar_balance(balance, fuente, cfg, hallazgos)
    maestro = cargar_terceros(terceros, fuente, cfg)
    ter = depurar(bal, maestro, cfg, hallazgos)
    inconsistencias(bal, cfg, hallazgos)
    partidas = generar_partidas(bal, cfg, hallazgos)

    pedidos = formatos or list(cfg.formatos)
    generados: dict[str, pd.DataFrame] = {}
    for fmt in pedidos:
        modo = cfg.formatos[fmt]["modo"]
        if modo in ("por_tercero", "sin_tercero"):
            if fmt not in cfg.reglas:
                hallazgos.append(("ALERTA", "Formato sin reglas", fmt,
                                  f"{fmt} no tiene reglas en mapeo_cuentas.csv; no se generó"))
                continue
            generados[fmt] = construir_formato(fmt, partidas, ter, bal, cfg, hallazgos)
        elif fmt == "1010" and accionistas:
            generados[fmt] = formato_1010(accionistas, bal, cfg, hallazgos)
        elif fmt == "2276" and nomina:
            generados[fmt] = formato_2276(nomina, bal, cfg, hallazgos)
        else:
            hallazgos.append(("INFO", "Insumo externo no suministrado", fmt,
                              f"{fmt} requiere archivo adicional (--accionistas / --nomina)"))

    # Parámetros sin verificar que efectivamente se usaron
    for fmt in generados:
        if not cfg.formatos[fmt].get("verificado"):
            cfg.marcar_uso(f"Layout formato {fmt} v{cfg.formatos[fmt]['version']}")
        usados = set(generados[fmt]["concepto"]) if "concepto" in generados[fmt] else set()
        ok = set(cfg.conceptos.loc[(cfg.conceptos["formato"] == fmt) &
                                   (cfg.conceptos["verificado"].str.upper() == "SI"), "concepto"])
        for c in sorted(usados - ok - {""}):
            cfg.marcar_uso(f"Concepto {c} del formato {fmt}")
    if any(fmt != "1011" for fmt in generados) and not cfg.parametros["cuantias_menores"].get("verificado"):
        cfg.marcar_uso("NIT/tipo de documento de cuantías menores")

    rutas = [escribir_formato(fmt, df, cfg, out) for fmt, df in generados.items()]
    cua = cuadres(partidas, generados, cfg)
    informe = escribir_informe(out, cfg, hallazgos, cua, partidas, ter, generados)
    return {"formatos": rutas, "informe": informe, "hallazgos": hallazgos, "generados": generados,
            "cuadres": cua, "sin_verificar": cfg.sin_verificar_usados}


def main() -> None:
    ap = argparse.ArgumentParser(description="Generador de información exógena DIAN desde balance por tercero")
    ap.add_argument("--fuente", required=True, help="siigo | alegra | dataico | generico")
    ap.add_argument("--balance", required=True, help="Balance de prueba por tercero (xlsx/csv)")
    ap.add_argument("--terceros", help="Maestro de terceros (xlsx/csv)")
    ap.add_argument("--accionistas", help="Libro de accionistas para 1010 (xlsx/csv)")
    ap.add_argument("--nomina", help="Consolidado anual nómina electrónica para 2276 (xlsx/csv)")
    ap.add_argument("--salida", default="salida")
    ap.add_argument("--config", help="Carpeta de configuración alterna (por cliente)")
    ap.add_argument("--formatos", nargs="*", help="Solo estos formatos (ej. 1001 1007)")
    a = ap.parse_args()
    r = ejecutar(a.fuente, a.balance, a.terceros, a.salida, a.accionistas, a.nomina, a.config, a.formatos)

    niveles = pd.Series([h[0] for h in r["hallazgos"]]).value_counts().to_dict()
    print(f"Formatos: {', '.join(p.name for p in r['formatos'])}")
    print(f"Informe:  {r['informe']}")
    print(f"Hallazgos: {niveles}")
    if r["sin_verificar"]:
        print(f"Parámetros SIN VERIFICAR usados: {len(r['sin_verificar'])} (ver hoja 'Parametros sin verificar')")


if __name__ == "__main__":
    main()
