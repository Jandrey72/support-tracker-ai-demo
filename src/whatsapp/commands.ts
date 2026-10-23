// ============================================================
//  Comandos del bot por WhatsApp
//  El equipo Mi Empresa escribe /comando en el grupo y el bot
//  responde con datos. Reutiliza los servicios que ya existen.
//  Comandos: /help /soportes /top /resumen /exportar /pendientes
//  /repetidos /reporte
// ============================================================
import type { WASocket } from '@whiskeysockets/baileys';
import {
  getDatosReporteMensual,
  getProblemasRepetidos,
  getStats,
  getSupports,
  getSupportMessages,
  type SupportFilters,
} from '../services/statsService.js';
import { toCSV, toExcel, toPDF } from '../services/exportService.js';
import { normalizarTicket } from '../services/ticketNumber.js';
import {
  cerrarTicket,
  cerrarPendientesDe,
  pendientesParaCerrar,
} from '../services/cierreService.js';
import { companyForGroup, EMPRESA_INTERNA } from '../config/companies.js';
import { prisma } from '../db/client.js';
import { logger } from '../config/logger.js';
import {
  avisarAlEquipo,
  companeros,
  estadoDelEquipo,
  marcarDisponibilidad,
  desdeHace,
} from '../services/availabilityService.js';
import { cargaActual } from '../services/assignmentService.js';
import { pendientesText, repetidosText } from '../services/resumenDiarioService.js';
import { buscarParecidos, parecidosTexto } from '../services/parecidosService.js';
import {
  buscarEmpresa,
  enviarReportesAClientes,
  enviarReportesDelMes,
  generarReporteMensualPDF,
  interpretarMes,
  mesAnterior,
  nombreArchivoReporte,
  nombreDelMes,
} from '../services/reporteMensualService.js';
import { env } from '../config/env.js';
import {
  AL_SALIR_QUEDA_UNO,
  AL_SALIR_NADIE_QUEDA,
  AL_VOLVER,
  AL_VOLVER_SIN_NADIE,
  frase,
} from '../config/frasesAusencia.js';

/** Etiquetas bonitas para los estados. */
const STATUS_LABEL: Record<string, string> = {
  open: '🟢 Abiertos',
  in_progress: '🟡 En progreso',
  completed: '✅ Completados',
};

/**
 * ¿Este chat es el canal interno de Mi Empresa?
 *
 * IMPORTANTE: en los grupos de los CLIENTES el bot solo escucha y registra;
 * nunca responde comandos ahí (el cliente no debe ver nuestros reportes,
 * números de ticket ni estadísticas). Todo eso vive en el grupo interno.
 *
 * Los chats privados (que no son grupo) también cuentan como internos:
 * son conversaciones directas con el equipo.
 */
export async function esCanalInterno(jid: string): Promise<boolean> {
  // Chat 1 a 1 con un técnico (messageHandler ya verificó que lo sea).
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return true;

  // Grupo: solo el interno de Mi Empresa.
  if (jid.endsWith('@g.us')) {
    const grupo = await prisma.group.findUnique({
      where: { waId: jid },
      select: { name: true },
    });
    return grupo ? companyForGroup(grupo.name) === EMPRESA_INTERNA : false;
  }

  // Ids que no son de WhatsApp ("manual", importaciones históricas):
  // no son chats reales, no se responde nada ahí.
  return false;
}

/** JID del grupo interno, para mandarle los avisos de tickets nuevos. */
export async function jidCanalInterno(): Promise<string | null> {
  const grupos = await prisma.group.findMany({ select: { waId: true, name: true } });
  return grupos.find((g) => companyForGroup(g.name) === EMPRESA_INTERNA)?.waId ?? null;
}

/** Manda un texto al grupo. En WhatsApp *asteriscos* = negrita. */
async function reply(sock: WASocket, jid: string, text: string): Promise<void> {
  await sock.sendMessage(jid, { text });
}

