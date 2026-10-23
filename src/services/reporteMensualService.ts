// ============================================================
//  Reporte mensual por cliente (PDF)
//
//  ESTE es el papel que justifica el precio: todo lo que se atendió en
//  el mes, con evidencia, en el mismo formato que Mi Empresa ya entrega
//  a mano ("Reporte de Actividades de Soporte Técnico"):
//
//    1. Encabezado: cliente, técnico(s), periodo, fecha de entrega
//    2. Título + marca de agua "Mi Empresa — Memoria Técnica"
//    3. Resumen del periodo (tabla Concepto | Detalle)
//    4. Actividades realizadas, numeradas, con cómo quedó cada una
//    5. Recomendación (ahí se ofrece el siguiente servicio)
//    6. Observaciones en lenguaje de cliente
//    7. Evidencia: fotos con pie
//    8. Pie: la razón social
//
//  El día 1 de cada mes se generan solos y llegan al grupo INTERNO para
//  revisarlos. Nunca se mandan directo al cliente: la regla de oro.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { COMPANIES, EMPRESA_INTERNA, companyForGroup } from '../config/companies.js';
import { prisma } from '../db/client.js';
import { avisarAlertaMonitoreo, enviarDocumentoInterno } from '../whatsapp/notifier.js';
import { getDatosReporteMensual, type DatosReporteMensual } from './statsService.js';
import { rutaAbsoluta } from './mediaService.js';
import { programarTarea } from './tareaProgramada.js';

const AZUL = '#1d4ed8';
const GRIS = '#475569';
const PIE = 'Mi Empresa';
const MAX_FOTOS = 8;

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** "agosto de 2026" */
export function nombreDelMes(anio: number, mes: number): string {
  return `${MESES[mes]} de ${anio}`;
}

/** Entiende "agosto", "ago", "8", "2026-08", "08/2026". Devuelve null si no. */
export function interpretarMes(texto: string, hoy = new Date()): { anio: number; mes: number } | null {
  const t = texto.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})$/.exec(t);
  if (m) return { anio: Number(m[1]), mes: Number(m[2]) - 1 };
  m = /^(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return { anio: Number(m[2]), mes: Number(m[1]) - 1 };

  let mes = -1;
  if (/^\d{1,2}$/.test(t)) mes = Number(t) - 1;
  else mes = MESES.findIndex((n) => t.length >= 3 && n.startsWith(t));
  if (mes < 0 || mes > 11) return null;

  // Un mes sin año es el más reciente que ya empezó: en enero, "diciembre"
  // es el del año pasado.
  const anio = mes > hoy.getMonth() ? hoy.getFullYear() - 1 : hoy.getFullYear();
  return { anio, mes };
}

/** El mes anterior al de `hoy`. */
export function mesAnterior(hoy = new Date()): { anio: number; mes: number } {
  const d = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  return { anio: d.getFullYear(), mes: d.getMonth() };
}

function duracion(min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return `${min} min`;
  if (min < 60 * 24) return `${(min / 60).toFixed(1)} horas`;
  return `${(min / 60 / 24).toFixed(1)} días`;
}

