"""Empaqueta el aplicativo offline en UN solo archivo HTML.

    python app/construir.py            -> app/dist/Exogena_YC.html

Toma la parametrización por defecto de config/ (única fuente de verdad), el motor JS,
la interfaz y la librería SheetJS, y los incrusta en el HTML. El archivo resultante
funciona sin internet y no envía datos a ningún servidor.
"""
from __future__ import annotations

import json
import sys

import yaml
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI.parent))

from exogena_engine import config as config_mod  # noqa: E402


def _yaml_opcional(d: Path, nombre: str, defecto):
    ruta = d / nombre
    if not ruta.exists():
        ruta = config_mod.CONFIG_DIR / nombre
    return yaml.safe_load(ruta.read_text(encoding="utf-8")) if ruta.exists() else defecto


def _doctrina(d: Path) -> dict:
    ruta = d / "doctrina.yaml"
    if not ruta.exists():
        ruta = config_mod.CONFIG_DIR / "doctrina.yaml"
    return yaml.safe_load(ruta.read_text(encoding="utf-8")) if ruta.exists() else {"criterios": []}


def config_por_defecto(config_dir: Path | str | None = None) -> dict:
    cfg = config_mod.cargar(config_dir or config_mod.CONFIG_DIR)
    formatos = {}
    for k, f in cfg.formatos.items():
        formatos[k] = {**f, "columnas": [list(c) for c in f["columnas"]]}
    reglas = [r.__dict__ for rs in cfg.reglas.values() for r in rs]
    divipola = cfg.divipola.drop(columns=["k_mpio", "k_dpto"]).to_dict("records")
    return {
        "parametros": cfg.parametros,
        "formatos": formatos,
        "reglas": reglas,
        "conceptos": cfg.conceptos.to_dict("records"),
        "fuentes": cfg.fuentes,
        "tiposDoc": cfg.tipos_doc.to_dict("records"),
        "paises": cfg.paises.to_dict("records"),
        "divipola": divipola,
        "prevalidadores": cfg.prevalidadores,
        "doctrina": _doctrina(Path(config_dir or config_mod.CONFIG_DIR)),
        "plantillaNomina": _yaml_opcional(Path(config_dir or config_mod.CONFIG_DIR), "plantilla_nomina.yaml", {"columnas": []})["columnas"],
        "criterios": _yaml_opcional(Path(config_dir or config_mod.CONFIG_DIR), "criterios.yaml", {"criterios": []})["criterios"],
    }


def main() -> Path:
    plantilla = (AQUI / "plantilla.html").read_text(encoding="utf-8")
    partes = {
        "/*__XLSX__*/": (AQUI / "vendor" / "xlsx.full.min.js").read_text(encoding="utf-8"),
        "/*__MOTOR__*/": (AQUI / "motor.js").read_text(encoding="utf-8"),
        "/*__UI__*/": (AQUI / "ui.js").read_text(encoding="utf-8"),
        "/*__CONFIG__*/": "window.CONFIG_DEFECTO = " + json.dumps(config_por_defecto(), ensure_ascii=False) + ";",
    }
    for marca, contenido in partes.items():
        assert marca in plantilla, marca
        # </script> dentro de un script rompe el HTML
        plantilla = plantilla.replace(marca, contenido.replace("</script", "<\\/script"))
    dist = AQUI / "dist"
    dist.mkdir(exist_ok=True)
    salida = dist / "Exogena_YC.html"
    salida.write_text(plantilla, encoding="utf-8")
    print(f"{salida} ({salida.stat().st_size / 1024:.0f} KB)")
    return salida


if __name__ == "__main__":
    main()
