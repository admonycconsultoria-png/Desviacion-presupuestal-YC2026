"""Genera un caso de prueba estilo Siigo con errores sembrados a propósito.

Errores sembrados (el motor debe encontrarlos todos):
  - 830045123 tiene DV 1 registrado (el correcto es otro)
  - 8605012347 es un NIT con el DV pegado
  - 'JUAN CARLOS PEREZ GOMEZ' aparece con dos cédulas distintas
  - 222222222 usado en la contabilidad como tercero
  - Honorarios 511025 con $1.500.000 sin tercero
  - Tercero 79555111 sin ciudad ni dirección
  - Cliente 900777888 con saldo crédito (anticipo mal clasificado)
"""
from pathlib import Path

import pandas as pd

AQUI = Path(__file__).parent

# cuenta, nombre cuenta, nit, nombre tercero, saldo_ini, debito, credito
MOV = [
    ("110505", "Caja general", "", "", 1_000_000, 5_000_000, 4_000_000),
    ("111005", "Bancos nacionales", "860034313", "BANCO DAVIVIENDA SA", 20_000_000, 480_000_000, 450_000_000),
    ("130505", "Clientes nacionales", "890900608", "ALMACENES EXITO SA", 0, 250_000_000, 200_000_000),
    ("130505", "Clientes nacionales", "900777888", "COMERCIALIZADORA ANDINA SAS", 0, 5_000_000, 7_000_000),
    ("130505", "Clientes nacionales", "1020304050", "MARIA FERNANDA LOPEZ RUIZ", 0, 800_000, 200_000),
    ("135515", "Retención en la fuente", "890900608", "ALMACENES EXITO SA", 0, 5_000_000, 0),
    ("135517", "IVA retenido", "890900608", "ALMACENES EXITO SA", 0, 2_000_000, 0),
    ("143505", "Mercancías", "830045123", "DISTRIBUIDORA CENTRAL LTDA", 10_000_000, 120_000_000, 0),
    ("143505", "Mercancías", "900123456", "EMPRESA DEMO SAS", 0, 0, 115_000_000),
    ("152805", "Equipo de cómputo", "8605012347", "TECNOLOGIA GLOBAL SAS", 0, 8_000_000, 0),
    ("220505", "Proveedores nacionales", "830045123", "DISTRIBUIDORA CENTRAL LTDA", 0, 100_000_000, 120_000_000),
    ("220505", "Proveedores nacionales", "8605012347", "TECNOLOGIA GLOBAL SAS", 0, 5_000_000, 8_000_000),
    ("233525", "Honorarios por pagar", "79555111", "PEDRO ANTONIO RAMIREZ", 0, 9_000_000, 10_000_000),
    ("236515", "Retención honorarios", "79555111", "PEDRO ANTONIO RAMIREZ", 0, 0, 1_100_000),
    ("236515", "Retención honorarios", "800197268", "DIRECCION DE IMPUESTOS Y ADUANAS NACIONALES", 0, 1_900_000, 0),
    ("236525", "Retención servicios", "901234567", "SERVICIOS INTEGRALES SAS", 0, 0, 800_000),
    ("236540", "Retención compras", "830045123", "DISTRIBUIDORA CENTRAL LTDA", 0, 0, 3_000_000),
    ("236701", "Retención IVA", "901234567", "SERVICIOS INTEGRALES SAS", 0, 0, 570_000),
    ("240801", "IVA generado", "890900608", "ALMACENES EXITO SA", 0, 0, 38_000_000),
    ("240801", "IVA generado", "1020304050", "MARIA FERNANDA LOPEZ RUIZ", 0, 0, 120_000),
    ("240802", "IVA descontable", "830045123", "DISTRIBUIDORA CENTRAL LTDA", 0, 22_800_000, 0),
    ("240802", "IVA descontable", "901234567", "SERVICIOS INTEGRALES SAS", 0, 3_800_000, 0),
    ("240801", "IVA generado", "800197268", "DIRECCION DE IMPUESTOS Y ADUANAS NACIONALES", 0, 11_000_000, 0),
    ("250505", "Salarios por pagar", "71234567", "JUAN CARLOS PEREZ GOMEZ", 0, 30_000_000, 32_000_000),
    ("310505", "Capital suscrito y pagado", "900123456", "EMPRESA DEMO SAS", -100_000_000, 0, 0),
    ("413524", "Ventas", "890900608", "ALMACENES EXITO SA", 0, 0, 200_000_000),
    ("413524", "Ventas", "1020304050", "MARIA FERNANDA LOPEZ RUIZ", 0, 0, 632_000),
    ("413524", "Ventas", "222222222", "CUANTIAS MENORES", 0, 0, 3_000_000),
    ("417505", "Devoluciones en ventas", "890900608", "ALMACENES EXITO SA", 0, 4_000_000, 0),
    ("421005", "Intereses", "860034313", "BANCO DAVIVIENDA SA", 0, 0, 350_000),
    ("510506", "Sueldos", "71234567", "JUAN CARLOS PEREZ GOMEZ", 0, 30_000_000, 0),
    ("510506", "Sueldos", "1098765432", "JUAN CARLOS PEREZ GOMEZ", 0, 2_000_000, 0),
    ("510569", "Aportes EPS", "900156264", "NUEVA EPS SA", 0, 2_700_000, 0),
    ("511025", "Honorarios revisoría", "79555111", "PEDRO ANTONIO RAMIREZ", 0, 10_000_000, 0),
    ("511025", "Honorarios revisoría", "", "", 0, 1_500_000, 0),
    ("512010", "Arrendamientos construcciones", "43111222", "LUZ MARINA OSPINA", 0, 60_000, 0),
    ("513525", "Servicios", "901234567", "SERVICIOS INTEGRALES SAS", 0, 20_000_000, 0),
    ("516005", "Depreciación", "900123456", "EMPRESA DEMO SAS", 0, 1_200_000, 0),
    ("530520", "Intereses", "860034313", "BANCO DAVIVIENDA SA", 0, 900_000, 0),
    ("613520", "Costo de ventas", "900123456", "EMPRESA DEMO SAS", 0, 115_000_000, 0),
]

