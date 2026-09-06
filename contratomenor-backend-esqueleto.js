/**
 * =============================================================================
 * ContratoMenor.app — Esqueleto de backend (Node.js + Express)
 * =============================================================================
 *
 * QUÉ ES ESTE ARCHIVO
 * -------------------
 * Un punto de partida para migrar ContratoMenor.app de "SPA estática con
 * estado en memoria/localStorage" a una arquitectura cliente-servidor real,
 * con varios puestos (Secretaría, Intervención, Alcaldía) trabajando sobre
 * los MISMOS expedientes de forma concurrente.
 *
 * Reutiliza, tal cual, la lógica normativa que en el frontend son funciones
 * JS puras: calcularFiscal, familiaAcumulada, esObjetoGenerico,
 * evaluarCumplimiento y calc347PorNif. Mantenerlas idénticas en un único
 * sitio (aquí) evita que Secretaría e Intervención vean cifras distintas
 * por tener versiones desincronizadas del cálculo en cada navegador.
 *
 * CÓMO EJECUTARLO (referencia)
 * -----------------------------
 *   npm init -y
 *   npm install express jsonwebtoken cors
 *   node contratomenor-backend-esqueleto.js
 *
 * Por defecto arranca en el puerto 3000 (variable de entorno PORT).
 * El almacén de datos es un array en memoria (EXPEDIENTES_DB): sustitúyelo
 * por una tabla real (PostgreSQL, MySQL, etc.) en las funciones marcadas
 * con "TODO: persistencia".
 *
 * CÓMO SE CONECTARÍA EL FRONTEND
 * -------------------------------
 * En contratomenor.html, el objeto App.state.expedientes pasaría de
 * inicializarse desde localStorage a poblarse con:
 *
 *   const res = await fetch(`${API_BASE_URL}/api/expedientes`, {
 *     headers: { Authorization: `Bearer ${token}` }
 *   });
 *   App.state.expedientes = await res.json();
 *
 * Y cada acción (marcarPublicado, cambiarEstado, wizardFinish, etc.) pasaría
 * de mutar el array local a hacer un fetch() con método POST/PATCH contra
 * el endpoint correspondiente, refrescando el estado con la respuesta del
 * servidor en lugar de asumir que la escritura local ya es la verdad.
 *
 * SEGURIDAD: este archivo es un ESQUELETO didáctico. La autenticación está
 * simplificada a propósito (ver sección AUTENTICACIÓN) y debe sustituirse
 * por un mecanismo real (OIDC/SSO corporativo, JWT firmado con secreto
 * gestionado de forma segura, etc.) antes de usarse en producción.
 * =============================================================================
 */

"use strict";

const express = require("express");
// const cors = require("cors"); // habilitar si el frontend se sirve desde otro origen

const app = express();
app.use(express.json());
// app.use(cors({ origin: "https://contratomenor.miayuntamiento.es" }));

const PORT = process.env.PORT || 3000;

/* =============================================================================
   CONFIGURACIÓN Y CATÁLOGOS
   (idénticos a los definidos en contratomenor.html — mantenerlos sincronizados,
   o mejor aún: extraerlos a un paquete/JSON compartido entre frontend y backend)
   ============================================================================= */

const CONFIG = {
  entidad: "Ayuntamiento de Riofrío del Tajo",
  cif: "P-4512300-B",
  sede: "Plaza Mayor, 1 — 45123 Riofrío del Tajo (Toledo)",
  secretaria: "María Dolores Iglesias Cantón, Secretaria-Interventora",
  umbralObra: 40000,
  umbralServicio: 15000,
  umbralSuministro: 15000,
  duracionMaxMeses: 12,
  ivaDefault: 21,
  umbralRegistro: 5000,
  umbral347: 3005.06
};

const FISCAL_CATEGORIES = [
  { id: "persona_juridica", label: "Persona jurídica (sociedad mercantil)", retencion: 0 },
  { id: "autonomo_profesional", label: "Autónomo — actividad profesional", retencion: 15 },
  { id: "autonomo_reducido", label: "Autónomo — inicio de actividad (retención reducida)", retencion: 7 },
  { id: "actividad_artistica", label: "Actividad artística", retencion: 15 },
  { id: "actividad_deportiva", label: "Actividad deportiva", retencion: 15 },
  { id: "agraria", label: "Actividad agrícola, forestal o ganadera", retencion: 2 },
  { id: "obra_instalaciones", label: "Empresario — obras e instalaciones", retencion: 1 }
];

