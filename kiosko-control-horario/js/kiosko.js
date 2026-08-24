import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, query, where, Timestamp, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  ref, uploadBytes, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';

import { db, storage, asegurarSesionAnonima, calcularPasswordHash } from './firebase-init.js';
import {
  resolverHorarioDelDia, evaluarEntrada, evaluarSalidaJornada, calcularHoraSalidaEfectiva,
  clasificarJornada, proximaMarcacion, combinarFechaYHora, dateAFechaKey,
} from './horario-logic.js';

// ---------------------------------------------------------------------------
// Estado en memoria de la sesión de marcación activa en el kiosko
// ---------------------------------------------------------------------------
let empleadoActual = null;       // { id, nombre, cargo, ... } (id = cédula)
let marcacionesHoy = [];         // docs de `marcaciones` ya registrados hoy
let horarioDelDiaActual = null;  // horario resuelto (base o excepción) para hoy
let horaSalidaEfectivaActual = null;
let tipoMarcacionPendiente = null;
let evalPendiente = null;
let fotoBlobPendiente = null;
let mediaStreamActual = null;

const LABELS_TIPO = {
  entrada_manana: 'Marcar entrada',
  salida_almuerzo: 'Marcar salida a almuerzo',
  entrada_almuerzo: 'Marcar entrada de almuerzo',
  salida_jornada: 'Marcar salida de jornada',
};
const LABELS_CONFIRMACION = {
  entrada_manana: 'Entrada de jornada',
  salida_almuerzo: 'Salida a almuerzo',
  entrada_almuerzo: 'Entrada de almuerzo',
  salida_jornada: 'Salida de jornada',
};

// ---------------------------------------------------------------------------
// Utilidades de UI
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function mostrarScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('screen-active'));
  $(id).classList.add('screen-active');
}
function mostrarCargando(v) { $('overlay-cargando').hidden = !v; }
function mostrarError(msg) {
  $('overlay-error-texto').textContent = msg;
  $('overlay-error').hidden = false;
}
$('btn-overlay-error-ok').addEventListener('click', () => { $('overlay-error').hidden = true; });

function formatoHora(date) {
  return date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

// Reloj en vivo de la pantalla de inicio
setInterval(() => {
  const el = $('home-reloj');
  if (el) el.textContent = formatoHora(new Date());
}, 1000);

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
(async function init() {
  try {
    await asegurarSesionAnonima();
  } catch (e) {
    mostrarError('No se pudo conectar. Verifica la conexión a internet de la tablet y recarga la página.');
  }
})();

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
$('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('login-error').hidden = true;
  const cedula = $('input-cedula').value.trim();
  const password = $('input-password').value;
  if (!cedula || !password) return;

  mostrarCargando(true);
  try {
    const snap = await getDoc(doc(db, 'empleados', cedula));
    if (!snap.exists() || snap.data().activo === false) {
      throw new Error('CREDENCIALES_INVALIDAS');
    }
    const data = snap.data();
    const hash = await calcularPasswordHash(password, data.salt || '');
    if (hash !== data.password_hash) throw new Error('CREDENCIALES_INVALIDAS');

    empleadoActual = { id: cedula, ...data };
    $('input-cedula').value = '';
    $('input-password').value = '';
    await entrarAHome();
  } catch (e) {
    $('login-error').textContent = 'Cédula o contraseña incorrecta.';
    $('login-error').hidden = false;
  } finally {
    mostrarCargando(false);
  }
});

$('btn-cerrar-sesion').addEventListener('click', () => {
  empleadoActual = null;
  marcacionesHoy = [];
  mostrarScreen('screen-login');
});

// ---------------------------------------------------------------------------
// Home — estado del día y botón dinámico
// ---------------------------------------------------------------------------
async function entrarAHome() {
  $('home-nombre').textContent = empleadoActual.nombre;
  $('home-cargo').textContent = empleadoActual.cargo || '';
  mostrarScreen('screen-home');
  await refrescarEstadoDelDia();
}

async function refrescarEstadoDelDia() {
  mostrarCargando(true);
  try {
    const fechaKey = dateAFechaKey(new Date());
    const qy = query(
      collection(db, 'marcaciones'),
      where('empleado_id', '==', empleadoActual.id),
      where('fecha', '==', fechaKey),
    );
    const snap = await getDocs(qy);
    marcacionesHoy = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const tipo = proximaMarcacion(marcacionesHoy);
    if (!tipo) {
      $('home-marcacion-disponible').hidden = true;
      $('home-jornada-completa').hidden = false;
    } else {
      $('home-marcacion-disponible').hidden = false;
      $('home-jornada-completa').hidden = true;
      $('btn-marcar-label').textContent = LABELS_TIPO[tipo];
    }
  } catch (e) {
    mostrarError('No se pudo cargar el estado del día. Verifica la conexión.');
  } finally {
    mostrarCargando(false);
  }
}

