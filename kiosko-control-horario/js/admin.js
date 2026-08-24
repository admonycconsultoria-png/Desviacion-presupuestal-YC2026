import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, query, where, orderBy,
  onSnapshot, runTransaction, Timestamp, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getMessaging, getToken, isSupported as messagingIsSupported,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js';

import { app, db, auth, generarSalt, calcularPasswordHash } from './firebase-init.js';
import { FCM_VAPID_KEY } from './firebase-config.js';
import {
  resolverHorarioDelDia, evaluarEntrada, calcularHoraSalidaEfectiva, clasificarJornada,
  combinarFechaYHora, dateAFechaKey, fechaKeyADate,
} from './horario-logic.js';
import { RECARGOS, HORA_INICIO_DIURNO, HORA_INICIO_NOCTURNO } from './config-recargos.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------
const empleadosById = new Map(); // cedula -> {nombre, cargo, activo, ...}
let unsubPendientes = null;
let unsubHistorial = null;

function mostrarCargando(v) { $('admin-overlay-cargando').hidden = !v; }
function aDate(ts) { return ts && ts.toDate ? ts.toDate() : new Date(ts); }

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
$('form-admin-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('admin-login-error').hidden = true;
  try {
    await signInWithEmailAndPassword(auth, $('admin-email').value.trim(), $('admin-password').value);
  } catch (e) {
    $('admin-login-error').textContent = 'Correo o contraseña incorrectos.';
    $('admin-login-error').hidden = false;
  }
});

$('btn-admin-logout').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  const esAdmin = !!user && user.providerData.some((p) => p.providerId === 'password');
  if (esAdmin) {
    $('admin-login').hidden = true;
    $('admin-app').hidden = false;
    $('admin-user-email').textContent = user.email;
    await cargarEmpleados();
    activarListenersRealtime();
  } else {
    $('admin-login').hidden = false;
    $('admin-app').hidden = true;
    if (unsubPendientes) unsubPendientes();
    if (unsubHistorial) unsubHistorial();
  }
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('tab-active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('tab-panel-active'));
    btn.classList.add('tab-active');
    $(btn.dataset.tab).classList.add('tab-panel-active');
  });
});

// ---------------------------------------------------------------------------
// Empleados
// ---------------------------------------------------------------------------
async function cargarEmpleados() {
  const snap = await getDocs(collection(db, 'empleados'));
  empleadosById.clear();
  snap.docs.forEach((d) => empleadosById.set(d.id, d.data()));
  renderListaEmpleados();
  poblarSelectsEmpleado();
}

function renderListaEmpleados() {
  const cont = $('lista-empleados');
  cont.innerHTML = '';
  [...empleadosById.entries()].sort((a, b) => a[1].nombre.localeCompare(b[1].nombre)).forEach(([cedula, emp]) => {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.innerHTML = `
      <p class="card-item-titulo">${emp.nombre} <span class="estado-chip ${emp.activo === false ? 'estado-rechazado' : 'estado-aprobado'}">${emp.activo === false ? 'Inactivo' : 'Activo'}</span></p>
      <p class="card-item-sub">Cédula ${cedula} · ${emp.cargo || ''}</p>
      <div class="card-item-acciones">
        <button class="btn btn-small btn-secondary" data-toggle="${cedula}">${emp.activo === false ? 'Reactivar' : 'Desactivar'}</button>
      </div>`;
    cont.appendChild(div);
  });
  cont.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cedula = btn.dataset.toggle;
      const actual = empleadosById.get(cedula);
      await updateDoc(doc(db, 'empleados', cedula), { activo: actual.activo === false });
      await cargarEmpleados();
    });
  });
}

function poblarSelectsEmpleado() {
  const opciones = [...empleadosById.entries()]
    .sort((a, b) => a[1].nombre.localeCompare(b[1].nombre))
    .map(([cedula, emp]) => `<option value="${cedula}">${emp.nombre}</option>`).join('');

  $('horario-empleado').innerHTML = opciones;
  $('horario-filtro-empleado').innerHTML = opciones;
  $('export-empleado').innerHTML = '<option value="">Todos</option>' + opciones;
}

