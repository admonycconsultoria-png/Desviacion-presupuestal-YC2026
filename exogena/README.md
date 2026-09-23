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
> | Consolidado anual de nómina en la plantilla `ejemplos/plantilla_nomina_2276.xlsx` (también se descarga desde el aplicativo) | 2276 |
> | Tabla de renglones de las declaraciones (pendiente de parametrizar) | 1011 |

## Aplicativo (uso diario)

**`app/dist/Exogena_YC.html`** es un solo archivo. Se abre con doble clic en Chrome o Edge, no requiere
instalación ni internet, y **los balances nunca salen del equipo**: se leen en memoria y no se guardan.
En el navegador solo se guarda la parametrización.

Flujo por empresa:

1. **+ Nueva empresa**: razón social, NIT, año gravable, software (Siigo, Alegra, Dataico o genérico) y
   dirección del informante.
2. **Procesar exógena**: arrastre el balance de prueba por tercero y el listado de terceros, más el libro de
   accionistas y la nómina si aplica, y pulse **Generar exógena**.
3. Revise los resultados:
   - **Hallazgos**: errores de NIT, DV, duplicados, direcciones y municipios.
   - **Cuadres**: formato frente a balance.
   - **Cuentas sin parametrizar**: se pueden asignar ahí mismo con un clic.
4. **Formatos y descargas**: un Excel por formato, con las columnas en el orden del prevalidador, más el
   informe de validación.

### Parametrización sin sorpresas

- **Asistente por formato**: recorre cada formato y pregunta **cuenta por cuenta del balance de esa empresa**:
  - si se reporta o no;
  - el tratamiento: débitos, créditos, débitos − créditos, créditos − débitos, saldo final deudor o acreedor, o
    saldo de la cuenta asignado a un banco;
  - el concepto y la columna.

  Muestra en vivo el valor que resultaría y cuántos terceros quedarían negativos. También muestra la estructura
  del formato en el orden del prevalidador y de qué cuentas sale cada columna. El dictamen no llega a "Listo"
  mientras quede una cuenta sin revisar. Si la regla de una cuenta cambia después de revisada, vuelve a quedar
  pendiente.
- **Corregir terceros**: tipo 13 en empresas pasa a 31, DV errado, NIT con el DV pegado, municipio (DIVIPOLA
  completa con buscador), dirección, país y nombres. Las correcciones se guardan por empresa, se aplican cada vez
  que se genera y se descargan en Excel para corregirlas también en el software.
- **Conciliación con declaraciones**: IVA descontable y generado, retenciones (350), ingresos, CxC, pasivos
  y efectivo contra los formatos, con un campo para explicar cada diferencia.
- **Sanciones (art. 651 E.T.)**: calculadora con 1%, 0,5% y 0,7%, 0,5 UVT por dato sin cuantía, tope de 7.500 UVT,
  reducciones del 10%, 50% y 70% y art. 640.
- **Descargas de hasta 5.000 registros por archivo**, que es el límite del prevalidador.
- **Diagnóstico de obligatoriedad**: criterios de doctrina con su fuente (`config/doctrina.yaml`), por ejemplo el
  Concepto DIAN 3863 de 2025 para personas naturales del Régimen Simple.
- **NotebookLM**: el aplicativo no se conecta a NotebookLM (no hay API disponible), así que se trabaja con él de
  dos formas:
  - la **pregunta por formato** para copiar y pegar;
  - el **paquete NotebookLM** (.md), una ficha de parametrización de la empresa para cargar como fuente junto con
    las resoluciones y los anexos técnicos.

  Ninguno de los dos incluye datos de terceros.

La configuración está en dos niveles:

| Nivel | Qué contiene | Dónde se edita |
|---|---|---|
| Por empresa | Reglas cuenta → formato/concepto/columna, cuentas bancarias, NIT excluidos | Pestaña *Parametrización de cuentas*: se exporta e importa en Excel y se puede copiar de otra empresa |
| Común | Conceptos, topes de cuantías menores, versiones de formato, marca "verificado" | *Parámetros normativos* |