$('btn-marcar').addEventListener('click', () => {
  const tipo = proximaMarcacion(marcacionesHoy);
  if (!tipo) return;
  iniciarFlujoMarcacion(tipo);
});

// ---------------------------------------------------------------------------
// Cámara
// ---------------------------------------------------------------------------
async function iniciarFlujoMarcacion(tipo) {
  tipoMarcacionPendiente = tipo;
  fotoBlobPendiente = null;
  $('camara-titulo').textContent = `Foto de verificación · ${LABELS_TIPO[tipo]}`;
  $('camara-preview').hidden = true;
  $('camara-video').hidden = false;
  $('btn-capturar').hidden = false;
  $('btn-repetir').hidden = true;
  $('btn-usar-foto').hidden = true;
  mostrarScreen('screen-camara');

  try {
    mediaStreamActual = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    $('camara-video').srcObject = mediaStreamActual;
  } catch (e) {
    mostrarError('No se pudo acceder a la cámara de la tablet. Avisa a un administrador.');
    volverAHome();
  }
}

function detenerCamara() {
  if (mediaStreamActual) {
    mediaStreamActual.getTracks().forEach((t) => t.stop());
    mediaStreamActual = null;
  }
}

$('btn-capturar').addEventListener('click', () => {
  const video = $('camara-video');
  const canvas = $('camara-canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

  canvas.toBlob((blob) => {
    fotoBlobPendiente = blob;
    $('camara-preview').src = URL.createObjectURL(blob);
    $('camara-preview').hidden = false;
    $('camara-video').hidden = true;
    $('btn-capturar').hidden = true;
    $('btn-repetir').hidden = false;
    $('btn-usar-foto').hidden = false;
  }, 'image/jpeg', 0.85);
});

$('btn-repetir').addEventListener('click', () => {
  fotoBlobPendiente = null;
  $('camara-preview').hidden = true;
  $('camara-video').hidden = false;
  $('btn-capturar').hidden = false;
  $('btn-repetir').hidden = true;
  $('btn-usar-foto').hidden = true;
});

$('btn-camara-cancelar').addEventListener('click', () => {
  detenerCamara();
  volverAHome();
});

$('btn-usar-foto').addEventListener('click', async () => {
  detenerCamara();
  await procesarEvaluacion();
});

function volverAHome() {
  mostrarScreen('screen-home');
  refrescarEstadoDelDia();
}

// ---------------------------------------------------------------------------
// Evaluación de la marcación contra el horario del día
// ---------------------------------------------------------------------------
async function procesarEvaluacion() {
  mostrarCargando(true);
  try {
    const ahora = new Date();
    const fechaKey = dateAFechaKey(ahora);

    const [historialSnap, excepcionSnap] = await Promise.all([
      getDocs(query(collection(db, 'horarios_empleado'), where('empleado_id', '==', empleadoActual.id))),
      getDocs(query(
        collection(db, 'excepciones_horario'),
        where('empleado_id', '==', empleadoActual.id),
        where('fecha', '==', fechaKey),
      )),
    ]);
    const historial = historialSnap.docs.map((d) => d.data());
    const excepciones = excepcionSnap.docs.map((d) => d.data());
    // Preferencia: aprobada > pendiente > rechazada (la más relevante para hoy).
    const excepcionDelDia = excepciones.find((e) => e.estado === 'aprobado')
      || excepciones.find((e) => e.estado === 'pendiente')
      || excepciones.find((e) => e.estado === 'rechazado')
      || null;

    horarioDelDiaActual = resolverHorarioDelDia(historial, excepcionDelDia, ahora);
    if (!horarioDelDiaActual) {
      mostrarError('No tienes un horario configurado todavía. Avisa a un administrador antes de marcar.');
      mostrarCargando(false);
      volverAHome();
      return;
    }

    let evalResult;
    const tipo = tipoMarcacionPendiente;

    if (tipo === 'entrada_manana') {
      const horaProgramada = combinarFechaYHora(ahora, horarioDelDiaActual.hora_entrada);
      evalResult = evaluarEntrada(horaProgramada, ahora);
    } else if (tipo === 'entrada_almuerzo') {
      const salidaAlmuerzo = marcacionesHoy.find((m) => m.tipo === 'salida_almuerzo');
      if (!salidaAlmuerzo) throw new Error('FALTA_SALIDA_ALMUERZO');
      const salidaTs = salidaAlmuerzo.timestamp.toDate ? salidaAlmuerzo.timestamp.toDate() : new Date(salidaAlmuerzo.timestamp);
      const horaProgramada = new Date(salidaTs.getTime() + (horarioDelDiaActual.duracion_almuerzo_minutos || 0) * 60000);
      evalResult = evaluarEntrada(horaProgramada, ahora);
    } else if (tipo === 'salida_almuerzo') {
      evalResult = { minutosDesviacion: null, requiereJustificacion: false };
    } else if (tipo === 'salida_jornada') {
      const entradaManana = marcacionesHoy.find((m) => m.tipo === 'entrada_manana');
      const entradaAlmuerzo = marcacionesHoy.find((m) => m.tipo === 'entrada_almuerzo');
      const tardanzaEM = Math.max(0, entradaManana?.minutos_desviacion || 0);
      const tardanzaEA = Math.max(0, entradaAlmuerzo?.minutos_desviacion || 0);
      horaSalidaEfectivaActual = calcularHoraSalidaEfectiva(horarioDelDiaActual, ahora, tardanzaEM, tardanzaEA);
      evalResult = evaluarSalidaJornada(horaSalidaEfectivaActual, ahora);
    }

    evalPendiente = evalResult;

    if (evalResult.requiereJustificacion) {
      mostrarCargando(false);
      mostrarPantallaJustificacion(tipo);
    } else {
      await confirmarYGuardarMarcacion(tipo, evalResult, null);
    }
  } catch (e) {
    mostrarCargando(false);
    if (e.message === 'FALTA_SALIDA_ALMUERZO') {
      mostrarError('No se encontró tu marcación de salida a almuerzo de hoy. Avisa a un administrador.');
    } else {
      mostrarError('No se pudo procesar la marcación. Verifica la conexión e intenta de nuevo.');
    }
    volverAHome();
  }
}

// ---------------------------------------------------------------------------
// Justificación obligatoria
// ---------------------------------------------------------------------------
function mostrarPantallaJustificacion(tipo) {
  const motivos = {
    entrada_manana: 'Llegaste tarde a tu jornada. Cuéntanos por qué:',
    entrada_almuerzo: 'Llegaste tarde de tu almuerzo. Cuéntanos por qué:',
    salida_jornada: 'Estás saliendo antes de tu hora de salida. Cuéntanos por qué:',
  };
  $('justificacion-motivo').textContent = motivos[tipo] || 'Explica el motivo:';
  $('input-justificacion').value = '';
  $('btn-confirmar-justificacion').disabled = true;
  mostrarScreen('screen-justificacion');
}

$('input-justificacion').addEventListener('input', (ev) => {
  $('btn-confirmar-justificacion').disabled = ev.target.value.trim().length === 0;
});

$('btn-confirmar-justificacion').addEventListener('click', async () => {
  const texto = $('input-justificacion').value.trim();
  if (!texto) return;
  await confirmarYGuardarMarcacion(tipoMarcacionPendiente, evalPendiente, texto);
});

$('btn-cancelar-justificacion').addEventListener('click', () => {
  fotoBlobPendiente = null;
  volverAHome();
});

// ---------------------------------------------------------------------------
// Guardado final: sube foto, crea el doc de marcación, actualiza resumen
// ---------------------------------------------------------------------------
async function confirmarYGuardarMarcacion(tipo, evalResult, justificacion) {
  mostrarCargando(true);
  try {
    const ahora = new Date();
    const fechaKey = dateAFechaKey(ahora);

    const storageRef = ref(storage, `fotos_marcacion/${empleadoActual.id}/${ahora.getTime()}.jpg`);
    await uploadBytes(storageRef, fotoBlobPendiente, { contentType: 'image/jpeg' });
    const fotoUrl = await getDownloadURL(storageRef);

    const usoExcepcion = horarioDelDiaActual && horarioDelDiaActual._origen === 'excepcion';
    const esTipoEntrada = tipo === 'entrada_manana' || tipo === 'entrada_almuerzo';
    const estado = (esTipoEntrada && evalResult.requiereJustificacion && !usoExcepcion)
      ? 'pendiente_autorizacion'
      : 'normal';

    const nuevaMarcacion = {
      empleado_id: empleadoActual.id,
      fecha: fechaKey,
      tipo,
      timestamp: Timestamp.fromDate(ahora),
      foto: fotoUrl,
      minutos_desviacion: evalResult.minutosDesviacion ?? null,
      justificacion: justificacion || null,
      estado,
    };
    await addDoc(collection(db, 'marcaciones'), nuevaMarcacion);
    marcacionesHoy.push(nuevaMarcacion);

    if (tipo === 'salida_jornada') {
      await guardarResumenDiario(fechaKey, ahora);
    }

    mostrarCargando(false);
    mostrarConfirmacion(tipo, ahora);
  } catch (e) {
    mostrarCargando(false);
    mostrarError('No se pudo guardar la marcación. Verifica la conexión e intenta de nuevo.');
    volverAHome();
  } finally {
    fotoBlobPendiente = null;
  }
}

async function guardarResumenDiario(fechaKey, salidaJornadaTs) {
  const entradaManana = marcacionesHoy.find((m) => m.tipo === 'entrada_manana');
  const salidaAlmuerzo = marcacionesHoy.find((m) => m.tipo === 'salida_almuerzo');
  const entradaAlmuerzo = marcacionesHoy.find((m) => m.tipo === 'entrada_almuerzo');
  if (!entradaManana || !salidaAlmuerzo || !entradaAlmuerzo) return;

  const aDate = (ts) => (ts.toDate ? ts.toDate() : new Date(ts));
  const { consolidado, detalle } = clasificarJornada({
    entradaManana: aDate(entradaManana.timestamp),
    salidaAlmuerzo: aDate(salidaAlmuerzo.timestamp),
    entradaAlmuerzo: aDate(entradaAlmuerzo.timestamp),
    salidaJornada: salidaJornadaTs,
    horaSalidaEfectiva: horaSalidaEfectivaActual,
  });

  await setDoc(doc(db, 'resumen_diario', `${empleadoActual.id}_${fechaKey}`), {
    empleado_id: empleadoActual.id,
    fecha: fechaKey,
    consolidado,
    detalle,
    horario_usado: {
      hora_entrada: horarioDelDiaActual.hora_entrada,
      hora_salida: horarioDelDiaActual.hora_salida,
      ajuste_por_tardanza: horarioDelDiaActual.ajuste_por_tardanza,
      origen: horarioDelDiaActual._origen,
    },
    hora_salida_efectiva: Timestamp.fromDate(horaSalidaEfectivaActual),
    generado_en: serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// Confirmación visual
// ---------------------------------------------------------------------------
function mostrarConfirmacion(tipo, momento) {
  $('confirmacion-nombre').textContent = empleadoActual.nombre;
  $('confirmacion-tipo').textContent = LABELS_CONFIRMACION[tipo] || tipo;
  $('confirmacion-hora').textContent = formatoHora(momento);
  mostrarScreen('screen-confirmacion');
}

$('btn-confirmacion-ok').addEventListener('click', () => {
  volverAHome();
});

// ---------------------------------------------------------------------------
// Excepción de horario / permiso especial
// ---------------------------------------------------------------------------
$('btn-excepcion').addEventListener('click', () => {
  $('input-excepcion-entrada').value = '';
  $('input-excepcion-salida').value = '';
  mostrarScreen('screen-excepcion');
});

$('btn-cancelar-excepcion').addEventListener('click', () => {
  volverAHome();
});

$('btn-enviar-excepcion').addEventListener('click', async () => {
  const horaEntrada = $('input-excepcion-entrada').value;
  const horaSalida = $('input-excepcion-salida').value;
  if (!horaEntrada || !horaSalida) {
    mostrarError('Debes indicar ambas horas.');
    return;
  }
  mostrarCargando(true);
  try {
    const fechaKey = dateAFechaKey(new Date());
    await addDoc(collection(db, 'excepciones_horario'), {
      empleado_id: empleadoActual.id,
      fecha: fechaKey,
      hora_entrada_declarada: horaEntrada,
      hora_salida_declarada: horaSalida,
      estado: 'pendiente',
      declarado_en: serverTimestamp(),
      resuelto_por: null,
      resuelto_en: null,
    });

    // Notificación push a los admins — no bloquea el flujo si falla.
    fetch('/.netlify/functions/notify-admins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empleado_id: empleadoActual.id,
        empleado_nombre: empleadoActual.nombre,
        fecha: fechaKey,
        hora_entrada_declarada: horaEntrada,
        hora_salida_declarada: horaSalida,
      }),
    }).catch(() => {});

    mostrarCargando(false);
    $('confirmacion-nombre').textContent = empleadoActual.nombre;
    $('confirmacion-tipo').textContent = 'Solicitud de cambio de horario enviada';
    $('confirmacion-hora').textContent = 'Pendiente de aprobación';
    mostrarScreen('screen-confirmacion');
  } catch (e) {
    mostrarCargando(false);
    mostrarError('No se pudo enviar la solicitud. Verifica la conexión e intenta de nuevo.');
  }
});