$('form-nuevo-empleado').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const cedula = $('emp-cedula').value.trim();
  const nombre = $('emp-nombre').value.trim();
  const cargo = $('emp-cargo').value.trim();
  const password = $('emp-password').value;
  const msg = $('emp-crear-msg');
  msg.hidden = true;
  try {
    const existente = await getDoc(doc(db, 'empleados', cedula));
    if (existente.exists()) throw new Error('YA_EXISTE');
    const salt = generarSalt();
    const password_hash = await calcularPasswordHash(password, salt);
    await setDoc(doc(db, 'empleados', cedula), {
      nombre, cargo, password_hash, salt, activo: true, foto_referencia: null,
    });
    msg.textContent = 'Empleado creado.';
    msg.className = 'msg-text ok';
    msg.hidden = false;
    ev.target.reset();
    await cargarEmpleados();
  } catch (e) {
    msg.textContent = e.message === 'YA_EXISTE' ? 'Ya existe un empleado con esa cédula.' : 'No se pudo crear el empleado.';
    msg.className = 'msg-text error';
    msg.hidden = false;
  }
});

// ---------------------------------------------------------------------------
// Pendientes de aprobación (tiempo real)
// ---------------------------------------------------------------------------
function activarListenersRealtime() {
  if (unsubPendientes) unsubPendientes();
  unsubPendientes = onSnapshot(
    query(collection(db, 'excepciones_horario'), where('estado', '==', 'pendiente')),
    (snap) => renderPendientes(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
  );

  if (unsubHistorial) unsubHistorial();
  unsubHistorial = onSnapshot(
    query(collection(db, 'excepciones_horario'), where('estado', 'in', ['aprobado', 'rechazado']), orderBy('resuelto_en', 'desc')),
    (snap) => renderHistorial(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
  );
}

function nombreEmpleado(cedula) {
  return empleadosById.get(cedula)?.nombre || cedula;
}

function renderPendientes(items) {
  const cont = $('lista-pendientes');
  const badge = $('badge-pendientes');
  cont.innerHTML = '';
  $('pendientes-vacio').hidden = items.length > 0;
  badge.hidden = items.length === 0;
  badge.textContent = items.length;

  items.sort((a, b) => (aDate(b.declarado_en) - aDate(a.declarado_en)));
  items.forEach((it) => {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.innerHTML = `
      <p class="card-item-titulo">${nombreEmpleado(it.empleado_id)}</p>
      <p class="card-item-sub">Fecha: ${it.fecha}</p>
      <p class="card-item-sub">Horario declarado: ${it.hora_entrada_declarada} – ${it.hora_salida_declarada}</p>
      <div class="card-item-acciones">
        <button class="btn btn-small btn-primary" data-aprobar="${it.id}">Aprobar</button>
        <button class="btn btn-small btn-danger" data-rechazar="${it.id}">Rechazar</button>
      </div>`;
    cont.appendChild(div);
  });

  cont.querySelectorAll('[data-aprobar]').forEach((btn) => {
    btn.addEventListener('click', () => resolverExcepcion(btn.dataset.aprobar, 'aprobado'));
  });
  cont.querySelectorAll('[data-rechazar]').forEach((btn) => {
    btn.addEventListener('click', () => resolverExcepcion(btn.dataset.rechazar, 'rechazado'));
  });
}

function renderHistorial(items) {
  const cont = $('lista-historial');
  cont.innerHTML = '';
  items.forEach((it) => {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.innerHTML = `
      <p class="card-item-titulo">${nombreEmpleado(it.empleado_id)}
        <span class="estado-chip ${it.estado === 'aprobado' ? 'estado-aprobado' : 'estado-rechazado'}">${it.estado}</span>
      </p>
      <p class="card-item-sub">Fecha: ${it.fecha} · Declarado: ${it.hora_entrada_declarada} – ${it.hora_salida_declarada}</p>
      <p class="card-item-sub">Resuelto por: ${it.resuelto_por_email || it.resuelto_por || '—'}</p>`;
    cont.appendChild(div);
  });
}

async function resolverExcepcion(id, nuevoEstado) {
  mostrarCargando(true);
  try {
    let datosExcepcion = null;
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'excepciones_horario', id);
      const snap = await tx.get(ref);
      if (!snap.exists() || snap.data().estado !== 'pendiente') {
        throw new Error('YA_RESUELTA');
      }
      datosExcepcion = snap.data();
      tx.update(ref, {
        estado: nuevoEstado,
        resuelto_por: auth.currentUser.uid,
        resuelto_por_email: auth.currentUser.email,
        resuelto_en: serverTimestamp(),
      });
    });

    if (nuevoEstado === 'aprobado' && datosExcepcion) {
      await recomputeResumenSiExiste(datosExcepcion.empleado_id, datosExcepcion.fecha);
    }
  } catch (e) {
    if (e.message === 'YA_RESUELTA') {
      alert('Esta solicitud ya fue resuelta por otro administrador.');
    } else {
      alert('No se pudo procesar la solicitud. Verifica la conexión.');
    }
  } finally {
    mostrarCargando(false);
  }
}

