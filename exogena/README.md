# Exógena DIAN parametrizada: AG 2026 (se presenta en 2027)

Este motor genera los formatos de información exógena a partir del **balance de prueba por tercero**
que se exporta de Alegra, Siigo o Dataico. Toda la lógica tributaria está en `config/`, que se puede
editar sin programar. El código no tiene cuentas ni conceptos fijos.

> **Límite:** con solo el balance **no** se pueden generar los 11 formatos. Estos son los insumos
> mínimos:
>
> | Insumo | Formatos que alimenta |
> |---|---|
> | Balance de prueba **por tercero**, nivel auxiliar, ene-dic, **sin comprobante de cierre** | 1001, 1003, 1005, 1006, 1007, 1008, 1009, 1012 |
> | Maestro de terceros (dirección, ciudad, tipo de documento) | Todos los que piden ubicación |
> | Libro de accionistas (`accionistas.csv`) | 1010 |
> | Consolidado anual de nómina electrónica (`nomina.csv`) | 2276 |
> | Tabla de renglones de las declaraciones (pendiente de parametrizar) | 1011 |

## Uso

```bash
cd exogena
pip install -r requirements.txt
python -m exogena_engine --fuente siigo \
    --balance balance_por_tercero.xlsx --terceros terceros.xlsx \
    --accionistas accionistas.csv --nomina nomina.csv \
    --salida salida/CLIENTE_X
```

Opciones útiles:

- `--config config_clientes/CLIENTE_X`: usa una copia de `config/` con el plan de cuentas propio de ese cliente.
- `--formatos 1001 1007`: genera solo esos formatos.

Para ver el flujo completo con errores sembrados a propósito:

```bash
python ejemplos/generar_ejemplo.py
python -m exogena_engine --fuente siigo --balance ejemplos/siigo_balance_por_tercero.xlsx \
  --terceros ejemplos/siigo_terceros.xlsx --accionistas ejemplos/accionistas.csv \
  --nomina ejemplos/nomina.csv --salida salida/demo
python -m pytest -q tests
```

### Qué produce

- `Formato_XXXX_vN_AG2026.xlsx`: un archivo por formato. Las columnas van en el orden del
  prevalidador y los encabezados coinciden con los suyos. Los códigos (dpto `05`, municipio `001`)
  van como texto para conservar los ceros a la izquierda.
- `Informe_validacion_exogena_AG2026.xlsx`, con estas hojas:
  - **Resumen**: registros por formato, conteo de hallazgos y dictamen *¿Listo para prevalidador?*
  - **Hallazgos**: los ERRORES impiden la carga, las ALERTAS hay que revisarlas y los INFO son decisiones del motor.
  - **Cuadres**: por formato y columna compara el total del balance con el total del archivo, y explica
    la diferencia (NIT excluidos, movimiento sin tercero, negativos llevados a cero). Si la diferencia no
    explicada es distinta de 0, algo se perdió.
  - **Parámetros sin verificar**: lista cada concepto, tope o layout que se usó sin validarlo contra la
    resolución. Mientras esta hoja tenga filas, el dictamen es **NO**.
  - **Trazabilidad**: la cuenta, el tercero, la regla y el valor de cada cifra de cada formato. Sirve de
    soporte ante un requerimiento.
  - **Terceros**: la base depurada.

## Arquitectura

```
exogena/
├── config/                  <- PARAMETRIZACIÓN (esto es lo que se mantiene año a año)
│   ├── parametros.yaml      año, informante, topes de cuantías menores, NIT excluidos
│   ├── formatos.yaml        layout de cada formato (versión, columnas, campos obligatorios)
│   ├── mapeo_cuentas.csv    PUC -> formato / concepto / columna / base de cálculo
│   ├── conceptos.csv        catálogo de conceptos con marca verificado SI/NO
│   ├── fuentes.yaml         alias de encabezados de Alegra / Siigo / Dataico
│   ├── tipos_documento.csv  CC, NIT, CE, PPT… -> códigos DIAN
│   ├── divipola.csv         departamentos y municipios (ampliar con la DIVIPOLA completa del DANE)
│   └── paises.csv           códigos de país DIAN
├── exogena_engine/
│   ├── fuentes.py           lectura y normalización: encabezados, totales, signos, formatos numéricos
│   ├── terceros.py          depuración: DV, tipo de documento, nombres, DIVIPOLA, duplicados
│   ├── motor.py             reglas, prorrateo, cuantías menores, base 1003
│   ├── externos.py          1010 (accionistas) y 2276 (nómina)
│   ├── validaciones.py      cuadres e inconsistencias contables
│   └── exportar.py          archivos de formatos e informe
├── ejemplos/generar_ejemplo.py   caso Siigo con 7 errores sembrados
└── tests/                   21 pruebas
```

