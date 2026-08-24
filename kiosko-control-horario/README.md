# Kiosko de Control Horario — Producción

Control horario estricto para personal de producción de la empresa textil
(Jardín, Antioquia). Kiosko fijo en tablet + panel administrador. Calcula y
clasifica automáticamente horas ordinarias, extra y dominical/festivo para
exportar un consolidado en Excel a Gestión Humana — **no liquida nómina**.

Módulo 1 de 3 (siguen inventario y consignación, fuera de este alcance).

## Stack

- Front-end: HTML/CSS/JS vanilla (módulos ES), sin build system.
- Backend: Firebase (Firestore + Storage + Authentication + Cloud Messaging).
- 1 función serverless de Netlify (`netlify/functions/notify-admins.js`) —
  necesaria porque las notificaciones push reales (con la app cerrada)
  requieren un servidor que llame a Firebase Admin SDK; Firestore por sí
  solo no puede "empujar" un push sin backend. Es la única pieza que no es
  puro Firebase, y corre gratis dentro del plan gratuito de Netlify.
- Excel: SheetJS (`xlsx`) del lado del cliente, vía CDN.

## Estructura

```
kiosko-control-horario/
  index.html              Kiosko de empleados (tablet fija en planta)
  admin.html               Panel administrador (Alejandro y Yeison)
  firebase-messaging-sw.js Service worker de notificaciones push (raíz del sitio)
  css/
  js/
    firebase-config.js     Claves del proyecto Firebase (completar)
    firebase-init.js       Bootstrap de Firebase + sesión anónima + hashing
    config-recargos.js     Constantes de recargos — TODO revisar con contador
    festivos.js            Festivos de Colombia (calculados, no guardados)
    horario-logic.js       Motor de reglas: tolerancia, hora efectiva, clasificación
    kiosko.js               Lógica del kiosko
    admin.js                 Lógica del panel admin
  netlify/functions/notify-admins.js
  firestore.rules
  storage.rules
  netlify.toml
  package.json              Solo para la función serverless (firebase-admin)
```

## Puesta en marcha

### 1. Crear el proyecto Firebase (nuevo y separado)