/**
 * Tras aprobar una excepción retroactiva, si el empleado ya cerró el día
 * (marcó salida_jornada), recalcula resumen_diario con el horario declarado
 * como horario base de ESE día — sin tocar las marcaciones originales
 * (son inmutables), solo la clasificación derivada.
 */
async function recomputeResumenSiExiste(empleadoId, fechaKey) {
  const snap = await getDocs(query(
    collection(db, 'marcaciones'),
    where('empleado_id', '==', empleadoId),
    where('fecha', '==', fechaKey),
  ));
  const marcaciones = snap.docs.map((d) => d.data());
  const entradaManana = marcaciones.find((m) => m.tipo === 'entrada_manana');
  const salidaAlmuerzo = marcaciones.find((m) => m.tipo === 'salida_almuerzo');
  const entradaAlmuerzo = marcaciones.find((m) => m.tipo === 'entrada_almuerzo');
  const salidaJornada = marcaciones.find((m) => m.tipo === 'salida_jornada');
  if (!entradaManana || !salidaAlmuerzo || !entradaAlmuerzo || !salidaJornada) return; // el día aún no cierra

  const historialSnap = await getDocs(query(collection(db, 'horarios_empleado'), where('empleado_id', '==', empleadoId)));
  const historial = historialSnap.docs.map((d) => d.data());
  const excepcionSnap = await getDocs(query(
    collection(db, 'excepciones_horario'),
    where('empleado_id', '==', empleadoId),
    where('fecha', '==', fechaKey),
  ));
  const excepcionAprobada = excepcionSnap.docs.map((d) => d.data()).find((e) => e.estado === 'aprobado') || null;

  const fecha = fechaKeyADate(fechaKey);
  const horarioDia = resolverHorarioDelDia(historial, excepcionAprobada, fecha);
  if (!horarioDia) return;

  const horaProgEM = combinarFechaYHora(fecha, horarioDia.hora_entrada);
  const evalEM = evaluarEntrada(horaProgEM, aDate(entradaManana.timestamp));
  const horaProgEA = new Date(aDate(salidaAlmuerzo.timestamp).getTime() + (horarioDia.duracion_almuerzo_minutos || 0) * 60000);
  const evalEA = evaluarEntrada(horaProgEA, aDate(entradaAlmuerzo.timestamp));
  const horaSalidaEfectiva = calcularHoraSalidaEfectiva(
    horarioDia, fecha, evalEM.minutosTardanzaParaJornada, evalEA.minutosTardanzaParaJornada,
  );

  const { consolidado, detalle } = clasificarJornada({
    entradaManana: aDate(entradaManana.timestamp),
    salidaAlmuerzo: aDate(salidaAlmuerzo.timestamp),
    entradaAlmuerzo: aDate(entradaAlmuerzo.timestamp),
    salidaJornada: aDate(salidaJornada.timestamp),
    horaSalidaEfectiva,
  });

  await setDoc(doc(db, 'resumen_diario', `${empleadoId}_${fechaKey}`), {
    empleado_id: empleadoId,
    fecha: fechaKey,
    consolidado,
    detalle,
    horario_usado: {
      hora_entrada: horarioDia.hora_entrada,
      hora_salida: horarioDia.hora_salida,
      ajuste_por_tardanza: horarioDia.ajuste_por_tardanza,
      origen: horarioDia._origen,
    },
    hora_salida_efectiva: Timestamp.fromDate(horaSalidaEfectiva),
    generado_en: serverTimestamp(),
    recalculado: true,
  });
}