/** Texto del menu de ayuda. */
function helpText(_empresa: string | null): string {
  return (
    '🤖 *Comandos del Support Tracker*\n' +
    '_Canal interno — ves todas las empresas._\n\n' +
    '📅 */hoy* — lo atendido hoy, con desglose por empresa\n' +
    '📆 */semana* — resumen de los últimos 7 días\n' +
    '📌 */pendientes* — lo abierto de cada quien, lo vencido primero\n' +
    '🔁 */repetidos* — clientes que repiten el mismo problema\n' +
    '📄 */reporte Acme* — PDF del mes pasado para el cliente\n' +
    '     `/reporte Acme agosto` — de otro mes\n' +
    '     `/reporte todos septiembre` — los de todos los clientes, aquí\n' +
    '📨 */enviarreportes* — manda cada PDF del mes pasado al grupo de su cliente\n' +
    '     `/enviarreportes agosto` — de otro mes (revísenlos antes)\n' +
    '📊 */resumen* — vista general (totales, estados, top)\n' +
    '📋 */soportes* — total y desglose por estado\n' +
    '🏆 */top* — top técnicos y categorías\n' +
    '🎫 */ticket* — detalle de un ticket + su conversación\n' +
    '✅ */cerrar 42 lo que se hizo* — lo marca terminado con su solución\n' +
    '     _Por privado: responde el aviso del ticket con *terminado*_\n' +
    '🧹 */cerrartodos* — cierra todos tus pendientes (te pide confirmar)\n' +
    '     `/cerrartodos si la causa` — los cierra con esa causa\n' +
    '📤 */exportar* — te envía el archivo\n' +
    '❓ */help* — muestra esta ayuda\n\n' +
    '👥 *Disponibilidad*\n' +
    '  `/ausente voy a Demo` — no me manden tickets\n' +
    '  `/disponible` — ya volví\n' +
    '  `/equipo` — quién está y con cuánta carga\n\n' +
    '*Formatos:* `csv` · `excel` · `pdf`\n\n' +
    '*Un solo archivo con varios soportes:*\n' +
    '  `/exportar Acme ayer pdf`\n' +
    '  `/exportar Acme mes excel`\n' +
    '  `/exportar Demo del 01/08/2026 al 21/08/2026 pdf`\n\n' +
    '*Uno solo:*\n' +
    '  `/ticket 42` — detalle + conversación\n' +
    '  `/ticket 42 pdf` — detalle y el archivo\n' +
    '  `/exportar 42 excel`\n\n' +
    '*Atajos de fecha:* `hoy` · `ayer` · `semana` · `mes`\n\n' +
    '💡 Cuando registro un soporte te aviso aquí el número.'
  );
}

/** Convierte una fecha a "AAAA-MM-DD" (lo que esperan dateFrom/dateTo). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ¿"AAAA-MM-DD" existe de verdad en el calendario? (31/02 no existe) */
function esFechaValida(texto: string): boolean {
  const d = new Date(texto + 'T12:00:00');
  return !Number.isNaN(d.getTime()) && ymd(d) === texto;
}

/**
 * Lee TODAS las palabras del comando y arma un filtro combinado.
 * Así `/exportar Acme ayer` funciona: empresa Y fecha a la vez.
 *
 * Reconoce, en cualquier orden:
 *   - número de ticket ....... 42, #42, TKT-0042
 *   - atajo de fecha ......... hoy, ayer, semana, mes
 *   - fecha exacta ........... 21/08/2026, 2026-08-21
 *   - rango .................. del 01/08/2026 al 21/08/2026
 *   - lo que sobre ........... nombre del cliente/empresa
 */
function interpretarFiltro(texto: string): {
  filtros: SupportFilters;
  etiqueta: string;
  nombreArchivo: string;
  /** Si viene lleno, no hay nada que exportar: se le explica al usuario. */
  error?: string;
} {
  const hoy = new Date();
  const palabras = texto.trim().split(/\s+/).filter(Boolean);

  const filtros: SupportFilters = {};
  const partesEtiqueta: string[] = [];
  const partesNombre: string[] = [];
  const sobrantes: string[] = [];
  let error: string | undefined;

  /** Convierte "21/08/2026" o "2026-08-21" a "AAAA-MM-DD". null si no es fecha. */
  const aFecha = (p: string): string | null => {
    const iso = p.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const dmy = p.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!iso && !dmy) return null;
    return iso ? p : `${dmy![3]}-${dmy![2].padStart(2, '0')}-${dmy![1].padStart(2, '0')}`;
  };

  const fijarRango = (desde: Date, hasta: Date, etiqueta: string, nombre: string): void => {
    filtros.dateFrom = ymd(desde);
    filtros.dateTo = ymd(hasta);
    partesEtiqueta.push(etiqueta);
    partesNombre.push(nombre);
  };

  for (let i = 0; i < palabras.length; i++) {
    const p = palabras[i];
    const lower = p.toLowerCase();

    // "del X al Y" — nos saltamos las preposiciones.
    if (lower === 'del' || lower === 'al' || lower === 'de' || lower === 'a') continue;

    // ¿Número de ticket?
    const ticket = normalizarTicket(p);
    if (ticket) {
      filtros.search = ticket;
      partesEtiqueta.push(ticket);
      partesNombre.push(ticket);
      continue;
    }

    // ¿Atajo de fecha?
    if (lower === 'hoy') {
      fijarRango(hoy, hoy, 'hoy', ymd(hoy));
      continue;
    }
    if (lower === 'ayer') {
      const ayer = new Date(hoy);
      ayer.setDate(ayer.getDate() - 1);
      fijarRango(ayer, ayer, 'ayer', ymd(ayer));
      continue;
    }
    if (lower === 'semana') {
      const desde = new Date(hoy);
      desde.setDate(desde.getDate() - 6);
      fijarRango(desde, hoy, 'últimos 7 días', `semana-${ymd(hoy)}`);
      continue;
    }
    if (lower === 'mes') {
      const desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
      fijarRango(desde, hoy, 'este mes', `mes-${ymd(hoy).slice(0, 7)}`);
      continue;
    }

    // ¿Fecha exacta? Si vienen dos seguidas, es un rango.
    const f1 = aFecha(p);
    if (f1) {
      if (!esFechaValida(f1)) {
        error = `📅 *${p}* no es una fecha válida.\nUsa por ejemplo \`21/08/2026\`, o los atajos \`hoy\`, \`ayer\`, \`semana\`, \`mes\`.`;
        break;
      }
      // ¿La siguiente palabra (saltando "al") también es fecha?
      let j = i + 1;
      if (palabras[j] && /^(al|a)$/i.test(palabras[j])) j++;
      const f2 = palabras[j] ? aFecha(palabras[j]) : null;

      if (f2 && esFechaValida(f2)) {
        const [desde, hasta] = f1 <= f2 ? [f1, f2] : [f2, f1];
        filtros.dateFrom = desde;
        filtros.dateTo = hasta;
        partesEtiqueta.push(`del ${desde} al ${hasta}`);
        partesNombre.push(`${desde}_a_${hasta}`);
        i = j;
      } else {
        filtros.dateFrom = f1;
        filtros.dateTo = f1;
        partesEtiqueta.push(f1);
        partesNombre.push(f1);
      }
      continue;
    }

    // No es nada de lo anterior: forma parte del nombre del cliente.
    sobrantes.push(p);
  }

  if (sobrantes.length) {
    const cliente = sobrantes.join(' ');
    filtros.client = cliente;
    partesEtiqueta.unshift(cliente);
    partesNombre.unshift(cliente.replace(/\s+/g, '-').toLowerCase());
  }

  return {
    filtros,
    etiqueta: partesEtiqueta.length ? partesEtiqueta.join(' · ') : 'Todos',
    nombreArchivo: partesNombre.length
      ? `soportes-${partesNombre.join('-')}`
      : `soportes-${ymd(hoy)}`,
    error,
  };
}

