// ============================================================================
// MOTOR DE REGLAS DE HORARIO — control horario estricto de producción.
// Puro (sin llamadas a Firebase) para poder probarse y reutilizarse tanto
// desde el kiosko (cierre del día) como desde el panel admin (recalcular un
// día tras aprobar/rechazar una excepción retroactiva).
// ============================================================================

import { HORA_INICIO_DIURNO, HORA_INICIO_NOCTURNO, TOLERANCIA_ENTRADA_MINUTOS } from './config-recargos.js';
import { esDominicalOFestivo } from './festivos.js';

const DIAS_SEMANA = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

// ---------------------------------------------------------------------------
// Utilidades de fecha/hora
// ---------------------------------------------------------------------------

/** 'HH:mm' -> minutos desde medianoche */
export function horaStringAMinutos(horaStr) {
  const [h, m] = horaStr.split(':').map(Number);
  return h * 60 + m;
}

/** Combina una fecha (Date, solo día) con una hora 'HH:mm' -> Date completo */
export function combinarFechaYHora(fechaBase, horaStr) {
  const minutos = horaStringAMinutos(horaStr);
  const d = new Date(fechaBase);
  d.setHours(0, minutos, 0, 0);
  return d;
}

/** 'YYYY-MM-DD' (fecha del documento) -> Date a medianoche local */
export function fechaKeyADate(fechaKey) {
  const [y, m, d] = fechaKey.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function dateAFechaKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function diaSemanaKey(date) {
  return DIAS_SEMANA[date.getDay()];
}

function diffMinutos(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

// ---------------------------------------------------------------------------
// Resolución del horario vigente / excepción aprobada para una fecha
// ---------------------------------------------------------------------------

/**
 * Busca en el historial de `horarios_empleado` (array de docs, cualquier
 * orden) el que estaba vigente en `fecha`. Nunca hay ambigüedad porque los
 * horarios nunca se editan, solo se versionan con vigente_desde/vigente_hasta.
 */
export function resolverHorarioVigente(historialHorarios, fecha) {
  const fechaKey = dateAFechaKey(fecha);
  // Como nunca se edita un horario existente (ni siquiera para cerrar su
  // vigencia), la resolución es "el más reciente cuyo vigente_desde ya
  // empezó" — eso basta para que uno nuevo reemplace al anterior sin tener
  // que tocarlo. vigente_hasta solo importa para horarios de vigencia
  // acotada de antemano (se fija al crear ESE doc, nunca editando otro).
  const candidatos = [...historialHorarios]
    .filter((h) => {
      const hasta = h.vigente_hasta;
      return h.vigente_desde <= fechaKey && (hasta === null || hasta === undefined || fechaKey <= hasta);
    })
    .sort((a, b) => (a.vigente_desde < b.vigente_desde ? 1 : -1));
  return candidatos[0] || null;
}

/**
 * Devuelve el "horario del día": si hay una excepción APROBADA para esa
 * fecha exacta, se usa la hora declarada como horario base de ese día
 * (manteniendo duracion_almuerzo_minutos y ajuste_por_tardanza del horario
 * vigente normal). Si no, se usa el horario vigente normal. El día
 * siguiente, sin nueva declaración, vuelve solo al horario vigente porque
 * la excepción es por fecha exacta, nunca se reutiliza.
 */
export function resolverHorarioDelDia(historialHorarios, excepcionDelDia, fecha) {
  const base = resolverHorarioVigente(historialHorarios, fecha);
  if (!base) return null;

  if (excepcionDelDia && excepcionDelDia.estado === 'aprobado') {
    return {
      ...base,
      hora_entrada: excepcionDelDia.hora_entrada_declarada,
      hora_salida: excepcionDelDia.hora_salida_declarada,
      _origen: 'excepcion',
    };
  }
  return { ...base, _origen: 'horario_base' };
}

// ---------------------------------------------------------------------------
// Evaluación de marcaciones individuales (tolerancia y justificación)
// ---------------------------------------------------------------------------

/**
 * Evalúa una marcación de ENTRADA (entrada_manana o entrada_almuerzo).
 * Regla: temprano nunca justifica y no cuenta para nada. Tarde <=5min no
 * justifica pero SÍ cuenta minutos para el corrimiento de jornada (cero
 * tolerancia en el cálculo). Tarde >5min exige justificación.
 */
export function evaluarEntrada(horaProgramadaDate, horaRealDate, tolerancia = TOLERANCIA_ENTRADA_MINUTOS) {
  const minutosDesviacion = diffMinutos(horaRealDate, horaProgramadaDate);

  if (minutosDesviacion <= 0) {
    return { minutosDesviacion, requiereJustificacion: false, minutosTardanzaParaJornada: 0 };
  }
  if (minutosDesviacion <= tolerancia) {
    return { minutosDesviacion, requiereJustificacion: false, minutosTardanzaParaJornada: minutosDesviacion };
  }
  return { minutosDesviacion, requiereJustificacion: true, minutosTardanzaParaJornada: minutosDesviacion };
}

/**
 * Evalúa la marcación de SALIDA DE JORNADA. Cero tolerancia: cualquier
 * salida antes de horaSalidaEfectiva exige justificación. Salir después
 * nunca justifica (se vuelve extra automático, clasificado aparte).
 */
export function evaluarSalidaJornada(horaSalidaEfectivaDate, horaRealDate) {
  const minutosDesviacion = diffMinutos(horaRealDate, horaSalidaEfectivaDate);
  const requiereJustificacion = minutosDesviacion < 0;
  return { minutosDesviacion, requiereJustificacion };
}

/**
 * hora_salida_efectiva = hora_salida_programada + minutos_tardanza_dia,
 * solo si ajuste_por_tardanza = true en el horario del día. La jornada
 * ordinaria completa siempre se paga íntegra — esto solo corre el punto
 * donde empieza a contar la hora extra, nunca descuenta salario.
 */
export function calcularHoraSalidaEfectiva(horario, fechaBase, minutosTardanzaEntradaManana, minutosTardanzaEntradaAlmuerzo) {
  const salidaProgramada = combinarFechaYHora(fechaBase, horario.hora_salida);
  if (!horario.ajuste_por_tardanza) return salidaProgramada;

  const minutosTardanzaDia = (minutosTardanzaEntradaManana || 0) + (minutosTardanzaEntradaAlmuerzo || 0);
  const efectiva = new Date(salidaProgramada);
  efectiva.setMinutes(efectiva.getMinutes() + minutosTardanzaDia);
  return efectiva;
}

// ---------------------------------------------------------------------------
// Clasificación de horas trabajadas (ordinaria/extra × diurna/nocturna ×
// ordinario/dominical-festivo)
// ---------------------------------------------------------------------------

/** Puntos de corte diurno/nocturno (Date) para el día calendario de `date`. */
function limitesDiurnoNocturno(date) {
  const inicioDiurno = new Date(date);
  inicioDiurno.setHours(HORA_INICIO_DIURNO, 0, 0, 0);
  const inicioNocturno = new Date(date);
  inicioNocturno.setHours(HORA_INICIO_NOCTURNO, 0, 0, 0);
  return { inicioDiurno, inicioNocturno };
}

/**
 * Parte un intervalo [inicio, fin) (mismo día calendario, no cruza
 * medianoche) en sub-segmentos {inicio, fin, esNocturno}, cortando en 6:00
 * a.m. y 9:00 p.m. de ese día.
 */
function partirPorDiurnoNocturno(inicio, fin) {
  const dia = new Date(inicio);
  dia.setHours(0, 0, 0, 0);
  const { inicioDiurno, inicioNocturno } = limitesDiurnoNocturno(dia);

  const cortes = [inicio, fin];
  if (inicioDiurno > inicio && inicioDiurno < fin) cortes.push(inicioDiurno);
  if (inicioNocturno > inicio && inicioNocturno < fin) cortes.push(inicioNocturno);
  cortes.sort((a, b) => a - b);

  const segmentos = [];
  for (let i = 0; i < cortes.length - 1; i++) {
    const segInicio = cortes[i];
    const segFin = cortes[i + 1];
    if (segFin <= segInicio) continue;
    const punto = segInicio; // instante representativo del segmento
    const esNocturno = punto < inicioDiurno || punto >= inicioNocturno;
    segmentos.push({ inicio: segInicio, fin: segFin, esNocturno });
  }
  return segmentos;
}

/** Parte un intervalo que puede cruzar medianoche en sub-intervalos de un solo día calendario. */
function partirPorDiaCalendario(inicio, fin) {
  const segmentos = [];
  let cursor = new Date(inicio);
  while (cursor < fin) {
    const finDia = new Date(cursor);
    finDia.setHours(24, 0, 0, 0); // medianoche siguiente
    const segFin = finDia < fin ? finDia : fin;
    segmentos.push({ inicio: new Date(cursor), fin: new Date(segFin) });
    cursor = segFin;
  }
  return segmentos;
}

/**
 * Divide un intervalo trabajado [inicio, fin) en micro-segmentos con toda
 * la clasificación resuelta: día calendario, diurno/nocturno,
 * dominical/festivo, y ordinaria/extra según el corte `horaSalidaEfectiva`.
 * Devuelve un objeto con minutos acumulados por categoría.
 */
function clasificarIntervalo(inicio, fin, horaSalidaEfectiva) {
  const acumulado = {
    ordinariaDiurna: 0,
    recargoNocturnoOrdinario: 0,
    extraDiurna: 0,
    extraNocturna: 0,
    dominicalFestivoOrdinarioDiurno: 0,
    dominicalFestivoOrdinarioNocturno: 0,
    dominicalFestivoExtraDiurna: 0,
    dominicalFestivoExtraNocturna: 0,
  };
  if (!(fin > inicio)) return acumulado;

  for (const diaSeg of partirPorDiaCalendario(inicio, fin)) {
    const esFestivoDia = esDominicalOFestivo(diaSeg.inicio);
    for (const seg of partirPorDiurnoNocturno(diaSeg.inicio, diaSeg.fin)) {
      // Sub-partir por el corte ordinaria/extra
      const puntosCorte = [seg.inicio, seg.fin];
      if (horaSalidaEfectiva > seg.inicio && horaSalidaEfectiva < seg.fin) {
        puntosCorte.push(horaSalidaEfectiva);
      }
      puntosCorte.sort((a, b) => a - b);

      for (let i = 0; i < puntosCorte.length - 1; i++) {
        const subInicio = puntosCorte[i];
        const subFin = puntosCorte[i + 1];
        const minutos = diffMinutos(subFin, subInicio);
        if (minutos <= 0) continue;
        const esExtra = subInicio >= horaSalidaEfectiva;

        if (esFestivoDia) {
          if (esExtra) {
            if (seg.esNocturno) acumulado.dominicalFestivoExtraNocturna += minutos;
            else acumulado.dominicalFestivoExtraDiurna += minutos;
          } else if (seg.esNocturno) {
            acumulado.dominicalFestivoOrdinarioNocturno += minutos;
          } else {
            acumulado.dominicalFestivoOrdinarioDiurno += minutos;
          }
        } else if (esExtra) {
          if (seg.esNocturno) acumulado.extraNocturna += minutos;
          else acumulado.extraDiurna += minutos;
        } else if (seg.esNocturno) {
          acumulado.recargoNocturnoOrdinario += minutos;
        } else {
          acumulado.ordinariaDiurna += minutos;
        }
      }
    }
  }
  return acumulado;
}

/**
 * Clasifica la jornada completa de un día a partir de los 4 timestamps de
 * marcación y la hora_salida_efectiva ya calculada. Devuelve minutos por
 * categoría granular (para el detalle de recargos) y horas agregadas en
 * las 5 columnas que exige el consolidado de nómina.
 */
export function clasificarJornada({ entradaManana, salidaAlmuerzo, entradaAlmuerzo, salidaJornada, horaSalidaEfectiva }) {
  const bloque1 = clasificarIntervalo(entradaManana, salidaAlmuerzo, horaSalidaEfectiva);
  const bloque2 = clasificarIntervalo(entradaAlmuerzo, salidaJornada, horaSalidaEfectiva);

  const granular = {};
  for (const key of Object.keys(bloque1)) {
    granular[key] = (bloque1[key] || 0) + (bloque2[key] || 0);
  }

  const minutosATexto = (min) => Math.round((min / 60) * 100) / 100;

  const consolidado = {
    horasOrdinarias: minutosATexto(granular.ordinariaDiurna + granular.recargoNocturnoOrdinario),
    horasExtraDiurna: minutosATexto(granular.extraDiurna),
    horasExtraNocturna: minutosATexto(granular.extraNocturna),
    horasDominicalFestivoDiurna: minutosATexto(granular.dominicalFestivoOrdinarioDiurno + granular.dominicalFestivoExtraDiurna),
    horasDominicalFestivoNocturna: minutosATexto(granular.dominicalFestivoOrdinarioNocturno + granular.dominicalFestivoExtraNocturna),
  };
  consolidado.total = Math.round(
    (consolidado.horasOrdinarias + consolidado.horasExtraDiurna + consolidado.horasExtraNocturna +
      consolidado.horasDominicalFestivoDiurna + consolidado.horasDominicalFestivoNocturna) * 100
  ) / 100;

  const detalle = Object.fromEntries(Object.entries(granular).map(([k, v]) => [k, minutosATexto(v)]));

  return { consolidado, detalle };
}

// ---------------------------------------------------------------------------
// Determinar cuál es la próxima marcación que le corresponde al empleado hoy
// ---------------------------------------------------------------------------

const SECUENCIA_MARCACIONES = ['entrada_manana', 'salida_almuerzo', 'entrada_almuerzo', 'salida_jornada'];

/** marcacionesHoy: array de docs `marcaciones` ya registrados hoy para el empleado. */
export function proximaMarcacion(marcacionesHoy) {
  const tiposHechos = new Set(marcacionesHoy.map((m) => m.tipo));
  for (const tipo of SECUENCIA_MARCACIONES) {
    if (!tiposHechos.has(tipo)) return tipo;
  }
  return null; // jornada del día completa
}
