/**
 * Exógena YC · Descarga masiva de facturas electrónicas desde Gmail a Google Drive.
 *
 * Guarda en una carpeta de Drive todos los adjuntos .zip y .xml de los correos que cumplen la CONSULTA.
 * Después se descarga la carpeta completa desde Drive (un solo ZIP) y se carga en el aplicativo.
 *
 * Uso (en la cuenta de Gmail que recibe las facturas):
 *   1. Abra https://script.google.com → Nuevo proyecto → borre el contenido y pegue este archivo.
 *   2. Ajuste CONSULTA (año, y si quiere el correo de recepción) y CARPETA.
 *   3. Seleccione la función guardarFacturas → Ejecutar. La primera vez pide autorización: acéptela.
 *   4. Google corta cada ejecución a los 6 minutos. Si el registro dice "Pausa", vuelva a ejecutar:
 *      continúa donde iba y no duplica archivos. Repita hasta que diga "Terminado".
 *   5. En Drive, clic derecho sobre la carpeta → Descargar. Cargue ese ZIP en el aplicativo
 *      (Procesar exógena → Facturas electrónicas).
 *
 * Solo lee correos y crea archivos en su Drive. No borra, no mueve y no envía nada.
 */
const CONSULTA = 'has:attachment (filename:zip OR filename:xml) after:2025/01/01 before:2026/01/01';
// Ejemplo solo para el buzón de recepción:  'to:facturas@miempresa.com has:attachment filename:zip after:2025/01/01 before:2026/01/01'
const CARPETA = 'Facturas electronicas AG 2025';
const LOTE = 100;              // hilos por búsqueda
const LIMITE_MS = 5 * 60 * 1000;

function guardarFacturas() {
  const inicio = Date.now();
  const props = PropertiesService.getUserProperties();
  const clave = 'desde_' + CONSULTA;
  let desde = Number(props.getProperty(clave) || 0);
  const carpeta = obtenerCarpeta_(CARPETA);
  const existentes = new Set();
  const archivos = carpeta.getFiles();
  while (archivos.hasNext()) existentes.add(archivos.next().getName());
  let guardados = 0;
  while (true) {
    const hilos = GmailApp.search(CONSULTA, desde, LOTE);
    if (!hilos.length) {
      props.deleteProperty(clave);
      Logger.log('Terminado. Archivos guardados en esta ejecución: ' + guardados + '. Total en la carpeta: ' + existentes.size);
      return;
    }
    for (const hilo of hilos) {
      for (const mensaje of hilo.getMessages()) {
        for (const adjunto of mensaje.getAttachments({ includeInlineImages: false })) {
          const nombre = adjunto.getName();
          if (!/\.(zip|xml)$/i.test(nombre)) continue;
          const unico = mensaje.getId() + '_' + nombre;   // el mismo nombre puede repetirse entre proveedores
          if (existentes.has(unico)) continue;
          carpeta.createFile(adjunto.copyBlob().setName(unico));
          existentes.add(unico);
          guardados++;
        }
      }
    }
    desde += hilos.length;
    props.setProperty(clave, String(desde));
    if (Date.now() - inicio > LIMITE_MS) {
      Logger.log('Pausa por el límite de tiempo de Google. Hilos revisados: ' + desde + '. Guardados: ' + guardados + '. Vuelva a ejecutar guardarFacturas.');
      return;
    }
  }
}

/** Empieza de nuevo desde el primer correo (no borra lo ya guardado). */
function reiniciar() {
  PropertiesService.getUserProperties().deleteProperty('desde_' + CONSULTA);
}

function obtenerCarpeta_(nombre) {
  const it = DriveApp.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : DriveApp.createFolder(nombre);
}