type Formato = 'csv' | 'excel' | 'pdf';

/** Detecta el formato pedido entre las palabras del comando. */
function detectarFormato(partes: string[]): Formato {
  for (const p of partes) {
    const w = p.toLowerCase();
    if (w === 'pdf') return 'pdf';
    if (w === 'excel' || w === 'xlsx' || w === 'xls') return 'excel';
    if (w === 'csv') return 'csv';
  }
  return 'csv'; // por defecto, el más ligero
}

function esPalabraDeFormato(p: string): boolean {
  return /^(pdf|csv|excel|xlsx|xls)$/i.test(p);
}

/** Genera el archivo y lo manda al chat. */
async function enviarArchivo(
  sock: WASocket,
  jid: string,
  casos: Awaited<ReturnType<typeof getSupports>>,
  formato: Formato,
  nombreBase: string,
): Promise<void> {
  const MIME: Record<Formato, string> = {
    csv: 'text/csv',
    pdf: 'application/pdf',
    excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const EXT: Record<Formato, string> = { csv: 'csv', pdf: 'pdf', excel: 'xlsx' };

  let buffer: Buffer;
  if (formato === 'pdf') buffer = await toPDF(casos);
  else if (formato === 'excel') buffer = await toExcel(casos);
  else buffer = Buffer.from(toCSV(casos), 'utf8');

  await sock.sendMessage(jid, {
    document: buffer,
    fileName: `${nombreBase}.${EXT[formato]}`,
    mimetype: MIME[formato],
  });
}

/** Detalle completo de un ticket, con la conversación que lo originó. */
async function ticketText(numero: string, empresa: string | null): Promise<string> {
  const num = numero.toUpperCase().startsWith('TKT-')
    ? numero.toUpperCase()
    : `TKT-${numero.toUpperCase()}`;

  const casos = await getSupports({ search: num });
  const caso = casos.find((c) => c.ticketNumber?.toUpperCase() === num) ?? casos[0];

  if (!caso) return `No encontré el ticket *${num}*.`;

  const ESTADO: Record<string, string> = {
    open: '🆕 Abierto',
    in_progress: '🔄 En progreso',
    completed: '✅ Completado',
  };

  let t = `🎫 *${caso.ticketNumber ?? 'Sin número'}*\n`;
  t += `${'─'.repeat(24)}\n`;
  t += `👥 Cliente: ${caso.client ?? '—'}\n`;
  t += `👨‍🔧 Técnico: ${caso.technician ?? 'Sin asignar'}\n`;
  t += `🏷️ Categoría: ${caso.category?.name ?? '—'}\n`;
  t += `⚡ Prioridad: ${caso.severity ?? 'Media'}\n`;
  t += `📌 Estado: ${ESTADO[caso.status] ?? caso.status}\n`;
  t += `📅 Creado: ${caso.createdAt.toLocaleString('es-MX')}\n`;

  if (caso.resolvedAt) {
    const mins = Math.round((caso.resolvedAt.getTime() - caso.startedAt.getTime()) / 60000);
    const dur = mins < 60 ? `${mins} min` : `${(mins / 60).toFixed(1)} h`;
    t += `⏱️ Resuelto en: ${dur}\n`;
  }

  t += `\n📝 *Qué pasó:*\n${caso.summary}\n`;

  if (caso.resolutionNote) {
    t += `\n🔧 *Cómo se resolvió:*\n${caso.resolutionNote}\n`;
  }

  // La evidencia: los mensajes de WhatsApp ligados al caso.
  const mensajes = await getSupportMessages(caso.id);
  if (mensajes.length) {
    t += `\n💬 *Conversación (${mensajes.length} mensaje/s):*\n`;
    for (const m of mensajes.slice(0, 15)) {
      const hora = m.timestamp.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      const texto = m.content.length > 160 ? m.content.slice(0, 160) + '…' : m.content;
      t += `  _${hora}_ *${m.senderName ?? 'Alguien'}:* ${texto}\n`;
    }
    if (mensajes.length > 15) {
      t += `  _...y ${mensajes.length - 15} mensaje(s) más._\n`;
    }
  }

  // Tickets cerrados parecidos: cómo se resolvió la vez pasada.
  const pista = parecidosTexto(await buscarParecidos(caso.id));
  if (pista) t += `\n${pista}\n`;

  return t.trim();
}

/** Resumen de los últimos 7 días. */
export async function semanaText(
  empresa: string | null,
  // Sin rango: los últimos 7 días hasta hoy (lo que pide /semana).
  // El resumen automático pasa la semana anterior completa, lunes a domingo.
  rango?: { desde: Date; hasta: Date },
): Promise<string> {
  const ahora = rango?.hasta ?? new Date();
  const hace7 = rango?.desde ?? new Date(ahora);
  if (!rango) {
    hace7.setDate(hace7.getDate() - 6);
    hace7.setHours(0, 0, 0, 0);
  }

  const casos = await getSupports(empresa ? { company: empresa } : {});
  const semana = casos.filter(
    c => new Date(c.createdAt) >= hace7 && new Date(c.createdAt) <= ahora,
  );

  if (semana.length === 0) {
    return rango
      ? '📆 *La semana pasada* no hubo soportes registrados.'
      : '📆 *Esta semana* — Aún no hay soportes registrados.';
  }

  const completados = semana.filter(c => c.status === 'completed').length;
  const abiertos = semana.filter(c => c.status === 'open').length;
  const enProceso = semana.filter(c => c.status === 'in_progress').length;

  // Por técnico: cuenta el RESPONSABLE (assignedTo), no quien habló al
  // último; si el caso es viejo y no tiene responsable, cae a technician.
  const porTecnico = new Map<string, number>();
  for (const c of semana) {
    const t = c.assignedTo || c.technician || 'Sin asignar';
    porTecnico.set(t, (porTecnico.get(t) ?? 0) + 1);
  }
  const topTechs = [...porTecnico.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, n], i) => `  ${i + 1}. ${t} — ${n}`)
    .join('\n');

  // Por día
  const porDia = new Map<string, number>();
  // En orden cronológico (getSupports los trae del más nuevo al más viejo).
  const cronologico = [...semana].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  for (const c of cronologico) {
    const dia = new Date(c.createdAt).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
    porDia.set(dia, (porDia.get(dia) ?? 0) + 1);
  }
  const diasStr = [...porDia.entries()].map(([d, n]) => `  ${d}: ${n}`).join('\n');

  const desde = hace7.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
  const hasta = ahora.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });

  return (
    `📆 *Semana del ${desde} al ${hasta}*\n\n` +
    `*Total:* ${semana.length}   ✅ ${completados}  🔄 ${enProceso}  🆕 ${abiertos}\n\n` +
    `👨‍🔧 *Por técnico:*\n${topTechs}\n\n` +
    `📅 *Por día:*\n${diasStr}`
  );
}