const OBJETOS_GENERICOS = [
  "varios", "diversos", "generales", "material diverso", "trabajos varios",
  "servicios varios", "servicios generales", "suministros varios", "obras varias", "gastos diversos"
];

function categoriaFiscalRetencion(id) {
  const c = FISCAL_CATEGORIES.find(x => x.id === id);
  return c ? c.retencion : 0;
}

function limiteFor(tipo) {
  if (tipo === "obra") return CONFIG.umbralObra;
  if (tipo === "servicio") return CONFIG.umbralServicio;
  return CONFIG.umbralSuministro;
}

/* =============================================================================
   ALMACÉN DE DATOS (EN MEMORIA — SUSTITUIR POR BASE DE DATOS REAL)
   ============================================================================= */

// TODO: persistencia — sustituir este array por consultas a PostgreSQL/MySQL,
// por ejemplo con un ORM (Prisma, Sequelize, Knex) o SQL directo (pg, mysql2).
// El "shape" de cada expediente debe mantenerse igual al del frontend para
// no tener que tocar las funciones normativas de más abajo.
let EXPEDIENTES_DB = [
  // ... aquí vivirían los mismos registros que hoy están en EXPEDIENTES_INICIALES
  // dentro de contratomenor.html. Se omiten en este esqueleto por brevedad.
];

function proximoNumeroExpediente(all) {
  const year = new Date().getFullYear();
  const nums = all
    .map(e => e.numero.match(/CM-(\d{4})-(\d+)/))
    .filter(m => m && Number(m[1]) === year)
    .map(m => Number(m[2]));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `CM-${year}-${String(next).padStart(3, "0")}`;
}

/* =============================================================================
   REGLAS DE NEGOCIO (idénticas a las del frontend — la "fuente de la verdad"
   pasa a ser el servidor; el frontend solo debería usarlas para dar feedback
   instantáneo en el wizard, pero la validación definitiva ocurre aquí)
   ============================================================================= */

function calcularFiscal(exp) {
  const base = Number(exp.base) || 0;
  const ivaRate = exp.ivaRate != null ? Number(exp.ivaRate) : CONFIG.ivaDefault;
  const iva = (base * ivaRate) / 100;
  const totalConIva = base + iva;
  const catId = exp.adjudicatario ? exp.adjudicatario.categoriaFiscal : null;
  const retRate = catId ? categoriaFiscalRetencion(catId) : 0;
  const retencion = (base * retRate) / 100;
  const neto = totalConIva - retencion;
  return { base, ivaRate, iva, totalConIva, retRate, retencion, neto };
}

function familiaAcumulada(exp, all) {
  const limite = limiteFor(exp.tipo);
  const fin = new Date(exp.fechaInicio);
  const inicioVentana = new Date(fin);
  inicioVentana.setMonth(inicioVentana.getMonth() - 12);
  const relacionados = all.filter(o =>
    o.familia === exp.familia && o.tipo === exp.tipo &&
    new Date(o.fechaInicio) <= fin && new Date(o.fechaInicio) > inicioVentana
  );
  const total = relacionados.reduce((s, o) => s + (Number(o.base) || 0), 0);
  return { total, limite, ratio: limite > 0 ? total / limite : 0, relacionados };
}

function esObjetoGenerico(texto) {
  if (!texto) return true;
  const t = texto.trim().toLowerCase();
  if (t.length < 18) return true;
  return OBJETOS_GENERICOS.some(g => t.includes(g));
}

function evaluarCumplimiento(exp, all) {
  const issues = [];
  const limite = limiteFor(exp.tipo);

  if (!exp.adjudicatario) {
    issues.push({ nivel: "bloqueante", categoria: "Adjudicatario", mensaje: "No se ha propuesto adjudicatario para el expediente." });
  }
  if (Number(exp.base) > limite) {
    issues.push({
      nivel: "bloqueante", categoria: "Umbral legal",
      mensaje: `La base (${exp.base} €) supera el límite legal de contrato menor de tipo "${exp.tipo}" (${limite} €, sin IVA).`
    });
  }
  const frac = familiaAcumulada(exp, all);
  if (frac.ratio >= 1) {
    issues.push({
      nivel: "bloqueante", categoria: "Fraccionamiento",
      mensaje: `Riesgo de fraccionamiento: la familia "${exp.familia}" acumula ${frac.total.toFixed(2)} € en 12 meses, superando el límite de ${frac.limite} €.`
    });
  } else if (frac.ratio >= 0.85) {
    issues.push({
      nivel: "aviso", categoria: "Fraccionamiento",
      mensaje: `Atención al fraccionamiento: la familia "${exp.familia}" acumula ${frac.total.toFixed(2)} € (${Math.round(frac.ratio * 100)}% del límite).`
    });
  }
  if (esObjetoGenerico(exp.objeto)) {
    issues.push({ nivel: "aviso", categoria: "Objeto del contrato", mensaje: "El objeto descrito es genérico o poco preciso." });
  }
  const numOfertas = exp.ofertas ? exp.ofertas.length : 0;
  if (numOfertas === 0) {
    issues.push({ nivel: "bloqueante", categoria: "Concurrencia", mensaje: "No consta ninguna oferta ni justificación de precio de mercado." });
  } else if (numOfertas < 3) {
    issues.push({ nivel: "aviso", categoria: "Concurrencia", mensaje: `Solo se han incorporado ${numOfertas} oferta(s).` });
  }
  if (Number(exp.base) > CONFIG.umbralRegistro) {
    issues.push({ nivel: "info", categoria: "Registro", mensaje: `Requiere inscripción en el Registro de Contratos (base > ${CONFIG.umbralRegistro} €).`, registroRequerido: true });
  }
  return issues;
}