**Respaldo:** la configuración vive en el navegador, así que conviene usar **Exportar configuración**
(genera un JSON) después de parametrizar. Con ese archivo se restaura todo en otro equipo o navegador.

Para reconstruir el HTML después de cambiar `config/` o el motor:

```bash
python app/construir.py      # empaqueta config/ + app/motor.js + app/ui.js + SheetJS en app/dist/Exogena_YC.html
```

`app/motor.js` es el mismo motor portado a JavaScript. La prueba `tests/test_paridad_js.py` garantiza que
produce exactamente los mismos formatos, hallazgos y parámetros sin verificar que la versión en Python.

## Uso por línea de comandos (procesos en lote)

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
│   ├── divipola.csv         DIVIPOLA completa: 1.121 municipios (paquete npm `divipola`, MIT)
│   ├── doctrina.yaml        criterios de obligatoriedad con su fuente
│   ├── paises.csv           tabla de países DIAN (248, del prevalidador)
│   └── prevalidadores/      layouts y catálogos extraídos de los prevalidadores DIAN (.json)
├── exogena_engine/
│   ├── fuentes.py           lectura y normalización: encabezados, totales, signos, formatos numéricos
│   ├── terceros.py          depuración: DV, tipo de documento, nombres, DIVIPOLA, duplicados
│   ├── motor.py             reglas, prorrateo, cuantías menores, base 1003
│   ├── externos.py          1010 (accionistas) y 2276 (nómina)
│   ├── prevalidador.py      lee el prevalidador DIAN (.xlsm) y verifica el orden de columnas
│   ├── validaciones.py      cuadres e inconsistencias contables
│   └── exportar.py          archivos de formatos e informe
├── app/
│   ├── motor.js             motor en JavaScript (paridad exacta con Python)
│   ├── ui.js, plantilla.html interfaz del aplicativo
│   ├── construir.py         empaqueta todo en dist/Exogena_YC.html
│   └── vendor/              SheetJS 0.18.5 (Apache 2.0) para leer y escribir Excel
├── ejemplos/generar_ejemplo.py   caso Siigo con 7 errores sembrados
└── tests/                   22 pruebas (incluye paridad Python ↔ JavaScript)
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

## Base normativa

La parametrización por defecto sigue la **Res. DIAN 227 de 2025** (Resolución Única, título 3: información
exógena). Incluye sus modificaciones, la **Res. 233 de 2025**, corregida por la 237 de 2025, y la **Res. 238
de 2025** (UVT 2026 = $52.374). Se contrastó con el texto oficial:

| Tema | Fuente | Estado |
|---|---|---|
| Obligados (2.400 UVT PJ; 11.800 + 2.400 UVT PN; RST solo 11.800; agentes de retención) | art. 1.3.1.1 | Verificado |
| Conceptos 1001 (v11 desde AG 2026; v10 para AG 2025), 1003, 1007, 1008, 1009, 1011 (PPE), 1012 | arts. 1.3.5.x | Verificado (`config/conceptos.csv`, columna `fuente`) |
| Cuantías menores: 1001 3 UVT por beneficiario sumando todos los conceptos; 1008/1009 12 UVT por tercero; 1006/1007 solo no identificables | arts. 1.3.5.2.1, 1.3.5.6.1, 1.3.5.7.1 | Verificado |
| Aportes a seguridad social (empleador deducible / trabajador no deducible); RST y no contribuyentes todo no deducible; exterior sin dirección | art. 1.3.5.2.1 par. 6, 9, 10, 14 | Verificado |
| 1010 v9: valor nominal + prima en colocación; 1005 v9 sin columna de prorrateo | arts. 1.3.5.1.1 y 1.3.5.5.1 (Res. 233) | Verificado |
| **Orden exacto de columnas**: 1003, 1006, 1007, 1008, 1009, 1010, 1011, 1012 y 2276 (45 columnas); 1001 v10 y 1005 v8 para AG 2025 | Prevalidador DIAN AG 2025 v3.3.0-26 (misma versión de formato) | Verificado automáticamente |
| Orden de columnas 1001 v11 y 1005 v9 (AG 2026) | Prevalidador AG 2026 (la DIAN aún no lo publica) | **Pendiente**: cargarlo en *Parámetros normativos* cuando salga |
| Catálogos de conceptos (incluye los 223 del 1011), países (248) y entidad informante del 2276 | Tablas del prevalidador AG 2025 | Verificado |