/** Resumen detallado de lo que se hizo HOY. */
async function hoyText(empresa: string | null): Promise<string> {
  const hoyInicio = new Date();
  hoyInicio.setHours(0, 0, 0, 0);
  const hoyFin = new Date();
  hoyFin.setHours(23, 59, 59, 999);

  const casos = await getSupports(empresa ? { company: empresa } : {});
  const hoy = casos.filter(c => {
    const fecha = new Date(c.createdAt);
    return fecha >= hoyInicio && fecha <= hoyFin;
  });

  const titulo = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  if (hoy.length === 0) {
    return `📅 *Hoy — ${titulo}*${empresa ? `\n🏢 ${empresa}` : ''}\n\nAún no hay soportes registrados hoy.`;
  }

  const completados = hoy.filter((c) => c.status === 'completed').length;
  const abiertos = hoy.filter((c) => c.status === 'open').length;
  const enProceso = hoy.filter((c) => c.status === 'in_progress').length;

  let texto = `📅 *Reporte del día — ${titulo}*\n`;
  if (empresa) texto += `🏢 ${empresa}\n`;
  texto += `\n*Total:* ${hoy.length} soporte(s)   ✅ ${completados}  🔄 ${enProceso}  🆕 ${abiertos}\n\n`;

  // En el canal interno mostramos primero cuántos lleva cada empresa.
  if (!empresa) {
    const porEmpresa = new Map<string, number>();
    for (const c of hoy) {
      const e = companyForGroup(c.group?.name);
      porEmpresa.set(e, (porEmpresa.get(e) ?? 0) + 1);
    }
    texto += '🏢 *Por empresa:*\n';
    for (const [e, n] of [...porEmpresa.entries()].sort((a, b) => b[1] - a[1])) {
      texto += `  ${e}: ${n}\n`;
    }
    texto += '\n';
  }

  // Luego el detalle por técnico, con el número de ticket a la mano.
  const porTecnico = new Map<string, typeof hoy>();
  for (const c of hoy) {
    const tech = c.technician || 'Sin asignar';
    if (!porTecnico.has(tech)) porTecnico.set(tech, []);
    porTecnico.get(tech)!.push(c);
  }

  for (const [tech, lista] of porTecnico) {
    texto += `👨‍🔧 *${tech}* (${lista.length}):\n`;
    for (const c of lista) {
      const estado = c.status === 'completed' ? '✅' : c.status === 'in_progress' ? '🔄' : '🆕';
      const num = c.ticketNumber ? `\`${c.ticketNumber.replace('TKT-', '#').replace(/#0+/, '#')}\` ` : '';
      const cliente = c.client ? `[${c.client}] ` : '';
      const resumen = c.summary.length > 60 ? c.summary.slice(0, 60) + '…' : c.summary;
      texto += `  ${estado} ${num}${cliente}${resumen}\n`;
    }
    texto += '\n';
  }

  texto += `_Descarga todo: \`/exportar hoy pdf\`_`;
  return texto.trim();
}