TERCEROS = [
    # tipo, nit, dv, razón social, nombres/apellidos, dirección, ciudad, departamento
    ("NIT", "860034313", "7", "BANCO DAVIVIENDA S.A.", "", "", "", "", "AV EL DORADO 68C 61", "Bogotá D.C.", "Bogotá"),
    ("NIT", "890900608", "9", "ALMACENES ÉXITO S.A.", "", "", "", "", "CR 48 32B SUR 139", "Envigado", "Antioquia"),
    ("NIT", "900777888", "", "COMERCIALIZADORA ANDINA S.A.S.", "", "", "", "", "CL 10 20 30", "Medellín", "Antioquia"),
    ("CC", "1020304050", "", "", "LOPEZ", "RUIZ", "MARIA", "FERNANDA", "CL 50 40 10", "Bello", "Antioquia"),
    ("NIT", "830045123", "1", "DISTRIBUIDORA CENTRAL LTDA", "", "", "", "", "CL 13 65 20", "Bogotá", "Cundinamarca"),
    ("NIT", "8605012347", "", "TECNOLOGIA GLOBAL SAS", "", "", "", "", "CR 7 71 21", "Bogotá", ""),
    ("CC", "79555111", "", "", "", "", "", "", "", "", ""),
    ("NIT", "800197268", "4", "DIRECCION DE IMPUESTOS Y ADUANAS NACIONALES", "", "", "", "", "CR 8 6C 38", "Bogotá", ""),
    ("NIT", "901234567", "", "SERVICIOS INTEGRALES SAS", "", "", "", "", "CL 30 45 12", "Cali", "Valle del Cauca"),
    ("CC", "71234567", "", "", "PEREZ", "GOMEZ", "JUAN", "CARLOS", "CL 1 2 3", "Itagüí", "Antioquia"),
    ("CC", "1098765432", "", "", "PEREZ", "GOMEZ", "JUAN", "CARLOS", "CL 9 9 9", "Bucaramanga", "Santander"),
    ("NIT", "900156264", "", "NUEVA EPS S.A.", "", "", "", "", "CR 85K 46A 66", "Bogotá", ""),
    ("CC", "43111222", "", "", "OSPINA", "", "LUZ", "MARINA", "CL 70 50 20", "Medellín", "Antioquia"),
    ("NIT", "900123456", "", "EMPRESA DEMO SAS", "", "", "", "", "CL 1 1 1", "Medellín", "Antioquia"),
]


