// Función serverless de Netlify: envía una notificación push (FCM) a todos
// los administradores que hayan activado notificaciones en el panel admin,
// cuando el kiosko crea una nueva excepción de horario pendiente.
//
// Requiere la variable de entorno FIREBASE_SERVICE_ACCOUNT_JSON en Netlify
// (Site settings > Environment variables) con el JSON completo de una
// service account de este proyecto Firebase (Firebase Console > Project
// settings > Service accounts > Generate new private key), pegado como
// una sola línea.
const admin = require('firebase-admin');

let inicializado = false;
function asegurarAdminApp() {
  if (inicializado) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT_JSON');
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  inicializado = true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'JSON inválido' };
  }

  const { empleado_nombre, fecha, hora_entrada_declarada, hora_salida_declarada } = body;
  if (!empleado_nombre || !fecha) {
    return { statusCode: 400, body: 'Faltan datos (empleado_nombre, fecha)' };
  }

  try {
    asegurarAdminApp();
    const db = admin.firestore();
    const tokensSnap = await db.collection('admin_tokens').get();
    const tokens = tokensSnap.docs.map((d) => d.data().token).filter(Boolean);

    if (tokens.length === 0) {
      return { statusCode: 200, body: 'Sin administradores con notificaciones activas todavía.' };
    }

    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: 'Nueva excepción de horario pendiente',
        body: `${empleado_nombre} · ${fecha} · ${hora_entrada_declarada || '?'}–${hora_salida_declarada || '?'}`,
      },
    });

    return { statusCode: 200, body: JSON.stringify({ enviados: resp.successCount, fallidos: resp.failureCount }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'Error enviando la notificación push.' };
  }
};
