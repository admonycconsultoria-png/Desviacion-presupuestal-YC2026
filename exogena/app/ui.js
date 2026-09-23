/* Interfaz del aplicativo Exógena YC. Todo corre en el navegador: los balances se leen en memoria,
 * nunca se guardan ni se envían. Solo la PARAMETRIZACIÓN se guarda (localStorage + respaldo JSON). */
(function () {
  "use strict";
  const DEF = window.CONFIG_DEFECTO;
  const LS_EMPRESAS = "exogenaYC.empresas.v1", LS_NORMATIVO = "exogenaYC.normativo.v1", LS_ACTIVA = "exogenaYC.activa.v1";
  const BASES = [
    ["neto_deb", "Débito − crédito (gastos, costos)"], ["neto_cred", "Crédito − débito (ingresos)"],
    ["debito", "Solo débitos (compras a inventario/activos, IVA descontable)"], ["credito", "Solo créditos (retenciones, IVA generado)"],
    ["saldo_deb", "Saldo final deudor (CxC)"], ["saldo_cred", "Saldo final acreedor (CxP)"],
    ["saldo_deb_cuenta", "Saldo deudor de toda la cuenta a un tercero fijo (bancos, DIAN)"],
    ["saldo_cred_cuenta", "Saldo acreedor de toda la cuenta a un tercero fijo (DIAN, municipio)"],
  ];
  const CAMPOS_TERCERO = new Set(["tipo_documento", "numero_identificacion", "dv", "primer_apellido", "segundo_apellido",
    "primer_nombre", "otros_nombres", "razon_social", "direccion", "codigo_departamento", "codigo_municipio", "pais"]);
  const CAMPOS_TEXTO = new Set([...CAMPOS_TERCERO, "concepto", "entidad_informante",
    "tipo_doc_dependiente", "nit_dependiente", "id_fideicomiso", "tipo_doc_colaboracion", "nit_colaboracion"]);

  // ------------------------------------------------------------------ utilidades
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const copia = (o) => JSON.parse(JSON.stringify(o));
  const pesos = (x) => Math.round(Number(x) || 0).toLocaleString("es-CO");
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function leerLS(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function guardarLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast("No se pudo guardar en este navegador. Exporte la configuración como respaldo."); return false; } }
  let tToast;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("ver"); clearTimeout(tToast); tToast = setTimeout(() => t.classList.remove("ver"), 3500); }
  function camposValor(fmt) { return DEF.formatos[fmt].columnas.map(([c]) => c).filter((c) => !CAMPOS_TERCERO.has(c) && c !== "concepto"); }
  function formatosConReglas() { return Object.keys(DEF.formatos).filter((f) => ["por_tercero", "sin_tercero"].includes(DEF.formatos[f].modo)); }

  // ------------------------------------------------------------------ estado
  function normativoDefecto() {
    const p = DEF.parametros;
    const formatos = {};
    Object.entries(DEF.formatos).forEach(([k, f]) => { formatos[k] = { version: f.version, verificado: !!f.verificado }; });
    return { version: NORMATIVO_VERSION, formatos, prevalidadores: [], topes: copia(p.topes), uvt: copia(p.uvt), cuantias_menores: copia(p.cuantias_menores),
      conceptos: copia(DEF.conceptos), paises: copia(DEF.paises), no_agrupar_si_retencion: p.no_agrupar_si_retencion !== false };
  }
  function empresaNueva(nombre, nit) {
    return { id: uid(), razon_social: nombre || "Nueva empresa", nit: nit || "", anio: new Date().getFullYear() - 1,
      direccion: "", codigo_departamento: "", codigo_municipio: "", fuente: "siigo", orden_nombre: "apellidos_nombres",
      cuentas_bancarias: [], nits_excluidos: [], reglas: copia(DEF.reglas), reglasVersion: REGLAS_VERSION, correcciones: {}, revisiones: {}, diagnostico: {} };
  }
  // normativo 2 = Res. 227/2025 (mod. 233/2025); 3 = columnas, conceptos y países del prevalidador DIAN
  const NORMATIVO_VERSION = 3, REGLAS_VERSION = 2;
  let normGuardado = leerLS(LS_NORMATIVO, null);
  const migrado = normGuardado && (normGuardado.version || 1) < NORMATIVO_VERSION;
  if (!normGuardado || migrado) normGuardado = { ...normativoDefecto(), prevalidadores: (normGuardado && normGuardado.prevalidadores) || [] };
  const E = {
    empresas: leerLS(LS_EMPRESAS, []),
    normativo: normGuardado,
    activa: leerLS(LS_ACTIVA, null),
    vista: "procesar", subvista: "hallazgos",
    archivos: {}, resultado: null, filtroNivel: "", filtroTexto: "", filtroFmt: "", filtroRegla: "", verFormato: null,
    fmtAsis: "1001", cacheBal: null,
  };
  E.empresas.forEach((x) => { x.correcciones = x.correcciones || {}; x.revisiones = x.revisiones || {}; x.diagnostico = x.diagnostico || {}; });
  const empresa = () => E.empresas.find((x) => x.id === E.activa) || null;
  let tGuardar;
  function guardar() { clearTimeout(tGuardar); tGuardar = setTimeout(() => { guardarLS(LS_EMPRESAS, E.empresas); guardarLS(LS_NORMATIVO, E.normativo); guardarLS(LS_ACTIVA, E.activa); }, 250); }

  function construirCfg(emp) {
    const cfg = copia(DEF);
    const p = cfg.parametros, n = E.normativo;
    p.anio_gravable = Number(emp.anio) || p.anio_gravable;
    p.empresa = { nit: String(emp.nit || "").replace(/\D/g, ""), razon_social: emp.razon_social, direccion: emp.direccion,
      codigo_departamento: emp.codigo_departamento, codigo_municipio: emp.codigo_municipio };
    p.validacion.orden_nombre_completo = emp.orden_nombre;
    p.cuentas_bancarias = {};
    (emp.cuentas_bancarias || []).forEach((c) => { if (c.cuenta && c.nit) p.cuentas_bancarias[String(c.cuenta).replace(/\D/g, "")] = String(c.nit).replace(/\D/g, ""); });
    p.nits_excluidos.global = ["{empresa}"].concat((emp.nits_excluidos || []).map((x) => String(x).replace(/\D/g, "")).filter(Boolean));
    p.topes = copia(n.topes); p.cuantias_menores = copia(n.cuantias_menores); p.no_agrupar_si_retencion = n.no_agrupar_si_retencion;
    if (n.uvt) p.uvt = copia(n.uvt);
    const reg = (emp.diagnostico || {}).regimen;
    p.forzar_no_deducible = reg === "simple" || reg === "no_contribuyente";
    Object.entries(n.formatos).forEach(([k, f]) => {
      if (!cfg.formatos[k]) return;
      cfg.formatos[k].version = f.version; cfg.formatos[k].verificado = f.verificado;
    });
    cfg.prevalidadores = prevalidadores();
    cfg.conceptos = copia(n.conceptos);
    if (n.paises) cfg.paises = copia(n.paises);
    cfg.reglas = copia(emp.reglas);
    p.correcciones_terceros = copia(emp.correcciones || {});
    return cfg;
  }

  // ------------------------------------------------------------------ barra lateral
  function renderLateral() {
    const cont = $("#lista-empresas");
    cont.innerHTML = E.empresas.length ? E.empresas.map((x) => `
      <div class="empresa-item ${x.id === E.activa && E.vista !== "normativo" ? "activa" : ""}" data-id="${x.id}">
        <b>${esc(x.razon_social)}</b><small>NIT ${esc(x.nit || "—")} · AG ${esc(x.anio)} · ${esc(x.fuente)}</small>
      </div>`).join("") : `<small style="color:var(--texto-2)">Aún no hay empresas.</small>`;
    $$(".empresa-item[data-id]", cont).forEach((el) => el.onclick = () => {
      if (E.activa !== el.dataset.id) { E.archivos = {}; E.resultado = null; }
      E.activa = el.dataset.id; if (E.vista === "normativo") E.vista = "procesar"; guardar(); render();
    });
    $("#nav-normativo").classList.toggle("activa", E.vista === "normativo");
    const emp = empresa();
    $("#hdr-empresa").textContent = emp && E.vista !== "normativo" ? `${emp.razon_social} · AG ${emp.anio}` : "";
  }

  // ------------------------------------------------------------------ vistas
  function render() {
    renderLateral();
    const m = $("#principal");
    if (E.vista === "normativo") return renderNormativo(m);
    const emp = empresa();
    if (!emp) {
      m.innerHTML = `<div class="panel"><h2>Bienvenido</h2>
        <p>1. Cree una empresa con <b>+ Nueva empresa</b> (NIT, año gravable y software contable).</p>
        <p>2. Cargue el <b>balance de prueba por tercero</b> y el <b>listado de terceros</b> exportados del software (enero a diciembre, sin comprobante de cierre).</p>
        <p>3. Revise los hallazgos, ajuste la parametrización de cuentas de esa empresa y descargue los formatos para el prevalidador.</p>
        <p class="ayuda">Cada empresa guarda su propia parametrización de cuentas. Los conceptos, topes y versiones de formato son comunes a todas y se ajustan en <b>Parámetros normativos</b>.</p></div>`;
      return;
    }
    m.innerHTML = `<div class="tabs">
      ${[["procesar", "Procesar exógena"], ["asistente", "Asistente por formato"], ["datos", "Datos y diagnóstico"],
         ["reglas", `Reglas de cuentas (${emp.reglas.length})`], ["correcciones", `Correcciones de terceros (${Object.keys(emp.correcciones || {}).length})`]]
        .map(([k, t]) => `<button class="tab ${E.vista === k ? "activa" : ""}" data-v="${k}">${t}</button>`).join("")}
      </div><div id="vista"></div>`;
    $$(".tab", m).forEach((b) => b.onclick = () => { E.vista = b.dataset.v; render(); });
    const v = $("#vista");
    if (E.vista === "datos") renderDatos(v, emp);
    else if (E.vista === "reglas") renderReglas(v, emp);
    else if (E.vista === "asistente") renderAsistente(v, emp);
    else if (E.vista === "correcciones") renderCorrecciones(v, emp);
    else renderProcesar(v, emp);
  }

  // ---------------- Procesar
  const INSUMOS = [
    ["balance", "Balance de prueba por tercero", true, "Enero a diciembre · nivel auxiliar · sin cierre"],
    ["terceros", "Listado de terceros", true, "Con dirección, ciudad y tipo de documento"],
    ["accionistas", "Libro de accionistas", false, "Para el 1010: nit, nombre, ciudad, porcentaje o acciones"],
    ["nomina", "Consolidado de nómina", false, "Para el 2276: use la plantilla de nómina (botón abajo)"],
  ];
  function renderProcesar(v, emp) {
    const fuentes = Object.entries(DEF.fuentes);
    v.innerHTML = `<div class="panel"><h2>1. Archivos del año gravable ${esc(emp.anio)}</h2>
      <p class="ayuda">Arrastre los archivos o haga clic en cada recuadro. Se aceptan .xlsx, .xls y .csv tal como salen del software.</p>
      <div class="barra"><label>Software contable&nbsp;<select id="sel-fuente">${fuentes.map(([k, f]) => `<option value="${k}" ${emp.fuente === k ? "selected" : ""}>${esc(k)} — ${esc(f.descripcion)}</option>`).join("")}</select></label></div>
      <div class="drops">${INSUMOS.map(([k, t, req, ay]) => {
        const a = E.archivos[k];
        return `<label class="drop ${a ? "cargado" : ""}" data-k="${k}"><input type="file" accept=".xlsx,.xls,.csv,.txt">
          <b>${t} ${req ? '<span class="req">*</span>' : ""}</b>
          <small>${a ? "✓ " + esc(a.nombre) + ` (${a.filas.length} filas)` : ay}</small></label>`;
      }).join("")}</div>
      <div class="barra" style="margin-top:14px"><button class="prim" id="btn-generar" ${E.archivos.balance ? "" : "disabled"}>Generar exógena</button>
      ${Object.keys(E.archivos).length ? '<button id="btn-limpiar">Quitar archivos</button>' : ""}
      <button id="btn-plantilla-nom">Descargar plantilla de nómina (2276)</button>
      <span class="esp"></span><small style="color:var(--texto-2)">El listado de terceros no es obligatorio para correr, pero sin él faltarán direcciones y municipios.</small></div>
      </div><div id="res"></div>`;
    $("#sel-fuente").onchange = (e) => { emp.fuente = e.target.value; guardar(); renderLateral(); };
    $$(".drop", v).forEach((d) => {
      const inp = $("input", d);
      inp.onchange = () => inp.files[0] && cargarArchivo(d.dataset.k, inp.files[0]);
      d.ondragover = (e) => { e.preventDefault(); d.classList.add("sobre"); };
      d.ondragleave = () => d.classList.remove("sobre");
      d.ondrop = (e) => { e.preventDefault(); d.classList.remove("sobre"); if (e.dataTransfer.files[0]) cargarArchivo(d.dataset.k, e.dataTransfer.files[0]); };
    });
    $("#btn-generar").onclick = () => generar(emp);
    $("#btn-plantilla-nom").onclick = descargarPlantillaNomina;
    if ($("#btn-limpiar")) $("#btn-limpiar").onclick = () => { E.archivos = {}; E.resultado = null; render(); };
    if (E.resultado) renderResultado($("#res"), emp);
  }

  // Plantilla del 2276: encabezados que lee el motor + hoja de instrucciones (config/plantilla_nomina.yaml)
  function descargarPlantillaNomina() {
    const cols = DEF.plantillaNomina || [];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([cols.map((c) => c.columna)]);
    ws["!cols"] = cols.map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, ws, "Nomina");
    const ins = XLSX.utils.aoa_to_sheet([["Plantilla de nómina para el formato 2276 v4"],
      ["Una fila por empleado con los acumulados del año. No cambie los encabezados. Valores en pesos, sin decimales. Deje vacío lo que no aplique."],
      [], ["Columna de la plantilla", "Columna del prevalidador 2276", "Qué va", "Obligatoria"]]
      .concat(cols.map((c) => [c.columna, c.dian, c.ayuda || "", c.obligatorio ? "Sí" : ""])));
    ins["!cols"] = [{ wch: 28 }, { wch: 60 }, { wch: 90 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ins, "Instrucciones");
    XLSX.writeFile(wb, "Plantilla_nomina_2276.xlsx");
  }

  function cargarArchivo(k, file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const filas = Exogena.leerLibro(XLSX, new Uint8Array(fr.result), file.name);
        E.archivos[k] = { nombre: file.name, filas };
        E.resultado = null;
        render();
      } catch (e) { toast("No se pudo leer " + file.name + ":\n" + e.message); }
    };
    fr.readAsArrayBuffer(file);
  }

  function generar(emp) {
    if (!String(emp.nit || "").trim()) { toast("Primero registre el NIT de la empresa en 'Datos de la empresa'."); E.vista = "datos"; render(); return; }
    const btn = $("#btn-generar"); btn.disabled = true; btn.textContent = "Procesando…";
    setTimeout(() => {
      try {
        const cfg = construirCfg(emp);
        const r = Exogena.ejecutar({ fuente: emp.fuente, balance: E.archivos.balance.filas, terceros: E.archivos.terceros && E.archivos.terceros.filas,
          accionistas: E.archivos.accionistas && E.archivos.accionistas.filas, nomina: E.archivos.nomina && E.archivos.nomina.filas }, cfg);
        r.cfg = cfg; r.fecha = new Date();
        E.resultado = r; E.subvista = "hallazgos"; E.verFormato = null;
      } catch (e) {
        E.resultado = null;
        toast("Error al procesar:\n" + e.message);
        console.error(e);
      }
      render();
    }, 30);
  }

  function renderResultado(el, emp) {
    const r = E.resultado;
    const n = (lv) => r.hallazgos.filter((h) => h[0] === lv).length;
    const sinRegla = cuentasSinRegla(r);
    const pend = pendientesRevision(emp, r.balance);
    const nPend = Object.values(pend).reduce((a, b) => a + b, 0);
    const listo = n("ERROR") === 0 && r.sinVerificar.length === 0 && nPend === 0;
    const revisar = r.cuadres.filter((c) => c.estado !== "OK").length;
    el.innerHTML = `
      <div class="dictamen ${listo ? "si" : "no"}">${listo ? "✓ Listo para prevalidador" :
        `No listo para prevalidador: ${[n("ERROR") ? `${n("ERROR")} errores por corregir` : "", nPend ? `${nPend} cuentas sin revisar en el asistente` : "", r.sinVerificar.length ? `${r.sinVerificar.length} parámetros normativos sin verificar` : ""].filter(Boolean).join(" · ")}`}</div>
      <div class="kpis">
        <div class="kpi"><span>Formatos generados</span><b>${Object.keys(r.generados).length}</b></div>
        <div class="kpi"><span>Terceros depurados</span><b>${r.terceros.size}</b></div>
        <div class="kpi e"><span>Errores</span><b>${n("ERROR")}</b></div>
        <div class="kpi a"><span>Alertas</span><b>${n("ALERTA")}</b></div>
        <div class="kpi ${revisar ? "e" : "o"}"><span>Cuadres con diferencia</span><b>${revisar}</b></div>
      </div>
      <div class="tabs">${[["hallazgos", `Hallazgos (${r.hallazgos.length})`], ["corregir", `Corregir terceros (${tercerosACorregir(r).length})`], ["formatos", "Formatos y descargas"], ["cuadres", "Cuadres"],
        ["sinregla", `Cuentas sin parametrizar (${sinRegla.length})`], ["verificar", `Parámetros sin verificar (${r.sinVerificar.length})`],
        ["conciliacion", "Conciliación con declaraciones"], ["sanciones", "Sanciones (art. 651)"]]
        .map(([k, t]) => `<button class="tab ${E.subvista === k ? "activa" : ""}" data-s="${k}">${t}</button>`).join("")}</div>
      <div id="sub"></div>`;
    $$(".tab[data-s]", el).forEach((b) => b.onclick = () => { E.subvista = b.dataset.s; renderResultado(el, emp); });
    const s = $("#sub", el);
    ({ conciliacion: subConciliacion, sanciones: subSanciones, hallazgos: subHallazgos, corregir: subCorregir, formatos: subFormatos, cuadres: subCuadres, sinregla: subSinRegla, verificar: subVerificar })[E.subvista](s, r, emp);
  }

  function subHallazgos(s, r) {
    const cats = [...new Set(r.hallazgos.map((h) => h[1]))].sort();
    s.innerHTML = `<div class="barra">
      <select id="f-nivel"><option value="">Todos los niveles</option>${["ERROR", "ALERTA", "INFO"].map((x) => `<option ${E.filtroNivel === x ? "selected" : ""}>${x}</option>`).join("")}</select>
      <select id="f-cat"><option value="">Todas las categorías</option>${cats.map((c) => `<option ${E.filtroTexto === "cat:" + c ? "selected" : ""} value="cat:${esc(c)}">${esc(c)}</option>`).join("")}</select>
      <input id="f-txt" placeholder="Buscar NIT, cuenta o texto…" value="${esc(E.filtroTexto.startsWith("cat:") ? "" : E.filtroTexto)}">
      <span class="esp"></span><small style="color:var(--texto-2)">ERROR impide la carga · ALERTA revisar · INFO decisión del motor</small></div>
      <div class="tabla-wrap"><table><thead><tr><th>Nivel</th><th>Categoría</th><th>NIT / cuenta</th><th>Detalle</th></tr></thead><tbody id="tb-h"></tbody></table></div>`;
    const pintar = () => {
      const t = E.filtroTexto.toLowerCase();
      const filas = r.hallazgos.filter((h) => (!E.filtroNivel || h[0] === E.filtroNivel) &&
        (!t || (t.startsWith("cat:") ? h[1].toLowerCase() === t.slice(4) : h.join(" ").toLowerCase().includes(t))));
      $("#tb-h").innerHTML = filas.length ? filas.slice(0, 2000).map((h) => `<tr class="${h[0]}"><td><span class="chip ${h[0]}">${h[0]}</span></td><td>${esc(h[1])}</td><td>${esc(h[2])}</td><td>${esc(h[3])}</td></tr>`).join("")
        : `<tr><td colspan="4" class="vacio">Sin hallazgos con ese filtro.</td></tr>`;
    };
    $("#f-nivel").onchange = (e) => { E.filtroNivel = e.target.value; pintar(); };
    $("#f-cat").onchange = (e) => { E.filtroTexto = e.target.value; $("#f-txt").value = ""; pintar(); };
    $("#f-txt").oninput = (e) => { E.filtroTexto = e.target.value; $("#f-cat").value = ""; pintar(); };
    pintar();
  }

  function subFormatos(s, r, emp) {
    const fmts = Object.keys(r.generados);
    s.innerHTML = `<div class="barra"><button class="prim" id="dl-todos">Descargar todos los formatos</button>
      <button id="dl-informe">Descargar informe de validación</button><span class="esp"></span>
      <small style="color:var(--texto-2)">Un archivo por formato, con las columnas en el orden del prevalidador.</small></div>
      <div class="formatos-lista">${fmts.map((f) => {
        const vals = camposValor(f);
        const tot = vals.slice(0, 2).map((c) => `${esc(r.cfg.formatos[f].columnas.find((x) => x[0] === c)[1])}: <b>$${pesos(r.generados[f].reduce((a, x) => a + (x[c] || 0), 0))}</b>`).join("<br>");
        return `<div class="fmt-card"><b>${f}</b><small>${esc(r.cfg.formatos[f].nombre)} · v${esc(r.cfg.formatos[f].version)}</small>
          <span>${r.generados[f].length} registros</span><small>${tot}</small>
          <div class="barra" style="margin:4px 0 0"><button class="mini prim" data-dl="${f}">Descargar</button><button class="mini" data-ver="${f}">Ver</button></div></div>`;
      }).join("")}</div><div id="prev" style="margin-top:16px"></div>`;
    $("#dl-todos").onclick = () => fmts.forEach((f, i) => setTimeout(() => descargarFormato(r, emp, f), i * 350));
    $("#dl-informe").onclick = () => descargarInforme(r, emp);
    $$("[data-dl]", s).forEach((b) => b.onclick = () => descargarFormato(r, emp, b.dataset.dl));
    $$("[data-ver]", s).forEach((b) => b.onclick = () => { E.verFormato = b.dataset.ver; verFormato(r); });
    if (E.verFormato && r.generados[E.verFormato]) verFormato(r);
  }
  function verFormato(r) {
    const f = E.verFormato, cols = r.cfg.formatos[f].columnas, filas = r.generados[f];
    $("#prev").innerHTML = `<div class="panel"><h2>Vista previa ${f} (${filas.length} registros)</h2><div class="tabla-wrap"><table>
      <thead><tr>${cols.map(([, h]) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${filas.slice(0, 500).map((x) => `<tr>${cols.map(([c]) => typeof x[c] === "number" ? `<td class="num">${pesos(x[c])}</td>` : `<td>${esc(x[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;
  }

  function subCuadres(s, r) {
    const cols = ["formato", "columna", "total_balance_segun_reglas", "excluido_por_nit", "sin_tercero", "negativos_llevados_a_cero", "total_en_formato", "diferencia_no_explicada", "estado"];
    s.innerHTML = `<p class="ayuda">Compara lo que dice el balance según la parametrización contra lo que quedó en cada formato. La diferencia se explica por NIT excluidos (propio, DIAN), movimiento sin tercero y negativos llevados a cero. Si queda diferencia no explicada, algo se perdió.</p>
      <div class="tabla-wrap"><table><thead><tr>${cols.map((c) => `<th>${c.replace(/_/g, " ")}</th>`).join("")}</tr></thead>
      <tbody>${r.cuadres.map((c) => `<tr>${cols.map((k) => k === "estado" ? `<td><span class="chip ${c[k]}">${c[k]}</span></td>` : typeof c[k] === "number" ? `<td class="num">${pesos(c[k])}</td>` : `<td>${esc(c[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function cuentasSinRegla(r) {
    const m = new Map();
    for (const f of r.balance) {
      if (!f.debito && !f.credito) continue;
      const fmt = "567".includes(f.cuenta[0]) ? "1001" : f.cuenta[0] === "4" ? "1007" : null;
      if (!fmt || Exogena.reglaPara(r.cfg, fmt, f.cuenta)) continue;
      const x = m.get(f.cuenta) || { cuenta: f.cuenta, nombre: f.nombre_cuenta, fmt, mov: 0 };
      x.mov += f.debito + f.credito; m.set(f.cuenta, x);
    }
    return [...m.values()].sort((a, b) => a.cuenta.localeCompare(b.cuenta));
  }
  function subSinRegla(s, r, emp) {
    const lista = cuentasSinRegla(r);
    if (!lista.length) { s.innerHTML = `<div class="vacio">Todas las cuentas de ingreso, gasto y costo con movimiento tienen regla.</div>`; return; }
    s.innerHTML = `<p class="ayuda">Cuentas de resultado con movimiento que no llegan a ningún formato. Asigne el concepto y vuelva a generar. La regla se guarda en la parametrización de esta empresa.</p>
      <div class="tabla-wrap"><table><thead><tr><th>Cuenta</th><th>Nombre</th><th>Movimiento</th><th>Formato</th><th>Concepto</th><th>Columna</th><th>Base</th><th></th></tr></thead><tbody>
      ${lista.map((x, i) => `<tr data-i="${i}"><td>${x.cuenta}</td><td>${esc(x.nombre)}</td><td class="num">${pesos(x.mov)}</td><td>${x.fmt}</td>
        <td><select class="c">${opcionesConcepto(x.fmt, x.fmt === "1001" ? "5016" : "4002")}</select></td>
        <td><select class="col">${camposValor(x.fmt).map((c) => `<option ${c === (x.fmt === "1001" ? "pago_deducible" : "ingreso_bruto") ? "selected" : ""}>${c}</option>`).join("")}</select></td>
        <td><select class="b">${BASES.map(([k]) => `<option ${k === (x.fmt === "1001" ? "neto_deb" : "neto_cred") ? "selected" : ""}>${k}</option>`).join("")}</select></td>
        <td><button class="mini prim">Agregar regla</button></td></tr>`).join("")}</tbody></table></div>`;
    $$("tbody tr", s).forEach((tr) => $("button", tr).onclick = () => {
      const x = lista[tr.dataset.i];
      emp.reglas.push({ formato: x.fmt, prefijo: x.cuenta, concepto: $(".c", tr).value, columna: $(".col", tr).value, base: $(".b", tr).value, notas: x.nombre });
      guardar(); tr.remove(); toast(`Regla agregada para ${x.cuenta}. Vuelva a generar para aplicarla.`);
    });
  }
  function opcionesConcepto(fmt, sel) {
    const cs = E.normativo.conceptos.filter((c) => c.formato === fmt);
    return cs.map((c) => `<option value="${esc(c.concepto)}" ${c.concepto === sel ? "selected" : ""}>${esc(c.concepto)} — ${esc(c.descripcion)}</option>`).join("") +
      `<option value="EXCLUIR" ${sel === "EXCLUIR" ? "selected" : ""}>EXCLUIR — no se reporta</option>`;
  }
  function subVerificar(s, r) {
    s.innerHTML = r.sinVerificar.length ? `<div class="aviso">Estos parámetros se usaron sin haber sido contrastados con la resolución DIAN del año gravable. Verifíquelos en <b>Parámetros normativos</b>. El orden de columnas se verifica solo al cargar allí el prevalidador DIAN de la misma versión del formato.</div>
      <div class="tabla-wrap"><table><thead><tr><th>Parámetro</th></tr></thead><tbody>${r.sinVerificar.map((x) => `<tr><td>${esc(x)}</td></tr>`).join("")}</tbody></table></div>
      <div class="barra" style="margin-top:12px"><button class="prim" id="ir-norm">Ir a Parámetros normativos</button></div>`
      : `<div class="vacio">Todos los parámetros usados están verificados.</div>`;
    if ($("#ir-norm")) $("#ir-norm").onclick = () => { E.vista = "normativo"; render(); };
  }

  // ---------------- Descargas
  function hoja(aoa, anchoMax = 50) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = (aoa[0] || []).map((_, j) => ({ wch: Math.min(anchoMax, Math.max(8, ...aoa.slice(0, 300).map((f) => String(f[j] === undefined ? "" : f[j]).length + 2))) }));
    return ws;
  }
  function aoaFormato(r, f) {
    const cols = r.cfg.formatos[f].columnas;
    return [cols.map(([, h]) => h)].concat(r.generados[f].map((x) => cols.map(([c]) => (CAMPOS_TEXTO.has(c) ? String(x[c] === undefined ? "" : x[c]) : x[c]))));
  }
  const sufijo = (emp) => `AG${emp.anio}_${String(emp.nit).replace(/\D/g, "")}`;
  function descargarFormato(r, emp, f) {
    // el prevalidador acepta hasta 5.000 registros por archivo: se parte en _parte1, _parte2...
    const aoa = aoaFormato(r, f), enc = aoa[0], datos = aoa.slice(1), MAX = 5000;
    const partes = Math.max(1, Math.ceil(datos.length / MAX));
    for (let i = 0; i < partes; i++) {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, hoja([enc].concat(datos.slice(i * MAX, (i + 1) * MAX))), f);
      setTimeout(() => XLSX.writeFile(wb, `Formato_${f}_v${r.cfg.formatos[f].version}_${sufijo(emp)}${partes > 1 ? "_parte" + (i + 1) : ""}.xlsx`), i * 300);
    }
    if (partes > 1) toast(`${f}: ${datos.length} registros en ${partes} archivos de máximo 5.000 (límite del prevalidador).`);
  }
  function descargarInforme(r, emp) {
    const wb = XLSX.utils.book_new();
    const n = (lv) => r.hallazgos.filter((h) => h[0] === lv).length;
    const res = [["Indicador", "Valor"], ["Empresa", emp.razon_social], ["NIT", emp.nit], ["Año gravable", emp.anio],
      ["Generado", r.fecha.toLocaleString("es-CO")], ["Formatos generados", Object.keys(r.generados).join(", ")]]
      .concat(Object.entries(r.generados).map(([f, x]) => [`Registros formato ${f}`, x.length]))
      .concat([["Hallazgos ERROR", n("ERROR")], ["Hallazgos ALERTA", n("ALERTA")], ["Hallazgos INFO", n("INFO")], ["Terceros depurados", r.terceros.size],
        ["¿Listo para prevalidador?", n("ERROR") === 0 && !r.sinVerificar.length ? "SÍ" : "NO — corregir ERRORES y verificar parámetros"]]);
    XLSX.utils.book_append_sheet(wb, hoja(res, 70), "Resumen");
    XLSX.utils.book_append_sheet(wb, hoja([["Nivel", "Categoría", "NIT o cuenta", "Detalle"]].concat(r.hallazgos.map((h) => h.map(String))), 110), "Hallazgos");
    const cc = Object.keys(r.cuadres[0] || { formato: 1 });
    XLSX.utils.book_append_sheet(wb, hoja([cc].concat(r.cuadres.map((c) => cc.map((k) => c[k])))), "Cuadres");
    XLSX.utils.book_append_sheet(wb, hoja([["Parámetro sin verificar"]].concat(r.sinVerificar.map((x) => [x])), 80), "Parametros sin verificar");
    const pc = ["formato", "cuenta", "nombre_cuenta", "nit", "concepto", "columna", "base", "prefijo_regla", "valor", "descartado"];
    XLSX.utils.book_append_sheet(wb, hoja([pc].concat(r.partidas.map((p) => pc.map((k) => (k === "valor" ? Math.round(p[k] * 100) / 100 : String(p[k])))))), "Trazabilidad");
    const tc = ["nit", "tipo_documento", "dv", "persona", "primer_apellido", "segundo_apellido", "primer_nombre", "otros_nombres", "razon_social", "direccion", "codigo_departamento", "codigo_municipio", "pais"];
    XLSX.utils.book_append_sheet(wb, hoja([tc].concat([...r.terceros.values()].map((t) => tc.map((k) => String(t[k] || ""))))), "Terceros");
    XLSX.writeFile(wb, `Informe_validacion_exogena_${sufijo(emp)}.xlsx`);
  }

  // ---------------- Datos de la empresa
  function renderDatos(v, emp) {
    const campo = (k, t, tipo = "text", extra = "") => `<label>${t}<input data-k="${k}" type="${tipo}" value="${esc(emp[k])}" ${extra}></label>`;
    v.innerHTML = `<div class="panel"><h2>Datos de la empresa informante</h2>
      <div class="grid-form">
        ${campo("razon_social", "Razón social")}
        ${campo("nit", "NIT (sin dígito de verificación)", "text", 'inputmode="numeric"')}
        ${campo("anio", "Año gravable", "number", 'min="2020" max="2100"')}
        ${campo("direccion", "Dirección (va en la fila de cuantías menores)")}
        ${campo("codigo_departamento", "Código departamento (ej. 05)", "text", 'maxlength="2"')}
        ${campo("codigo_municipio", "Código municipio (ej. 001)", "text", 'maxlength="3"')}
        <label>Software contable<select data-k="fuente">${Object.keys(DEF.fuentes).map((k) => `<option ${emp.fuente === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        <label>Nombres de personas naturales en el software<select data-k="orden_nombre">
          <option value="apellidos_nombres" ${emp.orden_nombre === "apellidos_nombres" ? "selected" : ""}>APELLIDOS NOMBRES</option>
          <option value="nombres_apellidos" ${emp.orden_nombre === "nombres_apellidos" ? "selected" : ""}>NOMBRES APELLIDOS</option></select></label>
        <label>NIT adicionales a excluir (separados por coma)<input data-k="nits_excluidos" value="${esc((emp.nits_excluidos || []).join(", "))}"></label>
      </div><p class="ayuda" id="dv-info" style="margin-top:12px"></p></div>
      ${panelDiagnostico(emp)}
      <div class="panel"><h2>Cuentas con tercero fijo (bancos, CDT, retenciones por pagar, ICA)</h2>
      <p class="ayuda">Para cuentas cuyo saldo se reporta completo a un solo tercero: la entidad financiera de cada cuenta bancaria o CDT (1012), el municipio de la retención de ICA por pagar (1009), etc. En la mayoría de software el tercero del movimiento bancario es el cliente o proveedor, no el banco.</p>
      <div class="tabla-wrap"><table><thead><tr><th>Cuenta auxiliar</th><th>NIT de la entidad</th><th></th></tr></thead><tbody id="tb-bancos"></tbody></table></div>
      <div class="barra" style="margin-top:10px"><button id="add-banco">+ Cuenta</button></div></div>
      <div class="panel"><h2>Zona de riesgo</h2><div class="barra">
      <button id="dup-emp">Duplicar empresa (misma parametrización)</button><button class="peligro" id="del-emp">Eliminar empresa</button></div></div>`;
    const dvInfo = () => {
      const nit = String(emp.nit || "").replace(/\D/g, "");
      $("#dv-info").textContent = nit ? `NIT ${nit} → dígito de verificación ${(() => { try { return Exogena.calcularDv(nit); } catch (e) { return "?"; } })()}` : "";
    };
    $$("[data-k]", v).forEach((i) => i.oninput = i.onchange = () => {
      const k = i.dataset.k;
      emp[k] = k === "nits_excluidos" ? i.value.split(",").map((x) => x.trim()).filter(Boolean) : i.value;
      E.resultado = null; guardar(); renderLateral(); dvInfo();
    });
    dvInfo();
    $$("[data-dg]", v).forEach((i) => i.oninput = i.onchange = () => {
      emp.diagnostico[i.dataset.dg] = i.value; guardar();
      if (["tipo_persona", "regimen"].includes(i.dataset.dg)) render(); else evaluarDiagnostico(emp);   // cambia qué campos se piden
    });
    evaluarDiagnostico(emp);
    const pintarBancos = () => {
      $("#tb-bancos").innerHTML = (emp.cuentas_bancarias || []).map((c, i) => `<tr><td><input data-i="${i}" data-c="cuenta" value="${esc(c.cuenta)}"></td>
        <td><input data-i="${i}" data-c="nit" value="${esc(c.nit)}"></td><td><button class="mini peligro" data-del="${i}">Quitar</button></td></tr>`).join("") ||
        `<tr><td colspan="3" class="vacio">Sin cuentas. Si se deja vacío, el motor intenta inferir el banco y deja una alerta.</td></tr>`;
      $$("#tb-bancos input").forEach((i) => i.oninput = () => { emp.cuentas_bancarias[i.dataset.i][i.dataset.c] = i.value; guardar(); });
      $$("#tb-bancos [data-del]").forEach((b) => b.onclick = () => { emp.cuentas_bancarias.splice(b.dataset.del, 1); guardar(); pintarBancos(); });
    };
    pintarBancos();
    $("#add-banco").onclick = () => { (emp.cuentas_bancarias = emp.cuentas_bancarias || []).push({ cuenta: "", nit: "" }); guardar(); pintarBancos(); };
    $("#dup-emp").onclick = () => {
      const n = copia(emp); n.id = uid(); n.razon_social = emp.razon_social + " (copia)"; n.nit = ""; n.cuentas_bancarias = [];
      E.empresas.push(n); E.activa = n.id; guardar(); render(); toast("Empresa duplicada. Registre el NIT de la nueva empresa.");
    };
    $("#del-emp").onclick = () => {
      if (!confirm(`¿Eliminar "${emp.razon_social}" y toda su parametrización? No se puede deshacer (salvo que tenga un respaldo exportado).`)) return;
      E.empresas = E.empresas.filter((x) => x.id !== emp.id); E.activa = E.empresas[0] ? E.empresas[0].id : null;
      E.archivos = {}; E.resultado = null; E.vista = "procesar"; guardar(); render();
    };
  }

  // ---------------- Parametrización de cuentas
  function renderReglas(v, emp) {
    const vieja = (emp.reglasVersion || 1) < REGLAS_VERSION;
    v.innerHTML = `${vieja ? `<div class="aviso">Esta empresa usa una parametrización anterior a la actualización según la Res. 227/2025 (conceptos del 1008/1009, 1011, retenciones y tercero fijo). <button class="prim" id="r-migrar">Actualizar a la parametrización 2026</button> (se reemplazan las reglas; las cuentas del asistente quedarán pendientes de revisar).</div>` : ""}
      <div class="panel"><h2>Parametrización de cuentas de ${esc(emp.razon_social)}</h2>
      <p class="ayuda">Cada regla envía las cuentas que empiezan por el <b>prefijo</b> a un formato, concepto y columna. Dentro de un formato gana la regla con el prefijo <b>más largo</b>: con 5105 → 5001 y 510569 → 5011, la EPS va a 5011 y el resto del gasto de personal a 5001. Concepto <b>EXCLUIR</b> saca una rama completa; <b>PRORRATA</b> reparte entre los conceptos del mismo tercero.</p>
      <div class="barra"><select id="rf-fmt"><option value="">Todos los formatos</option>${formatosConReglas().map((f) => `<option ${E.filtroFmt === f ? "selected" : ""}>${f}</option>`).join("")}</select>
        <input id="rf-txt" placeholder="Buscar prefijo o nota…" value="${esc(E.filtroRegla)}">
        <button class="prim" id="r-add">+ Regla</button><span class="esp"></span>
        <button id="r-exp">Exportar a Excel</button><button id="r-imp">Importar de Excel</button><input type="file" id="r-in" accept=".xlsx,.xls,.csv" class="oculto">
        ${E.empresas.length > 1 ? `<select id="r-copiar"><option value="">Copiar reglas de…</option>${E.empresas.filter((x) => x.id !== emp.id).map((x) => `<option value="${x.id}">${esc(x.razon_social)}</option>`).join("")}</select>` : ""}
        <button class="peligro" id="r-reset">Restaurar predeterminada</button></div>
      <div id="r-err"></div>
      <div class="tabla-wrap" style="max-height:600px"><table><thead><tr><th>Formato</th><th>Prefijo cuenta</th><th>Concepto</th><th>Columna</th><th>Base</th><th>Notas</th><th>Tercero</th><th></th></tr></thead><tbody id="tb-r"></tbody></table></div></div>`;
    const errores = () => {
      const errs = Exogena.validarReglas({ reglas: emp.reglas, formatos: DEF.formatos });
      $("#r-err").innerHTML = errs.length ? `<div class="aviso">${errs.slice(0, 8).map(esc).join("<br>")}${errs.length > 8 ? `<br>… y ${errs.length - 8} más` : ""}</div>` : "";
    };
    const pintar = () => {
      const t = E.filtroRegla.toLowerCase();
      const idx = emp.reglas.map((r, i) => i).filter((i) => {
        const r = emp.reglas[i];
        return (!E.filtroFmt || r.formato === E.filtroFmt) && (!t || (r.prefijo + " " + r.notas + " " + r.concepto).toLowerCase().includes(t));
      }).sort((a, b) => (emp.reglas[a].formato + emp.reglas[a].prefijo).localeCompare(emp.reglas[b].formato + emp.reglas[b].prefijo));
      $("#tb-r").innerHTML = idx.map((i) => {
        const r = emp.reglas[i];
        const cols = DEF.formatos[r.formato] ? camposValor(r.formato) : [];
        const conc = E.normativo.conceptos.filter((c) => c.formato === r.formato);
        return `<tr data-i="${i}">
          <td><select data-c="formato">${formatosConReglas().map((f) => `<option ${f === r.formato ? "selected" : ""}>${f}</option>`).join("")}</select></td>
          <td><input data-c="prefijo" value="${esc(r.prefijo)}" inputmode="numeric" style="width:100px"></td>
          <td><input data-c="concepto" value="${esc(r.concepto)}" list="dl-${esc(r.formato)}" style="width:110px" title="${esc((conc.find((c) => c.concepto === r.concepto) || {}).descripcion || "")}"></td>
          <td><select data-c="columna" ${r.concepto === "EXCLUIR" ? "disabled" : ""}><option></option>${cols.map((c) => `<option ${c === r.columna ? "selected" : ""}>${c}</option>`).join("")}</select></td>
          <td><select data-c="base" ${r.concepto === "EXCLUIR" ? "disabled" : ""}><option></option>${BASES.map(([k, d]) => `<option value="${k}" title="${esc(d)}" ${k === r.base ? "selected" : ""}>${k}</option>`).join("")}</select></td>
          <td><input data-c="notas" value="${esc(r.notas)}"></td>
          <td><input data-c="tercero" value="${esc(r.tercero || "")}" placeholder="del movimiento" title="vacío = tercero del movimiento; 'informante' = NIT de la empresa; o un NIT fijo" style="width:110px"></td>
          <td><button class="mini peligro" data-del="${i}" title="Eliminar regla">✕</button></td></tr>`;
      }).join("") || `<tr><td colspan="7" class="vacio">Sin reglas con ese filtro.</td></tr>`;
      $$("#tb-r [data-c]").forEach((el) => el.onchange = el.oninput = (e) => {
        const r = emp.reglas[el.closest("tr").dataset.i];
        r[el.dataset.c] = el.value.trim();
        E.resultado = null; guardar(); errores();
        if (e.type === "change" && (el.dataset.c === "formato" || el.dataset.c === "concepto")) pintar();
      });
      $$("#tb-r [data-del]").forEach((b) => b.onclick = () => { emp.reglas.splice(Number(b.dataset.del), 1); guardar(); pintar(); errores(); });
    };
    // listas de conceptos por formato para autocompletar
    v.insertAdjacentHTML("beforeend", formatosConReglas().map((f) => `<datalist id="dl-${f}">${E.normativo.conceptos.filter((c) => c.formato === f).map((c) => `<option value="${esc(c.concepto)}">${esc(c.descripcion)}</option>`).join("")}<option value="EXCLUIR"><option value="PRORRATA"></datalist>`).join(""));
    $("#rf-fmt").onchange = (e) => { E.filtroFmt = e.target.value; pintar(); };
    $("#rf-txt").oninput = (e) => { E.filtroRegla = e.target.value; pintar(); };
    $("#r-add").onclick = () => {
      const f = E.filtroFmt || "1001";
      emp.reglas.push({ formato: f, prefijo: "", concepto: "", columna: camposValor(f)[0], base: "neto_deb", notas: "" });
      E.filtroRegla = ""; guardar(); pintar(); errores();
      const ins = $$("#tb-r input[data-c=prefijo]").find((i) => !i.value); if (ins) ins.focus();
    };
    $("#r-reset").onclick = () => { if (confirm("¿Reemplazar la parametrización de esta empresa por la predeterminada? Se pierden los cambios.")) { emp.reglas = copia(DEF.reglas); guardar(); render(); } };
    $("#r-exp").onclick = () => {
      const cols = ["formato", "prefijo", "concepto", "columna", "base", "notas"];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, hoja([cols].concat(emp.reglas.map((r) => cols.map((c) => String(r[c] || "")))), 70), "Parametrizacion");
      XLSX.writeFile(wb, `Parametrizacion_${String(emp.nit).replace(/\D/g, "") || "empresa"}.xlsx`);
    };
    $("#r-imp").onclick = () => $("#r-in").click();
    $("#r-in").onchange = (e) => {
      const file = e.target.files[0]; if (!file) return;
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const filas = Exogena.leerLibro(XLSX, new Uint8Array(fr.result), file.name);
          const enc = filas[0].map((x) => Exogena.clave(x));
          const ix = (k) => enc.indexOf(k);
          if (ix("formato") < 0 || ix("prefijo") < 0) throw new Error("La primera fila debe tener: formato, prefijo, concepto, columna, base, notas");
          const nuevas = filas.slice(1).filter((f) => String(f[ix("formato")]).trim() && !String(f[ix("formato")]).startsWith("#")).map((f) => ({
            formato: String(f[ix("formato")]).trim(), prefijo: String(f[ix("prefijo")]).replace(/\D/g, ""), concepto: String(f[ix("concepto")] || "").trim(),
            columna: String(f[ix("columna")] || "").trim(), base: String(f[ix("base")] || "").trim(), notas: ix("notas") >= 0 ? String(f[ix("notas")] || "") : "" }));
          const errs = Exogena.validarReglas({ reglas: nuevas, formatos: DEF.formatos });
          if (errs.length && !confirm(`El archivo tiene ${errs.length} reglas con problemas (ej: ${errs[0]}). ¿Importar de todas formas?`)) return;
          emp.reglas = nuevas; guardar(); render(); toast(`${nuevas.length} reglas importadas.`);
        } catch (err) { toast("No se pudo importar: " + err.message); }
      };
      fr.readAsArrayBuffer(file);
    };
    if ($("#r-copiar")) $("#r-copiar").onchange = (e) => {
      const o = E.empresas.find((x) => x.id === e.target.value);
      if (o && confirm(`¿Reemplazar las reglas de esta empresa por las de "${o.razon_social}"?`)) { emp.reglas = copia(o.reglas); guardar(); render(); }
      else e.target.value = "";
    };
    if ($("#r-migrar")) $("#r-migrar").onclick = () => { emp.reglas = copia(DEF.reglas); emp.reglasVersion = REGLAS_VERSION; E.resultado = null; guardar(); render(); toast("Parametrización actualizada. Revise el Asistente por formato."); };
    pintar(); errores();
  }

  // ---------------- Prevalidadores DIAN (fuente del orden de columnas)
  function prevalidadores() {
    const propios = E.normativo.prevalidadores || [];   // los cargados reemplazan a los de fábrica con el mismo nombre
    return (DEF.prevalidadores || []).filter((d) => !propios.some((x) => x.nombre === d.nombre)).concat(propios);
  }
  // Estado del orden de columnas de un formato para una versión dada (la vigente y las de años anteriores)
  function estadoCols(k, version) {
    return Exogena.estadoColumnas(k, { columnas: DEF.formatos[k].columnas, version }, prevalidadores());
  }
  function celdaCols(k) {
    const f = DEF.formatos[k], vs = [[E.normativo.formatos[k].version, "vigente"]], anios = {};
    Object.entries(f.version_por_anio || {}).forEach(([a, v]) => { (anios[v] = anios[v] || []).push(a); });
    Object.entries(anios).forEach(([v, as]) => { if (!vs.some(([x]) => Number(x) === Number(v))) vs.push([v, "AG " + as.sort().join(" y ")]); });
    return vs.map(([v, et]) => {
      const e = estadoCols(k, v);
      const txt = e.verificado ? `✓ v${v} (${et}) = ${esc(e.fuente)}${e.omitidas.length ? ` · omite ${e.omitidas.length} opcional(es)` : ""}`
        : e.diferencias.length ? `✗ v${v} (${et}) difiere de ${esc(e.fuente)}: ${esc(e.diferencias.slice(0, 3).join(" · "))}`
        : `— v${v} (${et}): falta el prevalidador de esa versión`;
      return `<div class="${e.verificado ? "" : "ayuda"}" title="${esc(e.omitidas.join("; "))}">${txt}</div>`;
    }).join("");
  }
  // Carga un prevalidador .xlsm: guarda su layout y completa conceptos y países con sus tablas
  function cargarPrevalidador(file, alTerminar) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const p = Exogena.leerPrevalidador(XLSX, new Uint8Array(fr.result), file.name);
        if (!Object.keys(p.formatos).length) throw new Error("no se encontraron hojas de formatos");
        const n = E.normativo;
        n.prevalidadores = (n.prevalidadores || []).filter((x) => x.nombre !== p.nombre)
          .concat([{ nombre: p.nombre, formatos: Object.fromEntries(Object.entries(p.formatos).map(([k, v]) => [k, { version: v.version, columnas: v.columnas }])) }]);
        let nuevos = 0, marcados = 0;
        Object.entries(p.formatos).forEach(([fmt, v]) => v.conceptos.forEach(([c, d]) => {
          const ex = n.conceptos.find((x) => x.formato === fmt && x.concepto === c);
          if (!ex) { n.conceptos.push({ formato: fmt, concepto: c, descripcion: d, verificado: "SI", fuente: p.nombre }); nuevos++; }
          else if (String(ex.verificado).toUpperCase() !== "SI") { ex.verificado = "SI"; ex.fuente = (ex.fuente ? ex.fuente + "; " : "") + p.nombre; marcados++; }
        }));
        let paises = 0;
        n.paises = n.paises || copia(DEF.paises);
        p.paises.forEach(([c, nom]) => { if (!n.paises.some((x) => x.codigo === c)) { n.paises.push({ codigo: c, nombre: nom, alias: "" }); paises++; } });
        guardar(); E.resultado = null;
        const vers = Object.entries(p.formatos).map(([k, v]) => `${k} v${v.version}`).join(", ");
        toast(`Prevalidador ${p.nombre} cargado (${vers}). Conceptos nuevos: ${nuevos}, verificados: ${marcados}, países nuevos: ${paises}.`);
        alTerminar();
      } catch (err) { toast("No se pudo leer el prevalidador: " + err.message); }
    };
    fr.readAsArrayBuffer(file);
  }

  // ---------------- Parámetros normativos (comunes a todas las empresas)
  function renderNormativo(m) {
    const n = E.normativo;
    m.innerHTML = `<div class="panel"><h2>Parámetros normativos</h2>
      <div class="aviso">Aplican a todas las empresas. Contraste cada valor con la resolución de exógena vigente para el año gravable y su anexo técnico, y márquelo como verificado. Mientras haya parámetros usados sin verificar, el aplicativo no da el dictamen "Listo para prevalidador".</div>
      <div class="barra"><button class="peligro" id="n-reset">Restaurar valores de fábrica</button></div></div>
      <div class="panel"><h2>Formatos</h2><div class="tabla-wrap"><table><thead><tr><th>Formato</th><th>Nombre</th><th>Versión</th><th>Versión verificada</th><th>Orden de columnas vs. prevalidador DIAN</th></tr></thead><tbody>
      ${Object.entries(DEF.formatos).map(([k, f]) => `<tr><td>${k}</td><td>${esc(f.nombre)}</td><td><input type="number" data-fv="${k}" value="${esc(n.formatos[k].version)}" style="width:80px"></td>
        <td><input type="checkbox" data-fchk="${k}" ${n.formatos[k].verificado ? "checked" : ""}></td>
        <td style="font-size:12px">${celdaCols(k)}</td></tr>`).join("")}</tbody></table></div>
      <p class="ayuda" style="margin-top:8px">Versión verificada contra la Res. 227/2025 art. 1.3.10.1 y sus modificaciones. El orden de columnas no se marca a mano: se compara, encabezado por encabezado, con el prevalidador oficial de la DIAN de la <b>misma versión</b>.</p>
      <div class="barra"><button class="prim" id="n-prev-b">Cargar prevalidador DIAN (.xlsm)</button><input type="file" id="n-prev" accept=".xlsm,.xlsx" class="oculto">
        <span class="ayuda">Cargados: ${prevalidadores().map((p) => esc(p.nombre)).join(", ") || "ninguno"}. Cuando la DIAN publique el prevalidador del año gravable, cárguelo aquí: verifica el orden de columnas y completa conceptos y países.</span></div></div>
      <div class="panel"><h2>Cuantías menores</h2><p class="ayuda">Por debajo del tope (por tercero y concepto) los valores se agrupan en el NIT de cuantías menores.</p>
      <div class="grid-form"><label>NIT cuantías menores<input data-cm="nit" value="${esc(n.cuantias_menores.nit)}"></label>
        <label>Tipo de documento<input data-cm="tipo_documento" value="${esc(n.cuantias_menores.tipo_documento)}"></label>
        <label>Razón social<input data-cm="razon_social" value="${esc(n.cuantias_menores.razon_social)}"></label>
        <label>Verificado<input type="checkbox" data-cmchk ${n.cuantias_menores.verificado ? "checked" : ""}></label>
        <label>No agrupar terceros con retención<input type="checkbox" id="n-noag" ${n.no_agrupar_si_retencion ? "checked" : ""}></label></div>
      <p class="ayuda" style="margin-top:12px">Topes en UVT, evaluados por tercero sumando todo el formato. Valor UVT por año:
        ${Object.entries(n.uvt || {}).map(([a, v]) => `${a}: <input type="number" data-uvt="${a}" value="${v}" style="width:90px">`).join(" ")}</p>
      <div class="tabla-wrap"><table><thead><tr><th>Formato</th><th>Tope (UVT)</th><th>Equivale AG ${Math.max(...Object.keys(n.uvt || { 0: 0 }).map(Number))}</th><th>Columna(s) que se suman</th><th>Verificado</th></tr></thead><tbody>
      ${Object.entries(n.topes).map(([k, t]) => { const u = (n.uvt || {})[Math.max(...Object.keys(n.uvt || { 0: 0 }).map(Number))] || 0;
        return `<tr><td>${k}</td><td><input type="number" data-tv="${k}" value="${t.uvt === null || t.uvt === undefined ? "" : t.uvt}" placeholder="sin cuantía menor" style="width:110px"></td>
        <td class="num">${t.uvt ? "$" + pesos(t.uvt * u) : "—"}</td>
        <td><input data-tc="${k}" value="${esc(t.columna || "")}"></td><td><input type="checkbox" data-tchk="${k}" ${t.verificado ? "checked" : ""}></td></tr>`; }).join("")}</tbody></table></div></div>
      <div class="panel"><h2>Tabla de países</h2><p class="ayuda">Códigos de país DIAN (tabla propia de la DIAN, no ISO: Colombia = 169). Complete la tabla con el anexo técnico; un tercero del exterior con país no identificado genera ERROR.</p>
      <div class="barra"><button id="p-add">+ País</button></div>
      <div class="tabla-wrap" style="max-height:300px"><table><thead><tr><th>Código</th><th>Nombre</th><th>Otros nombres (separados por |)</th><th></th></tr></thead><tbody id="tb-p"></tbody></table></div></div>
      <div class="panel"><h2>Catálogo de conceptos</h2>
      <div class="barra"><button id="c-add">+ Concepto</button><button id="c-todos">Marcar todos como verificados</button></div>
      <div class="tabla-wrap"><table><thead><tr><th>Formato</th><th>Concepto</th><th>Descripción</th><th>Verificado</th><th></th></tr></thead><tbody id="tb-c"></tbody></table></div></div>`;
    const cambio = () => { guardar(); E.resultado = null; };
    $$("[data-fv]", m).forEach((i) => i.oninput = () => { n.formatos[i.dataset.fv].version = Number(i.value); cambio(); });
    $$("[data-fchk]", m).forEach((i) => i.onchange = () => { n.formatos[i.dataset.fchk].verificado = i.checked; cambio(); });
    $("#n-prev-b").onclick = () => $("#n-prev").click();
    $("#n-prev").onchange = (e) => { const f = e.target.files[0]; if (f) cargarPrevalidador(f, () => renderNormativo(m)); };
    $$("[data-cm]", m).forEach((i) => i.oninput = () => { n.cuantias_menores[i.dataset.cm] = i.value.trim(); cambio(); });
    $("[data-cmchk]", m).onchange = (e) => { n.cuantias_menores.verificado = e.target.checked; cambio(); };
    $("#n-noag").onchange = (e) => { n.no_agrupar_si_retencion = e.target.checked; cambio(); };
    $$("[data-tv]", m).forEach((i) => i.onchange = () => { const t = n.topes[i.dataset.tv]; t.uvt = i.value === "" ? null : Number(i.value); delete t.valor; cambio(); renderNormativo(m); });
    $$("[data-uvt]", m).forEach((i) => i.onchange = () => { n.uvt[i.dataset.uvt] = Number(i.value); cambio(); renderNormativo(m); });
    $$("[data-tc]", m).forEach((i) => i.oninput = () => { n.topes[i.dataset.tc].columna = i.value.trim(); cambio(); });
    $$("[data-tchk]", m).forEach((i) => i.onchange = () => { n.topes[i.dataset.tchk].verificado = i.checked; cambio(); });
    const pintarC = () => {
      $("#tb-c").innerHTML = n.conceptos.map((c, i) => `<tr><td><input data-i="${i}" data-k="formato" value="${esc(c.formato)}" style="width:70px"></td>
        <td><input data-i="${i}" data-k="concepto" value="${esc(c.concepto)}" style="width:80px"></td><td><input data-i="${i}" data-k="descripcion" value="${esc(c.descripcion)}"></td>
        <td><input type="checkbox" data-i="${i}" data-k="verificado" ${String(c.verificado).toUpperCase() === "SI" ? "checked" : ""}></td>
        <td><button class="mini peligro" data-del="${i}">✕</button></td></tr>`).join("");
      $$("#tb-c [data-k]").forEach((i) => i.oninput = i.onchange = () => {
        n.conceptos[i.dataset.i][i.dataset.k] = i.type === "checkbox" ? (i.checked ? "SI" : "NO") : i.value.trim(); cambio();
      });
      $$("#tb-c [data-del]").forEach((b) => b.onclick = () => { n.conceptos.splice(Number(b.dataset.del), 1); cambio(); pintarC(); });
    };
    pintarC();
    n.paises = n.paises || copia(DEF.paises);
    const pintarP = () => {
      $("#tb-p").innerHTML = n.paises.map((p, i) => `<tr><td><input data-i="${i}" data-k="codigo" value="${esc(p.codigo)}" style="width:70px"></td><td><input data-i="${i}" data-k="nombre" value="${esc(p.nombre)}"></td>
        <td><input data-i="${i}" data-k="alias" value="${esc(p.alias)}"></td><td><button class="mini peligro" data-del="${i}">✕</button></td></tr>`).join("");
      $$("#tb-p [data-k]").forEach((i) => i.oninput = () => { const v = i.value.trim(); n.paises[i.dataset.i][i.dataset.k] = i.dataset.k === "codigo" ? v.replace(/\D/g, "") : v.toUpperCase(); cambio(); });
      $$("#tb-p [data-del]").forEach((b) => b.onclick = () => { n.paises.splice(Number(b.dataset.del), 1); cambio(); pintarP(); });
    };
    pintarP();
    $("#p-add").onclick = () => { n.paises.push({ codigo: "", nombre: "", alias: "" }); cambio(); pintarP(); };
    $("#c-add").onclick = () => { n.conceptos.push({ formato: "1001", concepto: "", descripcion: "", verificado: "NO" }); cambio(); pintarC(); };
    $("#c-todos").onclick = () => { if (confirm("¿Confirma que contrastó TODOS los conceptos con el anexo técnico vigente?")) { n.conceptos.forEach((c) => { c.verificado = "SI"; }); cambio(); pintarC(); } };
    $("#n-reset").onclick = () => { if (confirm("¿Restaurar todos los parámetros normativos a los valores de fábrica? Se conservan los prevalidadores cargados.")) { E.normativo = { ...normativoDefecto(), prevalidadores: n.prevalidadores || [] }; guardar(); render(); } };
  }


  // ================================================================== CONCILIACIÓN CON DECLARACIONES
  const CONCILIA = [
    ["iva_descontable", "IVA descontable declarado (suma de las declaraciones de IVA del año)", (r) => tot(r, "1005", "iva_descontable")],
    ["iva_generado", "IVA generado declarado (suma de las declaraciones de IVA)", (r) => tot(r, "1006", "iva_generado")],
    ["ret_renta", "Retenciones a título de renta declaradas (formularios 350 del año)", (r) => tot(r, "1001", "ret_renta") + tot(r, "2276", "retencion")],
    ["ret_iva", "Retenciones a título de IVA declaradas (formularios 350)", (r) => tot(r, "1001", "ret_iva_comun") + tot(r, "1001", "ret_iva_no_dom")],
    ["ingresos", "Ingresos brutos de la declaración de renta", (r) => tot(r, "1007", "ingreso_bruto")],
    ["devoluciones", "Devoluciones, rebajas y descuentos de la renta", (r) => tot(r, "1007", "devoluciones")],
    ["cxc", "Cuentas por cobrar de la renta (patrimonio)", (r) => tot(r, "1008", "saldo_cxc", (x) => x.concepto !== "1318")],
    ["pasivos", "Pasivos de la declaración de renta", (r) => tot(r, "1009", "saldo_cxp")],
    ["efectivo", "Efectivo, equivalentes e inversiones de la renta", (r) => tot(r, "1012", "valor_31dic") + tot(r, "1011", "valor", (x) => x.concepto === "1105")],
    ["otras_ret", "Retenciones que le practicaron, tomadas en renta e IVA", (r) => tot(r, "1003", "retencion")],
  ];
  function tot(r, f, col, filtro) { return (r.generados[f] || []).filter(filtro || (() => true)).reduce((a, x) => a + (Number(x[col]) || 0), 0); }
  function subConciliacion(s, r, emp) {
    emp.conciliacion = emp.conciliacion || {};
    const c = emp.conciliacion[emp.anio] = emp.conciliacion[emp.anio] || {};
    s.innerHTML = `<p class="ayuda">La DIAN cruza la exógena con sus declaraciones. Digite los valores declarados: la diferencia no tiene que ser cero (la renta es fiscal y la exógena pide el devengo), pero toda diferencia debe estar explicada y documentada.</p>
      <div class="tabla-wrap"><table><thead><tr><th>Partida</th><th>Declarado</th><th>Exógena</th><th>Diferencia</th><th>Explicación</th></tr></thead><tbody>
      ${CONCILIA.map(([k, t, f]) => { const ex = f(r), dec = Number(c[k] || 0), dif = ex - dec;
        return `<tr><td>${esc(t)}</td><td><input type="number" data-cc="${k}" value="${c[k] ?? ""}" style="width:150px"></td><td class="num">${pesos(ex)}</td>
        <td class="num" style="color:${c[k] === undefined || c[k] === "" ? "var(--texto-2)" : Math.abs(dif) > 1000 ? "var(--error)" : "var(--ok)"}">${c[k] === undefined || c[k] === "" ? "—" : pesos(dif)}</td>
        <td><input data-ce="${k}" value="${esc(c[k + "_nota"] || "")}" placeholder="Por qué difiere"></td></tr>`; }).join("")}</tbody></table></div>`;
    $$("[data-cc]", s).forEach((i) => i.onchange = () => { c[i.dataset.cc] = i.value === "" ? "" : Number(i.value); guardar(); subConciliacion(s, r, emp); });
    $$("[data-ce]", s).forEach((i) => i.oninput = () => { c[i.dataset.ce + "_nota"] = i.value; guardar(); });
  }

  // ================================================================== SANCIONES (E.T. art. 651)
  function subSanciones(s, r, emp) {
    const uvts = E.normativo.uvt || {}, anioMax = Math.max(...Object.keys(uvts).map(Number));
    const st = E.sancion = E.sancion || { tipo: "0.007", base: 0, datos: 0, uvt: uvts[anioMax] || 0, momento: "0.1", l640: "1" };
    s.innerHTML = `<p class="ayuda">Estimación de la sanción por información exógena (E.T. art. 651, al que remite la Res. 227/2025 art. 1.3.11.1). Los errores se suman en valor absoluto (no se netean). La UVT es la del año en que se liquida la sanción.</p>
      <div class="grid-form">
        <label>Conducta<select id="sa-tipo"><option value="0.01">No suministró la información (1%)</option><option value="0.005">Suministró extemporáneamente (0,5%)</option><option value="0.007">Información con errores (0,7%)</option></select></label>
        <label>Suma de las partidas con error o no suministradas ($)<input id="sa-base" type="number" value="${st.base}"></label>
        <label>Datos sin cuantía errados o faltantes (0,5 UVT c/u)<input id="sa-datos" type="number" value="${st.datos}"></label>
        <label>Valor UVT<input id="sa-uvt" type="number" value="${st.uvt}"></label>
        <label>Momento de la corrección<select id="sa-mom"><option value="0.1">Voluntaria, antes del pliego de cargos (10%)</option><option value="0.5">Dentro del mes siguiente al pliego (50%)</option><option value="0.7">Dentro de los 2 meses siguientes a la resolución sanción (70%)</option><option value="1">Sin reducción (100%)</option></select></label>
        <label>Reducción art. 640 (lesividad, proporcionalidad)<select id="sa-640"><option value="1">No aplica</option><option value="0.5">50%</option><option value="0.25">75%</option></select></label>
      </div><div id="sa-res" style="margin-top:14px"></div>`;
    $("#sa-tipo").value = st.tipo; $("#sa-mom").value = st.momento; $("#sa-640").value = st.l640;
    const calc = () => {
      Object.assign(st, { tipo: $("#sa-tipo").value, base: Number($("#sa-base").value) || 0, datos: Number($("#sa-datos").value) || 0,
        uvt: Number($("#sa-uvt").value) || 0, momento: $("#sa-mom").value, l640: $("#sa-640").value });
      const bruta = st.base * Number(st.tipo) + st.datos * 0.5 * st.uvt;
      const tope = 7500 * st.uvt, minima = 10 * st.uvt;
      const topada = Math.min(bruta, tope);
      let final = topada * Number(st.momento) * Number(st.l640);
      const aplicaMin = bruta > 0 && final < minima;
      if (aplicaMin) final = minima;
      $("#sa-res").innerHTML = `<div class="kpis"><div class="kpi"><span>Sanción calculada</span><b>$${pesos(bruta)}</b></div>
        <div class="kpi"><span>Tope 7.500 UVT</span><b>$${pesos(tope)}</b></div>
        <div class="kpi e"><span>Sanción a pagar (estimada)</span><b>$${pesos(final)}</b></div></div>
        <small style="color:var(--texto-2)">${aplicaMin ? "Se aplicó la sanción mínima de 10 UVT (art. 639 E.T.). " : ""}Corregir antes del vencimiento no genera sanción. Verifique siempre el texto vigente de los arts. 651, 639 y 640 del E.T.</small>`;
    };
    $$("#sa-tipo,#sa-base,#sa-datos,#sa-uvt,#sa-mom,#sa-640", s).forEach((i) => i.oninput = i.onchange = calc);
    calc();
  }
  // ================================================================== ASISTENTE POR FORMATO
  const TRATAMIENTOS = [
    ["EXCLUIR", "No se reporta en este formato"],
    ["neto_deb", "Débitos − créditos"], ["neto_cred", "Créditos − débitos"],
    ["debito", "Solo débitos"], ["credito", "Solo créditos"],
    ["saldo_deb", "Saldo final deudor (por tercero)"], ["saldo_cred", "Saldo final acreedor (por tercero)"],
    ["saldo_deb_cuenta", "Saldo deudor de la cuenta a un tercero fijo"],
    ["saldo_cred_cuenta", "Saldo acreedor de la cuenta a un tercero fijo"],
  ];
  const nat = (x) => (Math.abs(x) < 0.5 ? "0" : `${pesos(Math.abs(x))} ${x > 0 ? "D" : "C"}`);
  function formatosAsistente() { return formatosConReglas().filter((f) => (DEF.formatos[f].universo || []).length); }

  function balanceNormalizado(emp) {
    if (E.resultado && E.resultado.balance) return E.resultado.balance;
    const a = E.archivos.balance;
    if (!a) return null;
    const k = a.nombre + "|" + a.filas.length + "|" + emp.fuente + "|" + JSON.stringify(emp.correcciones || {});
    if (E.cacheBal && E.cacheBal.k === k) return E.cacheBal.bal;
    const cfg = construirCfg(emp);
    Exogena.prepararConfig(cfg);
    const bal = Exogena.cargarBalance(a.filas, emp.fuente, cfg, []);
    E.cacheBal = { k, bal };
    return bal;
  }
  function candidatos(fmt, bal) {
    const uni = DEF.formatos[fmt].universo || [];
    const m = new Map();
    for (const r of bal) {
      if (!uni.some((u) => r.cuenta.startsWith(u))) continue;
      if (!r.debito && !r.credito && Math.abs(r.saldo_final) < 0.5) continue;
      const x = m.get(r.cuenta) || { cuenta: r.cuenta, nombre: r.nombre_cuenta, filas: [], nits: new Set(), si: 0, d: 0, c: 0, sf: 0, sinT: 0 };
      x.filas.push(r); if (r.nit) x.nits.add(r.nit); else x.sinT += r.debito + r.credito;
      x.si += r.saldo_inicial; x.d += r.debito; x.c += r.credito; x.sf += r.saldo_final;
      if (!x.nombre && r.nombre_cuenta) x.nombre = r.nombre_cuenta;
      m.set(r.cuenta, x);
    }
    return [...m.values()].sort((a, b) => a.cuenta.localeCompare(b.cuenta));
  }
  function criteriosCuenta(fmt, cuenta) {
    const cs = (DEF.criterios || []).filter((c) => c.formato === fmt && (c.prefijos || []).some((p) => cuenta.startsWith(String(p))));
    if (!cs.length) return "";
    return `<details style="margin-top:4px;font-size:11px;max-width:360px"><summary style="cursor:pointer;color:var(--azul)">📌 Criterio${cs.length > 1 ? "s (" + cs.length + ")" : ""}</summary>
      ${cs.map((c) => `<div style="margin-top:4px">${esc(c.texto)} <span style="color:var(--texto-2)">(${esc(c.fuente)})</span></div>`).join("")}</details>`;
  }
  function reglaEfectiva(emp, fmt, cuenta) { return Exogena.reglaPara({ reglas: emp.reglas }, fmt, cuenta); }
  function firma(regla) { return regla ? [regla.concepto, regla.columna, regla.base, regla.prefijo].join("|") : "SIN_REGLA"; }
  function revisada(emp, fmt, cuenta) {
    const rv = (emp.revisiones[fmt] || {})[cuenta];
    return !!rv && rv === firma(reglaEfectiva(emp, fmt, cuenta));
  }
  function pendientesRevision(emp, bal) {
    const out = {};
    if (!bal) return out;
    for (const f of formatosAsistente()) {
      const n = candidatos(f, bal).filter((c) => !revisada(emp, f, c.cuenta)).length;
      if (n) out[f] = n;
    }
    return out;
  }
  function valorSegun(c, base) {
    if (!base || base === "EXCLUIR") return { total: 0, neg: 0 };
    if (base === "saldo_deb_cuenta") return { total: c.sf, neg: c.sf < 0 ? 1 : 0 };
    const f = { neto_deb: (r) => r.debito - r.credito, neto_cred: (r) => r.credito - r.debito, debito: (r) => r.debito,
      credito: (r) => r.credito, saldo_deb: (r) => r.saldo_final, saldo_cred: (r) => -r.saldo_final }[base];
    const porNit = new Map();
    c.filas.forEach((r) => porNit.set(r.nit, (porNit.get(r.nit) || 0) + f(r)));
    let total = 0, neg = 0;
    porNit.forEach((v) => { total += v; if (v < -0.5) neg++; });
    return { total, neg };
  }

  function renderAsistente(v, emp) {
    let bal;
    try { bal = balanceNormalizado(emp); } catch (e) { v.innerHTML = `<div class="aviso">No se pudo leer el balance: ${esc(e.message)}</div>`; return; }
    if (!bal) {
      v.innerHTML = `<div class="panel"><h2>Asistente de parametrización por formato</h2>
        <p>El asistente recorre cada formato y le pregunta, <b>cuenta por cuenta del balance de esta empresa</b>, si se reporta, en qué concepto y columna, y si se toma el débito, el crédito, el neto o el saldo final. Muestra en vivo el valor que resultaría.</p>
        <p>Primero cargue el balance de prueba por tercero en <b>Procesar exógena</b>.</p><button class="prim" id="ir-proc">Ir a Procesar exógena</button></div>`;
      $("#ir-proc").onclick = () => { E.vista = "procesar"; render(); };
      return;
    }
    const fmts = formatosAsistente();
    if (!fmts.includes(E.fmtAsis)) E.fmtAsis = fmts[0];
    const fmt = E.fmtAsis, spec = DEF.formatos[fmt];
    const vers = { ...E.normativo.formatos[fmt] };
    if (spec.version_por_anio && spec.version_por_anio[String(emp.anio)]) vers.version = spec.version_por_anio[String(emp.anio)];
    const cands = candidatos(fmt, bal);
    const chips = fmts.map((f) => {
      const cs = candidatos(f, bal), ok = cs.filter((c) => revisada(emp, f, c.cuenta)).length;
      return `<button class="tab ${f === fmt ? "activa" : ""}" data-f="${f}">${f} <span class="chip ${ok === cs.length ? "OK" : "REVISAR"}">${ok}/${cs.length}</span></button>`;
    }).join("");
    const vals = camposValor(fmt);
    const conc = E.normativo.conceptos.filter((c) => c.formato === fmt);
    v.innerHTML = `<div class="tabs">${chips}</div>
      <div class="panel"><h2>${fmt} · ${esc(spec.nombre)} <small style="color:var(--texto-2);font-weight:400">versión ${esc(vers.version)} ${vers.verificado ? "✓ verificada" : "· sin verificar"}</small></h2>
        <p class="ayuda">${esc(spec.que_reporta || "")}. Cuentas del balance que se preguntan: ${(spec.universo || []).map((u) => `<b>${u}</b>`).join(", ")}.</p>
        ${(DEF.criterios || []).filter((c) => c.formato === fmt && !(c.prefijos || []).length).map((c) => `<div class="aviso" style="background:var(--info-f);color:var(--texto);margin-bottom:8px">📌 ${esc(c.texto)} <small style="color:var(--texto-2)">(${esc(c.fuente)})</small></div>`).join("")}
        <details><summary style="cursor:pointer;font-weight:600">Estructura del formato en el orden del prevalidador (${spec.columnas.length} columnas)</summary>
        <div class="tabla-wrap" style="margin-top:8px"><table><thead><tr><th>#</th><th>Columna</th><th>De dónde sale</th></tr></thead><tbody>
        ${spec.columnas.map(([c, h], i) => {
          let origen;
          if (c === "concepto") origen = "Concepto de la regla de cada cuenta";
          else if (CAMPOS_TERCERO.has(c)) origen = "Dato del tercero (maestro depurado + correcciones)";
          else {
            const cs = cands.filter((x) => { const r = reglaEfectiva(emp, fmt, x.cuenta); return r && r.concepto !== "EXCLUIR" && (r.columna === c || (r.concepto === "PRORRATA" && r.columna === c)); });
            origen = cs.length ? `Σ ${cs.length} cuentas: ${cs.slice(0, 8).map((x) => x.cuenta).join(", ")}${cs.length > 8 ? "…" : ""}` : (c === "base_retencion" ? "Estimada con los ingresos del tercero (validar con certificados)" : "<span style='color:var(--alerta)'>Ninguna cuenta asignada</span>");
          }
          return `<tr><td>${i + 1}</td><td>${esc(h)}</td><td>${origen}</td></tr>`;
        }).join("")}</tbody></table></div></details></div>
      <div class="panel"><h2>Cuentas del balance para el ${fmt}</h2>
        <p class="ayuda">Saldos con D (débito) o C (crédito). Al cambiar el tratamiento se guarda una regla para esa cuenta exacta y queda marcada como revisada. Una cuenta con tratamiento heredado de un prefijo debe confirmarse explícitamente.</p>
        <div class="barra"><button id="as-todas">Confirmar todas las pendientes con su tratamiento actual</button>
          <button id="as-nb">Pregunta para NotebookLM</button><button id="as-paq">Descargar paquete NotebookLM</button><span class="esp"></span>
          <small style="color:var(--texto-2)">${cands.filter((c) => !revisada(emp, fmt, c.cuenta)).length} pendientes de ${cands.length}</small></div>
        <div id="as-preg"></div>
        <div class="tabla-wrap" style="max-height:640px"><table><thead><tr><th>✓</th><th>Cuenta</th><th>Terceros</th><th>Saldo inicial</th><th>Débitos</th><th>Créditos</th><th>Saldo final</th><th>Tratamiento</th><th>Concepto</th><th>Columna</th><th>Valor resultante</th></tr></thead>
        <tbody>${cands.map((c) => {
          const r = reglaEfectiva(emp, fmt, c.cuenta), ok = revisada(emp, fmt, c.cuenta);
          const base = !r ? "" : r.concepto === "EXCLUIR" ? "EXCLUIR" : r.base;
          const vr = valorSegun(c, base);
          const hered = r && r.prefijo !== c.cuenta ? `<br><small style="color:var(--texto-2)">heredada de ${esc(r.prefijo)}</small>` : !r ? `<br><small style="color:var(--error)">sin regla: no llega al formato</small>` : "";
          const concOpts = spec.concepto ? `<option value=""></option>${conc.map((x) => `<option value="${esc(x.concepto)}" ${r && r.concepto === x.concepto ? "selected" : ""}>${esc(x.concepto)} ${esc(x.descripcion.slice(0, 34))}</option>`).join("")}${fmt === "1001" ? `<option value="PRORRATA" ${r && r.concepto === "PRORRATA" ? "selected" : ""}>PRORRATA (reparte entre conceptos del tercero)</option>` : ""}` : `<option value="">(sin concepto)</option>`;
          return `<tr data-c="${c.cuenta}" class="${ok ? "" : "ALERTA"}">
            <td><input type="checkbox" class="as-ok" ${ok ? "checked" : ""} title="Revisada"></td>
            <td><b>${c.cuenta}</b><br><small>${esc(c.nombre)}</small>${hered}${criteriosCuenta(fmt, c.cuenta)}</td>
            <td class="num">${c.nits.size}${c.sinT ? `<br><small style="color:var(--error)">+ sin tercero</small>` : ""}</td>
            <td class="num">${nat(c.si)}</td><td class="num">${pesos(c.d)}</td><td class="num">${pesos(c.c)}</td><td class="num">${nat(c.sf)}</td>
            <td><select class="as-base">${!r ? `<option value="">— elegir —</option>` : ""}${TRATAMIENTOS.map(([k, t]) => `<option value="${k}" ${k === base ? "selected" : ""}>${t}</option>`).join("")}</select></td>
            <td><select class="as-conc" ${base === "EXCLUIR" ? "disabled" : ""}>${concOpts}</select></td>
            <td><select class="as-col" ${base === "EXCLUIR" ? "disabled" : ""}><option value=""></option>${vals.map((x) => `<option ${r && r.columna === x ? "selected" : ""}>${x}</option>`).join("")}</select></td>
            <td class="num">${base === "EXCLUIR" ? "—" : `<b>${pesos(vr.total)}</b>${vr.neg ? `<br><small style="color:var(--error)">${vr.neg} terceros negativos</small>` : ""}`}</td></tr>`;
        }).join("") || `<tr><td colspan="11" class="vacio">El balance no tiene cuentas con movimiento o saldo en ${(spec.universo || []).join(", ")}.</td></tr>`}</tbody></table></div></div>`;
    $$(".tab[data-f]", v).forEach((b) => b.onclick = () => { E.fmtAsis = b.dataset.f; renderAsistente(v, emp); });
    const marcar = (cuenta, si) => {
      emp.revisiones[fmt] = emp.revisiones[fmt] || {};
      if (si) emp.revisiones[fmt][cuenta] = firma(reglaEfectiva(emp, fmt, cuenta)); else delete emp.revisiones[fmt][cuenta];
    };
    $$("tbody tr[data-c]", v).forEach((tr) => {
      const cuenta = tr.dataset.c;
      $(".as-ok", tr).onchange = (e) => {
        if (e.target.checked && !reglaEfectiva(emp, fmt, cuenta)) { e.target.checked = false; toast("Primero elija el tratamiento (aunque sea 'No se reporta')."); return; }
        marcar(cuenta, e.target.checked); guardar(); renderAsistente(v, emp);
      };
      const cambio = () => {
        const base = $(".as-base", tr).value; if (!base) return;
        const actual = reglaEfectiva(emp, fmt, cuenta);
        let concepto = $(".as-conc", tr).value, columna = $(".as-col", tr).value;
        if (base === "EXCLUIR") { concepto = "EXCLUIR"; columna = ""; }
        else {
          if (!columna) columna = (actual && actual.columna && actual.concepto !== "EXCLUIR") ? actual.columna : vals[0];
          if (spec.concepto && !concepto) concepto = (actual && actual.concepto !== "EXCLUIR") ? actual.concepto : ((conc[conc.length - 1] || {}).concepto || "");
        }
        const i = emp.reglas.findIndex((x) => x.formato === fmt && x.prefijo === cuenta);
        const nueva = { formato: fmt, prefijo: cuenta, concepto, columna, base: base === "EXCLUIR" ? "" : base, notas: (i >= 0 ? emp.reglas[i].notas : "") || ("Asistente: " + (tr.querySelector("small") || {}).textContent) };
        if (i >= 0) emp.reglas[i] = nueva; else emp.reglas.push(nueva);
        marcar(cuenta, true); E.resultado = null; guardar(); renderAsistente(v, emp);
      };
      $(".as-base", tr).onchange = cambio; $(".as-conc", tr).onchange = cambio; $(".as-col", tr).onchange = cambio;
    });
    $("#as-todas").onclick = () => {
      const pend = cands.filter((c) => !revisada(emp, fmt, c.cuenta));
      const sin = pend.filter((c) => !reglaEfectiva(emp, fmt, c.cuenta));
      if (!pend.length) return toast("No hay cuentas pendientes en este formato.");
      if (!confirm(`¿Confirma el tratamiento actual de ${pend.length - sin.length} cuentas del ${fmt}?${sin.length ? `\n${sin.length} cuentas sin regla quedan pendientes: decida una por una.` : ""}`)) return;
      pend.filter((c) => reglaEfectiva(emp, fmt, c.cuenta)).forEach((c) => marcar(c.cuenta, true)); guardar(); renderAsistente(v, emp);
    };
    $("#as-nb").onclick = () => {
      const txt = preguntaNotebook(emp, fmt, cands);
      $("#as-preg").innerHTML = `<div class="panel" style="background:var(--azul-suave)"><h2>Pregunta para NotebookLM · ${fmt}</h2>
        <p class="ayuda">Péguela en un cuaderno de NotebookLM que tenga cargadas la Res. 000227 de 2025, sus modificaciones (000233 de 2025 y 000012 de 2026) y el anexo técnico del formato. No incluye datos de terceros.</p>
        <textarea style="width:100%;height:220px;font:12px monospace" readonly>${esc(txt)}</textarea>
        <div class="barra" style="margin-top:8px"><button class="prim" id="as-copiar">Copiar</button></div></div>`;
      $("#as-copiar").onclick = () => copiar(txt);
    };
    $("#as-paq").onclick = () => descargarPaqueteNotebook(emp, bal);
  }

  function copiar(txt) {
    const ok = () => toast("Copiado. Péguelo en NotebookLM.");
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(ok, () => fallback());
    else fallback();
    function fallback() { const t = document.createElement("textarea"); t.value = txt; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); ok(); } catch (e) { toast("Seleccione el texto y cópielo manualmente."); } t.remove(); }
  }

  const NORMAS = "Resolución DIAN 000227 del 23 de septiembre de 2025 (resolución única de información exógena), modificada por la Resolución 000233 del 30 de octubre de 2025 y la Resolución 000012 del 29 de abril de 2026, y el anexo técnico vigente del formato";
  function preguntaNotebook(emp, fmt, cands) {
    const spec = DEF.formatos[fmt], v = E.normativo.formatos[fmt];
    const trat = Object.fromEntries(TRATAMIENTOS);
    const lineas = cands.map((c) => {
      const r = reglaEfectiva(emp, fmt, c.cuenta);
      if (!r) return `- ${c.cuenta} ${c.nombre}: SIN DEFINIR (¿se reporta en el ${fmt}? ¿en qué concepto, columna y con qué valor?)`;
      if (r.concepto === "EXCLUIR") return `- ${c.cuenta} ${c.nombre}: la estoy EXCLUYENDO del ${fmt}`;
      const col = (spec.columnas.find((x) => x[0] === r.columna) || [])[1] || r.columna;
      return `- ${c.cuenta} ${c.nombre}: concepto ${r.concepto || "(sin concepto)"}, columna "${col}", tomando ${trat[r.base] || r.base}`;
    });
    return `Contexto: información exógena del año gravable ${emp.anio}. Fuentes: ${NORMAS} ${fmt} (${spec.nombre}).

1. ¿Cuál es la versión vigente del formato ${fmt} para el año gravable ${emp.anio}? Yo tengo la versión ${v.version}.
2. Confirma el orden exacto de las columnas del formato ${fmt}. Mi estructura es:
${spec.columnas.map(([, h], i) => `   ${i + 1}. ${h}`).join("\n")}
   Señala columnas que falten, sobren o estén en otro orden.
3. Lista todos los conceptos válidos del formato ${fmt} (código y descripción).
4. ¿Cuál es el tope de cuantías menores del formato ${fmt}, cómo se agrupan (NIT y tipo de documento) y qué datos del informante se usan?
5. Para cada cuenta de mi balance, confirma o corrige si se reporta en el ${fmt}, el concepto, la columna y si se toma el débito, el crédito, el neto o el saldo final:
${lineas.join("\n")}

Responde en una tabla (cuenta | ¿se reporta? | concepto | columna | valor a tomar | soporte) y cita el artículo, numeral, parágrafo o sección del anexo técnico que sustenta cada respuesta. Si las fuentes no lo dicen expresamente, responde "No consta en las fuentes" en lugar de suponer.`;
  }

  function descargarPaqueteNotebook(emp, bal) {
    const trat = Object.fromEntries(TRATAMIENTOS);
    let md = `# Ficha de parametrización de exógena · ${emp.razon_social} · AG ${emp.anio}\n\n`;
    md += `Generada por Exógena YC el ${new Date().toLocaleString("es-CO")}. Esta ficha NO contiene datos de terceros (ni NIT, ni nombres, ni valores por tercero): solo el plan de cuentas de la empresa y cómo se parametrizó cada cuenta.\n\n`;
    md += `## Cómo usarla en NotebookLM\n\n1. Cree un cuaderno para el año gravable ${emp.anio}.\n2. Cargue como fuentes: la Resolución 000227 de 2025, la 000233 de 2025, la 000012 de 2026, los anexos técnicos de cada formato (PDF de la DIAN), la doctrina que use (p. ej. Concepto 003863 de 2025) y esta ficha.\n3. Haga las preguntas de la sección final, una por formato. Exija siempre la cita; lo que NotebookLM no pueda citar no se toma como cierto.\n4. Lleve las correcciones al aplicativo (Asistente por formato y Parámetros normativos) y marque como verificado solo lo que tenga cita.\n\n`;
    md += `## Parámetros normativos que debe confirmar\n\n| Formato | Versión usada | Verificada | Tope cuantías menores | Verificado |\n|---|---|---|---|---|\n`;
    formatosAsistente().forEach((f) => { const t = E.normativo.topes[f] || {}; md += `| ${f} | ${E.normativo.formatos[f].version} | ${E.normativo.formatos[f].verificado ? "Sí" : "No"} | ${t.valor ? "$" + pesos(t.valor) : "sin agrupación"} | ${t.verificado ? "Sí" : "No"} |\n`; });
    md += `\nConceptos sin verificar: ${E.normativo.conceptos.filter((c) => String(c.verificado).toUpperCase() !== "SI").map((c) => c.formato + "-" + c.concepto).join(", ") || "ninguno"}.\n\n`;
    md += `Tabla de países: el aplicativo solo tiene ${(E.normativo.paises || DEF.paises).length} países cargados. Pida a NotebookLM la tabla de códigos de país del anexo técnico.\n\n`;
    for (const f of formatosAsistente()) {
      const spec = DEF.formatos[f], cs = candidatos(f, bal);
      md += `## Formato ${f} · ${spec.nombre}\n\n${spec.que_reporta || ""}.\n\nColumnas en el orden usado: ${spec.columnas.map(([, h], i) => `${i + 1}) ${h}`).join("; ")}.\n\n`;
      md += `| Cuenta | Nombre | Tratamiento | Concepto | Columna | Origen de la regla | Revisada |\n|---|---|---|---|---|---|---|\n`;
      cs.forEach((c) => {
        const r = reglaEfectiva(emp, f, c.cuenta);
        md += `| ${c.cuenta} | ${c.nombre.replace(/\|/g, "/")} | ${!r ? "SIN DEFINIR" : r.concepto === "EXCLUIR" ? "No se reporta" : trat[r.base] || r.base} | ${r && r.concepto !== "EXCLUIR" ? r.concepto : ""} | ${r && r.concepto !== "EXCLUIR" ? r.columna : ""} | ${r ? (r.prefijo === c.cuenta ? "propia" : "prefijo " + r.prefijo) : ""} | ${revisada(emp, f, c.cuenta) ? "Sí" : "No"} |\n`;
      });
      md += `\n### Pregunta para NotebookLM\n\n\`\`\`\n${preguntaNotebook(emp, f, cs)}\n\`\`\`\n\n`;
    }
    md += `## Criterios de obligatoriedad registrados\n\n`;
    ((DEF.doctrina || {}).criterios || []).forEach((c) => { md += `- ${c.conclusion} Fuente: ${c.fuente}. ${c.advertencia || ""}\n`; });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    a.download = `NotebookLM_parametrizacion_${String(emp.nit).replace(/\D/g, "") || "empresa"}_AG${emp.anio}.md`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ================================================================== CORRECCIÓN DE TERCEROS
  const CORREGIBLES = new Set(["Tipo documento incoherente", "DV errado", "NIT con DV pegado", "Municipio no identificado", "Municipio homónimo",
    "Sin dirección", "Falta direccion", "Falta codigo_departamento", "Falta codigo_municipio", "Falta pais", "País no identificado",
    "Nombre incompleto", "Nombre partido por heurística", "Longitud de identificación", "Tercero sin maestro"]);
  function tercerosACorregir(r) {
    const m = new Map();
    for (const h of r.hallazgos) {
      if (!CORREGIBLES.has(h[1]) || !/^\d+$/.test(String(h[2]))) continue;
      if (!m.has(h[2])) m.set(h[2], new Set());
      m.get(h[2]).add(h[1]);
    }
    return [...m].map(([nit, cats]) => ({ nit, cats: [...cats] })).sort((a, b) => b.cats.length - a.cats.length || a.nit.localeCompare(b.nit));
  }
  let dlDivipola = null;
  function datalists() {
    if (!dlDivipola) {
      dlDivipola = `<datalist id="dl-mpio">${DEF.divipola.map((d) => `<option value="${esc(d.municipio)} · ${esc(d.departamento)} · ${d.codigo_departamento}${d.codigo_municipio}">`).join("")}</datalist>`;
    }
    const paises = E.normativo.paises || DEF.paises;
    return dlDivipola + `<datalist id="dl-pais">${paises.map((p) => `<option value="${esc(p.codigo)} · ${esc(p.nombre)}">`).join("")}</datalist>`;
  }
  const codMpio = (v) => { const m = String(v || "").match(/(\d{5})\s*$/); return m ? [m[1].slice(0, 2), m[1].slice(2)] : null; };
  const codPais = (v) => { const m = String(v || "").match(/^\s*(\d{1,3})/); return m ? m[1].padStart(3, "0") : ""; };
  function sugerencia(t, cats) {
    const s = {};
    if (cats.includes("Tipo documento incoherente")) { s.tipo_documento = "31"; s.persona = "juridica"; }
    if (cats.includes("NIT con DV pegado")) { s.nit_correcto = t.nit.slice(0, 9); s.dv = t.nit.slice(9); }
    const nit = s.nit_correcto || t.nit;
    if ((s.tipo_documento || t.tipo_documento) === "31" && /^\d{5,15}$/.test(nit)) { try { s.dv = String(Exogena.calcularDv(nit)); } catch (e) { /* */ } }
    return s;
  }
  function filaCorreccion(emp, t, cats) {
    const c = { ...(emp.correcciones[t.nit] || {}) };
    const sug = sugerencia(t, cats);
    const val = (k) => (c[k] !== undefined ? c[k] : sug[k] !== undefined ? sug[k] : t[k] || "");
    const persona = val("persona") || t.persona;
    const mp = c.codigo_departamento ? DEF.divipola.find((d) => d.codigo_departamento === c.codigo_departamento && d.codigo_municipio === c.codigo_municipio)
      : DEF.divipola.find((d) => d.codigo_departamento === t.codigo_departamento && d.codigo_municipio === t.codigo_municipio);
    const paises = E.normativo.paises || DEF.paises;
    const ps = paises.find((p) => p.codigo === (c.pais || t.pais));
    return `<tr data-nit="${t.nit}" class="${emp.correcciones[t.nit] ? "" : "ERROR"}">
      <td><b>${t.nit}</b><br>${cats.map((x) => `<span class="chip ALERTA" style="margin:1px">${esc(x)}</span>`).join(" ")}</td>
      <td><select data-k="tipo_documento">${(DEF.tiposDoc).map((x) => `<option value="${x.codigo}" ${val("tipo_documento") === x.codigo ? "selected" : ""}>${x.codigo} ${esc(x.descripcion.slice(0, 22))}</option>`).join("")}</select>
        <select data-k="persona"><option value="juridica" ${persona === "juridica" ? "selected" : ""}>Jurídica</option><option value="natural" ${persona === "natural" ? "selected" : ""}>Natural</option></select></td>
      <td><input data-k="dv" value="${esc(val("dv"))}" style="width:40px">${cats.includes("NIT con DV pegado") ? `<br><small>NIT correcto</small><input data-k="nit_correcto" value="${esc(val("nit_correcto"))}" style="width:110px">` : ""}</td>
      <td>${persona === "juridica" ? `<input data-k="razon_social" value="${esc(val("razon_social") || [t.primer_nombre, t.otros_nombres, t.primer_apellido, t.segundo_apellido].filter(Boolean).join(" "))}" placeholder="Razón social">`
        : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px">${["primer_apellido", "segundo_apellido", "primer_nombre", "otros_nombres"].map((k) => `<label style="font-size:10px;color:var(--texto-2)">${k.replace("_", " ")}<input data-k="${k}" value="${esc(val(k))}" title="${k.replace("_", " ")}"></label>`).join("")}</div>`}</td>
      <td><input data-k="direccion" value="${esc(val("direccion"))}" placeholder="Dirección"></td>
      <td><input data-k="mpio" list="dl-mpio" value="${mp ? esc(`${mp.municipio} · ${mp.departamento} · ${mp.codigo_departamento}${mp.codigo_municipio}`) : ""}" placeholder="Escriba el municipio…"></td>
      <td><input data-k="pais" list="dl-pais" value="${ps ? esc(ps.codigo + " · " + ps.nombre) : esc(c.pais || t.pais || "")}" placeholder="Código país" style="width:110px"></td>
      <td><button class="mini prim">Guardar</button></td></tr>`;
  }
  function leerFilaCorreccion(tr, t) {
    const g = (k) => { const el = $(`[data-k="${k}"]`, tr); return el ? el.value.trim() : undefined; };
    const c = { tipo_documento: g("tipo_documento"), persona: g("persona"), dv: g("dv"), direccion: g("direccion") };
    ["razon_social", "primer_apellido", "segundo_apellido", "primer_nombre", "otros_nombres", "nit_correcto"].forEach((k) => { const v = g(k); if (v !== undefined) c[k] = v; });
    const mp = codMpio(g("mpio")); if (mp) { c.codigo_departamento = mp[0]; c.codigo_municipio = mp[1]; }
    const ps = codPais(g("pais")); if (ps) c.pais = ps;
    Object.keys(c).forEach((k) => { if (c[k] === "" || c[k] === undefined) delete c[k]; });
    return c;
  }
  function guardarCorreccion(emp, nit, c) {
    if (c.nit_correcto && c.nit_correcto !== nit) {
      const { nit_correcto, ...resto } = c;
      emp.correcciones[nit] = { nit_correcto };
      emp.correcciones[nit_correcto] = { ...(emp.correcciones[nit_correcto] || {}), ...resto };
    } else { delete c.nit_correcto; emp.correcciones[nit] = c; }
  }
  function subCorregir(s, r, emp) {
    const lista = tercerosACorregir(r);
    if (!lista.length) { s.innerHTML = `<div class="vacio">No hay terceros con errores corregibles.</div>`; return; }
    s.innerHTML = datalists() + `<p class="ayuda">Corrija aquí los datos que el prevalidador rechazaría. Las correcciones se guardan <b>por empresa</b> y se aplican cada vez que se genera, pero lo correcto es llevarlas también al software contable: en <b>Correcciones de terceros</b> puede descargar el listado.</p>
      <div class="barra"><button class="prim" id="co-auto">Aplicar sugerencias automáticas (tipo 31 a empresas, DV correcto, NIT con DV pegado)</button>
      <button id="co-regen">Volver a generar con las correcciones</button></div>
      <div class="tabla-wrap" style="max-height:640px"><table><thead><tr><th>NIT y problemas</th><th>Tipo doc / persona</th><th>DV</th><th>Nombre o razón social</th><th>Dirección</th><th>Municipio</th><th>País</th><th></th></tr></thead>
      <tbody>${lista.slice(0, 300).map(({ nit, cats }) => filaCorreccion(emp, r.terceros.get(nit) || { nit, numero_identificacion: nit }, cats)).join("")}</tbody></table></div>
      ${lista.length > 300 ? `<small>Se muestran 300 de ${lista.length}.</small>` : ""}`;
    $$("tbody tr[data-nit]", s).forEach((tr) => {
      const t = r.terceros.get(tr.dataset.nit) || { nit: tr.dataset.nit };
      $("button", tr).onclick = () => { guardarCorreccion(emp, t.nit, leerFilaCorreccion(tr, t)); guardar(); tr.classList.remove("ERROR"); toast(`Corrección de ${t.nit} guardada.`); };
      $('[data-k="persona"]', tr).onchange = () => { guardarCorreccion(emp, t.nit, leerFilaCorreccion(tr, t)); guardar(); subCorregir(s, r, emp); };
    });
    $("#co-auto").onclick = () => {
      let n = 0;
      lista.forEach(({ nit, cats }) => {
        const t = r.terceros.get(nit); if (!t) return;
        const sug = sugerencia(t, cats);
        if (Object.keys(sug).length) { guardarCorreccion(emp, nit, { ...(emp.correcciones[nit] || {}), ...sug }); n++; }
      });
      guardar(); toast(`${n} sugerencias aplicadas. Vuelva a generar para ver el efecto.`); subCorregir(s, r, emp);
    };
    $("#co-regen").onclick = () => { E.vista = "procesar"; generar(emp); };
  }
  function renderCorrecciones(v, emp) {
    const cs = Object.entries(emp.correcciones || {});
    const campos = ["nit_correcto", "tipo_documento", "persona", "dv", "razon_social", "primer_apellido", "segundo_apellido", "primer_nombre", "otros_nombres", "direccion", "codigo_departamento", "codigo_municipio", "pais"];
    v.innerHTML = `<div class="panel"><h2>Correcciones de terceros de ${esc(emp.razon_social)}</h2>
      <p class="ayuda">Se aplican sobre el maestro del software cada vez que se genera. Descargue el listado y corríjalo también en el software, para que el año siguiente no se repita.</p>
      <div class="barra"><button class="prim" id="cr-dl" ${cs.length ? "" : "disabled"}>Descargar listado para corregir en el software</button></div>
      <div class="tabla-wrap"><table><thead><tr><th>NIT</th>${campos.map((c) => `<th>${c.replace(/_/g, " ")}</th>`).join("")}<th></th></tr></thead><tbody>
      ${cs.map(([nit, c]) => `<tr><td>${nit}</td>${campos.map((k) => `<td>${esc(c[k] || "")}</td>`).join("")}<td><button class="mini peligro" data-del="${nit}">Quitar</button></td></tr>`).join("") || `<tr><td colspan="${campos.length + 2}" class="vacio">Sin correcciones. Se registran desde Procesar exógena → Corregir terceros.</td></tr>`}
      </tbody></table></div></div>`;
    $$("[data-del]", v).forEach((b) => b.onclick = () => { delete emp.correcciones[b.dataset.del]; guardar(); renderCorrecciones(v, emp); render(); });
    if (cs.length) $("#cr-dl").onclick = () => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, hoja([["nit"].concat(campos)].concat(cs.map(([nit, c]) => [nit].concat(campos.map((k) => String(c[k] || "")))))), "Correcciones");
      XLSX.writeFile(wb, `Correcciones_terceros_${String(emp.nit).replace(/\D/g, "")}.xlsx`);
    };
  }

  // ================================================================== DIAGNÓSTICO DE OBLIGATORIEDAD
  function panelDiagnostico(emp) {
    const d = emp.diagnostico || (emp.diagnostico = {});
    const sel = (k, ops) => `<select data-dg="${k}"><option value=""></option>${ops.map(([v, t]) => `<option value="${v}" ${d[k] === v ? "selected" : ""}>${t}</option>`).join("")}</select>`;
    const num = (k, t, ay) => `<label>${t}<input data-dg="${k}" type="number" min="0" value="${esc(d[k] || "")}" placeholder="${ay || ""}"></label>`;
    const a = Number(emp.anio) || 0;
    return `<div class="panel"><h2>Diagnóstico de obligatoriedad</h2>
      <p class="ayuda">Aplica el art. 1.3.1.1 de la Res. 000227 de 2025 (numerales 4, 5 y 6 y parágrafos 1 a 3) y la doctrina registrada. Ingresos brutos: ordinarios, extraordinarios y ganancias ocasionales, sin la venta de casa o apartamento de habitación.</p>
      <div class="grid-form">
        <label>Tipo de persona${sel("tipo_persona", [["juridica", "Persona jurídica o entidad"], ["natural", "Persona natural"]])}</label>
        <label>Régimen${sel("regimen", [["ordinario", "Ordinario"], ["simple", "Régimen Simple (RST)"], ["esal", "Régimen tributario especial"], ["no_contribuyente", "No contribuyente"]])}</label>
        <label>¿Practicó retención o autorretención (renta, IVA o timbre) en ${a}?${sel("practica_retencion", [["si", "Sí"], ["no", "No"]])}</label>
        <label>¿Adelanta en ${a} la cancelación del RUT?${sel("cancelacion_rut", [["no", "No"], ["si", "Sí"]])}</label>
        ${num("ingresos", `Ingresos brutos ${a} ($)`)}
        ${num("ingresos_ant", `Ingresos brutos ${a - 1} ($)`)}
        ${d.tipo_persona === "natural" && d.regimen !== "simple" ? num("ingresos_capital", `Rentas de capital y no laborales ${a} ($)`, "intereses, arriendos, honorarios sin vínculo…") : ""}
        ${num("uvt", `UVT ${a} ($)`, String(uvtDe(a) || ""))}
      </div><div id="dg-res" style="margin-top:12px"></div></div>`;
  }
  function uvtDe(anio) { return Number((E.normativo.uvt || DEF.parametros.uvt || {})[anio]) || 0; }

  // Art. 1.3.1.1: obligado si cumple CUALQUIERA de los numerales; el par. 2 lo excluye si cancela el RUT
  function dictamenObligado(emp) {
    const d = emp.diagnostico || {}, U = (DEF.doctrina || {}).obligados || {}, a = Number(emp.anio) || 0;
    const uvt = Number(d.uvt) || uvtDe(a), uvtAnt = uvtDe(a - 1);
    const enUvt = (v, u) => (Number(v) && u ? Number(v) / u : null);
    const ing = enUvt(d.ingresos, uvt), ingAnt = enUvt(d.ingresos_ant, uvtAnt), cap = enUvt(d.ingresos_capital, uvt);
    const f = (x) => (x === null ? "sin dato" : `${pesos(x)} UVT`);
    const pasos = [], faltan = [];
    if (!d.tipo_persona) return { estado: "pendiente", pasos, faltan: ["tipo de persona"] };
    if (d.cancelacion_rut === "si") return { estado: "no", pasos: ["Par. 2: quien adelanta en el año la cancelación del RUT no está obligado (en contratos de colaboración, informan las partes)."], faltan };
    let obligado = false;
    const supera = (t) => [ing, ingAnt].some((x) => x !== null && x > t);
    const ingTxt = `ingresos ${a}: ${f(ing)}; ${a - 1}: ${f(ingAnt)}`;
    if (d.tipo_persona === "juridica") {
      const t = U.pj_ingresos_uvt;
      if (supera(t)) { obligado = true; pasos.push(`Num. 5: persona jurídica con ingresos brutos superiores a ${pesos(t)} UVT (${ingTxt}) → OBLIGADA.`); }
      else if (ing !== null || ingAnt !== null) pasos.push(`Num. 5: no supera ${pesos(t)} UVT (${ingTxt}).`);
      if (d.practica_retencion === "si") { obligado = true; pasos.push("Num. 6: practicó retención o autorretención en el año → OBLIGADA, sin importar los ingresos."); }
    } else if (d.regimen === "simple") {
      const t = U.pn_ingresos_uvt;
      if (supera(t)) { obligado = true; pasos.push(`Num. 4 inc. 2: persona natural del RST con ingresos brutos superiores a ${pesos(t)} UVT sin considerar el tipo de ingreso (${ingTxt}) → OBLIGADA.`); }
      else if (ing !== null || ingAnt !== null) pasos.push(`Num. 4 inc. 2: no supera ${pesos(t)} UVT (${ingTxt}).`);
      if (d.practica_retencion === "si" && !obligado) pasos.push("Num. 6 y par. 3: practicó retención, pero según el Concepto 3863 de 2025 la persona natural del RST no queda obligada solo por ser agente de retención (ver criterio abajo).");
    } else {
      const t = U.pn_ingresos_uvt, tc = U.pn_capital_no_laborales_uvt;
      if (supera(t) && cap !== null && cap > tc) { obligado = true; pasos.push(`Num. 4 inc. 1: ingresos brutos superiores a ${pesos(t)} UVT (${ingTxt}) y rentas de capital y no laborales de ${f(cap)} (> ${pesos(tc)}) → OBLIGADA.`); }
      else pasos.push(`Num. 4 inc. 1: exige las dos condiciones: ingresos brutos > ${pesos(t)} UVT (${ingTxt}) y rentas de capital y no laborales > ${pesos(tc)} UVT (${f(cap)}).`);
      if (d.practica_retencion === "si") { obligado = true; pasos.push("Num. 6: practicó retención o autorretención en el año → OBLIGADA."); }
      if (obligado) pasos.push("Par. 3: la persona natural obligada por el num. 4 inc. 1 o el num. 6 reporta solo la información de sus rentas de capital y no laborales.");
    }
    if (!obligado) {
      if (ing === null) faltan.push(`ingresos brutos ${a}`);
      if (ingAnt === null) faltan.push(`ingresos brutos ${a - 1} (el umbral se cumple con cualquiera de los dos años)`);
      if (d.tipo_persona === "natural" && d.regimen !== "simple" && cap === null) faltan.push(`rentas de capital y no laborales ${a}`);
      if (!d.practica_retencion) faltan.push("si practicó retención");
      if (!d.regimen) faltan.push("régimen");
    }
    const estado = obligado ? "si" : faltan.length ? "pendiente" : "no";
    return { estado, pasos, faltan };
  }

  function evaluarDiagnostico(emp) {
    const d = emp.diagnostico || {};
    const el = $("#dg-res"); if (!el) return;
    const r = dictamenObligado(emp), U = (DEF.doctrina || {}).obligados || {};
    const cab = { si: ["ERROR", "OBLIGADA a presentar exógena del año gravable " + esc(emp.anio)],
      no: ["OK", "No obligada por los numerales 4, 5 y 6 del art. 1.3.1.1"],
      pendiente: ["REVISAR", "Faltan datos para concluir"] }[r.estado];
    let html = `<div class="aviso" style="background:var(--info-f);color:var(--texto)"><p><span class="chip ${cab[0]}">${cab[1]}</span></p>
      ${r.pasos.length ? `<ul style="margin:6px 0 6px 18px">${r.pasos.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      ${r.faltan.length ? `<p><b>Falta:</b> ${esc(r.faltan.join(", "))}.</p>` : ""}
      ${r.estado === "no" ? "<p>Revise los demás numerales antes de descartar: entidades financieras y cooperativas (2), bolsas y comisionistas (3), establecimientos permanentes (7), consorcios, uniones temporales y otros contratos de colaboración (8), entes públicos (9 y 16), obligados a consolidar estados financieros (11), proveedores de activos digitales (21).</p>" : ""}
      <small><b>Fuente:</b> ${esc(U.fuente || "Res. 000227 de 2025, art. 1.3.1.1")}. UVT: ${esc(emp.anio)} = $${pesos(Number(d.uvt) || uvtDe(Number(emp.anio)))}, ${Number(emp.anio) - 1} = $${pesos(uvtDe(Number(emp.anio) - 1))}.</small></div>`;
    const crit = ((DEF.doctrina || {}).criterios || []).filter((c) => Object.entries(c.aplica_si || {}).every(([k, v]) =>
      k === "practica_retencion" ? (d.practica_retencion === "si") === v : d[k] === v));
    html += crit.map((c) => `<div class="aviso" style="background:var(--info-f);color:var(--texto);margin-top:8px"><p><b>Doctrina:</b> ${esc(c.conclusion)}</p>
      <small><b>Fuente:</b> ${esc(c.fuente)}. ${c.verificado ? "" : `<b style="color:var(--alerta)">${esc(c.advertencia || "Sin verificar.")}</b>`}</small></div>`).join("");
    el.innerHTML = html;
  }

  // ------------------------------------------------------------------ acciones globales
  $("#btn-nueva").onclick = () => {
    const nombre = prompt("Razón social de la empresa:"); if (!nombre) return;
    const nit = (prompt("NIT sin dígito de verificación:") || "").replace(/\D/g, "");
    const e = empresaNueva(nombre.trim(), nit);
    E.empresas.push(e); E.activa = e.id; E.vista = "datos"; E.archivos = {}; E.resultado = null; guardar(); render();
    toast("Empresa creada. Complete los datos y luego cargue los archivos en 'Procesar exógena'.");
  };
  $("#nav-normativo").onclick = () => { E.vista = "normativo"; render(); };
  $("#btn-exportar-todo").onclick = () => {
    const datos = JSON.stringify({ tipo: "exogenaYC", version: 1, exportado: new Date().toISOString(), empresas: E.empresas, normativo: E.normativo }, null, 1);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([datos], { type: "application/json" }));
    a.download = `Respaldo_exogena_YC_${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("#btn-importar-todo").onclick = () => $("#in-importar").click();
  $("#in-importar").onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then((t) => {
      const d = JSON.parse(t);
      if (d.tipo !== "exogenaYC" || !Array.isArray(d.empresas)) throw new Error("No es un respaldo de Exógena YC");
      const modo = E.empresas.length ? confirm("Aceptar = REEMPLAZAR toda la configuración actual.\nCancelar = AGREGAR las empresas del respaldo a las actuales.") : true;
      if (modo) { E.empresas = d.empresas; if (d.normativo) E.normativo = d.normativo; }
      else { const ids = new Set(E.empresas.map((x) => x.id)); d.empresas.forEach((x) => { if (ids.has(x.id)) x.id = uid(); E.empresas.push(x); }); }
      E.activa = E.empresas[0] ? E.empresas[0].id : null; E.vista = "procesar"; E.resultado = null; guardar(); render();
      toast(`Respaldo importado: ${d.empresas.length} empresas.`);
    }).catch((err) => toast("No se pudo importar: " + err.message));
    e.target.value = "";
  };
  // completa parámetros normativos nuevos si el aplicativo se actualizó
  const nd = normativoDefecto();
  Object.keys(nd.formatos).forEach((k) => { if (!E.normativo.formatos[k]) E.normativo.formatos[k] = nd.formatos[k]; });
  Object.keys(nd.topes).forEach((k) => { if (!E.normativo.topes[k]) E.normativo.topes[k] = nd.topes[k]; });
  if (!E.empresas.find((x) => x.id === E.activa)) E.activa = E.empresas[0] ? E.empresas[0].id : null;
  if (migrado) { guardar(); setTimeout(() => toast("Parámetros normativos actualizados: columnas, conceptos y países del prevalidador DIAN."), 300); }
  render();
})();