function tieneBloqueantes(exp, all) {
  return evaluarCumplimiento(exp, all).some(i => i.nivel === "bloqueante");
}

function calc347PorNif(nif, all, year) {
  const relevantes = all.filter(o => o.adjudicatario && o.adjudicatario.nif === nif && new Date(o.fechaInicio).getFullYear() === year);
  const total = relevantes.reduce((s, o) => s + calcularFiscal(o).totalConIva, 0);
  return { total, obligacion: total > CONFIG.umbral347, relevantes };
}

/* =============================================================================
   GENERACIÓN DOCUMENTAL (versión servidor)
   En el frontend, estas funciones devuelven HTML para imprimir/exportar a PDF
   con html2canvas+jsPDF en el propio navegador. En el servidor interesa más
   generar el PDF directamente (por ejemplo con "pdfkit" o renderizando HTML
   con "puppeteer"), para poder firmarlo electrónicamente antes de entregarlo.
   Aquí se deja solo el esqueleto de texto y el punto de integración de firma.
   ============================================================================= */

const TIPOS_DOCUMENTO = ["memoria", "aprobacion", "adjudicacion", "formalizacion", "checklist"];

function generarDocumentoTexto(exp, all, tipoDoc) {
  const fisc = calcularFiscal(exp);
  switch (tipoDoc) {
    case "memoria":
      return `MEMORIA JUSTIFICATIVA — Expediente ${exp.numero}\nObjeto: ${exp.objeto}\nBase: ${fisc.base} € · IVA: ${fisc.iva} € · Total: ${fisc.totalConIva} €`;
    case "aprobacion":
      return `APROBACIÓN DE GASTO — Expediente ${exp.numero}\nImporte total: ${fisc.totalConIva} €\nAdjudicatario propuesto: ${exp.adjudicatario ? exp.adjudicatario.empresa : "(pendiente)"}`;
    case "adjudicacion":
      return `PROPUESTA DE ADJUDICACIÓN — Expediente ${exp.numero}\nOfertas: ${(exp.ofertas || []).map(o => `${o.empresa} (${o.precio} €)`).join("; ")}`;
    case "formalizacion":
      return `FORMALIZACIÓN / FACTURA-CONTRATO — Expediente ${exp.numero}\nNeto a pagar: ${fisc.neto} €`;
    case "checklist":
      return `CHECKLIST DE CUMPLIMIENTO — Expediente ${exp.numero}\n` +
        evaluarCumplimiento(exp, all).map(i => `[${i.nivel.toUpperCase()}] ${i.categoria}: ${i.mensaje}`).join("\n");
    default:
      throw new Error(`Tipo de documento no reconocido: ${tipoDoc}`);
  }
}

/**
 * Punto de integración de firma electrónica.
 *
 * TODO: firma electrónica — sustituir este stub por la llamada real a un
 * proveedor homologado (por ejemplo, la plataforma @firma / Cl@ve Firma del
 * Estado, FNMT, o un proveedor cualificado bajo eIDAS como Signaturit,
 * Uanataca o similar). El flujo habitual es:
 *   1) Generar el PDF definitivo del documento (servidor).
 *   2) Enviarlo al servicio de firma junto con el certificado/rol del firmante
 *      (Secretaría-Intervención, Alcaldía) mediante su SDK/API (PAdES).
 *   3) Recibir el PDF firmado (o una referencia/job id si la firma es asíncrona)
 *      y almacenarlo junto al expediente, dejando constancia de fecha, firmante
 *      y huella (hash) del documento firmado para su trazabilidad.
 *
 * No se implementa criptografía de firma en este esqueleto: cada proveedor
 * exige su propio SDK, credenciales y formato de certificado.
 */
