/* Motor de exógena DIAN en JavaScript: misma lógica que exogena_engine (Python).
 * Corre en el navegador (aplicativo offline) y en Node (pruebas de paridad).
 * Entrada: filas crudas (arrays) de las hojas de Excel. Salida: formatos + hallazgos + cuadres.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ utilidades
  function sinTildes(t) {
    t = String(t).replace(/ñ/g, "\u0000").replace(/Ñ/g, "\u0001");
    t = t.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return t.replace(/\u0000/g, "ñ").replace(/\u0001/g, "Ñ");
  }
  function vacio(v) { return v === null || v === undefined || (typeof v === "number" && isNaN(v)); }
  function clave(v) {
    if (vacio(v)) return "";
    let t = sinTildes(String(v)).toLowerCase().replace(/ñ/g, "n");
    t = t.replace(/[^a-z0-9 ]+/g, " ");
    return t.replace(/\s+/g, " ").trim();
  }
  function textoDian(v) {
    if (vacio(v)) return "";
    let t = sinTildes(String(v)).toUpperCase();
    t = t.replace(/[^A-Z0-9Ñ #\-.]+/g, " ");
    return t.replace(/\s+/g, " ").trim();
  }
  function soloDigitos(v) {
    if (vacio(v)) return "";
    if (typeof v === "number" && Number.isInteger(v)) v = v.toFixed(0);
    return String(v).replace(/\D/g, "");
  }
  function aNumero(v) {
    if (vacio(v)) return 0;
    if (typeof v === "number") return v;
    let s = String(v).trim().replace(/\$/g, "").replace(/ /g, "");
    if (!s || s === "-" || s === "--") return 0;
    const neg = s.startsWith("(") && s.endsWith(")");
    s = s.replace(/^\(|\)$/g, "");
    if (s.includes(",") && s.includes(".")) {
      s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    } else if (s.includes(",")) {
      const p = s.split(",");
      s = p.length === 2 && p[1].length !== 3 ? s.replace(",", ".") : s.replace(/,/g, "");
    } else {
      const p = s.split(".");
      const ent = p[0].replace("-", "");
      if (p.length > 2 || (p.length === 2 && p[1].length === 3 && ent !== "" && ent !== "0" && ent.length <= 3)) s = s.replace(/\./g, "");
    }
    const n = parseFloat(s);
    if (isNaN(n)) return 0;
    return neg ? -n : n;
  }
  const r0 = (x) => Math.sign(x) * Math.floor(Math.abs(x) + 0.5); // redondeo comercial simétrico
  function agrupar(arr, fk) {
    const m = new Map();
    for (const x of arr) { const k = fk(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return m;
  }
  const suma = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const fmtPesos = (x) => "$" + Math.round(x).toLocaleString("es-CO");

  // ------------------------------------------------------------------ DV
  const PESOS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  function calcularDv(nit) {
    const d = String(nit).replace(/\D/g, "");
    if (!d || d.length > PESOS.length) throw new Error("NIT inválido para cálculo de DV: " + nit);
    let s = 0;
    const rev = d.split("").reverse();
    rev.forEach((c, i) => { s += Number(c) * PESOS[i]; });
    const r = s % 11;
    return r < 2 ? r : 11 - r;
  }
  function separarDv(v) {
    const s = vacio(v) ? "" : (typeof v === "number" ? soloDigitos(v) : String(v).trim());
    const i = s.lastIndexOf("-");
    if (i > 0) {
      const base = s.slice(0, i).replace(/\D/g, ""), dv = s.slice(i + 1).replace(/\D/g, "");
      if (base && dv.length === 1) return [base, dv];
    }
    return [s.replace(/\D/g, ""), ""];
  }

  // ------------------------------------------------------------------ lectura de tablas
  function ubicarEncabezado(filas, alias) {
    const todos = new Set();
    Object.values(alias).forEach((l) => l.forEach((a) => todos.add(clave(a))));
    let mejor = 0, idx = -1;
    for (let i = 0; i < Math.min(filas.length, 40); i++) {
      const n = (filas[i] || []).filter((v) => todos.has(clave(v))).length;
      if (n > mejor) { mejor = n; idx = i; }
    }
    if (idx < 0) throw new Error("No se encontró la fila de encabezados. Revise los alias de la fuente.");
    const enc = filas[idx].map((v) => (vacio(v) ? "" : String(v)));
    const mapa = {};
    const porClave = {};
    enc.forEach((e, j) => { const k = clave(e); if (k && !(k in porClave)) porClave[k] = j; });
    const usados = new Set();
    for (const [canon, opciones] of Object.entries(alias)) {
      for (const op of opciones) {
        const j = porClave[clave(op)];
        if (j !== undefined && !usados.has(j)) { mapa[canon] = j; usados.add(j); break; }
      }
    }
    const datos = filas.slice(idx + 1).map((f) => {
      const o = {};
      for (const [canon, j] of Object.entries(mapa)) o[canon] = f[j];
      return o;
    });
    return { datos, columnas: Object.keys(mapa), encabezados: enc };
  }

  // ------------------------------------------------------------------ fuentes
  const NATURALEZA_CREDITO = ["2", "3", "4"];

  function cargarBalance(filas, fuente, cfg, hallazgos) {
    const spec = cfg.fuentes[fuente];
    const { datos, columnas, encabezados } = ubicarEncabezado(filas, spec.balance);
    const faltan = ["cuenta", "debito", "credito"].filter((c) => !columnas.includes(c));
    if (faltan.length) throw new Error("El balance no trae las columnas " + faltan.join(", ") +
      ". Encabezados leídos: " + encabezados.filter(Boolean).join(" | "));
    let bal = datos.map((d) => {
      const [nit, dv] = separarDv(d.nit);
      return {
        _nivel: d.nivel,
        cuenta: soloDigitos(d.cuenta), nombre_cuenta: vacio(d.nombre_cuenta) ? "" : String(d.nombre_cuenta).trim(),
        nit, dv_fuente: dv, nombre_tercero: vacio(d.nombre_tercero) ? "" : String(d.nombre_tercero).trim(),
        saldo_inicial: aNumero(d.saldo_inicial), debito: aNumero(d.debito), credito: aNumero(d.credito),
        saldo_final: aNumero(d.saldo_final), _trans: d.transaccional,
      };
    });
    const filtro = spec.filtro_filas || {};
    if (filtro.excluir_nivel && columnas.includes("nivel")) {
      const k = clave(filtro.excluir_nivel);
      bal = bal.filter((r) => !clave(r._nivel).includes(k));
    }
    const porJerarquia = filtro.modo === "jerarquia_nivel" && columnas.includes("nivel");
    if (porJerarquia) bal = jerarquia(bal);
    // Movimiento con tercero en cuentas sin código contable (Alegra permite crearlas)
    for (const [nombre, g] of agrupar(bal.filter((r) => r.cuenta === "" && r.nit !== ""), (r) => r.nombre_cuenta)) {
      hallazgos.push(["ERROR", "Cuenta sin código contable", nombre || "(sin nombre)", `'${nombre}' tiene ${g.length} filas con tercero (débitos ${fmtPesos(suma(g, (r) => r.debito))}, créditos ${fmtPesos(suma(g, (r) => r.credito))}) y no tiene código PUC: asígnele código en el software o esos valores quedan por fuera de la exógena`]);
    }
    bal = bal.filter((r) => r.cuenta !== "");
    const corr = cfg.parametros.correcciones_terceros || {};
    bal.forEach((r) => { const c = corr[r.nit]; if (c && c.nit_correcto) r.nit = String(c.nit_correcto); });

    if (porJerarquia) { /* ya filtrado */ }
    else if (filtro.columna && columnas.includes(filtro.columna)) {
      const validos = new Set(filtro.valores_validos.map(clave));
      bal = bal.filter((r) => validos.has(clave(r._trans)));
    } else {
      bal = soloHojas(bal, hallazgos);
    }
    if (spec.signo_saldo === "natural") {
      bal.forEach((r) => { if (NATURALEZA_CREDITO.includes(r.cuenta[0])) { r.saldo_inicial *= -1; r.saldo_final *= -1; } });
    }
    if (bal.every((r) => r.saldo_final === 0) && bal.some((r) => r.debito || r.credito)) {
      bal.forEach((r) => { r.saldo_final = r.saldo_inicial + r.debito - r.credito; });
    }
    bal.forEach((r) => { delete r._trans; delete r._nivel; });
    return bal;
  }

  // Alegra: árbol por la columna Nivel. Filas con tercero = detalle. Una fila sin tercero abre un bloque
  // (filas más profundas o terceros con su mismo código y nivel) cuyo total ya está en el detalle:
  // solo se conserva el residuo (total − elementos directos del bloque) como movimiento sin tercero.
  function jerarquia(bal) {
    bal = bal.filter((r) => !vacio(r._nivel) && String(r._nivel).trim() !== "");
    const n = bal.length, prof = bal.map((r) => (String(r._nivel).match(/>/g) || []).length), fin = new Array(n);
    const C = ["saldo_inicial", "debito", "credito", "saldo_final"];
    for (let i = n - 1; i >= 0; i--) {
      if (bal[i].nit !== "") { fin[i] = i + 1; continue; }
      let j = i + 1;
      while (j < n && (prof[j] > prof[i] || (prof[j] === prof[i] && bal[j].cuenta === bal[i].cuenta && bal[j].nit !== "")))
        j = bal[j].nit === "" && prof[j] > prof[i] ? fin[j] : j + 1;
      fin[i] = j;
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      if (bal[i].nit !== "") { out.push(bal[i]); continue; }
      const resto = { ...bal[i] };
      let j = i + 1;
      while (j < fin[i]) { C.forEach((c) => { resto[c] -= bal[j][c]; }); j = bal[j].nit === "" ? fin[j] : j + 1; }
      if (Math.max(Math.abs(resto.debito), Math.abs(resto.credito), Math.abs(resto.saldo_final)) >= 1) out.push(resto);
    }
    return out;
  }

  function soloHojas(bal, hallazgos) {
    const cuentas = [...new Set(bal.map((r) => r.cuenta))].sort();
    const padres = new Set();
    for (let i = 0; i < cuentas.length - 1; i++) {
      if (cuentas[i + 1].startsWith(cuentas[i])) padres.add(cuentas[i]);
    }
    bal = bal.filter((r) => !padres.has(r.cuenta));
    const quitar = new Set();
    for (const [cuenta, g] of agrupar(bal, (r) => r.cuenta)) {
      const sin = g.filter((r) => r.nit === ""), con = g.filter((r) => r.nit !== "");
      if (!sin.length || !con.length) continue;
      const iguales = ["debito", "credito", "saldo_final"].every((c) => Math.abs(suma(sin, (r) => r[c]) - suma(con, (r) => r[c])) < 1);
      if (iguales) sin.forEach((r) => quitar.add(r));
      else hallazgos.push(["ALERTA", "Movimiento sin tercero", cuenta, `Cuenta ${cuenta} tiene movimiento sin tercero además de movimiento con tercero`]);
    }
    return bal.filter((r) => !quitar.has(r));
  }

  const CANON_TERCEROS = ["nit", "dv", "tipo_documento", "tipo_persona", "razon_social", "primer_nombre",
    "otros_nombres", "primer_apellido", "segundo_apellido", "direccion", "ciudad", "departamento", "pais",
    "codigo_municipio_dane", "email"];

  function cargarTerceros(filas, fuente, cfg) {
    if (!filas) return [];
    const { datos } = ubicarEncabezado(filas, cfg.fuentes[fuente].terceros);
    return datos.map((d) => {
      const o = {};
      CANON_TERCEROS.forEach((c) => { o[c] = vacio(d[c]) ? "" : (typeof d[c] === "number" ? soloDigitos(d[c]) : String(d[c])); });
      const [nit, dv] = separarDv(d.nit);
      o.nit = nit;
      o.dv = soloDigitos(o.dv) || dv;
      return o;
    }).filter((o) => o.nit !== "");
  }

  // ------------------------------------------------------------------ facturas electrónicas (UBL 2.1)
  // Emisor y adquirente de cada factura o nota, con los datos validados por la DIAN. Espejo de facturas.py.
  const CAMPOS_FE = ["nit", "dv", "tipo_documento", "tipo_persona", "razon_social", "primer_apellido", "segundo_apellido",
    "primer_nombre", "otros_nombres", "direccion", "ciudad", "departamento", "codigo_municipio_dane", "pais"];
  const local = (el) => el.localName || String(el.nodeName).split(":").pop();
  const hijo = (el, n) => (el ? [...el.children].find((h) => local(h) === n) || null : null);
  const desc = (el, n) => (el ? [...el.getElementsByTagName("*")].find((h) => local(h) === n) || null : null);
  const txtEl = (el) => (el ? String(el.textContent || "").trim() : "");
  function direccionFe(addr) {
    if (!addr) return null;
    const linea = hijo(addr, "AddressLine");
    return { direccion: linea ? [...linea.children].filter((l) => local(l) === "Line").map(txtEl).join(" ") : "",
      ciudad: txtEl(hijo(addr, "CityName")), departamento: txtEl(hijo(addr, "CountrySubentity")),
      codigo_municipio_dane: soloDigitos(txtEl(hijo(addr, "ID"))), pais: txtEl(hijo(hijo(addr, "Country"), "IdentificationCode")) };
  }
  function parteFe(party, fuente) {
    const tax = desc(party, "PartyTaxScheme"), legal = desc(party, "PartyLegalEntity");
    let cid = tax ? hijo(tax, "CompanyID") : null;
    if (!cid || !txtEl(cid)) cid = legal ? hijo(legal, "CompanyID") : null;
    const nit = soloDigitos(txtEl(cid));
    if (!nit) return null;
    const razon = txtEl(hijo(tax, "RegistrationName")) || txtEl(hijo(legal, "RegistrationName")) || txtEl(desc(hijo(party, "PartyName"), "Name"));
    // Dirección del RUT antes que la física: hay proveedores que ponen la razón social en la línea física
    const cands = [tax ? direccionFe(hijo(tax, "RegistrationAddress")) : null, direccionFe(hijo(hijo(party, "PhysicalLocation"), "Address"))].filter(Boolean);
    const buenas = cands.filter((c) => c.direccion && clave(c.direccion) !== clave(razon));
    let ubic = (buenas.length ? buenas : cands.length ? cands : [{}])[0];
    if (ubic.direccion && clave(ubic.direccion) === clave(razon)) ubic = { ...ubic, direccion: "" };
    const persona = desc(party, "Person");
    return { nit, dv: soloDigitos(cid.getAttribute("schemeID") || ""), tipo_documento: cid.getAttribute("schemeName") || "",
      tipo_persona: "", razon_social: textoDian(razon),
      primer_apellido: persona ? textoDian(txtEl(hijo(persona, "FamilyName"))) : "", segundo_apellido: "",
      primer_nombre: persona ? textoDian(txtEl(hijo(persona, "FirstName"))) : "",
      otros_nombres: persona ? textoDian(txtEl(hijo(persona, "MiddleName"))) : "",
      direccion: ubic.direccion || "", ciudad: ubic.ciudad || "", departamento: ubic.departamento || "",
      codigo_municipio_dane: ubic.codigo_municipio_dane || "", pais: ubic.pais || "", fuente };
  }
  // DOMParserClase: window.DOMParser en el navegador
  function leerFacturaXml(texto, nombre, DOMParserClase) {
    let doc;
    try { doc = new DOMParserClase().parseFromString(texto, "application/xml"); } catch (e) { return []; }
    const raiz = doc.documentElement;
    if (!raiz || doc.getElementsByTagName("parsererror").length) return [];
    if (local(raiz) === "AttachedDocument") {
      const interno = desc(desc(raiz, "ExternalReference"), "Description");
      return interno ? leerFacturaXml(txtEl(interno), nombre, DOMParserClase) : [];
    }
    if (!["Invoice", "CreditNote", "DebitNote"].includes(local(raiz))) return [];
    const numero = txtEl(hijo(raiz, "ID")) || nombre;
    const salida = [];
    for (const [rol, etiqueta] of [["AccountingSupplierParty", "emisor"], ["AccountingCustomerParty", "adquirente"]]) {
      const cont = hijo(raiz, rol), party = hijo(cont, "Party");
      if (!party) continue;
      const t = parteFe(party, `FE ${numero} (${etiqueta})`);
      if (t) { t.tipo_persona = { 1: "juridica", 2: "natural" }[txtEl(hijo(cont, "AdditionalAccountID"))] || ""; salida.push(t); }
    }
    return salida;
  }
  // Archivos .xml o .zip (XML + PDF como llegan al correo). El ZIP se abre con el lector CFB de SheetJS.
  function leerFacturasArchivo(XLSX, datos, nombre, DOMParserClase) {
    const u8 = datos instanceof Uint8Array ? datos : new Uint8Array(datos);
    const aTexto = (b) => new TextDecoder("utf-8").decode(b);
    if (/\.zip$/i.test(nombre)) {
      const cfb = XLSX.CFB.read(u8, { type: "array" });
      return cfb.FileIndex.filter((e) => e.type === 2 && /\.xml$/i.test(e.name) && e.content)
        .flatMap((e) => leerFacturaXml(aTexto(e.content instanceof Uint8Array ? e.content : new Uint8Array(e.content)), e.name, DOMParserClase));
    }
    return /\.xml$/i.test(nombre) ? leerFacturaXml(aTexto(u8), nombre, DOMParserClase) : [];
  }

  function direccionValida(d, mpios) { return textoDian(d).length >= 8 && !mpios.has(clave(d)); }
  // Completa el maestro: solo campos vacíos, y la dirección si es inválida; agrega terceros del balance que no están
  function completarMaestro(maestro, balance, registros, cfg, hallazgos) {
    if (!registros || !registros.length) return maestro;
    const usados = new Set(balance.map((r) => r.nit).filter(Boolean));
    const mpios = new Set(cfg.divipola.map((d) => d.k_mpio || clave(d.municipio)));
    const mejor = new Map();
    for (const r of registros) {
      if (!usados.has(r.nit)) continue;
      const puntos = (r.direccion && direccionValida(r.direccion, mpios) ? 2 : 0) + (r.codigo_municipio_dane ? 1 : 0);
      const previo = mejor.get(r.nit);
      if (!previo || puntos > previo[0]) mejor.set(r.nit, [puntos, r]);
    }
    if (!mejor.size) return maestro;
    const m = maestro.map((f) => { const o = { ...f }; CAMPOS_FE.forEach((c) => { if (o[c] === undefined || o[c] === null) o[c] = ""; }); return o; });
    const cambios = new Map();
    for (const f of m) {
      const par = mejor.get(f.nit);
      if (!par) continue;
      const fe = par[1], hechos = [];
      for (const c of ["dv", "tipo_documento", "tipo_persona", "razon_social", "primer_apellido", "primer_nombre", "otros_nombres", "pais"]) {
        if (!String(f[c]).trim() && fe[c]) { f[c] = fe[c]; hechos.push(c); }
      }
      if (fe.direccion && direccionValida(fe.direccion, mpios) && !direccionValida(String(f.direccion), mpios)) { f.direccion = fe.direccion; hechos.push("direccion"); }
      if (fe.codigo_municipio_dane && !soloDigitos(String(f.codigo_municipio_dane))) {
        f.codigo_municipio_dane = fe.codigo_municipio_dane; f.ciudad = fe.ciudad; f.departamento = fe.departamento; hechos.push("municipio");
      }
      if (hechos.length) cambios.set(f.nit, hechos);
    }
    const presentes = new Set(m.map((f) => f.nit));
    for (const [nit, [, r]] of mejor) {
      if (presentes.has(nit)) continue;
      const o = {}; CAMPOS_FE.forEach((c) => { o[c] = r[c]; }); m.push(o); cambios.set(nit, ["tercero completo"]);
    }
    for (const [nit, hechos] of cambios) hallazgos.push(["INFO", "Completado con factura electrónica", nit, `${hechos.join(", ")} tomados de ${mejor.get(nit)[1].fuente}`]);
    return m;
  }

  // ------------------------------------------------------------------ terceros
  const PARTICULAS = new Set(["DE", "DEL", "LA", "LAS", "LOS", "SAN", "SANTA", "VAN", "VON", "Y"]);
  const DIRECCIONES_VACIAS = new Set(["no aplica", "na", "n a", "sin direccion", "ninguna", "0", "x", ""]);
  const NITS_GENERICOS = new Set(["222222222", "999999999", "111111111", "0", "1", "123456789"]);
  const SUFIJOS_JURIDICA = ["SAS", "S A S", "LTDA", "S A", "SA", "E U", "EU", "S EN C", "SCA", "ESP", "E S P", "CORP", "BIC"];
  const PREFIJOS_JURIDICA = ["BANCO", "FONDO", "FUNDACION", "ASOCIACION", "COOPERATIVA", "CORPORACION",
    "CAJA DE COMPENSACION", "EPS", "UNIVERSIDAD", "COLEGIO", "CLINICA", "MUNICIPIO", "DEPARTAMENTO", "DIRECCION DE IMPUESTOS"];

  function esJuridicaPorNombre(nombre) {
    const n = " " + textoDian(nombre).replace(/[.\s]+/g, " ").trim() + " ";
    return SUFIJOS_JURIDICA.some((s) => n.includes(" " + s + " ")) || PREFIJOS_JURIDICA.some((p) => n.trim().startsWith(p));
  }
  function tipoDocumento(v, cfg) {
    const t = textoDian(v);
    if (!t) return "";
    if (/^\d+$/.test(t) && cfg.tiposDoc.some((x) => x.codigo === t)) return t;
    for (const x of cfg.tiposDoc) {
      if (x.alias.split("|").includes(t) || clave(t) === clave(x.descripcion)) return x.codigo;
    }
    return "";
  }
  function agruparParticulas(tokens) {
    const out = []; let pend = [];
    for (const t of tokens) {
      if (PARTICULAS.has(t)) pend.push(t); else { out.push(pend.concat([t]).join(" ")); pend = []; }
    }
    if (pend.length) out.push(pend.join(" "));
    return out;
  }
  function partirNombre(nombre, orden) {
    const t = agruparParticulas(textoDian(nombre).split(" ").filter(Boolean));
    let ap1 = "", ap2 = "", n1 = "", n2 = "";
    const ambiguo = !(t.length === 2 || t.length === 4);
    if (orden === "apellidos_nombres") {
      if (t.length >= 4) { [ap1, ap2, n1] = t; n2 = t.slice(3).join(" "); }
      else if (t.length === 3) [ap1, ap2, n1] = t;
      else if (t.length === 2) [ap1, n1] = t;
      else if (t.length) ap1 = t[0];
    } else {
      if (t.length >= 4) { n1 = t[0]; n2 = t.slice(1, -2).join(" "); ap1 = t[t.length - 2]; ap2 = t[t.length - 1]; }
      else if (t.length === 3) [n1, ap1, ap2] = t;
      else if (t.length === 2) [n1, ap1] = t;
      else if (t.length) ap1 = t[0];
    }
    return [{ primer_apellido: ap1, segundo_apellido: ap2, primer_nombre: n1, otros_nombres: n2 }, ambiguo];
  }
  function ubicar(ciudad, dpto, codDane, cfg) {
    let cod = soloDigitos(codDane);
    if (cod.length === 4) cod = "0" + cod;
    if (cod.length === 5) return [cod.slice(0, 2), cod.slice(2), false];
    const k = clave(ciudad);
    if (!k) return ["", "", false];
    let cand = cfg.divipola.filter((d) => d.k_mpio === k || k.startsWith(d.k_mpio + " "));
    if (cand.length > 1 && dpto) {
      const kd = clave(dpto);
      const f = cand.filter((d) => d.k_dpto === kd || kd.startsWith(d.k_dpto) || d.k_dpto.startsWith(kd));
      if (f.length) cand = f;
    }
    if (!cand.length) return ["", "", false];
    const homonimo = new Set(cand.map((d) => d.codigo_departamento + d.codigo_municipio)).size > 1;
    return [cand[0].codigo_departamento, cand[0].codigo_municipio, homonimo];
  }
  function pais(v, cfg) {
    const t = textoDian(v);
    if (!t) return "169";
    if (/^\d+$/.test(t)) return t.padStart(3, "0");
    for (const p of cfg.paises) if (t === p.nombre || p.alias.split("|").includes(t)) return p.codigo;
    return "";
  }

  function parche(c) {
    const p = {};
    ["tipo_documento", "dv", "razon_social", "primer_apellido", "segundo_apellido", "primer_nombre", "otros_nombres", "direccion", "pais"]
      .forEach((k) => { if (c[k] !== undefined && String(c[k]).trim()) p[k] = String(c[k]); });
    if (c.persona) p.tipo_persona = "persona " + c.persona;
    if (c.codigo_departamento && c.codigo_municipio) p.codigo_municipio_dane = String(c.codigo_departamento).padStart(2, "0") + String(c.codigo_municipio).padStart(3, "0");
    return p;
  }

  function depurar(balance, maestro, cfg, hallazgos) {
    const orden = cfg.parametros.validacion.orden_nombre_completo || "apellidos_nombres";
    const nombresBal = new Map(), dvBal = new Map();
    for (const r of balance) {
      if (!r.nit) continue;
      if (!nombresBal.has(r.nit)) nombresBal.set(r.nit, new Set());
      if (String(r.nombre_tercero).trim()) nombresBal.get(r.nit).add(textoDian(r.nombre_tercero));
      if (r.dv_fuente && !dvBal.has(r.nit)) dvBal.set(r.nit, r.dv_fuente);
    }
    const mMap = new Map();
    for (const [nit, g] of agrupar(maestro, (m) => m.nit)) {
      if (g.length > 1) hallazgos.push(["ALERTA", "Duplicado en maestro", nit, `NIT repetido ${g.length} veces en el maestro de terceros; se usa el primero`]);
      mMap.set(nit, g[0]);
    }
    const cm = cfg.parametros.cuantias_menores, emp = cfg.parametros.empresa;
    const correcciones = cfg.parametros.correcciones_terceros || {};
    // NIT corregido (p. ej. DV pegado): el NIT nuevo hereda la ficha del maestro del NIT viejo
    Object.entries(correcciones).forEach(([viejo, c]) => {
      const nuevo = c && c.nit_correcto ? String(c.nit_correcto) : "";
      if (nuevo && !mMap.has(nuevo) && mMap.has(String(viejo))) mMap.set(nuevo, { ...mMap.get(String(viejo)), nit: nuevo });
    });
    const terceros = new Map();
    const nits = [...nombresBal.keys()].sort();
    for (const nit of nits) {
      if (nit === cm.nit) {
        hallazgos.push(["ERROR", "NIT genérico", nit, "Se contabilizó con el NIT de cuantías menores; la agrupación la hace el motor, reclasificar al tercero real"]);
        terceros.set(nit, { nit, tipo_documento: cm.tipo_documento, numero_identificacion: nit, dv: "", persona: "juridica",
          primer_apellido: "", segundo_apellido: "", primer_nombre: "", otros_nombres: "", razon_social: cm.razon_social,
          direccion: textoDian(emp.direccion || ""), codigo_departamento: emp.codigo_departamento || "",
          codigo_municipio: emp.codigo_municipio || "", pais: "169" });
        continue;
      }
      let m = mMap.get(nit);
      const cr = correcciones[nit];
      if (cr) m = { ...(m || {}), ...parche(cr) };
      const get = (c) => (m ? String(m[c] || "").trim() : "");
      if (!m) hallazgos.push(["ALERTA", "Tercero sin maestro", nit, "Aparece en el balance pero no en el maestro de terceros: sin dirección ni ubicación"]);
      const nb = [...(nombresBal.get(nit) || [])].sort();
      if (nb.length > 1) hallazgos.push(["ALERTA", "Mismo NIT, nombres distintos", nit, nb.join(" | ")]);
      const razon = textoDian(get("razon_social")) || nb[0] || "";
      if (NITS_GENERICOS.has(nit)) hallazgos.push(["ERROR", "NIT genérico", nit, `'${razon}' usa un NIT genérico en la contabilidad; reclasificar al tercero real`]);

      let tipo = tipoDocumento(get("tipo_documento"), cfg);
      const tp = clave(get("tipo_persona"));
      let juridica;
      if (tp.includes("juridic")) juridica = true;
      else if (tp.includes("natural")) juridica = false;
      else juridica = esJuridicaPorNombre(razon) || (nit.length === 9 && "89".includes(nit[0]));
      if (!tipo) {
        tipo = juridica ? "31" : "13";
        hallazgos.push(["INFO", "Tipo de documento inferido", nit, `Sin tipo en maestro; se asignó ${tipo}`]);
      }
      if (juridica && !["31", "42", "43", "44"].includes(tipo)) hallazgos.push(["ERROR", "Tipo documento incoherente", nit, `'${razon}' parece persona jurídica pero tiene tipo ${tipo}`]);

      const dvFuente = soloDigitos(get("dv")) || dvBal.get(nit) || "";
      let dvCalc = "";
      if (tipo === "31") {
        try { dvCalc = String(calcularDv(nit)); } catch (e) { hallazgos.push(["ERROR", "NIT inválido", nit, e.message]); }
        if (dvFuente && dvCalc && dvFuente !== dvCalc) hallazgos.push(["ERROR", "DV errado", nit, `DV registrado ${dvFuente}, DV correcto ${dvCalc}`]);
      }
      if (nit.length === 10 && "89".includes(nit[0])) {
        try { if (String(calcularDv(nit.slice(0, 9))) === nit[9]) hallazgos.push(["ERROR", "NIT con DV pegado", nit, `Probablemente es ${nit.slice(0, 9)}-${nit[9]}`]); } catch (e) { /* */ }
      }
      if ((tipo === "13" || tipo === "31") && !(nit.length >= 5 && nit.length <= 10)) hallazgos.push(["ERROR", "Longitud de identificación", nit, `${nit.length} dígitos`]);

      let nom, razonOut;
      if (tipo === "31" && juridica) {
        nom = { primer_apellido: "", segundo_apellido: "", primer_nombre: "", otros_nombres: "" };
        razonOut = razon;
      } else {
        const sep = {};
        ["primer_apellido", "segundo_apellido", "primer_nombre", "otros_nombres"].forEach((k) => { sep[k] = textoDian(get(k)); });
        if (sep.primer_apellido && !sep.primer_nombre && razon && !textoDian(get("razon_social")).endsWith(sep.primer_apellido)) sep.primer_nombre = razon;
        if (sep.primer_apellido && sep.primer_nombre) nom = sep;
        else {
          const [n, amb] = partirNombre(razon, orden);
          nom = n;
          if (amb) hallazgos.push(["ALERTA", "Nombre partido por heurística", nit, `'${razon}' -> ${n.primer_apellido} / ${n.segundo_apellido} / ${n.primer_nombre} / ${n.otros_nombres}`]);
        }
        razonOut = "";
        if (!nom.primer_apellido || !nom.primer_nombre) hallazgos.push(["ERROR", "Nombre incompleto", nit, "Persona natural sin primer apellido o primer nombre"]);
      }

      const [dp, mp, homonimo] = ubicar(get("ciudad"), get("departamento"), get("codigo_municipio_dane"), cfg);
      if (homonimo) hallazgos.push(["ALERTA", "Municipio homónimo", nit, `'${get("ciudad")}' existe en varios departamentos y el maestro no trae uno que lo distinga; se asignó ${dp}-${mp}. Confirmar`]);
      const ps = pais(get("pais"), cfg);
      if (ps === "169" && !mp) hallazgos.push(["ALERTA", "Municipio no identificado", nit, `Ciudad '${get("ciudad")}' / dpto '${get("departamento")}' no se encontró en DIVIPOLA`]);
      if (!ps) hallazgos.push(["ERROR", "País no identificado", nit, `'${get("pais")}' no está en la tabla de países`]);
      let dir = textoDian(get("direccion"));
      if (DIRECCIONES_VACIAS.has(clave(dir))) dir = "";
      if (!dir && m) hallazgos.push(["ALERTA", "Sin dirección", nit, "Requerida en 1001/1003/1008/1009/1010"]);

      terceros.set(nit, { nit, tipo_documento: tipo, numero_identificacion: nit, dv: dvCalc || dvFuente,
        persona: juridica ? "juridica" : "natural", ...nom, razon_social: razonOut, direccion: dir,
        codigo_departamento: dp, codigo_municipio: mp, pais: ps });
    }
    const porNombre = agrupar([...terceros.values()], (t) => clave([t.razon_social, t.primer_apellido, t.segundo_apellido, t.primer_nombre].join(" ")));
    for (const [k, g] of porNombre) {
      if (k && g.length > 1) hallazgos.push(["ALERTA", "Posible tercero duplicado", g.map((t) => t.nit).join(", "), `Mismo nombre '${k.toUpperCase()}' con ${g.length} identificaciones`]);
    }
    return terceros;
  }

  // ------------------------------------------------------------------ reglas y motor
  const RETENCIONES = ["ret_renta", "ret_asumida", "ret_iva_comun", "ret_iva_no_dom", "retencion"];
  const CAMPOS_TERCERO = new Set(["tipo_documento", "numero_identificacion", "dv", "primer_apellido", "segundo_apellido",
    "primer_nombre", "otros_nombres", "razon_social", "direccion", "codigo_departamento", "codigo_municipio", "pais"]);
  const BASES = {
    neto_deb: (f) => f.debito - f.credito, neto_cred: (f) => f.credito - f.debito,
    debito: (f) => f.debito, credito: (f) => f.credito,
    saldo_deb: (f) => f.saldo_final, saldo_cred: (f) => -f.saldo_final,
    // débito − crédito solo del tercero con débitos (proveedor); los créditos de terceros sin débitos son salidas al costo
    compras_netas: (f) => (f.debito > 0 ? Math.max(f.debito - f.credito, 0) : 0),
  };

  function terceroFijo(cfg, v) {
    v = String(v || "").trim();
    return v === "informante" ? String(cfg.parametros.empresa.nit) : v.replace(/\D/g, "");
  }
  function topePesos(cfg, fmt) {
    const t = (cfg.parametros.topes || {})[fmt] || {};
    if (t.valor) return Number(t.valor);
    if (!t.uvt) return null;
    const uvt = (cfg.parametros.uvt || {})[String(cfg.parametros.anio_gravable)];
    if (!uvt) throw new Error(`No hay valor de UVT para el año ${cfg.parametros.anio_gravable}`);
    return Number(t.uvt) * Number(uvt);
  }
  function datosInformante(cfg) {
    const e = cfg.parametros.empresa; let dv = "";
    try { dv = String(calcularDv(e.nit)); } catch (x) { /* */ }
    return { tipo_documento: "31", numero_identificacion: String(e.nit), dv, primer_apellido: "", segundo_apellido: "",
      primer_nombre: "", otros_nombres: "", razon_social: textoDian(e.razon_social || ""), direccion: textoDian(e.direccion || ""),
      codigo_departamento: e.codigo_departamento || "", codigo_municipio: e.codigo_municipio || "", pais: "169" };
  }

  function reglaPara(cfg, fmt, cuenta) {
    let mejor = null;
    for (const r of cfg.reglas) {
      if (r.formato === fmt && cuenta.startsWith(r.prefijo) && (!mejor || r.prefijo.length > mejor.prefijo.length)) mejor = r;
    }
    return mejor;
  }
  function nitsExcluidos(cfg, fmt) {
    const ex = cfg.parametros.nits_excluidos || {};
    const l = (ex.global || []).concat(ex[fmt] || []);
    return new Set(l.map((n) => (n === "{empresa}" ? String(cfg.parametros.empresa.nit) : String(n))));
  }

  function validarReglas(cfg) {
    const errores = [];
    cfg.reglas.forEach((r, i) => {
      const f = cfg.formatos[r.formato];
      if (!f) { errores.push(`Regla ${i + 1}: formato ${r.formato} no existe`); return; }
      if (!/^\d+$/.test(r.prefijo)) errores.push(`Regla ${i + 1} (${r.formato}): prefijo '${r.prefijo}' no es numérico`);
      if (r.concepto === "EXCLUIR") return;
      if (!(r.base in BASES) && !["saldo_deb_cuenta", "saldo_cred_cuenta"].includes(r.base)) errores.push(`Regla ${i + 1} (${r.formato} ${r.prefijo}): base '${r.base}' inválida`);
      if (!f.columnas.some(([c]) => c === r.columna)) errores.push(`Regla ${i + 1} (${r.formato} ${r.prefijo}): columna '${r.columna}' no existe en el formato`);
    });
    return errores;
  }

  const PATRON_ENTIDAD = /\b(BANCO|BANCOLOMBIA|DAVIVIENDA|BBVA|COLPATRIA|SCOTIABANK|ITAU|AV VILLAS|CAJA SOCIAL|OCCIDENTE|POPULAR|AGRARIO|BANCAMIA|FALABELLA|PICHINCHA|SERFINANZA|NEQUI|DAVIPLATA|LULO|NU COLOMBIA|MOVII|CONFIAR|COTRAFA|JFK|COOPERATIVA|FIDUCIARIA|FONDO)\b/;
  const SECUNDARIAS = /\b(FIDUCIARIA|FONDO|COMISIONISTA|VALORES)\b/;

  function generarPartidas(balance, cfg, hallazgos) {
    const formatos = Object.keys(cfg.formatos).filter((f) => ["por_tercero", "sin_tercero"].includes(cfg.formatos[f].modo));
    const excl = {};
    formatos.forEach((f) => { excl[f] = nitsExcluidos(cfg, f); });
    const salida = [];
    for (const fila of balance) {
      for (const fmt of formatos) {
        const regla = reglaPara(cfg, fmt, fila.cuenta);
        if (!regla || regla.concepto === "EXCLUIR" || regla.base.endsWith("_cuenta")) continue;
        const valor = BASES[regla.base](fila);
        if (Math.abs(valor) < 0.5) continue;
        const modo = cfg.formatos[fmt].modo;
        let motivo = "", nit = fila.nit;
        if (modo === "por_tercero" && regla.tercero) nit = terceroFijo(cfg, regla.tercero);
        else if (modo === "por_tercero") {
          if (!fila.nit) motivo = "sin_tercero";
          else if (excl[fmt].has(fila.nit)) motivo = "nit_excluido";
        }
        salida.push({ formato: fmt, cuenta: fila.cuenta, nombre_cuenta: fila.nombre_cuenta,
          nit: modo === "por_tercero" ? nit : "", concepto: regla.concepto, columna: regla.columna,
          base: regla.base, prefijo_regla: regla.prefijo, valor, descartado: motivo });
      }
    }
    // Cuentas cuyo saldo se toma completo (bancos): el tercero del movimiento es la contraparte
    const fijos = cfg.parametros.cuentas_bancarias || {};
    for (const [cuenta, g] of agrupar(balance, (r) => r.cuenta)) {
      for (const fmt of formatos) {
        const regla = reglaPara(cfg, fmt, cuenta);
        if (!regla || regla.concepto === "EXCLUIR" || !regla.base.endsWith("_cuenta")) continue;
        const valor = suma(g, (r) => r.saldo_final) * (regla.base === "saldo_cred_cuenta" ? -1 : 1);
        if (Math.abs(valor) < 0.5) continue;
        let nit = regla.tercero ? terceroFijo(cfg, regla.tercero) : String(fijos[cuenta] || "");
        if (!nit && regla.base === "saldo_cred_cuenta") {
          hallazgos.push(["ERROR", "Tercero de la cuenta sin definir", cuenta, `Formato ${fmt}: el saldo de la cuenta ${cuenta} (${fmtPesos(valor)}) se reporta a un solo acreedor; configúrelo en Cuentas con tercero fijo`]);
        } else if (!nit) {
          const vistos = new Map();
          g.filter((r) => r.nit).forEach((r) => { if (!vistos.has(r.nit)) vistos.set(r.nit, r.nombre_tercero); });
          let cand = [...vistos].filter(([, n]) => PATRON_ENTIDAD.test(textoDian(n)));
          if (cand.length > 1) { const p = cand.filter(([, n]) => !SECUNDARIAS.test(textoDian(n))); if (p.length) cand = p; }
          if (cand.length === 1) {
            nit = cand[0][0];
            hallazgos.push(["ALERTA", "Entidad financiera inferida", cuenta, `Formato ${fmt}: saldo de la cuenta ${cuenta} (${fmtPesos(valor)}) asignado a '${cand[0][1]}' (${nit}). Confirmar y fijarlo en Cuentas bancarias`]);
          } else {
            hallazgos.push(["ERROR", "Entidad financiera sin definir", cuenta, `Formato ${fmt}: no se pudo determinar la entidad de la cuenta ${cuenta}; configúrela en Cuentas bancarias`]);
          }
        }
        salida.push({ formato: fmt, cuenta, nombre_cuenta: g[0].nombre_cuenta, nit, concepto: regla.concepto,
          columna: regla.columna, base: regla.base, prefijo_regla: regla.prefijo, valor, descartado: nit ? "" : "sin_tercero" });
      }
    }
    const sinT = salida.filter((p) => p.descartado === "sin_tercero" && !p.base.endsWith("_cuenta"));
    for (const [, g] of agrupar(sinT, (p) => p.formato + "|" + p.cuenta)) {
      hallazgos.push(["ERROR", "Movimiento sin tercero", g[0].cuenta, `Formato ${g[0].formato}: ${fmtPesos(suma(g, (p) => p.valor))} en la cuenta ${g[0].cuenta} sin NIT; no se puede reportar hasta asignarle tercero`]);
    }
    return salida;
  }

  function prorratear(p, cfg) {
    const pr = p.filter((x) => x.concepto === "PRORRATA");
    if (!pr.length) return p;
    const resto = p.filter((x) => x.concepto !== "PRORRATA");
    const nuevas = [];
    for (const [, g] of agrupar(pr, (x) => [x.formato, x.nit, x.columna].join("|"))) {
      const total = suma(g, (x) => x.valor);
      const pesos = new Map();
      resto.filter((x) => x.formato === g[0].formato && x.nit === g[0].nit && (x.columna === "pago_deducible" || x.columna === "pago_no_deducible"))
        .forEach((x) => pesos.set(x.concepto, (pesos.get(x.concepto) || 0) + x.valor));
      for (const [k, v] of pesos) if (!(v > 0)) pesos.delete(k);
      if (!pesos.size) pesos.set((cfg.parametros.concepto_prorrata_defecto || {})[g[0].formato] || "5016", 1);
      const tot = [...pesos.values()].reduce((a, b) => a + b, 0);
      for (const [concepto, peso] of pesos) nuevas.push({ ...g[0], concepto, valor: total * peso / tot, prefijo_regla: "PRORRATA" });
    }
    return resto.concat(nuevas);
  }

  function base1003(tabla, balance, hallazgos) {
    const ing = new Map();
    balance.filter((r) => r.cuenta.startsWith("4")).forEach((r) => ing.set(r.nit, (ing.get(r.nit) || 0) + r.credito - r.debito));
    tabla.forEach((t) => { t.base_retencion = 0; });
    for (const t of tabla.filter((x) => x.concepto === "1309")) {
      t.base_retencion = t.retencion / 0.15;
      hallazgos.push(["INFO", "Base 1309 estimada", t.nit, "Base del 1309 = valor del IVA, estimada como retención / 15%; validar contra certificados"]);
    }
    for (const [nit, g] of agrupar(tabla.filter((x) => x.concepto !== "1309"), (t) => t.nit)) {
      const base = ing.get(nit) || 0;
      const totRet = suma(g, (t) => t.retencion);
      if (base <= 0) {
        hallazgos.push(["ALERTA", "Base 1003 no encontrada", nit, "Le practicaron retención pero no hay ingresos con ese tercero; tomar la base del certificado de retención"]);
        continue;
      }
      g.forEach((t) => { t.base_retencion = totRet ? base * t.retencion / totRet : 0; });
      hallazgos.push(["INFO", "Base 1003 estimada", nit, `Base estimada con ingresos del tercero (${fmtPesos(base)}); validar contra certificados`]);
    }
  }

  function retencionesHuerfanas(fmt, tabla, valores, hallazgos) {
    const pagos = ["pago_deducible", "pago_no_deducible"].filter((c) => valores.includes(c));
    const rets = valores.filter((c) => RETENCIONES.includes(c));
    if (!pagos.length || !rets.length) return tabla;
    const tp = (t) => suma(pagos, (c) => t[c]);
    const quitar = new Set();
    for (const t of tabla) {
      if (tp(t) >= 0.5 || suma(rets, (c) => t[c]) <= 0.5) continue;
      const mismos = tabla.filter((x) => x.nit === t.nit && tp(x) > 0.5);
      if (!mismos.length) {
        hallazgos.push(["ALERTA", "Retención sin pago", t.nit, `Formato ${fmt} concepto ${t.concepto}: hay retención pero ningún pago o abono al tercero; revisar la causación`]);
        continue;
      }
      const destino = mismos.reduce((a, b) => (tp(b) > tp(a) ? b : a));
      rets.forEach((c) => { destino[c] += t[c]; });
      quitar.add(t);
      hallazgos.push(["INFO", "Retención reasignada", t.nit, `Formato ${fmt}: retención del concepto ${t.concepto} trasladada al concepto ${destino.concepto}, donde está el pago`]);
    }
    return tabla.filter((t) => !quitar.has(t));
  }

  // Tope por tercero sumando TODO el formato (art. 1.3.5.2.1 par. 1; 1.3.5.6.1 y 1.3.5.7.1 par. 1).
  // Un tercero con retención nunca se agrupa.
  function cuantiasMenores(fmt, tabla, valores, cfg) {
    const t = (cfg.parametros.topes || {})[fmt] || {};
    const tope = topePesos(cfg, fmt);
    if (!tope) return tabla;
    if (!t.verificado) cfg._sinVerificar.add(`Tope cuantías menores formato ${fmt}`);
    const cols = t.columna.split("+");
    const rets = valores.filter((c) => RETENCIONES.includes(c));
    const porNit = new Map(), conRet = new Set();
    for (const x of tabla) {
      porNit.set(x.nit, (porNit.get(x.nit) || 0) + suma(cols, (c) => x[c] || 0));
      if (rets.length && suma(rets, (c) => Math.abs(x[c])) > 0.5) conRet.add(x.nit);
    }
    const noAgrupar = cfg.parametros.no_agrupar_si_retencion !== false;
    const menoresNit = new Set([...porNit].filter(([n, v]) => v < tope && !(noAgrupar && conRet.has(n)) && n !== String(cfg.parametros.empresa.nit)).map(([n]) => n));
    const menores = tabla.filter((x) => menoresNit.has(x.nit));
    if (!menores.length) return tabla;
    const out = tabla.filter((x) => !menoresNit.has(x.nit));
    const nitCm = cfg.parametros.cuantias_menores.nit;
    for (const [concepto, g] of agrupar(menores, (x) => x.concepto)) {
      const fila = { concepto, nit: nitCm };
      valores.forEach((c) => { fila[c] = suma(g, (x) => x[c] || 0); });
      out.push(fila);
    }
    return out;
  }

  function construirFormato(fmt, partidas, terceros, balance, cfg, hallazgos) {
    const spec = cfg.formatos[fmt];
    const campos = spec.columnas.map(([c]) => c);
    const valores = campos.filter((c) => !CAMPOS_TERCERO.has(c) && c !== "concepto");
    let p = prorratear(partidas.filter((x) => x.formato === fmt && x.descartado === ""), cfg);
    if (!p.length) return [];

    if (spec.modo === "sin_tercero") {
      return [...agrupar(p, (x) => x.concepto)].map(([concepto, g]) => {
        const o = { concepto };
        valores.forEach((c) => {
          const v = suma(g.filter((x) => x.columna === c), (x) => x.valor);
          if (v < -0.5) hallazgos.push(["ALERTA", "Valor negativo", concepto, `Formato ${fmt} concepto ${concepto}: ${Math.round(v).toLocaleString("es-CO")}; se reporta en cero`]);
          o[c] = r0(Math.max(0, v));
        });
        return o;
      }).filter((o) => valores.some((c) => Math.abs(o[c]) > 0.5));
    }
    let tabla = [...agrupar(p, (x) => x.concepto + "|" + x.nit)].map(([, g]) => {
      const o = { concepto: g[0].concepto, nit: g[0].nit };
      valores.forEach((c) => { o[c] = suma(g.filter((x) => x.columna === c), (x) => x.valor); });
      return o;
    });
    if (fmt === "1003") base1003(tabla, balance, hallazgos);
    if (fmt === "1001" && cfg.parametros.forzar_no_deducible) {
      for (const t of tabla) for (const [d, nd] of [["pago_deducible", "pago_no_deducible"], ["iva_deducible", "iva_no_deducible"]]) {
        if (d in t && nd in t) { t[nd] += t[d]; t[d] = 0; }
      }
    }
    for (const t of tabla) {
      for (const c of valores) {
        if (t[c] < -0.5) hallazgos.push(["ALERTA", "Valor negativo", t.nit, `Formato ${fmt} concepto ${t.concepto} columna ${c}: ${Math.round(t[c]).toLocaleString("es-CO")} (naturaleza contraria o reversión); se reporta en cero`]);
        if (t[c] < 0) t[c] = 0;
      }
    }
    tabla = tabla.filter((t) => valores.some((c) => Math.abs(t[c]) > 0.5));
    tabla = retencionesHuerfanas(fmt, tabla, valores, hallazgos);
    tabla = cuantiasMenores(fmt, tabla, valores, cfg);

    const cm = cfg.parametros.cuantias_menores, emp = cfg.parametros.empresa;
    const out = tabla.map((r) => {
      let t;
      if (r.nit === cm.nit) {
        t = { tipo_documento: cm.tipo_documento, numero_identificacion: cm.nit, dv: "", primer_apellido: "", segundo_apellido: "",
          primer_nombre: "", otros_nombres: "", razon_social: cm.razon_social, direccion: textoDian(emp.direccion || ""),
          codigo_departamento: emp.codigo_departamento || "", codigo_municipio: emp.codigo_municipio || "", pais: "169" };
      } else {
        t = terceros.get(r.nit) || { numero_identificacion: r.nit };
        if (r.nit === String(cfg.parametros.empresa.nit)) t = { ...t, ...datosInformante(cfg) };
        const exterior = !["", "169", undefined, null].includes(t.pais);
        if (exterior) t = { ...t, direccion: "", codigo_departamento: "", codigo_municipio: "" };
        for (const req of spec.requiere || []) {
          if ((exterior && ["direccion", "codigo_departamento", "codigo_municipio"].includes(req)) || t[req]) continue;
          // ERROR solo si el prevalidador rechaza la columna vacía; si no, dato que la norma pide y falta
          if ((spec.obligatorios || [req]).includes(req)) hallazgos.push(["ERROR", "Falta " + req, r.nit, `Formato ${fmt}: el tercero no tiene ${req} y el prevalidador lo exige`]);
          else hallazgos.push(["ALERTA", "Falta " + req, r.nit, `Formato ${fmt}: el tercero no tiene ${req}. El prevalidador acepta la columna vacía, pero repórtela si la conoce`]);
        }
        const minimo = spec.direccion_minima || 0;
        if (!exterior && t.direccion && String(t.direccion).length < minimo) {
          const esCiudad = cfg.divipola.some((d) => d.k_mpio === clave(t.direccion));
          hallazgos.push(["ERROR", "Dirección muy corta", r.nit, `Formato ${fmt}: '${t.direccion}' tiene menos de ${minimo} caracteres; el prevalidador la rechaza${esCiudad ? " (es el nombre de un municipio, no una dirección)" : ""}`]);
        }
      }
      const o = {};
      for (const c of campos) {
        if (CAMPOS_TERCERO.has(c)) o[c] = t[c] || "";
        else if (c === "concepto") o[c] = spec.concepto ? r.concepto : "";
        else o[c] = r0(r[c] || 0);
      }
      return o;
    });
    out.sort((a, b) => (String(a.concepto) + a.numero_identificacion).localeCompare(String(b.concepto) + b.numero_identificacion));
    return out;
  }

  // ------------------------------------------------------------------ externos (1010, 2276)
  const ALIAS_PERSONA = {
    nit: ["nit", "identificacion", "numero identificacion", "documento", "cedula"], dv: ["dv"],
    tipo_documento: ["tipo documento", "tipo de documento", "tipo identificacion", "tipo de identificacion"], tipo_persona: ["tipo persona"],
    razon_social: ["nombre", "razon social", "nombre completo", "empleado", "socio", "accionista"],
    primer_apellido: ["primer apellido"], segundo_apellido: ["segundo apellido"], primer_nombre: ["primer nombre"],
    otros_nombres: ["otros nombres", "segundo nombre"], direccion: ["direccion"], ciudad: ["ciudad", "municipio"],
    departamento: ["departamento"], pais: ["pais"], codigo_municipio_dane: ["codigo dane", "codigo municipio"],
  };
  function personas(filas, extras, cfg, hallazgos) {
    const alias = { ...ALIAS_PERSONA };
    extras.forEach((e) => { alias[e] = [e, e.replace(/_/g, " ")]; });
    const { datos } = ubicarEncabezado(filas, alias);
    const maestro = datos.map((d) => {
      const o = {};
      Object.keys(ALIAS_PERSONA).forEach((c) => { o[c] = vacio(d[c]) ? "" : (typeof d[c] === "number" ? soloDigitos(d[c]) : String(d[c])); });
      o.nit = soloDigitos(o.nit);
      extras.forEach((e) => { o["_" + e] = d[e]; });
      return o;
    }).filter((o) => o.nit);
    const pseudo = maestro.map((m) => ({ nit: m.nit, nombre_tercero: m.razon_social, dv_fuente: m.dv }));
    return [depurar(pseudo, maestro, cfg, hallazgos), maestro];
  }

  function porcentajeDian(p) {
    const txt = (Math.round(Number(p) * 10000) / 10000).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    const [ent, dec = ""] = txt.split(".");
    return [parseInt(ent + dec, 10), dec.length];
  }

  function formato1010(filas, balance, cfg, hallazgos) {
    const campos = cfg.formatos["1010"].columnas.map(([c]) => c);
    const [ter, lista] = personas(filas, ["porcentaje", "acciones", "valor_nominal", "capital", "prima"], cfg, hallazgos);
    const tiene = (k) => lista.some((m) => !vacio(m["_" + k]) && String(m["_" + k]).trim() !== "");
    let pct;
    if (tiene("porcentaje")) pct = lista.map((m) => aNumero(m._porcentaje));
    else if (tiene("acciones")) {
      const acc = lista.map((m) => aNumero(m._acciones)); const tot = acc.reduce((a, b) => a + b, 0);
      pct = acc.map((a) => a / tot * 100);
    } else throw new Error("Accionistas: se requiere una columna 'porcentaje' o 'acciones'");
    const totalPct = pct.reduce((a, b) => a + b, 0);
    if (Math.abs(totalPct - 100) > 0.0001) hallazgos.push(["ERROR", "1010 participación", "", `Los porcentajes suman ${totalPct.toFixed(4)}%, no 100%`]);
    const capital = -suma(balance.filter((r) => r.cuenta.startsWith("31")), (r) => r.saldo_final);
    const colNom = tiene("valor_nominal") ? "_valor_nominal" : tiene("capital") ? "_capital" : null;
    const hayPrima = tiene("prima");
    const primaBal = -suma(balance.filter((r) => r.cuenta.startsWith("3205")), (r) => r.saldo_final);
    if (primaBal > 0.5 && !hayPrima) hallazgos.push(["ALERTA", "1010 prima en colocación", "", `El balance tiene prima en colocación de acciones (${fmtPesos(primaBal)}) y el libro de accionistas no trae la columna 'prima'. Asígnela por accionista según las actas; no la reparta a prorrata`]);
    if (!colNom) hallazgos.push(["INFO", "1010 valor nominal estimado", "", `Sin columna 'valor nominal': se usa capital (cuenta 31, ${fmtPesos(capital)}) x participación`]);
    return lista.map((m, i) => {
      let t = ter.get(m.nit) || {};
      if (!["", "169", undefined, null].includes(t.pais)) t = { ...t, direccion: "", codigo_departamento: "", codigo_municipio: "" };
      const [num, pos] = porcentajeDian(pct[i]);
      const o = {};
      campos.forEach((c) => { o[c] = t[c] || ""; });
      o.valor_nominal = r0(colNom ? aNumero(m[colNom]) : capital * pct[i] / 100);
      o.prima = r0(hayPrima ? aNumero(m._prima) : 0);
      o.porcentaje = num; o.posicion_decimal = pos;
      return o;
    });
  }

  // Campos numéricos del 2276 v4 (45 columnas); SUMAN_TOTAL_2276 forma el total de ingresos brutos
  const VALORES_2276 = /^(pagos_|cesantias|pensiones|total_|aporte|retencion|otros_pagos|iva_mayor_valor|alimentacion_hasta_41uvt|ingreso_promedio_6m)/;
  const SUMAN_TOTAL_2276 = /^(pagos_|cesantias|pensiones|otros_pagos)/;
  function formato2276(filas, balance, cfg, hallazgos) {
    const campos = cfg.formatos["2276"].columnas.map(([c]) => c);
    const valores = campos.filter((c) => VALORES_2276.test(c));
    const pagos = valores.filter((c) => SUMAN_TOTAL_2276.test(c));
    const PERSONA = new Set(["tipo_documento", "numero_identificacion", "dv", "primer_apellido", "segundo_apellido", "primer_nombre",
      "otros_nombres", "razon_social", "direccion", "codigo_departamento", "codigo_municipio", "pais", "entidad_informante"]);
    const textos = campos.filter((c) => !valores.includes(c) && !PERSONA.has(c));
    const [ter, lista] = personas(filas, valores.concat(textos), cfg, hallazgos);
    const sinTotal = lista.every((m) => !aNumero(m._total_ingresos));
    const entidad = String(cfg.parametros.entidad_informante_2276 || "1");
    const out = lista.map((m) => {
      const t = ter.get(m.nit) || {};
      const o = {};
      campos.forEach((c) => { o[c] = t[c] || ""; });
      textos.forEach((c) => { const v = m["_" + c]; o[c] = vacio(v) ? "" : (typeof v === "number" && Number.isInteger(v) ? String(v) : String(v).trim()); });
      o.entidad_informante = entidad;
      valores.forEach((c) => { o[c] = r0(aNumero(m["_" + c])); });
      if (sinTotal) o.total_ingresos = suma(pagos, (c) => o[c]);
      return o;
    });
    const contable = suma(balance.filter((r) => /^(5105|5205|7205)(06|03)/.test(r.cuenta)), (r) => r.debito - r.credito);
    const nomina = suma(out, (o) => o.pagos_salarios);
    if (contable && Math.abs(contable - nomina) > cfg.parametros.validacion.tolerancia_cuadre) {
      hallazgos.push(["ALERTA", "2276 vs contabilidad", "", `Salarios nómina ${fmtPesos(nomina)} vs sueldos contables ${fmtPesos(contable)} (dif. ${fmtPesos(nomina - contable)})`]);
    }
    return out;
  }

  // ------------------------------------------------------------------ validaciones
  function cuadres(partidas, generados, cfg) {
    const tol = cfg.parametros.validacion.tolerancia_cuadre;
    const out = [];
    if (cfg.parametros.forzar_no_deducible) {
      const mov = { pago_deducible: "pago_no_deducible", iva_deducible: "iva_no_deducible" };
      partidas = partidas.map((p) => (p.formato === "1001" && mov[p.columna] ? { ...p, columna: mov[p.columna] } : p));
    }
    const grupos = agrupar(partidas, (p) => p.formato + "|" + p.columna);
    for (const [k, g] of [...grupos].sort()) {
      const [fmt, col] = k.split("|");
      if (!generados[fmt]) continue;
      const total = suma(g, (p) => p.valor);
      const excl = suma(g.filter((p) => p.descartado === "nit_excluido"), (p) => p.valor);
      const sinT = suma(g.filter((p) => p.descartado === "sin_tercero"), (p) => p.valor);
      const enArchivo = suma(generados[fmt], (r) => r[col] || 0);
      const lineas = agrupar(g.filter((p) => p.descartado === ""), (p) => p.concepto + "|" + p.nit);
      let neg = 0;
      for (const [, l] of lineas) { const s = suma(l, (p) => p.valor); if (s < -0.5) neg += s; }
      const noExp = total - excl - sinT - neg - enArchivo;
      out.push({ formato: fmt, columna: col, total_balance_segun_reglas: r0(total), excluido_por_nit: r0(excl),
        sin_tercero: r0(sinT), negativos_llevados_a_cero: r0(neg), total_en_formato: r0(enArchivo),
        diferencia_no_explicada: r0(noExp), estado: Math.abs(noExp) <= tol ? "OK" : "REVISAR" });
    }
    return out;
  }

  function inconsistencias(balance, cfg, hallazgos) {
    const val = cfg.parametros.validacion;
    for (const [cuenta, g] of agrupar(balance, (r) => r.cuenta)) {
      const mov = suma(g, (r) => r.debito + r.credito);
      if (!mov) continue;
      if ("567".includes(cuenta[0]) && !reglaPara(cfg, "1001", cuenta)) hallazgos.push(["ALERTA", "Cuenta sin parametrizar", cuenta, `Gasto/costo ${cuenta} (${g[0].nombre_cuenta}) sin regla en 1001 (mov. ${fmtPesos(mov)})`]);
      if (cuenta[0] === "4" && !reglaPara(cfg, "1007", cuenta)) hallazgos.push(["ALERTA", "Cuenta sin parametrizar", cuenta, `Ingreso ${cuenta} (${g[0].nombre_cuenta}) sin regla en 1007`]);
    }
    const res = balance.filter((r) => "4567".includes(r.cuenta[0]));
    if (res.length) {
      const mov = suma(res, (r) => r.debito + r.credito), saldo = suma(res, (r) => Math.abs(r.saldo_final));
      if (mov > 0 && saldo / mov < 0.01) hallazgos.push(["ERROR", "Cierre incluido", "", "Las cuentas de resultado quedan en cero: el balance parece incluir el comprobante de cierre. Expórtelo excluyéndolo"]);
    }
    const ing = balance.filter((r) => /^4[12]/.test(r.cuenta) && !r.cuenta.startsWith("4175"));
    const cr = suma(ing, (r) => r.credito);
    if (cr > 0) {
      const pct = suma(ing, (r) => r.debito) / cr * 100;
      if (pct > val.alerta_debitos_ingresos_pct) hallazgos.push(["ALERTA", "Débitos en ingresos", "", `Débitos en 41/42 = ${pct.toFixed(1)}% de los créditos: revisar si son devoluciones que debían ir a 4175`]);
    }
    for (const [pref, esp, nombre] of [["13", 1, "CxC con saldo crédito"], ["22", -1, "Proveedores con saldo débito"], ["23", -1, "CxP con saldo débito"]]) {
      balance.filter((r) => r.cuenta.startsWith(pref) && !/^(236[578]|1355)/.test(r.cuenta) && r.saldo_final * esp < -1000)
        .forEach((r) => hallazgos.push(["ALERTA", nombre, r.nit || r.cuenta, `Cuenta ${r.cuenta} saldo ${Math.round(r.saldo_final).toLocaleString("es-CO")}: reclasificar antes de 1008/1009`]));
    }
    const dif = suma(balance, (r) => r.debito - r.credito);
    if (Math.abs(dif) > 1) hallazgos.push(["ERROR", "Balance descuadrado", "", `Débitos - créditos = ${dif.toFixed(2)}`]);
  }

  // ------------------------------------------------------------------ prevalidador DIAN
  // Compara el layout configurado (versión del año) con el de un prevalidador de la MISMA versión.
  // Deben coincidir en orden; el prevalidador puede traer columnas extra al final solo si son opcionales.
  function estadoColumnas(fmt, spec, prevalidadores) {
    const nuestras = spec.columnas.map(([, e]) => e);
    for (const p of prevalidadores || []) {
      const lay = (p.formatos || {})[fmt];
      if (!lay || Number(lay.version) !== Number(spec.version)) continue;
      const suyas = lay.columnas, difs = [];
      for (let k = 0; k < Math.max(nuestras.length, suyas.length); k++) {
        const a = k < nuestras.length ? nuestras[k] : null, b = k < suyas.length ? suyas[k].encabezado : null;
        if (a === null && !suyas[k].obligatorio) continue;
        if (a === null || b === null || clave(a) !== clave(b)) difs.push(`col ${k + 1}: configurada '${a || "—"}' / prevalidador '${b || "—"}'`);
      }
      return { verificado: !difs.length, fuente: p.nombre, diferencias: difs, omitidas: suyas.slice(nuestras.length).map((c) => c.encabezado) };
    }
    return { verificado: false, fuente: "", diferencias: [], omitidas: [] };
  }

  // Campos que el prevalidador exige: fila 5 = S, o macro E0074/E0075/E0076/E0100 que los exige para terceros de
  // Colombia (dirección, departamento, municipio). Misma versión o, si no hay, cualquier versión, por encabezado.
  const EXIGE_SI_COLOMBIA = /^(E0074|E0075|E0076|E0100)/, LONGITUD_MINIMA = /^E0074\((\d+)\)|^E0100/;
  function layoutPrevalidador(fmt, spec, prevalidadores) {
    const lays = (prevalidadores || []).map((p) => (p.formatos || {})[fmt]).filter(Boolean)
      .sort((a, b) => (Number(a.version) !== Number(spec.version)) - (Number(b.version) !== Number(spec.version)));
    return lays[0] || null;
  }
  function camposObligatorios(fmt, spec, prevalidadores) {
    const lay = layoutPrevalidador(fmt, spec, prevalidadores);
    if (!lay) return [];
    const oblig = new Map(lay.columnas.map((c) => [clave(c.encabezado), c.obligatorio || EXIGE_SI_COLOMBIA.test(c.validacion || "")]));
    return spec.columnas.filter(([, e]) => oblig.get(clave(e))).map(([c]) => c);
  }
  function longitudMinimaDireccion(fmt, spec, prevalidadores) {
    const lay = layoutPrevalidador(fmt, spec, prevalidadores);
    for (const c of (lay || {}).columnas || []) { const m = LONGITUD_MINIMA.exec(c.validacion || ""); if (m) return Number(m[1] || 8); }
    return 0;
  }

  const FORMATOS_PREVALIDADOR = ["1001", "1003", "1005", "1006", "1007", "1008", "1009", "1010", "1011", "1012", "2276"];
  // Lee el prevalidador (.xlsm) con SheetJS: versiones (DefinicionFormatos), columnas (hojas F####) y catálogos (Tablas)
  function leerPrevalidador(XLSX, datos, nombre) {
    const wb = XLSX.read(datos, { type: "array", bookVBA: false });
    const hoja = (n) => wb.Sheets[n] ? filasDeHoja(XLSX, wb.Sheets[n]) : null;
    const txt = (v) => (vacio(v) ? "" : String(v).replace(/(?:_x000D_|\s)+/g, " ").trim());
    const def = hoja("DefinicionFormatos"), tab = hoja("Tablas");
    if (!def || !tab) throw new Error("El archivo no parece un prevalidador de exógena de la DIAN (faltan las hojas DefinicionFormatos/Tablas)");
    const versiones = {};
    def.slice(2).forEach((f) => { const m = /^\s*(\d{4})\s*\(V-(\d+)\)/.exec(txt(f[1])); if (m) versiones[m[1]] = Number(m[2]); });
    const tablas = {};
    for (let i = 1; i < tab.length;) {
      const n = txt(tab[i][0]), c = txt(tab[i][1]);
      if (n.startsWith("D") && /^\d+$/.test(c)) { tablas[n] = tab.slice(i + 1, i + 1 + Number(c)).map((f) => [txt(f[0]), txt(f[1])]); i += Number(c) + 1; } else i++;
    }
    const formatos = {};
    for (const fmt of FORMATOS_PREVALIDADOR) {
      const r = hoja("F" + fmt);
      if (!r || !versiones[fmt]) continue;
      const cols = [];
      for (let j = 1; j < r[1].length && txt(r[1][j]) && !txt(r[1][j]).startsWith("|"); j++) {
        cols.push({ encabezado: txt(r[1][j]), tipo: txt(r[2][j]), longitud: Math.trunc(Number(txt(r[3][j]) || 0)),
          obligatorio: txt(r[4][j]).toUpperCase() === "S", tabla: txt(r[5][j]), validacion: txt(r[8][j]), xml: txt(r[9][j]) });
      }
      const conceptos = cols.length && cols[0].xml === "cpt" && tablas[cols[0].tabla] ? tablas[cols[0].tabla] : [];
      formatos[fmt] = { version: versiones[fmt], columnas: cols, conceptos };
    }
    const base = String(nombre || "prevalidador").replace(/\.[^.]+$/, "");
    return { nombre: /^[0-9a-f]{8}-/.test(base) ? base.slice(9) : base, formatos,
      paises: (tablas.D_2_107 || []).map(([c, n]) => [c, textoDian(n)]),
      tipos_documento: tablas.DTiposDocto || [], entidad_informante_2276: tablas.DEntidadInfor || [] };
  }

  // ------------------------------------------------------------------ orquestación
  function prepararConfig(cfg) {
    const anio = String(cfg.parametros.anio_gravable);
    Object.values(cfg.formatos).forEach((f) => { if (f.version_por_anio && f.version_por_anio[anio]) f.version = f.version_por_anio[anio]; });
    Object.entries(cfg.formatos).forEach(([k, f]) => {
      f.verificacion_columnas = estadoColumnas(k, f, cfg.prevalidadores); f.columnas_verificadas = f.verificacion_columnas.verificado;
      f.obligatorios = camposObligatorios(k, f, cfg.prevalidadores);
      f.direccion_minima = longitudMinimaDireccion(k, f, cfg.prevalidadores);
    });
    cfg.divipola.forEach((d) => { d.k_mpio = clave(d.municipio); d.k_dpto = clave(d.departamento); });
    cfg._sinVerificar = new Set();
    return cfg;
  }

  function ejecutar(entrada, cfg) {
    // entrada: { fuente, balance: filas[][], terceros?: filas[][], accionistas?: filas[][], nomina?: filas[][], formatos? }
    prepararConfig(cfg);
    const errores = validarReglas(cfg);
    if (errores.length) throw new Error("Parametrización inválida:\n" + errores.join("\n"));
    const hallazgos = [];
    const bal = cargarBalance(entrada.balance, entrada.fuente, cfg, hallazgos);
    const maestro = completarMaestro(cargarTerceros(entrada.terceros, entrada.fuente, cfg), bal, entrada.facturas, cfg, hallazgos);
    const ter = depurar(bal, maestro, cfg, hallazgos);
    inconsistencias(bal, cfg, hallazgos);
    const partidas = generarPartidas(bal, cfg, hallazgos);
    const pedidos = entrada.formatos || Object.keys(cfg.formatos);
    const generados = {};
    for (const fmt of pedidos) {
      const modo = cfg.formatos[fmt].modo;
      if (modo === "por_tercero" || modo === "sin_tercero") {
        if (!cfg.reglas.some((r) => r.formato === fmt)) { hallazgos.push(["ALERTA", "Formato sin reglas", fmt, `${fmt} no tiene reglas en la parametrización; no se generó`]); continue; }
        generados[fmt] = construirFormato(fmt, partidas, ter, bal, cfg, hallazgos);
      } else if (fmt === "1010" && entrada.accionistas) generados[fmt] = formato1010(entrada.accionistas, bal, cfg, hallazgos);
      else if (fmt === "2276" && entrada.nomina) generados[fmt] = formato2276(entrada.nomina, bal, cfg, hallazgos);
      else hallazgos.push(["INFO", "Insumo externo no suministrado", fmt, `${fmt} requiere archivo adicional (${fmt === "1010" ? "libro de accionistas" : "consolidado de nómina"})`]);
    }
    for (const fmt of Object.keys(generados)) {
      if (!cfg.formatos[fmt].verificado) cfg._sinVerificar.add(`Layout formato ${fmt} v${cfg.formatos[fmt].version}`);
      const ver = cfg.formatos[fmt].verificacion_columnas;
      if (!ver.verificado) cfg._sinVerificar.add(`Orden de columnas del formato ${fmt} v${cfg.formatos[fmt].version} (${ver.diferencias.length ? "difiere del prevalidador" : "sin prevalidador DIAN de esa versión"})`);
      if (ver.omitidas.length) hallazgos.push(["INFO", "Columnas opcionales no generadas", fmt, `El prevalidador del ${fmt} v${cfg.formatos[fmt].version} trae columnas opcionales que el aplicativo no calcula: ${ver.omitidas.join("; ")}. Diligéncielas si aplican`]);
      const ok = new Set(cfg.conceptos.filter((c) => c.formato === fmt && String(c.verificado).toUpperCase() === "SI").map((c) => c.concepto));
      new Set(generados[fmt].map((r) => r.concepto).filter(Boolean)).forEach((c) => { if (!ok.has(c)) cfg._sinVerificar.add(`Concepto ${c} del formato ${fmt}`); });
    }
    if (Object.keys(generados).some((f) => f !== "1011") && !cfg.parametros.cuantias_menores.verificado) cfg._sinVerificar.add("NIT/tipo de documento de cuantías menores");

    const orden = { ERROR: 0, ALERTA: 1, INFO: 2 };
    const vistos = new Set();
    const hall = hallazgos.filter((h) => { const k = h.join("\u0001"); if (vistos.has(k)) return false; vistos.add(k); return true; })
      .sort((a, b) => orden[a[0]] - orden[b[0]] || a[1].localeCompare(b[1]));
    return { balance: bal, terceros: ter, partidas, generados, hallazgos: hall, cuadres: cuadres(partidas, generados, cfg),
      sinVerificar: [...cfg._sinVerificar].sort() };
  }

  // CSV: UTF-8 si es válido, si no Windows-1252 (Excel en español guarda así)
  function textoCsv(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u8).replace(/^\uFEFF/, ""); }
    catch (e) { return new TextDecoder("windows-1252").decode(u8); }
  }

  // Algunos exports (Siigo) declaran mal el rango de la hoja (!ref = A1:A813): se recalcula con las celdas reales
  function filasDeHoja(XLSX, ws) {
    let maxR = 0, maxC = 0;
    for (const k of Object.keys(ws)) {
      if (k[0] === "!") continue;
      const c = XLSX.utils.decode_cell(k);
      if (c.r > maxR) maxR = c.r;
      if (c.c > maxC) maxC = c.c;
    }
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  }
  function leerLibro(XLSX, datos, nombre) {
    const wb = /\.(csv|txt)$/i.test(nombre || "")
      ? XLSX.read(textoCsv(datos), { type: "string", raw: true })
      : XLSX.read(datos, { type: "array" });
    return filasDeHoja(XLSX, wb.Sheets[wb.SheetNames[0]]);
  }

  const api = { ejecutar, estadoColumnas, leerPrevalidador, leerFacturaXml, leerFacturasArchivo, completarMaestro, ubicar, textoCsv, leerLibro, cargarBalance, prepararConfig, porcentajeDian, topePesos, calcularDv, separarDv, aNumero, clave, textoDian, partirNombre, validarReglas, reglaPara };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Exogena = api;
})(typeof window !== "undefined" ? window : globalThis);
