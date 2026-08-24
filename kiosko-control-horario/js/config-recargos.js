// ============================================================================
// CONSTANTES DE RECARGOS Y HORARIOS — NINGÚN VALOR AQUÍ ES DEFINITIVO.
// Todo debe confirmarse con el contador/asesor laboral antes de usar esta
// app en producción para generar el consolidado que se entrega a nómina.
// ============================================================================

/**
 * Franja diurna/nocturna. La Ley 2101 de 2021 modificó estos límites
 * (venían siendo 6:00 a.m.–10:00 p.m. / 10:00 p.m.–6:00 a.m., y desde el
 * cambio son 6:00 a.m.–9:00 p.m. / 9:00 p.m.–6:00 a.m.).
 * TODO: verificar con contador antes de producción — confirmar que la franja
 * vigente para esta empresa en la fecha de uso es 6am–9pm / 9pm–6am y no
 * quedó en un régimen de transición distinto.
 */
export const HORA_INICIO_DIURNO = 6;   // 6:00 a.m.
export const HORA_INICIO_NOCTURNO = 21; // 9:00 p.m.

/**
 * Jornada máxima legal semanal (Ley 2101 de 2021 — reducción gradual).
 * 2023: 47h, jul-2023: 46h, jul-2024: 44h, jul-2025: 42h.
 * TODO: verificar con contador que 42h/semana sigue vigente en la fecha de
 * uso y que no aplica un régimen distinto para este sector/empresa.
 */
export const JORNADA_MAXIMA_SEMANAL_HORAS = 42;

/** Tolerancia de entrada (mañana y post-almuerzo) antes de exigir justificación. */
export const TOLERANCIA_ENTRADA_MINUTOS = 5;

/**
 * Porcentajes de recargo — TODO: verificar con contador antes de producción.
 * Valores puestos aquí son los usuales de referencia en Colombia, NO una
 * confirmación para esta empresa.
 */
export const RECARGOS = {
  // Trabajo nocturno dentro de la jornada ordinaria (no es hora extra).
  recargoNocturnoOrdinario: 0.35, // TODO: verificar con contador antes de producción

  // Horas extra.
  extraDiurna: 0.25,   // TODO: verificar con contador antes de producción
  extraNocturna: 0.75, // TODO: verificar con contador antes de producción

  // Dominical/festivo — depende además de si es habitual u ocasional para
  // el empleado, distinción que esta app NO calcula todavía (ver
  // `dominicalEsHabitual` más abajo).
  dominicalFestivoOrdinarioDiurno: 0.75,     // TODO: verificar con contador antes de producción
  dominicalFestivoOrdinarioNocturno: 1.10,   // TODO: verificar con contador antes de producción (75% + recargo nocturno)
  dominicalFestivoExtraDiurna: 1.00,         // TODO: verificar con contador antes de producción
  dominicalFestivoExtraNocturna: 1.50,       // TODO: verificar con contador antes de producción
};

/**
 * Umbral de dominicales trabajados en el mes para considerar el recargo
 * dominical "habitual" en vez de "ocasional" (afecta si se compensa con
 * día de descanso o solo con recargo en dinero — la app NO decide esto
 * todavía, solo deja el dato de cuántos dominicales trabajó cada empleado
 * en el mes para que Gestión Humana lo evalúe).
 * TODO: verificar con contador antes de producción.
 */
export const UMBRAL_DOMINICALES_HABITUAL = 2;