async function firmarDocumento({ expedienteId, tipoDoc, pdfBuffer, firmante }) {
  // Ejemplo de forma en que se integraría (pseudocódigo, sin ejecutar):
  //
  //   const resultado = await proveedorFirmaSDK.firmarPAdES({
  //     documento: pdfBuffer,
  //     certificado: firmante.certificadoRef,
  //     motivo: `Firma de ${tipoDoc} del expediente ${expedienteId}`,
  //   });
  //   return { firmado: true, pdfFirmado: resultado.documentoFirmado, firmaId: resultado.id };

  throw new Error("firmarDocumento no implementado: integrar con proveedor de firma electrónica homologado (eIDAS).");
}

/* =============================================================================
   AUTENTICACIÓN Y CONTROL DE ACCESO POR PERFIL
   ============================================================================= */

/**
 * TODO: autenticación real — sustituir esta comprobación simplificada por
 * verificación de un JWT firmado (jsonwebtoken.verify) emitido tras un login
 * contra el directorio corporativo (LDAP/Active Directory) o un proveedor
 * SSO/OIDC municipal. Aquí, por simplicidad del esqueleto, se lee el rol
 * directamente de una cabecera, lo cual NO es seguro para producción.
 */
function autenticar(req, res, next) {
  const rol = req.header("X-Debug-Role"); // sustituir por JWT real
  if (!rol) return res.status(401).json({ error: "No autenticado." });
  req.user = { rol }; // roles esperados: 'secretaria' | 'intervencion' | 'alcaldia'
  next();
}

function requiereRol(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.user || !rolesPermitidos.includes(req.user.rol)) {
      return res.status(403).json({ error: `Acción no permitida para el perfil "${req.user ? req.user.rol : "desconocido"}".` });
    }
    next();
  };
}

app.use(autenticar);

/* =============================================================================
   RUTAS
   ============================================================================= */

// Listado de expedientes, con filtros básicos por query string.
app.get("/api/expedientes", (req, res) => {
  let rows = EXPEDIENTES_DB.slice();
  const { tipo, estado, familia, texto } = req.query;
  if (tipo) rows = rows.filter(e => e.tipo === tipo);
  if (estado) rows = rows.filter(e => e.estado === estado);
  if (familia) rows = rows.filter(e => e.familia === familia);
  if (texto) rows = rows.filter(e => (e.numero + " " + e.objeto).toLowerCase().includes(String(texto).toLowerCase()));
  res.json(rows);
});

app.get("/api/expedientes/:id", (req, res) => {
  const exp = EXPEDIENTES_DB.find(e => e.id === req.params.id);
  if (!exp) return res.status(404).json({ error: "Expediente no encontrado." });
  res.json(exp);
});

// Alta de expediente (equivalente a App.wizardFinish en el frontend).
// Solo Secretaría e Intervención pueden abrir expedientes.
app.post("/api/expedientes", requiereRol("secretaria", "intervencion"), (req, res) => {
  const d = req.body || {};
  if (!d.objeto || !d.credito || d.base == null) {
    return res.status(400).json({ error: "Faltan campos obligatorios: objeto, credito, base." });
  }
  const nuevo = {
    id: `e_${Date.now()}`,
    numero: proximoNumeroExpediente(EXPEDIENTES_DB),
    tipo: d.tipo || "servicio",
    familia: d.familia,
    departamento: d.departamento,
    objeto: d.objeto,
    credito: d.credito,
    base: Number(d.base) || 0,
    ivaRate: Number(d.ivaRate != null ? d.ivaRate : CONFIG.ivaDefault),
    duracionMeses: Number(d.duracionMeses) || 1,
    fechaInicio: d.fechaInicio,
    fechaCreacion: new Date().toISOString().slice(0, 10),
    estado: "borrador",
    ofertas: Array.isArray(d.ofertas) ? d.ofertas : [],
    adjudicatario: d.adjudicatario || null,
    publicado: false,
    registrado: false,
    observaciones: d.observaciones || ""
  };
  // TODO: persistencia — INSERT en base de datos en lugar de push en memoria.
  EXPEDIENTES_DB.push(nuevo);
  res.status(201).json(nuevo);
});