// ---------------------------------------------------------------------------
// Horarios
// ---------------------------------------------------------------------------
$('form-nuevo-horario').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('horario-crear-msg');
  msg.hidden = true;
  try {
    const dias = [...document.querySelectorAll('#form-nuevo-horario .dias-check input:checked')].map((i) => i.value);
    await addDoc(collection(db, 'horarios_empleado'), {
      empleado_id: $('horario-empleado').value,
      dias_laborales: dias,
      hora_entrada: $('horario-entrada').value,
      hora_salida: $('horario-salida').value,
      duracion_almuerzo_minutos: Number($('horario-almuerzo').value),
      ajuste_por_tardanza: $('horario-ajuste').checked,
      vigente_desde: $('horario-desde').value,
      vigente_hasta: $('horario-hasta').value || null,
    });
    msg.textContent = 'Horario guardado.';
    msg.className = 'msg-text ok';
    msg.hidden = false;
    ev.target.reset();
    if ($('horario-filtro-empleado').value) cargarHistorialHorarios($('horario-filtro-empleado').value);
  } catch (e) {
    msg.textContent = 'No se pudo guardar el horario.';
    msg.className = 'msg-text error';
    msg.hidden = false;
  }
});

$('horario-filtro-empleado').addEventListener('change', (ev) => cargarHistorialHorarios(ev.target.value));

