// Service worker de Firebase Cloud Messaging — recibe las notificaciones
// push cuando el panel admin NO está en primer plano. Debe vivir en la raíz
// del sitio (Netlify lo sirve como /firebase-messaging-sw.js) porque así lo
// busca por defecto el SDK de FCM al registrar el token.
//
// IMPORTANTE: estos valores deben coincidir EXACTAMENTE con js/firebase-config.js.
// Se duplican aquí a propósito: un service worker "classic" no puede
// importar un módulo ES de otro archivo del proyecto sin build system.
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'TODO_API_KEY',
  authDomain: 'TODO_PROYECTO.firebaseapp.com',
  projectId: 'TODO_PROYECTO',
  storageBucket: 'TODO_PROYECTO.appspot.com',
  messagingSenderId: 'TODO_SENDER_ID',
  appId: 'TODO_APP_ID',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'Control Horario', {
    body: body || 'Tienes una solicitud pendiente de revisar.',
  });
});