def main() -> None:
    filas = []
    for cuenta, ncuenta, nit, ntercero, si, d, c in MOV:
        filas.append({"Nivel": "Auxiliar", "Transaccional": "Sí", "Código cuenta contable": cuenta,
                      "Nombre cuenta contable": ncuenta, "Identificación": nit, "Sucursal": "0",
                      "Nombre tercero": ntercero, "Saldo inicial": si, "Movimiento débito": d,
                      "Movimiento crédito": c, "Saldo final": si + d - c})
    # Filas de totales (Transaccional = No) que el filtro debe descartar
    filas.insert(0, {"Nivel": "Clase", "Transaccional": "No", "Código cuenta contable": "1",
                     "Nombre cuenta contable": "Activo", "Movimiento débito": 999, "Movimiento crédito": 0})
    bal = pd.DataFrame(filas)
    # Contrapartida para que el balance cuadre (partida doble)
    dif = bal.loc[bal["Transaccional"] == "Sí", "Movimiento débito"].sum() - \
        bal.loc[bal["Transaccional"] == "Sí", "Movimiento crédito"].sum()
    bal.loc[len(bal)] = {"Nivel": "Auxiliar", "Transaccional": "Sí", "Código cuenta contable": "110505",
                         "Nombre cuenta contable": "Caja general", "Identificación": "", "Sucursal": "0",
                         "Nombre tercero": "", "Saldo inicial": 0,
                         "Movimiento débito": max(-dif, 0), "Movimiento crédito": max(dif, 0),
                         "Saldo final": -dif}
    with pd.ExcelWriter(AQUI / "siigo_balance_por_tercero.xlsx") as w:
        pd.DataFrame([["EMPRESA DEMO SAS"], ["Balance de prueba por tercero"], ["Enero - Diciembre 2026"]]) \
            .to_excel(w, index=False, header=False)
        bal.to_excel(w, index=False, startrow=4)

    ter = pd.DataFrame(TERCEROS, columns=["Tipo de identificación", "Identificación", "Dígito verificación",
                                          "Razón social", "Primer apellido", "Segundo apellido",
                                          "Primer nombre", "Segundo nombre", "Dirección", "Ciudad",
                                          "Departamento"])
    ter.to_excel(AQUI / "siigo_terceros.xlsx", index=False)

    pd.DataFrame([
        {"nit": "71234567", "tipo documento": "CC", "nombre": "PEREZ GOMEZ JUAN CARLOS", "direccion": "CL 1 2 3",
         "ciudad": "Itagüí", "departamento": "Antioquia", "porcentaje": 60},
        {"nit": "43111222", "tipo documento": "CC", "nombre": "OSPINA LUZ MARINA", "direccion": "CL 70 50 20",
         "ciudad": "Medellín", "departamento": "Antioquia", "porcentaje": 40},
    ]).to_csv(AQUI / "accionistas.csv", index=False)

    pd.DataFrame([
        {"nit": "71234567", "tipo documento": "CC", "primer apellido": "PEREZ", "segundo apellido": "GOMEZ",
         "primer nombre": "JUAN", "otros nombres": "CARLOS", "direccion": "CL 1 2 3", "ciudad": "Itagüí",
         "departamento": "Antioquia", "pagos_salarios": 30_000_000, "pagos_prestaciones": 5_000_000,
         "cesantias_fondo": 2_500_000, "aporte_salud": 1_200_000, "aporte_pension": 1_200_000, "retencion": 0},
    ]).to_csv(AQUI / "nomina.csv", index=False)
    print("Ejemplos generados en", AQUI)


if __name__ == "__main__":
    main()