async function cargarHistorialHorarios(empleadoId) {
  const cont = $('lista-horarios');
  if (!empleadoId) { cont.innerHTML = ''; return; }
  const snap = await getDocs(query(collection(db, 'horarios_empleado'), where('empleado_id', '==', empleadoId)));
  const horarios = snap.docs.map((d) => d.data()).sort((a, b) => (a.vigente_desde < b.vigente_desde ? 1 : -1));
  cont.innerHTML = '';
  horarios.forEach((h) => {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.innerHTML = `
      <p class="card-item-titulo">${h.hora_entrada} – ${h.hora_salida} (almuerzo ${h.duracion_almuerzo_minutos} min)</p>
      <p class="card-item-sub">Vigente desde ${h.vigente_desde} ${h.vigente_hasta ? `hasta ${h.vigente_hasta}` : '(actual)'}</p>
      <p class="card-item-sub">Días: ${h.dias_laborales.join(', ')} · Ajuste por tardanza: ${h.ajuste_por_tardanza ? 'Sí' : 'No'}</p>`;
    cont.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Exportar a Excel
// ---------------------------------------------------------------------------
$('export-rango').addEventListener('change', actualizarRangoExport);
$('export-desde').addEventListener('change', actualizarRangoExport);

function actualizarRangoExport() {
  const rango = $('export-rango').value;
  const hastaInput = $('export-hasta');
  if (rango === 'libre') { hastaInput.readOnly = false; return; }

  const desdeVal = $('export-desde').value || dateAFechaKey(new Date());
  $('export-desde').value = desdeVal;
  const desde = fechaKeyADate(desdeVal);
  let hasta = new Date(desde);
  if (rango === 'dia') hasta = new Date(desde);
  if (rango === 'semana') hasta.setDate(hasta.getDate() + 6);
  if (rango === 'quincena') hasta.setDate(hasta.getDate() + 14);
  $('export-hasta').value = dateAFechaKey(hasta);
  hastaInput.readOnly = true;
}
actualizarRangoExport();

$('btn-exportar').addEventListener('click', async () => {
  const desde = $('export-desde').value;
  const hasta = $('export-hasta').value;
  const empleadoFiltro = $('export-empleado').value;
  const msg = $('export-msg');
  msg.hidden = true;
  if (!desde || !hasta) {
    msg.textContent = 'Selecciona el rango de fechas.';
    msg.className = 'msg-text error';
    msg.hidden = false;
    return;
  }

  mostrarCargando(true);
  try {
    const restricciones = [where('fecha', '>=', desde), where('fecha', '<=', hasta)];
    if (empleadoFiltro) restricciones.push(where('empleado_id', '==', empleadoFiltro));
    const snap = await getDocs(query(collection(db, 'resumen_diario'), ...restricciones));
    const filas = snap.docs.map((d) => d.data()).sort((a, b) => {
      const nombreA = nombreEmpleado(a.empleado_id);
      const nombreB = nombreEmpleado(b.empleado_id);
      return nombreA === nombreB ? a.fecha.localeCompare(b.fecha) : nombreA.localeCompare(nombreB);
    });

    if (filas.length === 0) {
      msg.textContent = 'No hay resúmenes diarios para ese rango/empleado (recuerda que el resumen se genera al marcar salida de jornada).';
      msg.className = 'msg-text error';
      msg.hidden = false;
      return;
    }

    generarExcel(filas, desde, hasta);
    msg.textContent = 'Excel generado.';
    msg.className = 'msg-text ok';
    msg.hidden = false;
  } catch (e) {
    msg.textContent = 'No se pudo generar el Excel. Puede que Firestore requiera crear un índice compuesto (revisa la consola del navegador para el enlace).';
    msg.className = 'msg-text error';
    msg.hidden = false;
    console.error(e);
  } finally {
    mostrarCargando(false);
  }
});

function generarExcel(filas, desde, hasta) {
  const encabezadoConsolidado = ['Empleado', 'Fecha', 'Horas ordinarias', 'Horas extra diurna', 'Horas extra nocturna', 'Horas dominical/festivo diurna', 'Horas dominical/festivo nocturna', 'Total del período'];
  const filasConsolidado = [encabezadoConsolidado];

  const encabezadoDetalle = ['Empleado', 'Fecha', 'Ordinaria diurna', 'Recargo nocturno ordinario', 'Extra diurna', 'Extra nocturna', 'Dominical/festivo ordinario diurno', 'Dominical/festivo ordinario nocturno', 'Dominical/festivo extra diurna', 'Dominical/festivo extra nocturna'];
  const filasDetalle = [encabezadoDetalle];

  const totalesPorEmpleado = new Map();

  filas.forEach((f) => {
    const nombre = nombreEmpleado(f.empleado_id);
    const c = f.consolidado;
    filasConsolidado.push([nombre, f.fecha, c.horasOrdinarias, c.horasExtraDiurna, c.horasExtraNocturna, c.horasDominicalFestivoDiurna, c.horasDominicalFestivoNocturna, c.total]);

    const d = f.detalle;
    filasDetalle.push([nombre, f.fecha, d.ordinariaDiurna, d.recargoNocturnoOrdinario, d.extraDiurna, d.extraNocturna, d.dominicalFestivoOrdinarioDiurno, d.dominicalFestivoOrdinarioNocturno, d.dominicalFestivoExtraDiurna, d.dominicalFestivoExtraNocturna]);

    if (!totalesPorEmpleado.has(nombre)) {
      totalesPorEmpleado.set(nombre, { horasOrdinarias: 0, horasExtraDiurna: 0, horasExtraNocturna: 0, horasDominicalFestivoDiurna: 0, horasDominicalFestivoNocturna: 0, total: 0 });
    }
    const t = totalesPorEmpleado.get(nombre);
    t.horasOrdinarias += c.horasOrdinarias;
    t.horasExtraDiurna += c.horasExtraDiurna;
    t.horasExtraNocturna += c.horasExtraNocturna;
    t.horasDominicalFestivoDiurna += c.horasDominicalFestivoDiurna;
    t.horasDominicalFestivoNocturna += c.horasDominicalFestivoNocturna;
    t.total += c.total;
  });

  filasConsolidado.push([]);
  totalesPorEmpleado.forEach((t, nombre) => {
    filasConsolidado.push([`TOTAL PERÍODO — ${nombre}`, '', round2(t.horasOrdinarias), round2(t.horasExtraDiurna), round2(t.horasExtraNocturna), round2(t.horasDominicalFestivoDiurna), round2(t.horasDominicalFestivoNocturna), round2(t.total)]);
  });

  const filasConfig = [
    ['Constante', 'Valor actual (SIN CONFIRMAR)', 'Nota'],
    ['Franja diurna', `${HORA_INICIO_DIURNO}:00 – ${HORA_INICIO_NOCTURNO}:00`, 'TODO: verificar con contador antes de producción'],
    ['Recargo nocturno ordinario', `${RECARGOS.recargoNocturnoOrdinario * 100}%`, 'TODO: verificar con contador antes de producción'],
    ['Extra diurna', `${RECARGOS.extraDiurna * 100}%`, 'TODO: verificar con contador antes de producción'],
    ['Extra nocturna', `${RECARGOS.extraNocturna * 100}%`, 'TODO: verificar con contador antes de producción'],
    ['Dominical/festivo ordinario diurno', `${RECARGOS.dominicalFestivoOrdinarioDiurno * 100}%`, 'TODO: verificar con contador antes de producción'],
    ['Dominical/festivo ordinario nocturno', `${RECARGOS.dominicalFestivoOrdinarioNocturno * 100}%`, 'TODO: verificar con contador antes de producción'],
    ['Dominical/festivo extra diurna', `${RECARGOS.dominicalFestivoExtraDiurna * 100}%`, 'TODO: verificar con contador antes de producción'],
    ['Dominical/festivo extra nocturna', `${RECARGOS.dominicalFestivoExtraNocturna * 100}%`, 'TODO: verificar con contador antes de producción'],
    [],
    ['Este consolidado clasifica HORAS por tipo. No calcula valores en pesos', 'no reemplaza la liquidación de nómina.'],
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filasConsolidado), 'Consolidado');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filasDetalle), 'Detalle recargos');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filasConfig), 'Config recargos (TODO)');
  XLSX.writeFile(wb, `consolidado_horas_${desde}_a_${hasta}.xlsx`);
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------------------
// Notificaciones push (FCM)
// ---------------------------------------------------------------------------
$('btn-activar-notificaciones').addEventListener('click', async () => {
  try {
    if (!(await messagingIsSupported())) {
      alert('Este navegador no soporta notificaciones push.');
      return;
    }
    const permiso = await Notification.requestPermission();
    if (permiso !== 'granted') {
      alert('Debes permitir las notificaciones para recibir avisos de solicitudes pendientes.');
      return;
    }
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: FCM_VAPID_KEY });
    await setDoc(doc(db, 'admin_tokens', auth.currentUser.uid), {
      token, email: auth.currentUser.email, actualizado_en: serverTimestamp(),
    });
    alert('Notificaciones activadas en este dispositivo.');
  } catch (e) {
    console.error(e);
    alert('No se pudieron activar las notificaciones. Revisa la consola para más detalle.');
  }
});
