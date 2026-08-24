// Festivos de Colombia — calculados por algoritmo, nunca guardados a mano.
// Incluye: festivos fijos, Semana Santa (Jueves y Viernes Santo, vía cálculo
// de Pascua) y festivos trasladables al lunes siguiente (Ley Emiliani, Ley 51
// de 1983) cuando no caen en lunes.
//
// Todas las fechas se manejan como Date a medianoche LOCAL (zona horaria del
// dispositivo, que en este proyecto siempre es America/Bogota — la tablet es
// fija en Jardín, Antioquia).

/** Domingo de Pascua para un año dado (algoritmo de Meeus/Jones/Butcher). */
function domingoPascua(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31); // 3 = marzo, 4 = abril
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, mes - 1, dia);
}

function sumarDias(date, dias) {
  const d = new Date(date);
  d.setDate(d.getDate() + dias);
  return d;
}

/** Traslada una fecha al lunes siguiente si no cae en lunes (Ley Emiliani). */
function trasladarALunes(date) {
  const dia = date.getDay(); // 0 = domingo, 1 = lunes, ...
  if (dia === 1) return new Date(date);
  const diasHastaLunes = (8 - dia) % 7 || 7;
  return sumarDias(date, dia === 0 ? 1 : diasHastaLunes);
}

function clave(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const _cache = new Map();

/**
 * Devuelve el set de festivos de un año como strings 'YYYY-MM-DD'.
 * Incluye Jueves y Viernes Santo (no son festivos remunerados en Colombia
 * salvo convención, pero se calculan porque son referencia habitual de
 * jornada reducida en el sector — NO se cuentan como festivo/dominical en
 * la clasificación de horas a menos que se confirme lo contrario con el
 * contador; ver horario-logic.js).
 */
export function festivosColombia(year) {
  if (_cache.has(year)) return _cache.get(year);

  const pascua = domingoPascua(year);
  const fechas = [];

  // Festivos fijos (no se trasladan)
  fechas.push(new Date(year, 0, 1));   // Año Nuevo
  fechas.push(new Date(year, 4, 1));   // Día del Trabajo
  fechas.push(new Date(year, 6, 20));  // Independencia de Colombia
  fechas.push(new Date(year, 7, 7));   // Batalla de Boyacá
  fechas.push(new Date(year, 11, 8));  // Inmaculada Concepción
  fechas.push(new Date(year, 11, 25)); // Navidad

  // Semana Santa (fijos respecto a Pascua, no se trasladan)
  fechas.push(sumarDias(pascua, -3)); // Jueves Santo
  fechas.push(sumarDias(pascua, -2)); // Viernes Santo

  // Trasladables al lunes siguiente (Ley Emiliani)
  fechas.push(trasladarALunes(new Date(year, 0, 6)));   // Reyes Magos
  fechas.push(trasladarALunes(new Date(year, 2, 19)));  // San José
  fechas.push(trasladarALunes(sumarDias(pascua, 39)));  // Ascensión del Señor
  fechas.push(trasladarALunes(sumarDias(pascua, 60)));  // Corpus Christi
  fechas.push(trasladarALunes(sumarDias(pascua, 68)));  // Sagrado Corazón
  fechas.push(trasladarALunes(new Date(year, 5, 29)));  // San Pedro y San Pablo
  fechas.push(trasladarALunes(new Date(year, 7, 15)));  // Asunción de la Virgen
  fechas.push(trasladarALunes(new Date(year, 9, 12)));  // Día de la Raza
  fechas.push(trasladarALunes(new Date(year, 10, 1)));  // Todos los Santos
  fechas.push(trasladarALunes(new Date(year, 10, 11))); // Independencia de Cartagena

  const set = new Set(fechas.map(clave));
  _cache.set(year, set);
  return set;
}

/** ¿La fecha dada (Date) es festivo en Colombia? */
export function esFestivo(date) {
  return festivosColombia(date.getFullYear()).has(clave(date));
}

/** ¿La fecha dada es domingo o festivo? (para recargo dominical/festivo). */
export function esDominicalOFestivo(date) {
  return date.getDay() === 0 || esFestivo(date);
}