### Cómo funciona `mapeo_cuentas.csv`

```
formato,prefijo,concepto,columna,base,notas
1001,5135,5004,pago_deducible,neto_deb,Servicios
1001,236525,5004,ret_renta,credito,Retención servicios
1001,2367,PRORRATA,ret_iva_comun,credito,Retención IVA
1001,5160,EXCLUIR,,,Depreciaciones
```

- Dentro de cada formato gana el **prefijo más largo**. `5105` manda todo el gasto de personal a 5001, y
  `510569` envía la EPS a 5011.
- `base` indica qué cifra del balance se toma: `neto_deb`, `neto_cred`, `debito`, `credito`, `saldo_deb`
  o `saldo_cred`.
- `EXCLUIR` corta una rama completa, por ejemplo las depreciaciones, que no son pagos.
- `PRORRATA` reparte la retención de IVA entre los conceptos 1001 del tercero en proporción a sus pagos.
  Así la retención queda en la misma fila que el pago que la originó.
- Una misma cuenta puede alimentar varios formatos: `2408` va al 1005 por débito y al 1006 por crédito.

### Reglas que aplica el motor

| Regla | Por qué |
|---|---|
| Se excluye el NIT del propio informante | Traslados internos (1435 a 6135) y cierre |
| Se excluye el NIT DIAN en 1001/1005/1006 | El pago de retenciones o IVA no es un pago a un tercero |
| Compras (5007) desde débitos de 14xx, con 6135 excluido | Evita contar dos veces la compra y el costo |
| Retenciones desde créditos de 2365/2367 | Los débitos son pagos a la DIAN |
| Si hay retención, no se agrupa en cuantías menores | Criterio conservador (parametrizable) |
| Los negativos se reportan en 0 con alerta | El prevalidador no los acepta y casi siempre son errores de causación |
| La base del 1003 se estima con los ingresos del tercero | Tomar la base real del certificado cuando exista |

## Riesgos

1. **Parámetros sin verificar.** Al momento de escribir esto (sep-2026) no se ha revisado la resolución de
   exógena que rige el AG 2026 ni la versión de sus anexos. Los códigos de concepto, los topes de cuantías
   menores y las versiones de formato que trae `config/` son de referencia y **todos están marcados
   `verificado: false` / `NO`**. El motor no dará el dictamen "listo" hasta que un contador los contraste
   contra la resolución y cambie la marca. Esto es deliberado.
2. **Dataico.** Su adaptador se basa en alias genéricos. Hay que probarlo con un export real antes de
   confiar en él.
3. **IVA sin subcuentas.** Si el cliente lleva todo el IVA en `2408` sin separar generado de descontable,
   los débitos por reversión de IVA generado inflan el 1005. La solución de fondo es contable: crear
   subcuentas en el cliente.
4. **Cierre incluido.** Si el balance se exporta con el comprobante de cierre, las cuentas de resultado
   dan neto cero. El motor lo detecta y lo marca como ERROR.
5. **Salarios en 1001 frente a 2276.** La regla `5105 -> 5001` queda activa, pero hay que confirmar en el
   anexo si los pagos laborales ya reportados en 2276 también van en 1001.
6. **La DIVIPOLA incluida es parcial** (capitales y municipios frecuentes). Antes de producción hay que
   reemplazar `config/divipola.csv` por la tabla completa del DANE, que tiene las mismas columnas.

## Hoja de ruta

| Fase | Entregable | Estado |
|---|---|---|
| 1. Diagnóstico | Obligatoriedad por cliente (ingresos y patrimonio del año anterior contra el umbral de la resolución) y checklist de insumos | Pendiente |
| 2. Arquitectura | Motor, parametrización, adaptadores y validaciones | **Hecho (esta versión)** |
| 3. Verificación normativa | Contrastar `conceptos.csv`, topes y `formatos.yaml` con la resolución y los anexos del AG 2026, y cambiar las marcas a SI | Pendiente, **crítico** |
| 4. Calibración por software | Un export real de cada software (Siigo, Alegra, Dataico) de un cliente piloto, con ajuste de alias y del filtro de totales | Pendiente |
| 5. 1011 | Tabla de renglones de las declaraciones, en modo `sin_tercero` | Pendiente |
| 6. Escalamiento | Carpeta `config_clientes/<cliente>` por cliente, ejecución en lote y generación del XML Muisca directo | Pendiente |