### Verificación contra el prevalidador

El orden de columnas **no se marca a mano**. Cada hoja `F####` del prevalidador de la DIAN trae el encabezado,
tipo, longitud y obligatoriedad de cada columna, y la hoja `DefinicionFormatos` la versión. El aplicativo compara,
encabezado por encabezado, el layout de `config/formatos.yaml` con el del prevalidador **de la misma versión**:
si coincide queda verificado; si el prevalidador trae columnas opcionales adicionales al final, se informan como
omitidas. Un prevalidador de otra versión no verifica nada.

```bash
python -m exogena_engine.prevalidador Prevalidador_AG2026.xlsm             # informe de diferencias
python -m exogena_engine.prevalidador Prevalidador_AG2026.xlsm --guardar    # lo guarda en config/prevalidadores/
```

En el aplicativo: *Parámetros normativos → Cargar prevalidador DIAN (.xlsm)*. Además agrega los conceptos y países
de sus tablas que falten.

`config/criterios.yaml` reúne las reglas que el asistente muestra junto a cada cuenta, cada una con su fuente:
el artículo de la resolución o "Práctica" cuando se trata de un criterio profesional.

## Riesgos

1. **Formatos 1001 v11 y 1005 v9 (AG 2026).** Su versión está verificada en la resolución, pero el orden de
   columnas no: el layout es el del prevalidador AG 2025 (v10/v8) hasta que la DIAN publique el del AG 2026.
   El dictamen no dice "listo" mientras tanto. Esto es deliberado.
2. **Dataico.** Su adaptador se basa en alias genéricos. Hay que probarlo con un export real antes de
   confiar en él.
3. **IVA sin subcuentas.** Si el cliente lleva todo el IVA en `2408` sin separar generado de descontable,
   los débitos por reversión de IVA generado inflan el 1005. La solución de fondo es contable: crear
   subcuentas en el cliente.
4. **Cierre incluido.** Si el balance se exporta con el comprobante de cierre, las cuentas de resultado
   dan neto cero. El motor lo detecta y lo marca como ERROR.
5. **Salarios en 1001 frente a 2276.** La regla `5105 -> 5001` queda activa, pero hay que confirmar en el
   anexo si los pagos laborales ya reportados en 2276 también van en 1001.
6. **Norma base.** Rige la Res. 000227 de 2025, modificada por la 000233 de 2025 (corregida por la 237) y la
   238 de 2025 (UVT 2026).

## Hoja de ruta

| Fase | Entregable | Estado |
|---|---|---|
| 1. Diagnóstico | Obligatoriedad por cliente (ingresos y patrimonio del año anterior contra el umbral de la resolución) y checklist de insumos | Pendiente |
| 2. Arquitectura | Motor, parametrización, adaptadores y validaciones | **Hecho (esta versión)** |
| 3. Verificación normativa | Conceptos, topes y versiones contra la Res. 227; columnas y catálogos contra el prevalidador AG 2025 | **Hecho**, salvo columnas de 1001 v11 y 1005 v9 (falta prevalidador AG 2026) |
| 4. Calibración por software | Un export real de cada software (Siigo, Alegra, Dataico) de un cliente piloto, con ajuste de alias y del filtro de totales | Pendiente |
| 5. 1011 | Tabla de renglones de las declaraciones, en modo `sin_tercero` | Pendiente |
| 6. Aplicativo | HTML sin conexión con multiempresa, parametrización por empresa y descargas para el prevalidador | **Hecho** |
| 7. Escalamiento | Generación directa del XML Muisca y comparación contra la exógena del año anterior | Pendiente |
