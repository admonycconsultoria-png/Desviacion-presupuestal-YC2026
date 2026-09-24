"""Dígito de verificación DIAN (módulo 11 con pesos primos)."""
from __future__ import annotations

PESOS = (3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71)


def calcular_dv(nit: str) -> int:
    digitos = "".join(ch for ch in str(nit) if ch.isdigit())
    if not digitos or len(digitos) > len(PESOS):
        raise ValueError(f"NIT inválido para cálculo de DV: {nit!r}")
    suma = sum(int(d) * PESOS[i] for i, d in enumerate(reversed(digitos)))
    residuo = suma % 11
    return residuo if residuo in (0, 1) else 11 - residuo


def separar_dv(valor: str) -> tuple[str, str | None]:
    """'900123456-8' -> ('900123456', '8'). Si no hay guion no adivina el DV."""
    s = str(valor).strip()
    if "-" in s:
        base, _, dv = s.rpartition("-")
        base_d = "".join(c for c in base if c.isdigit())
        dv_d = "".join(c for c in dv if c.isdigit())
        if base_d and len(dv_d) == 1:
            return base_d, dv_d
    return "".join(c for c in s if c.isdigit()), None
