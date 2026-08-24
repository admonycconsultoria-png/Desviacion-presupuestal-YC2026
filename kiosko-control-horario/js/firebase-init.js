// Bootstrap de Firebase compartido por kiosko.js y admin.js. Se importa como
// módulo ES directamente desde el CDN de Firebase — sin build system, tal
// como pide el stack (HTML/CSS/JS vanilla).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore, connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getStorage, connectStorageEmulator,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import {
  getAuth, connectAuthEmulator, signInAnonymously, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const auth = getAuth(app);

/**
 * Garantiza que el kiosko tenga una sesión de Firebase Auth (anónima) antes
 * de tocar Firestore/Storage — ver firestore.rules para el porqué. No
 * identifica al empleado; el login real por cédula+contraseña es aparte.
 */
export function asegurarSesionAnonima() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      if (user) {
        resolve(user);
        return;
      }
      signInAnonymously(auth).then((cred) => resolve(cred.user)).catch(reject);
    });
  });
}

/** SHA-256 en hex vía Web Crypto API (sin librerías externas). */
export async function sha256Hex(texto) {
  const datos = new TextEncoder().encode(texto);
  const hashBuffer = await crypto.subtle.digest('SHA-256', datos);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Sal aleatoria en hex, para generar password_hash de un empleado nuevo. */
export function generarSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** password_hash = sha256(salt + ':' + password). El salt se guarda aparte en el doc del empleado. */
export async function calcularPasswordHash(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}