1. [Firebase Console](https://console.firebase.google.com) → crear proyecto nuevo.
2. Activar **Firestore Database** (modo producción, región más cercana a Colombia).
3. Activar **Storage**.
4. Activar **Authentication** → método **Correo/Contraseña** → crear ahí las
   dos cuentas de administrador (Alejandro y Yeison).
5. Activar **Cloud Messaging** (gratis, no requiere plan Blaze).
6. Project settings → tus apps → agregar app Web → copiar el `firebaseConfig`
   a `js/firebase-config.js`.
7. Project settings → Cloud Messaging → Web configuration → generar/copiar la
   **VAPID key** a `FCM_VAPID_KEY` en el mismo archivo.
8. **Duplicar los mismos valores** en `firebase-messaging-sw.js` (un service
   worker clásico no puede importar el módulo `.js` del proyecto).
9. Desplegar las reglas: con Firebase CLI, `firebase deploy --only firestore:rules,storage:rules`
   (o pegarlas manualmente en la consola: Firestore → Rules, Storage → Rules).

### 2. Función serverless (notificaciones push)

1. Project settings → Service accounts → **Generate new private key** (descarga un `.json`).
2. En Netlify: Site settings → Environment variables → crear
   `FIREBASE_SERVICE_ACCOUNT_JSON` con el contenido completo de ese `.json`
   pegado en una sola línea.
3. Netlify instala `firebase-admin` automáticamente (`package.json`) al
   construir el sitio.

### 3. Desplegar en Netlify

- Conectar este repositorio (o arrastrar la carpeta `kiosko-control-horario/`
  a Netlify Drop para una prueba rápida).
- Si se conecta el repo completo, configurar **Base directory** =
  `kiosko-control-horario` en Netlify (este repo tiene otros proyectos en la raíz).
- `netlify.toml` ya define `publish = "."` y `functions = "netlify/functions"`.

### 4. Cargar los primeros datos

Todo se crea desde el panel admin (`admin.html`) una vez despliegue y hayas
iniciado sesión con una de las cuentas de Authentication:

1. Pestaña **Empleados** → crear cada empleado (cédula, nombre, cargo,
   contraseña inicial). Avísale la contraseña para que la cambie si luego
   agregas esa función (no está en el alcance de este módulo).
2. Pestaña **Horarios** → crear la primera versión de horario de cada
   empleado (vigente desde su fecha de ingreso o desde hoy).
3. Pestaña admin → botón **Activar notificaciones** en cada dispositivo/
   navegador desde el que Alejandro o Yeison quieran recibir avisos push.
4. Dejar `index.html` abierto en modo kiosko en la tablet de planta.

## Reglas de negocio implementadas (resumen)

- Tolerancia de 5 min en **entrada_manana** y **entrada_almuerzo**: temprano
  nunca justifica; tarde ≤5 min no justifica pero sí cuenta para correr la
  jornada (cero tolerancia en el cálculo); tarde >5 min exige justificación.
- **salida_jornada**: cero tolerancia, cualquier salida anticipada exige
  justificación; salir después nunca justifica (se vuelve extra automático).
- `hora_salida_efectiva = hora_salida_programada + minutos_tardanza_dia`,
  solo si `ajuste_por_tardanza = true`. La jornada ordinaria siempre se paga
  completa — esto solo corre el punto donde empieza la hora extra.
- Excepciones de horario: declaradas por el empleado, pendientes hasta que
  un admin aprueba/rechaza (transacción de Firestore — el primero que
  resuelve gana, desaparece en tiempo real de la lista del otro admin). Solo
  afecta esa fecha exacta; al día siguiente vuelve solo al horario vigente.
- Historial de horarios **versionado, nunca editado**: cada horario nuevo
  simplemente tiene un `vigente_desde` más reciente; la resolución toma
  siempre el más reciente aplicable a la fecha, así que nunca hace falta
  tocar (ni las reglas de Firestore permiten tocar) un horario ya creado.
- Festivos de Colombia: calculados por algoritmo (Pascua + Ley Emiliani), no
  se guardan a mano.
- Clasificación de horas: ordinaria/extra × diurna/nocturna ×
  ordinario/dominical-festivo. El consolidado exportado agrupa esto en las 5
  columnas pedidas; un detalle más granular (incluye el recargo nocturno
  dentro de la jornada ordinaria, 35%) queda en la segunda hoja del Excel
  ("Detalle recargos") para que nómina tenga toda la información aunque no
  esté en las columnas principales.

## Decisiones que se apartan (por necesidad) del prompt original

- **`empleados.salt`**: se agregó un campo `salt` (no estaba en el modelo de
  datos original) porque un `password_hash` sin sal por empleado es
  criptográficamente débil incluso para SHA-256. Se genera al crear el
  empleado y es la sal que se concatena antes de hashear.
- **`resumen_diario` (colección nueva)**: no estaba en el modelo de datos
  original. Se agregó porque el cálculo de horas requiere los 4 timestamps
  del día + el horario vigente + los festivos — recalcular eso cada vez que
  el panel admin genera un Excel sería lento e implicaría reimplementar la
  lógica dos veces. El kiosko calcula y guarda el resumen del día al marcar
  `salida_jornada`; el panel admin lo recalcula solo si aprueba una
  excepción retroactiva para un día que ya cerró. El Excel se genera leyendo
  esta colección, no recalculando desde cero.
- **`admin_tokens` (colección nueva)**: guarda los tokens FCM de los
  administradores que activaron notificaciones, para que la función
  serverless sepa a quién enviarle el push.

## Seguridad del login del kiosko (limitación conocida)

El kiosko **no usa Firebase Authentication por empleado** (no tienen correo,
y el prompt pide login por cédula+contraseña). Esto significa que, sin un
backend propio, la verificación de contraseña ocurre en el navegador: el
kiosko necesita poder leer el documento `empleados/{cedula}` (incluido
`password_hash`) para compararlo.

Mitigaciones aplicadas en `firestore.rules`:

- Solo se permite **leer un documento puntual por cédula** (`get`), nunca
  **listar** la colección completa — no se puede descargar la lista de
  hashes de todos los empleados.
- El kiosko se autentica con Firebase Auth **anónimo** al cargar la página,
  así que cualquier acceso a Firestore exige al menos pasar por Firebase
  Auth (cierra el paso a bots que golpeen la REST API sin más).
- Las contraseñas nunca se guardan ni se transmiten en texto plano, solo su
  hash SHA-256 con sal.

Esto **no es tan fuerte como un backend propio** verificando contraseñas.
Es una limitación inherente a "sin backend adicional" + "login sin correo".
Mitigación adicional recomendada, fuera de este módulo: restringir el
dispositivo (la tablet) a la red local de la planta, y considerar contraseñas
tipo PIN corto que se roten periódicamente en vez de contraseñas permanentes.

## Pendientes explícitos antes de producción

- **Porcentajes de recargo** (`js/config-recargos.js`, constantes `RECARGOS`)
  — todos marcados `// TODO: verificar con contador antes de producción`.
  Ninguno es definitivo.
- **Franja diurna/nocturna** (6 a.m.–9 p.m. / 9 p.m.–6 a.m.) — cambió con la
  Ley 2101 de 2021, confirmar con contador que sigue vigente y aplica igual
  a esta empresa.
- **Jornada máxima semanal** — configurada en 42h (`JORNADA_MAXIMA_SEMANAL_HORAS`),
  confirmar que ya aplica el último tramo de la reducción gradual de la Ley 2101.
- **Dominical habitual vs. ocasional**: la app registra que se trabajó un
  dominical/festivo pero **no calcula** si es habitual u ocasional para ese
  empleado (afecta si se compensa con descanso o solo con recargo en
  dinero) — queda pendiente de definir con el contador.
- **Respaldo legal de "la jornada se corre por tardanza"**: la app
  implementa la lógica, pero el reglamento interno de trabajo que la
  respalde legalmente está pendiente de redactar y firmar. No usar en
  producción para liquidar sin ese respaldo.
- Este módulo **no calcula pago en pesos**, solo horas clasificadas.

## Fuera de alcance de este módulo

Inventario (materia prima, en proceso, terminado) y consignación son los
módulos 2 y 3, no incluidos aquí.