function fechaCorta(d: Date): string {
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Las fotos del mes que pdfkit sabe pintar (JPG y PNG), con su pie. */
async function fotosDelMes(datos: DatosReporteMensual) {
  const ids = datos.casos.map((c) => c.id);
  if (ids.length === 0) return { fotos: [], total: 0 };

  const [manuales, deWhatsApp] = await Promise.all([
    prisma.evidence.findMany({
      where: { supportCaseId: { in: ids } },
      select: { storedPath: true, supportCaseId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.message.findMany({
      where: { supportCaseId: { in: ids }, mediaUrl: { not: null } },
      select: { mediaUrl: true, supportCaseId: true, timestamp: true },
      orderBy: { timestamp: 'asc' },
    }),
  ]);

  const porId = new Map(datos.casos.map((c) => [c.id, c]));
  const todas = [
    ...manuales.map((e) => ({ ruta: e.storedPath, caseId: e.supportCaseId, fecha: e.createdAt })),
    ...deWhatsApp.map((m) => ({ ruta: m.mediaUrl!, caseId: m.supportCaseId!, fecha: m.timestamp })),
  ];

  const fotos: Array<{ abs: string; pie: string }> = [];
  // Total de evidencia del mes (manual + WhatsApp), aunque no todas quepan en el PDF.
  const total = todas.length;
  for (const f of todas) {
    if (!/\.(jpe?g|png)$/i.test(f.ruta)) continue;
    // rutaAbsoluta revisa que no se salga de uploads/ (nunca confiar en la base).
    const abs = rutaAbsoluta(f.ruta);
    if (!abs || !fs.existsSync(abs)) continue;
    const caso = porId.get(f.caseId);
    fotos.push({
      abs,
      pie: `${caso?.ticketNumber ?? ''} · ${fechaCorta(f.fecha)} — ${caso?.summary.slice(0, 90) ?? ''}`,
    });
    if (fotos.length >= MAX_FOTOS) break;
  }
  return { fotos, total };
}

/** Arma el PDF de una empresa y un mes. */
export async function generarReporteMensualPDF(datos: DatosReporteMensual): Promise<Buffer> {
  const { fotos, total: totalEvidencia } = await fotosDelMes(datos);
  const periodo = `${fechaCorta(datos.desde)} al ${fechaCorta(datos.hasta)}`;
  const tecnicos = datos.porTecnico.map((t) => t.nombre).filter((n) => n !== 'Sin asignar');

  return new Promise((resolve, reject) => {
    // bufferPages: permite volver a cada página al final para ponerle el pie.
    const doc = new PDFDocument({ margin: 50, size: 'LETTER', bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ancho = doc.page.width - 100; // área útil entre márgenes
    const izq = 50;

    /** Si no cabe `alto`, página nueva. */
    const espacio = (alto: number): void => {
      if (doc.y + alto > doc.page.height - 80) doc.addPage();
    };

    const subtitulo = (texto: string): void => {
      espacio(60);
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(AZUL).text(texto, izq);
      doc.moveTo(izq, doc.y + 2).lineTo(izq + ancho, doc.y + 2).lineWidth(1).strokeColor(AZUL).stroke();
      doc.moveDown(0.6);
    };

    /** Tabla sencilla de dos columnas con renglones cebra. */
    const tabla = (encabezado: [string, string], filas: Array<[string, string]>): void => {
      const col1 = ancho * 0.45;
      const fila = (a: string, b: string, negrita: boolean, fondo: string | null): void => {
        doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
        const alto = Math.max(
          doc.heightOfString(a, { width: col1 - 12 }),
          doc.heightOfString(b, { width: ancho - col1 - 12 }),
        ) + 10;
        espacio(alto);
        const y = doc.y;
        if (fondo) doc.rect(izq, y, ancho, alto).fill(fondo);
        doc.fillColor(negrita ? '#fff' : '#0f172a');
        doc.text(a, izq + 6, y + 5, { width: col1 - 12 });
        doc.text(b, izq + col1 + 6, y + 5, { width: ancho - col1 - 12 });
        doc.x = izq;
        doc.y = y + alto;
      };
      fila(encabezado[0], encabezado[1], true, AZUL);
      filas.forEach(([a, b], i) => fila(a, b, false, i % 2 ? '#f1f5f9' : null));
      doc.moveDown(0.5);
    };

    // ---------- 1) Encabezado ----------
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#0f172a').text('TIC', izq, 50, { continued: true })
      .fillColor(AZUL).text('GLOBAL');
    doc.font('Helvetica').fontSize(9).fillColor(GRIS).text('Soporte técnico e infraestructura de TI');
    doc.moveDown(1);

    const datosEncabezado: Array<[string, string]> = [
      ['Cliente', datos.empresa],
      ['Técnico(s)', tecnicos.length ? tecnicos.join(', ') : 'Equipo Mi Empresa'],
      ['Periodo de actividades', periodo],
      ['Fecha de entrega', fechaCorta(new Date())],
    ];
    for (const [k, v] of datosEncabezado) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(GRIS).text(`${k}: `, { continued: true })
        .font('Helvetica').fillColor('#0f172a').text(v);
    }

    // ---------- 2) Título ----------
    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#0f172a')
      .text('Reporte de Actividades de Soporte Técnico', { align: 'center' });
    doc.font('Helvetica').fontSize(11).fillColor(GRIS)
      .text(nombreDelMes(datos.desde.getFullYear(), datos.desde.getMonth()), { align: 'center' });

    // ---------- 3) Resumen del periodo ----------
    const t = datos.totales;
    subtitulo('Resumen del periodo');
    tabla(['Concepto', 'Detalle'], [
      ['Solicitudes de soporte atendidas', String(t.total)],
      ['Resueltas', `${t.cerrados} de ${t.total}`],
      ['En seguimiento', String(t.pendientes)],
      ['Tiempo promedio de resolución', duracion(t.promedioMin)],
      ['Mensajes atendidos por WhatsApp', String(t.mensajes)],
      ['Fotos y capturas de evidencia', String(totalEvidencia)],
    ]);

    if (datos.porCategoria.length) {
      subtitulo('Soportes por tipo');
      tabla(['Tipo de soporte', 'Cantidad'], datos.porCategoria.map((c) => [c.nombre, String(c.total)]));
    }

    // ---------- 4) Actividades realizadas ----------
    subtitulo('Actividades realizadas');
    if (datos.casos.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor(GRIS).text('No se registraron solicitudes de soporte en este periodo.');
    }
    datos.casos.forEach((c, i) => {
      espacio(55);
      const cabeza = `${i + 1}. ${c.category?.name ?? 'Soporte técnico'}${c.site ? ` — ${c.site}` : ''}`;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(cabeza, izq);
      doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
        .text(`${c.ticketNumber ?? ''}  ·  ${fechaCorta(c.createdAt)}${c.assignedTo || c.technician ? `  ·  Atendió: ${c.assignedTo || c.technician}` : ''}`);
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text(`•  ${c.summary}`, izq + 10, doc.y, { width: ancho - 10 });
      if (c.resolutionNote) {
        doc.text(`•  Solución: ${c.resolutionNote}`, izq + 10, doc.y, { width: ancho - 10 });
      }
      const quedo = c.status === 'completed'
        ? `Quedó resuelto${c.resolvedAt ? ` el ${fechaCorta(c.resolvedAt)}` : ''}.`
        : 'Sigue en seguimiento por nuestro equipo.';
      doc.font('Helvetica-Oblique').fillColor(c.status === 'completed' ? '#166534' : '#92400e')
        .text(quedo, izq + 10, doc.y, { width: ancho - 10 });
      doc.x = izq;
      doc.moveDown(0.6);
    });

    // ---------- 5) Recomendación ----------
    // Si un mismo tipo de problema se repitió, ahí hay algo de fondo que
    // conviene atender (y un servicio que ofrecer).
    const repetidas = datos.porCategoria.filter((c) => c.total >= env.REPETIDOS_MINIMO && !/^otros?$|sin categor/i.test(c.nombre));
    if (repetidas.length) {
      subtitulo('Recomendación');
      const lista = repetidas.map((c) => `${c.nombre} (${c.total} veces)`).join(', ');
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text(
        `Durante el mes se repitieron solicitudes del mismo tipo: ${lista}. ` +
          'Cuando un problema regresa varias veces, normalmente hay una causa de fondo ' +
          '(un equipo que ya cumplió su vida útil, una configuración que conviene reforzar o ' +
          'un enlace que se satura). Recomendamos agendar una revisión preventiva para ' +
          'atenderla de raíz y evitar que se sigan presentando interrupciones.',
        { align: 'justify' },
      );
    }

    // ---------- 6) Observaciones ----------
    subtitulo('Observaciones');
    const pendientesTxt = t.pendientes
      ? `, de las cuales ${t.cerrados} quedaron resueltas. Quedan ${t.pendientes} en seguimiento, que se atenderán a la brevedad.`
      : ' y todas quedaron resueltas.';
    doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text(
      `En ${nombreDelMes(datos.desde.getFullYear(), datos.desde.getMonth())} atendimos ` +
        `${t.total} solicitud(es) de soporte para ${datos.empresa}${pendientesTxt} ` +
        'Cada atención quedó registrada con su conversación y, cuando aplica, con fotos o ' +
        'capturas como evidencia. Seguimos a sus órdenes para cualquier duda sobre este reporte.',
      { align: 'justify' },
    );

    // ---------- 7) Evidencia ----------
    if (fotos.length) {
      subtitulo('Evidencia');
      const anchoFoto = (ancho - 20) / 2;
      const altoFoto = 170;
      let columna = 0;
      let filaY = doc.y;
      for (const f of fotos) {
        if (columna === 0) {
          if (doc.y + altoFoto + 40 > doc.page.height - 80) doc.addPage();
          filaY = doc.y;
        }
        const x = izq + columna * (anchoFoto + 20);
        try {
          doc.image(f.abs, x, filaY, { fit: [anchoFoto, altoFoto], align: 'center', valign: 'center' });
          doc.rect(x, filaY, anchoFoto, altoFoto).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
        } catch (err) {
          logger.warn(`Foto omitida del reporte (${path.basename(f.abs)}): ${(err as Error).message}`);
        }
        doc.font('Helvetica').fontSize(8).fillColor(GRIS).text(f.pie, x, filaY + altoFoto + 4, { width: anchoFoto });
        columna = (columna + 1) % 2;
        doc.y = columna === 0 ? filaY + altoFoto + 40 : filaY;
      }
      doc.x = izq;
      if (columna === 1) doc.y = filaY + altoFoto + 40;
    }

    // ---------- 8) Pie y marca de agua en TODAS las páginas ----------
    const paginas = doc.bufferedPageRange();
    for (let i = 0; i < paginas.count; i++) {
      doc.switchToPage(i);
      // Sin margen inferior mientras escribimos el pie, o pdfkit abre otra página.
      const margenAbajo = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;

      doc.save();
      doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('Helvetica-Bold').fontSize(36).fillColor('#1d4ed8').fillOpacity(0.05)
        .text('Mi Empresa — Memoria Técnica', 0, doc.page.height / 2 - 25, { width: doc.page.width, align: 'center' });
      doc.restore();
      doc.fillOpacity(1);

      doc.moveTo(izq, doc.page.height - 55).lineTo(izq + ancho, doc.page.height - 55)
        .lineWidth(0.5).strokeColor('#cbd5e1').stroke();
      doc.font('Helvetica').fontSize(8).fillColor(GRIS)
        .text(PIE, izq, doc.page.height - 48, { width: ancho, align: 'center' })
        .text(`Página ${i + 1} de ${paginas.count}`, izq, doc.page.height - 36, { width: ancho, align: 'center' });
      doc.page.margins.bottom = margenAbajo;
    }

    doc.end();
  });
}

/** Nombre de archivo: Reporte-Acme-2026-08.pdf */
export function nombreArchivoReporte(empresa: string, anio: number, mes: number): string {
  const limpio = empresa.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `Reporte-${limpio}-${anio}-${String(mes + 1).padStart(2, '0')}.pdf`;
}

/** Empresa del catálogo a partir de lo que escriba alguien ("acme" → Acme). */
export function buscarEmpresa(texto: string): string | null {
  const t = texto.trim().toLowerCase();
  if (!t) return null;
  // Un pedazo del nombre sirve ("acme"), pero con al menos 3 letras: con
  // "o" sola cualquier cliente coincidiría.
  const c = COMPANIES.find(
    (e) =>
      e.match.some((m) => t.includes(m)) ||
      (t.length >= 3 && (e.name.toLowerCase().includes(t) || e.match.some((m) => m.includes(t)))),
  );
  return c?.name ?? null;
}

/**
 * Genera y manda al grupo interno los reportes de todas las empresas con
 * actividad en ese mes. Devuelve false si el bot no pudo mandar nada.
 */
export async function enviarReportesDelMes(anio: number, mes: number): Promise<boolean> {
  let enviados = 0;
  let intentados = 0;
  for (const empresa of COMPANIES) {
    if (empresa.name === EMPRESA_INTERNA) continue;
    const datos = await getDatosReporteMensual(empresa.name, anio, mes);
    if (datos.totales.total === 0) continue;

    intentados++;
    // Si el PDF de UN cliente truena, se salta ese y se sigue. Si el error
    // subiera, el reloj reintentaría todo y volvería a mandar los que sí
    // salieron: spam en el grupo cada 10 minutos.
    let pdf: Buffer;
    try {
      pdf = await generarReporteMensualPDF(datos);
    } catch (err) {
      logger.error(`📄 No pude generar el reporte de ${empresa.name}: ${(err as Error).message}`);
      continue;
    }
    const ok = await enviarDocumentoInterno(
      pdf,
      nombreArchivoReporte(empresa.name, anio, mes),
      'application/pdf',
      `📄 *Reporte de ${nombreDelMes(anio, mes)} — ${empresa.name}*\n` +
        `${datos.totales.total} soporte(s) · ${datos.totales.cerrados} resuelto(s)\n` +
        '_Revísenlo antes de mandárselo al cliente._',
    );
    if (ok) enviados++;
    // Si el primero no salió, el bot no está conectado: no tiene caso seguir.
    else if (enviados === 0) return false;
  }
  logger.info(`📄 Reportes de ${nombreDelMes(anio, mes)}: ${enviados}/${intentados} enviados.`);
  if (enviados > 0) {
    await avisarAlertaMonitoreo(
      '✅ Cuando estén revisados, mándenlos a cada cliente con:\n' +
        `*/enviarreportes ${MESES[mes]}*`,
    );
  }
  return true;
}

/**
 * JID del grupo de WhatsApp de una empresa, o null si no tiene.
 * Solo grupos ACTIVOS: Acme tiene además "Soporte Acme (histórico)",
 * que está apagado y no debe recibir nada. Si quedan varios activos, gana el
 * que tuvo el mensaje más reciente (el que de verdad usan).
 */
export async function grupoDeEmpresa(empresa: string): Promise<string | null> {
  const grupos = (await prisma.group.findMany({ where: { isActive: true } }))
    .filter((g) => g.waId.endsWith('@g.us') && companyForGroup(g.name) === empresa);
  if (grupos.length === 0) return null;
  if (grupos.length === 1) return grupos[0].waId;

  const ultimo = await prisma.message.findFirst({
    where: { groupId: { in: grupos.map((g) => g.id) } },
    orderBy: { timestamp: 'desc' },
    select: { groupId: true },
  });
  return (grupos.find((g) => g.id === ultimo?.groupId) ?? grupos[0]).waId;
}

export type ResultadoEnvio = {
  empresa: string;
  estado: 'enviado' | 'sin_grupo' | 'error';
  total: number;
};

/**
 * /enviarreportes: manda el PDF de cada cliente a SU grupo de WhatsApp.
 *
 * Es la única vez que el bot habla en un grupo de cliente por su cuenta, y
 * solo cuando alguien del equipo lo ordena desde el grupo interno después de
 * revisar los PDF que llegaron el día 1. Nunca se dispara solo.
 */
export async function enviarReportesAClientes(anio: number, mes: number): Promise<ResultadoEnvio[]> {
  const resultados: ResultadoEnvio[] = [];
  for (const empresa of COMPANIES) {
    if (empresa.name === EMPRESA_INTERNA) continue;
    const datos = await getDatosReporteMensual(empresa.name, anio, mes);
    if (datos.totales.total === 0) continue;
    const total = datos.totales.total;

    const grupo = await grupoDeEmpresa(empresa.name);
    if (!grupo) {
      resultados.push({ empresa: empresa.name, estado: 'sin_grupo', total });
      continue;
    }

    try {
      const pdf = await generarReporteMensualPDF(datos);
      const ok = await enviarDocumentoInterno(
        pdf,
        nombreArchivoReporte(empresa.name, anio, mes),
        'application/pdf',
        `📄 *Reporte de Actividades de Soporte Técnico — ${nombreDelMes(anio, mes)}*\n` +
          `${total} soporte(s) atendido(s) · ${datos.totales.cerrados} resuelto(s)\n\n` +
          'Quedamos al pendiente de cualquier duda. — *Mi Empresa*',
        grupo,
      );
      resultados.push({ empresa: empresa.name, estado: ok ? 'enviado' : 'error', total });
    } catch (err) {
      logger.error(`📄 No pude enviar el reporte de ${empresa.name}: ${(err as Error).message}`);
      resultados.push({ empresa: empresa.name, estado: 'error', total });
    }
  }
  const enviados = resultados.filter((r) => r.estado === 'enviado').length;
  logger.info(`📄 Reportes de ${nombreDelMes(anio, mes)} a clientes: ${enviados}/${resultados.length}.`);
  return resultados;
}

export function iniciarReporteMensual(): void {
  if (!env.REPORTE_MENSUAL) {
    logger.info('📄 Reporte mensual apagado (REPORTE_MENSUAL=false).');
    return;
  }
  logger.info(`📄 Reporte mensual: el día 1 desde las ${env.REPORTE_MENSUAL_HORA}:00.`);

  programarTarea({
    nombre: 'Reporte mensual',
    archivoEstado: '.reporte-mensual.json',
    vueltaPendiente: (ahora) => {
      if (ahora.getDate() !== 1 || ahora.getHours() < env.REPORTE_MENSUAL_HORA) return null;
      const { anio, mes } = mesAnterior(ahora);
      return `${anio}-${String(mes + 1).padStart(2, '0')}`;
    },
    ejecutar: async (_vuelta, ahora) => {
      const { anio, mes } = mesAnterior(ahora);
      return enviarReportesDelMes(anio, mes);
    },
  });
}
