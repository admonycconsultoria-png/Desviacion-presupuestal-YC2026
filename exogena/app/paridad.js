// Ejecuta el motor JS sobre archivos locales e imprime el resultado en JSON (pruebas de paridad con Python).
// node app/paridad.js config.json fuente balance.xlsx [terceros.xlsx] [accionistas] [nomina]
const fs = require("fs");
const path = require("path");
const XLSX = require(path.join(__dirname, "vendor", "xlsx.full.min.js"));
const Exogena = require(path.join(__dirname, "motor.js"));

const [cfgPath, fuente, bal, ter, acc, nom] = process.argv.slice(2);
const leer = (p) => (!p || p === "-" ? null : Exogena.leerLibro(XLSX, new Uint8Array(fs.readFileSync(p)), p));
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const r = Exogena.ejecutar({ fuente, balance: leer(bal), terceros: leer(ter), accionistas: leer(acc), nomina: leer(nom) }, cfg);
process.stdout.write(JSON.stringify({ generados: r.generados, cuadres: r.cuadres, hallazgos: r.hallazgos, sinVerificar: r.sinVerificar }));