/** Construye el texto de /resumen a partir de las estadísticas. */
function resumenText(stats: Awaited<ReturnType<typeof getStats>>, filtro?: string): string {
  if (stats.total === 0) {
    return `📊 *Resumen*${filtro ? ` (${filtro})` : ''}\n\nAún no hay soportes registrados.`;
  }
  const topCat = stats.byCategory[0];
  const topTech = stats.topTechnicians[0];
  const linea = [
    `${STATUS_LABEL.open}: ${stats.byStatus.open}`,
    `${STATUS_LABEL.in_progress}: ${stats.byStatus.in_progress}`,
    `${STATUS_LABEL.completed}: ${stats.byStatus.completed}`,
  ].join('   ');

  return (
    `📊 *Resumen de soportes*${filtro ? ` — ${filtro}` : ''}\n\n` +
    `*Total:* ${stats.total}\n` +
    `${linea}\n` +
    (topCat ? `🏷️ Categoría top: *${topCat.name}* (${topCat.count})\n` : '') +
    (topTech ? `👨‍🔧 Técnico top: *${topTech.technician}* (${topTech.count})\n` : '') +
    (stats.avgResolutionMinutes != null
      ? `⏱️ Tiempo promedio: ${stats.avgResolutionMinutes} min`
      : '')
  );
}

/** Construye el texto de /soportes (solo totales por estado). */
function soportesText(stats: Awaited<ReturnType<typeof getStats>>, filtro?: string): string {
  return (
    `📋 *Soportes*${filtro ? ` — ${filtro}` : ''}\n\n` +
    `*Total:* ${stats.total}\n` +
    `${STATUS_LABEL.open}: ${stats.byStatus.open}\n` +
    `${STATUS_LABEL.in_progress}: ${stats.byStatus.in_progress}\n` +
    `${STATUS_LABEL.completed}: ${stats.byStatus.completed}`
  );
}

/** Construye el texto de /top (top técnicos y categorías). */
function topText(stats: Awaited<ReturnType<typeof getStats>>, filtro?: string): string {
  if (stats.total === 0) return 'Aún no hay datos para el top.';
  const techs = stats.topTechnicians
    .slice(0, 5)
    .map((t, i) => `${i + 1}. ${t.technician} — ${t.count}`)
    .join('\n');
  const cats = stats.byCategory
    .slice(0, 5)
    .map((c, i) => `${i + 1}. ${c.name} — ${c.count}`)
    .join('\n');
  return (
    `🏆 *Top*${filtro ? ` — ${filtro}` : ''}\n\n` +
    `👨‍🔧 *Técnicos:*\n${techs || 'Sin datos'}\n\n` +
    `🏷️ *Categorías:*\n${cats || 'Sin datos'}`
  );
}

/**
 * Marca ausente/disponible a quien escribió y devuelve el texto a publicar.
 * El aviso sale en el grupo interno: el equipo se entera en el momento.
 */
async function marcarAusencia(
  quien: string | null | undefined,
  disponible: boolean,
  motivo: string | null,
): Promise<{ ok: boolean; texto: string; quien?: string }> {
  if (!quien) {
    return {
      ok: false,
      texto: '🤔 No te reconocí. Tu número no está en el catálogo del equipo (`config/technicians.ts`).',
    };
  }

  const estado = await marcarDisponibilidad(quien, disponible, motivo);
  if (!estado) {
    return { ok: false, texto: `🤔 "${quien}" no está en la lista del equipo de soporte.` };
  }

  // ¿Quiénes quedan disponibles además de quien acaba de cambiar?
  const otros = (await estadoDelEquipo()).filter((e) => e.disponible && e.name !== estado.name);
  const nombres = otros.map((o) => o.name).join(' y ');

  const texto = !disponible
    ? otros.length > 0
      ? frase(AL_SALIR_QUEDA_UNO, { ausente: estado.name, presente: nombres, motivo })
      : frase(AL_SALIR_NADIE_QUEDA, { ausente: estado.name, motivo })
    : otros.length > 0
      ? frase(AL_VOLVER, { ausente: estado.name, presente: nombres })
      : frase(AL_VOLVER_SIN_NADIE, { ausente: estado.name });

  return { ok: true, texto, quien: estado.name };
}

