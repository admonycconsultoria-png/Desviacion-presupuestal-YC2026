// Config del proyecto Firebase — completar con los valores reales del proyecto
// NUEVO Y SEPARADO que se cree para esta app (Firebase Console > Configuración
// del proyecto > tus apps > SDK setup and configuration).
//
// Este archivo es público (se sirve desde el navegador) por diseño: las claves
// de Firebase Web NO son secretas, la seguridad real la dan las Firestore/Storage
// Security Rules (ver firestore.rules y storage.rules) y NO deben confundirse
// con credenciales de servidor.

export const firebaseConfig = {
  apiKey: "TODO_API_KEY",
  authDomain: "TODO_PROYECTO.firebaseapp.com",
  projectId: "TODO_PROYECTO",
  storageBucket: "TODO_PROYECTO.appspot.com",
  messagingSenderId: "TODO_SENDER_ID",
  appId: "TODO_APP_ID",
};

// VAPID key pública para Firebase Cloud Messaging (Console > Project settings >
// Cloud Messaging > Web configuration > Web Push certificates). Necesaria solo
// en admin.js para registrar el token push del navegador del administrador.
export const FCM_VAPID_KEY = "TODO_VAPID_KEY";
