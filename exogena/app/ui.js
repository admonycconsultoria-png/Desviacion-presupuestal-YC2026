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
    ["saldo_deb_cuenta", "Saldo de toda la cuenta a un tercero fijo (bancos)"],
  ];
  const CAMPOS_TERCERO = new Set(["tipo_documento", "numero_identificacion", "dv", "primer_apellido", "segundo_apellido",
    "primer_nombre", "otros_nombres", "razon_social", "direccion", "codigo_departamento", "codigo_municipio", "pais"]);
  const CAMPOS_TEXTO = new Set([...CAMPOS_TERCERO, "concepto", "entidad_informante"]);

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
    return { formatos, topes: copia(p.topes), cuantias_menores: copia(p.cuantias_menores), conceptos: copia(DEF.conceptos),
      no_agrupar_si_retencion: p.no_agrupar_si_retencion !== false };
  }
  function empresaNueva(nombre, nit) {
    return { id: uid(), razon_social: nombre || "Nueva empresa", nit: nit || "", anio: new Date().getFullYear() - 1,
      direccion: "", codigo_departamento: "", codigo_municipio: "", fuente: "siigo", orden_nombre: "apellidos_nombres",
      cuentas_bancarias: [], nits_excluidos: [], reglas: copia(DEF.reglas) };
  }
  const E = {
    empresas: leerLS(LS_EMPRESAS, []),
    normativo: leerLS(LS_NORMATIVO, null) || normativoDefecto(),
    activa: leerLS(LS_ACTIVA, null),
    vista: "procesar", subvista: "hallazgos",
    archivos: {}, resultado: null, filtroNivel: "", filtroTexto: "", filtroFmt: "", filtroRegla: "", verFormato: null,
  };
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
    Object.entries(n.formatos).forEach(([k, f]) => { if (cfg.formatos[k]) { cfg.formatos[k].version = f.version; cfg.formatos[k].verificado = f.verificado; } });
    cfg.conceptos = copia(n.conceptos);
    cfg.reglas = copia(emp.reglas);
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
      ${[["procesar", "Procesar exógena"], ["datos", "Datos de la empresa"], ["reglas", `Parametrización de cuentas (${emp.reglas.length})`]]
        .map(([k, t]) => `<button class="tab ${E.vista === k ? "activa" : ""}" data-v="${k}">${t}</button>`).join("")}
      </div><div id="vista"></div>`;
    $$(".tab", m).forEach((b) => b.onclick = () => { E.vista = b.dataset.v; render(); });
    const v = $("#vista");
    if (E.vista === "datos") renderDatos(v, emp);
    else if (E.vista === "reglas") renderReglas(v, emp);
    else renderProcesar(v, emp);
  }

  // ---------------- Procesar
  const INSUMOS = [
    ["balance", "Balance de prueba por tercero", true, "Enero a diciembre · nivel auxiliar · sin cierre"],
    ["terceros", "Listado de terceros", true, "Con dirección, ciudad y tipo de documento"],
    ["accionistas", "Libro de accionistas", false, "Para el 1010: nit, nombre, ciudad, porcentaje o acciones"],
    ["nomina", "Consolidado de nómina", false, "Para el 2276: columnas con los nombres de campo del formato"],
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
    if ($("#btn-limpiar")) $("#btn-limpiar").onclick = () => { E.archivos = {}; E.resultado = null; render(); };
    if (E.resultado) renderResultado($("#res"), emp);
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
    const listo = n("ERROR") === 0 && r.sinVerificar.length === 0;
    const revisar = r.cuadres.filter((c) => c.estado !== "OK").length;
    el.innerHTML = `
      <div class="dictamen ${listo ? "si" : "no"}">${listo ? "✓ Listo para prevalidador" :
        `No listo para prevalidador: ${n("ERROR")} errores por corregir${r.sinVerificar.length ? ` y ${r.sinVerificar.length} parámetros normativos sin verificar` : ""}`}</div>
      <div class="kpis">
        <div class="kpi"><span>Formatos generados</span><b>${Object.keys(r.generados).length}</b></div>
        <div class="kpi"><span>Terceros depurados</span><b>${r.terceros.size}</b></div>
        <div class="kpi e"><span>Errores</span><b>${n("ERROR")}</b></div>
        <div class="kpi a"><span>Alertas</span><b>${n("ALERTA")}</b></div>
        <div class="kpi ${revisar ? "e" : "o"}"><span>Cuadres con diferencia</span><b>${revisar}</b></div>
      </div>
      <div class="tabs">${[["hallazgos", `Hallazgos (${r.hallazgos.length})`], ["formatos", "Formatos y descargas"], ["cuadres", "Cuadres"],
        ["sinregla", `Cuentas sin parametrizar (${sinRegla.length})`], ["verificar", `Parámetros sin verificar (${r.sinVerificar.length})`]]
        .map(([k, t]) => `<button class="tab ${E.subvista === k ? "activa" : ""}" data-s="${k}">${t}</button>`).join("")}</div>
      <div id="sub"></div>`;
    $$(".tab[data-s]", el).forEach((b) => b.onclick = () => { E.subvista = b.dataset.s; renderResultado(el, emp); });
    const s = $("#sub", el);
    ({ hallazgos: subHallazgos, formatos: subFormatos, cuadres: subCuadres, sinregla: subSinRegla, verificar: subVerificar })[E.subvista](s, r, emp);
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
    s.innerHTML = r.sinVerificar.length ? `<div class="aviso">Estos parámetros se usaron sin haber sido contrastados con la resolución DIAN y el anexo técnico del año gravable. Verifíquelos en <b>Parámetros normativos</b> y márquelos como verificados.</div>
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
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, hoja(aoaFormato(r, f)), f);
    XLSX.writeFile(wb, `Formato_${f}_v${r.cfg.formatos[f].version}_${sufijo(emp)}.xlsx`);
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
      <div class="panel"><h2>Cuentas bancarias → entidad (formato 1012)</h2>
      <p class="ayuda">En la mayoría de software el tercero del movimiento bancario es el cliente o proveedor, no el banco. Indique a qué entidad corresponde cada cuenta auxiliar de bancos, ahorros o CDT.</p>
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
    v.innerHTML = `<div class="panel"><h2>Parametrización de cuentas de ${esc(emp.razon_social)}</h2>
      <p class="ayuda">Cada regla envía las cuentas que empiezan por el <b>prefijo</b> a un formato, concepto y columna. Dentro de un formato gana la regla con el prefijo <b>más largo</b>: con 5105 → 5001 y 510569 → 5011, la EPS va a 5011 y el resto del gasto de personal a 5001. Concepto <b>EXCLUIR</b> saca una rama completa; <b>PRORRATA</b> reparte entre los conceptos del mismo tercero.</p>
      <div class="barra"><select id="rf-fmt"><option value="">Todos los formatos</option>${formatosConReglas().map((f) => `<option ${E.filtroFmt === f ? "selected" : ""}>${f}</option>`).join("")}</select>
        <input id="rf-txt" placeholder="Buscar prefijo o nota…" value="${esc(E.filtroRegla)}">
        <button class="prim" id="r-add">+ Regla</button><span class="esp"></span>
        <button id="r-exp">Exportar a Excel</button><button id="r-imp">Importar de Excel</button><input type="file" id="r-in" accept=".xlsx,.xls,.csv" class="oculto">
        ${E.empresas.length > 1 ? `<select id="r-copiar"><option value="">Copiar reglas de…</option>${E.empresas.filter((x) => x.id !== emp.id).map((x) => `<option value="${x.id}">${esc(x.razon_social)}</option>`).join("")}</select>` : ""}
        <button class="peligro" id="r-reset">Restaurar predeterminada</button></div>
      <div id="r-err"></div>
      <div class="tabla-wrap" style="max-height:600px"><table><thead><tr><th>Formato</th><th>Prefijo cuenta</th><th>Concepto</th><th>Columna</th><th>Base</th><th>Notas</th><th></th></tr></thead><tbody id="tb-r"></tbody></table></div></div>`;
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
    pintar(); errores();
  }

  // ---------------- Parámetros normativos (comunes a todas las empresas)
  function renderNormativo(m) {
    const n = E.normativo;
    m.innerHTML = `<div class="panel"><h2>Parámetros normativos</h2>
      <div class="aviso">Aplican a todas las empresas. Contraste cada valor con la resolución de exógena vigente para el año gravable y su anexo técnico, y márquelo como verificado. Mientras haya parámetros usados sin verificar, el aplicativo no da el dictamen "Listo para prevalidador".</div>
      <div class="barra"><button class="peligro" id="n-reset">Restaurar valores de fábrica</button></div></div>
      <div class="panel"><h2>Formatos</h2><div class="tabla-wrap"><table><thead><tr><th>Formato</th><th>Nombre</th><th>Versión</th><th>Verificado</th></tr></thead><tbody>
      ${Object.entries(DEF.formatos).map(([k, f]) => `<tr><td>${k}</td><td>${esc(f.nombre)}</td><td><input type="number" data-fv="${k}" value="${esc(n.formatos[k].version)}" style="width:80px"></td>
        <td><input type="checkbox" data-fchk="${k}" ${n.formatos[k].verificado ? "checked" : ""}></td></tr>`).join("")}</tbody></table></div></div>
      <div class="panel"><h2>Cuantías menores</h2><p class="ayuda">Por debajo del tope (por tercero y concepto) los valores se agrupan en el NIT de cuantías menores.</p>
      <div class="grid-form"><label>NIT cuantías menores<input data-cm="nit" value="${esc(n.cuantias_menores.nit)}"></label>
        <label>Tipo de documento<input data-cm="tipo_documento" value="${esc(n.cuantias_menores.tipo_documento)}"></label>
        <label>Razón social<input data-cm="razon_social" value="${esc(n.cuantias_menores.razon_social)}"></label>
        <label>Verificado<input type="checkbox" data-cmchk ${n.cuantias_menores.verificado ? "checked" : ""}></label>
        <label>No agrupar terceros con retención<input type="checkbox" id="n-noag" ${n.no_agrupar_si_retencion ? "checked" : ""}></label></div>
      <div class="tabla-wrap" style="margin-top:12px"><table><thead><tr><th>Formato</th><th>Tope ($)</th><th>Columna(s) que se comparan</th><th>Verificado</th></tr></thead><tbody>
      ${Object.entries(n.topes).map(([k, t]) => `<tr><td>${k}</td><td><input type="number" data-tv="${k}" value="${t.valor === null ? "" : t.valor}" placeholder="sin agrupación"></td>
        <td><input data-tc="${k}" value="${esc(t.columna || "")}"></td><td><input type="checkbox" data-tchk="${k}" ${t.verificado ? "checked" : ""}></td></tr>`).join("")}</tbody></table></div></div>
      <div class="panel"><h2>Catálogo de conceptos</h2>
      <div class="barra"><button id="c-add">+ Concepto</button><button id="c-todos">Marcar todos como verificados</button></div>
      <div class="tabla-wrap"><table><thead><tr><th>Formato</th><th>Concepto</th><th>Descripción</th><th>Verificado</th><th></th></tr></thead><tbody id="tb-c"></tbody></table></div></div>`;
    const cambio = () => { guardar(); E.resultado = null; };
    $$("[data-fv]", m).forEach((i) => i.oninput = () => { n.formatos[i.dataset.fv].version = Number(i.value); cambio(); });
    $$("[data-fchk]", m).forEach((i) => i.onchange = () => { n.formatos[i.dataset.fchk].verificado = i.checked; cambio(); });
    $$("[data-cm]", m).forEach((i) => i.oninput = () => { n.cuantias_menores[i.dataset.cm] = i.value.trim(); cambio(); });
    $("[data-cmchk]", m).onchange = (e) => { n.cuantias_menores.verificado = e.target.checked; cambio(); };
    $("#n-noag").onchange = (e) => { n.no_agrupar_si_retencion = e.target.checked; cambio(); };
    $$("[data-tv]", m).forEach((i) => i.oninput = () => { n.topes[i.dataset.tv].valor = i.value === "" ? null : Number(i.value); cambio(); });
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
    $("#c-add").onclick = () => { n.conceptos.push({ formato: "1001", concepto: "", descripcion: "", verificado: "NO" }); cambio(); pintarC(); };
    $("#c-todos").onclick = () => { if (confirm("¿Confirma que contrastó TODOS los conceptos con el anexo técnico vigente?")) { n.conceptos.forEach((c) => { c.verificado = "SI"; }); cambio(); pintarC(); } };
    $("#n-reset").onclick = () => { if (confirm("¿Restaurar todos los parámetros normativos a los valores de fábrica?")) { E.normativo = normativoDefecto(); guardar(); render(); } };
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
  render();
})();