/**
 * Avisa del cambio a los COMPAÑEROS de soporte, por privado.
 *
 * Antes se publicaba en el grupo interno y hacía ruido para gente que no
 * es de soporte. Ahora es cosa del equipo: a cada técnico le llega la
 * frase a su chat, y a quien lo mandó solo un acuse corto.
 * (Con AVISO_AUSENCIA=grupo vuelve a publicarse en el interno.)
 */
async function publicarAusencia(
  sock: WASocket,
  jid: string,
  resultado: { ok: boolean; texto: string; quien?: string },
): Promise<void> {
  if (!resultado.ok) {
    await reply(sock, jid, resultado.texto);
    return;
  }

  await avisarAlEquipo(resultado.texto, resultado.quien);

  const otros = companeros(resultado.quien);
  await reply(
    sock,
    jid,
    otros.length
      ? `✅ Anotado. Ya le avisé a ${otros.join(' y ')}.`
      : '✅ Anotado.',
  );
}

/** Quién está disponible y con cuánta carga. */
async function equipoText(): Promise<string> {
  const [estado, carga] = await Promise.all([estadoDelEquipo(), cargaActual()]);
  const lineas = estado.map((e) => {
    const abiertos = carga.get(e.name) ?? 0;
    return e.disponible
      ? `  ✅ *${e.name}* — ${abiertos} abierto(s)`
      : `  🚪 *${e.name}* — fuera${e.motivo ? ` (${e.motivo})` : ''}` +
        `, hace ${desdeHace(e.desde)} · ${abiertos} abierto(s)`;
  });

  const disponibles = estado.filter((e) => e.disponible).length;
  return (
    '👥 *Equipo de soporte*\n\n' +
    lineas.join('\n') +
    (disponibles === 0
      ? '\n\n⚠️ Nadie disponible: los soportes nuevos quedan *sin asignar*.'
      : '')
  );
}

/**
 * Procesa un comando. Devuelve true si el texto ERA un comando (para que el
 * messageHandler sepa que ya se atendió y no lo mande a la IA).
 */