// Cambios de estado — se podría restringir por transición y por rol
// (p. ej. solo Intervención puede pasar a "registrado").
app.patch("/api/expedientes/:id/estado", requiereRol("secretaria", "intervencion", "alcaldia"), (req, res) => {
  const exp = EXPEDIENTES_DB.find(e => e.id === req.params.id);
  if (!exp) return res.status(404).json({ error: "Expediente no encontrado." });
  exp.estado = req.body.estado;
  res.json(exp);
});

app.post("/api/expedientes/:id/publicar", requiereRol("secretaria"), (req, res) => {
  const exp = EXPEDIENTES_DB.find(e => e.id === req.params.id);
  if (!exp) return res.status(404).json({ error: "Expediente no encontrado." });
  exp.publicado = true;
  if (exp.estado === "aprobado") exp.estado = "publicado";
  res.json(exp);
});

app.post("/api/expedientes/:id/registrar", requiereRol("intervencion"), (req, res) => {
  const exp = EXPEDIENTES_DB.find(e => e.id === req.params.id);
  if (!exp) return res.status(404).json({ error: "Expediente no encontrado." });
  exp.registrado = true;
  if (exp.estado === "publicado") exp.estado = "registrado";
  res.json(exp);
});

// Cálculo fiscal — equivalente a calcularFiscal() del frontend.
app.get("/api/expedientes/:id/fiscal", (req, res) => {
  const exp = EXPEDIENTES_DB.find(e => e.id === req.params.id);
  if (!exp) return res.status(404).json({ error: "Expediente no encontrado." });
  res.json(calcularFiscal(exp));
});

// Checklist de cumplimiento — equivalente a evaluarCumplimiento() del frontend.
app.get("/api/expedientes/:id/cumplimiento", (req, res) => {
  const exp = EXPEDIENTES_DB.find(e => e.id === req.params.id);
  if (!exp) return res.status(404).json({ error: "Expediente no encontrado." });
  res.json({
    issues: evaluarCumplimiento(exp, EXPEDIENTES_DB),
    bloqueado: tieneBloqueantes(exp, EXPEDIENTES_DB)
  });
});

// Resumen del modelo 347 (acumulado anual por NIF).
app.get("/api/347/resumen", (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const porNif = {};
  EXPEDIENTES_DB.forEach(exp => {
    if (!exp.adjudicatario) return;
    if (new Date(exp.fechaInicio).getFullYear() !== year) return;
    const nif = exp.adjudicatario.nif;
    if (!porNif[nif]) porNif[nif] = { nif, empresa: exp.adjudicatario.empresa, total: 0 };
    porNif[nif].total += calcularFiscal(exp).totalConIva;
  });
  const resumen = Object.values(porNif).map(r => ({ ...r, obligacion: r.total > CONFIG.umbral347 }));
  res.json(resumen);
});

// Generación documental — devuelve el texto fuente del documento.
// Para PDF real en servidor: renderizar este texto/HTML con "puppeteer" o
// construirlo directamente con "pdfkit", y opcionalmente pasarlo por
// firmarDocumento() antes de servirlo.
app.get("/api/expedientes/:id/documentos/:tipo", (req, res) => {
  const exp = EXPEDIENTES_DB.find(e => e.id === req.params.id);
  if (!exp) return res.status(404).json({ error: "Expediente no encontrado." });
  if (!TIPOS_DOCUMENTO.includes(req.params.tipo)) {
    return res.status(400).json({ error: `Tipo de documento no válido. Use uno de: ${TIPOS_DOCUMENTO.join(", ")}` });
  }
  const texto = generarDocumentoTexto(exp, EXPEDIENTES_DB, req.params.tipo);
  res.type("text/plain").send(texto);
});

// Punto de entrada para disparar la firma electrónica de un documento ya
// generado (requiere haber implementado firmarDocumento() más arriba).
app.post("/api/expedientes/:id/documentos/:tipo/firmar", requiereRol("secretaria", "alcaldia"), async (req, res) => {
  try {
    const resultado = await firmarDocumento({
      expedienteId: req.params.id,
      tipoDoc: req.params.tipo,
      pdfBuffer: null, // aquí iría el PDF ya generado en servidor
      firmante: req.user
    });
    res.json(resultado);
  } catch (err) {
    res.status(501).json({ error: err.message });
  }
});

/* =============================================================================
   MANEJO DE ERRORES Y ARRANQUE
   ============================================================================= */

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor." });
});

app.listen(PORT, () => {
  console.log(`ContratoMenor.app API escuchando en el puerto ${PORT}`);
});

module.exports = {
  app,
  calcularFiscal,
  familiaAcumulada,
  esObjetoGenerico,
  evaluarCumplimiento,
  calc347PorNif
};