export async function handleCommand(
  sock: WASocket,
  jid: string,
  text: string,
  /** Nombre del técnico que escribió (para /ausente y /disponible). */
  quien?: string | null,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;

  // ¿Mandaron varios comandos en un solo mensaje (uno por línea)?
  // Los atendemos en orden en vez de tratar todo como un comando gigante.
  const lineas = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/'));

  if (lineas.length > 1) {
    const MAX = 5; // tope, para que un mensaje largo no sature el chat
    for (const linea of lineas.slice(0, MAX)) {
      await handleCommand(sock, jid, linea, quien);
    }
    if (lineas.length > MAX) {
      await reply(sock, jid, `⚠️ Solo atendí los primeros ${MAX} comandos del mensaje.`);
    }
    return true;
  }

  // Un solo comando: si traía saltos de línea, nos quedamos con la primera línea.
  const unaLinea = lineas[0] ?? trimmed;

  // 🔒 Los comandos SOLO funcionan en el canal interno de Mi Empresa.
  // En los grupos de clientes el bot escucha y registra, pero no responde:
  // el cliente no debe ver nuestros reportes ni estadísticas.
  if (!(await esCanalInterno(jid))) {
    logger.debug(`Comando ignorado (grupo de cliente): ${unaLinea}`);
    return true; // lo damos por atendido para que no pase a la IA
  }

  // Separa el comando del resto: "/resumen Acme" -> cmd="resumen", arg="Acme"
  const [rawCmd, ...rest] = unaLinea.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ').trim();

  // Desde el canal interno se ve TODO. Para acotar a una empresa se pide
  // a mano, ej. `/exportar Acme ayer pdf`.
  const filters: SupportFilters = arg ? { client: arg } : {};

  try {
    switch (cmd) {
      case 'hola':
        await reply(sock, jid, '👋 ¡Hola! Soy el Support Tracker. Escribe /help.');
        return true;

      case 'hoy': {
        await reply(sock, jid, await hoyText(null));
        return true;
      }

      case 'semana': {
        await reply(sock, jid, await semanaText(null));
        return true;
      }

      case 'pendientes': {
        await reply(sock, jid, await pendientesText());
        return true;
      }

      case 'repetidos': {
        const lista = await getProblemasRepetidos(env.REPETIDOS_DIAS, env.REPETIDOS_MINIMO);
        await reply(
          sock, jid,
          repetidosText(lista, `🔁 *Se repite en los últimos ${env.REPETIDOS_DIAS} días* (${env.REPETIDOS_MINIMO}+ de lo mismo):`) ||
            `✅ Ningún cliente repite el mismo problema ${env.REPETIDOS_MINIMO}+ veces en ${env.REPETIDOS_DIAS} días.`,
        );
        return true;
      }

      case 'reporte': {
        // "/reporte Acme", "/reporte Acme agosto", "/reporte beta 2026-07".
        // La última palabra puede ser el mes; lo demás, la empresa.
        const palabras = [...rest];
        const posibleMes = palabras.length > 1 ? interpretarMes(palabras[palabras.length - 1]) : null;
        if (posibleMes) palabras.pop();
        const { anio, mes } = posibleMes ?? mesAnterior();

        // "/reporte todos septiembre": lo mismo que pasa solo el día 1, todos
        // los PDF al grupo interno (nunca a los clientes).
        if (palabras.join(' ').toLowerCase() === 'todos') {
          await reply(sock, jid, `📄 Generando los reportes de ${nombreDelMes(anio, mes)} de todos los clientes…`);
          const ok = await enviarReportesDelMes(anio, mes);
          if (!ok) await reply(sock, jid, '📄 No pude mandar los PDF; revisen el log.');
          return true;
        }

        const empresa = buscarEmpresa(palabras.join(' '));

        if (!empresa) {
          await reply(
            sock, jid,
            '📄 Dime de qué cliente. Ejemplos:\n' +
            '  `/reporte Acme` — el mes pasado\n' +
            '  `/reporte Beta agosto`\n' +
            '  `/reporte Demo 2026-07`',
          );
          return true;
        }

        const datos = await getDatosReporteMensual(empresa, anio, mes);
        if (datos.totales.total === 0) {
          await reply(sock, jid, `📄 *${empresa}* no tiene soportes en ${nombreDelMes(anio, mes)}.`);
          return true;
        }
        await sock.sendMessage(jid, {
          document: await generarReporteMensualPDF(datos),
          fileName: nombreArchivoReporte(empresa, anio, mes),
          mimetype: 'application/pdf',
          caption:
            `📄 *${empresa} — ${nombreDelMes(anio, mes)}*\n` +
            `${datos.totales.total} soporte(s) · ${datos.totales.cerrados} resuelto(s)\n` +
            '_Revísalo antes de mandárselo al cliente._',
        });
        return true;
      }

      case 'enviarreportes': {
        // "/enviarreportes" = el mes pasado; "/enviarreportes agosto" = otro.
        // Manda el PDF de cada cliente a SU grupo. Solo se llega aquí desde el
        // canal interno (ver el candado de arriba), nunca desde un cliente.
        const cual = arg ? interpretarMes(arg) : mesAnterior();
        if (!cual) {
          await reply(sock, jid, '📨 No entendí el mes. Ejemplos: `/enviarreportes`, `/enviarreportes agosto`.');
          return true;
        }
        const { anio, mes } = cual;
        await reply(sock, jid, `📨 Mandando los reportes de ${nombreDelMes(anio, mes)} a cada cliente…`);

        const resultados = await enviarReportesAClientes(anio, mes);
        if (resultados.length === 0) {
          await reply(sock, jid, `📨 Nadie tuvo soportes en ${nombreDelMes(anio, mes)}; no mandé nada.`);
          return true;
        }
        const icono = { enviado: '✅', sin_grupo: '⚠️', error: '❌' } as const;
        const nota = { enviado: '', sin_grupo: ' — no encontré su grupo', error: ' — falló, revisen el log' } as const;
        const lineas = resultados.map(
          (r) => `${icono[r.estado]} ${r.empresa} (${r.total})${nota[r.estado]}`,
        );
        await reply(
          sock, jid,
          `📨 *Reportes de ${nombreDelMes(anio, mes)}*\n` + lineas.join('\n'),
        );
        return true;
      }

      case 'cerrar':
      case 'terminado': {
        // "/cerrar 42 se cambió el tóner" → completado, con su solución.
        const [crudo, ...nota] = rest;
        const num = crudo ? normalizarTicket(crudo) : null;
        if (!num) {
          await reply(
            sock, jid,
            '✅ Dime cuál ticket. Ejemplo:\n  `/cerrar 42 se cambió el tóner`',
          );
          return true;
        }
        const caso = await prisma.supportCase.findFirst({
          where: { ticketNumber: num, deletedAt: null },
        });
        if (!caso) {
          await reply(sock, jid, `🤔 No encuentro *${num}*.`);
          return true;
        }
        const cerrado = await cerrarTicket(caso.id, quien ?? 'Equipo Mi Empresa', nota.join(' '));
        logger.info(`✅ ${quien ?? '¿?'} cerró ${num} con /cerrar.`);
        await reply(
          sock, jid,
          `✅ *${num}* cerrado.` +
            (cerrado.resolutionNote
              ? `\n📝 Solución: ${cerrado.resolutionNote}`
              : '\n💡 Sin nota de solución. Agrégala así: `/cerrar 42 lo que se hizo`'),
        );
        return true;
      }

      case 'cerrartodos': {
        // Para cuando el trabajo se hizo pero nadie cerró cada ticket.
        // "/cerrartodos"              → solo dice cuántos son (no cierra nada)
        // "/cerrartodos si"           → los cierra con nota genérica
        // "/cerrartodos si la causa"  → los cierra con esa causa
        if (!quien) {
          await reply(sock, jid, '🤔 No sé quién eres: este comando cierra *tus* pendientes.');
          return true;
        }
        const [confirma, ...causa] = rest;
        const pendientes = await pendientesParaCerrar(quien);
        if (pendientes.length === 0) {
          await reply(sock, jid, `✅ ${quien}, no tienes pendientes.`);
          return true;
        }
        if (confirma?.toLowerCase() !== 'si' && confirma?.toLowerCase() !== 'sí') {
          const MAX = 10;
          const lista = pendientes
            .slice(0, MAX)
            .map((c) => `  • ${c.ticketNumber ?? '—'} ${c.summary.slice(0, 50)}`)
            .join('\n');
          await reply(
            sock, jid,
            `⚠️ ${quien}, voy a cerrar *${pendientes.length}* pendientes tuyos:\n` +
              lista +
              (pendientes.length > MAX ? `\n  …y ${pendientes.length - MAX} más` : '') +
              '\n\nPara confirmar manda:\n  `/cerrartodos si la causa`\n' +
              '_La causa es opcional; va como nota de solución en todos._',
          );
          return true;
        }
        const cerrados = await cerrarPendientesDe(quien, causa.join(' '));
        logger.info(`✅ ${quien} cerró ${cerrados} pendientes con /cerrartodos.`);
        await reply(
          sock, jid,
          `✅ Listo: cerré *${cerrados}* pendientes de ${quien}.` +
            (causa.length
              ? `\n📝 Causa: ${causa.join(' ')}`
              : '\n💡 Quedaron con nota genérica; la causa de cada uno la puedes editar en el dashboard.'),
        );
        return true;
      }

      case 'ausente':
      case 'fuera': {
        await publicarAusencia(sock, jid, await marcarAusencia(quien, false, arg));
        return true;
      }

      case 'disponible':
      case 'volvi':
      case 'volví': {
        await publicarAusencia(sock, jid, await marcarAusencia(quien, true, null));
        return true;
      }

      case 'equipo': {
        await reply(sock, jid, await equipoText());
        return true;
      }

      case 'help':
      case 'ayuda':
        await reply(sock, jid, helpText(null));
        return true;

      case 'resumen': {
        const stats = await getStats(filters);
        await reply(sock, jid, resumenText(stats, arg || undefined));
        return true;
      }

      case 'soportes': {
        const stats = await getStats(filters);
        await reply(sock, jid, soportesText(stats, arg || undefined));
        return true;
      }

      case 'top': {
        const stats = await getStats(filters);
        await reply(sock, jid, topText(stats, arg || undefined));
        return true;
      }

      case 'ticket': {
        // El número es la primera palabra que no sea formato ni otro comando.
        const crudo = rest.find((p) => !esPalabraDeFormato(p) && !p.startsWith('/'));
        const num = crudo ? normalizarTicket(crudo) : null;

        if (!num) {
          await reply(
            sock, jid,
            '🎫 Dime cuál ticket. Ejemplos:\n' +
            '  `/ticket 42`\n' +
            '  `/ticket 42 pdf` — con el archivo',
          );
          return true;
        }

        await reply(sock, jid, await ticketText(num, null));

        // Si además pidió un formato, le mandamos el archivo de ese ticket.
        if (rest.some(esPalabraDeFormato)) {
          const casos = await getSupports({ search: num });
          if (casos.length) {
            await enviarArchivo(sock, jid, casos, detectarFormato(rest), num);
          }
        }
        return true;
      }

      case 'exportar':
      case 'export': {
        // El argumento trae el formato (csv/excel/pdf) y, además, un número de
        // ticket, un atajo de fecha (hoy/ayer/semana/mes) o un cliente.
        const formato = detectarFormato(rest);
        const texto = rest.filter((p) => !esPalabraDeFormato(p)).join(' ').trim();

        const { filtros, etiqueta, nombreArchivo, error } = interpretarFiltro(texto);
        if (error) {
          await reply(sock, jid, error);
          return true;
        }


        const cases = await getSupports(filtros);

        if (cases.length === 0) {
          await reply(sock, jid, `No encontré soportes para *${etiqueta}*.`);
          return true;
        }

        await enviarArchivo(sock, jid, cases, formato, nombreArchivo);
        await reply(sock, jid, `📤 *${etiqueta}* — ${cases.length} soporte(s) exportado(s).`);
        return true;
      }

      default:
        await reply(
          sock,
          jid,
          `❓ No conozco el comando */${cmd}*.\nEscribe */help* para ver los disponibles.`,
        );
        return true;
    }
  } catch (err) {
    logger.error(`Error en comando /${cmd}: ${(err as Error).message}`);
    await reply(sock, jid, '⚠️ Ocurrió un error procesando el comando.');
    return true;
  }
}
