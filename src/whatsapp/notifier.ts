// ============================================================
//  Avisos por WhatsApp
//  - Al canal interno: tickets nuevos creados desde la web.
//  - Al privado del técnico asignado: "te tocó este soporte".
//  - Copia al privado del OTRO técnico en rotación: "se le asignó a Fulano",
//    para que nadie se entere tarde de quién trae qué.
// ============================================================
import type { WASocket } from '@whiskeysockets/baileys';
import { logger } from '../config/logger.js';
import { prisma } from '../db/client.js';
import {
  findTechnicianByName,
  jidDeTecnico,
  tecnicosEnSoporte,
  last10,
  type Technician,
} from '../config/technicians.js';
import { buscarParecidos, parecidosTexto } from '../services/parecidosService.js';

let _sock: WASocket | null = null;

export function setNotifierSock(sock: WASocket): void {
  _sock = sock;
}

/** Dónde quedó un mensaje que mandamos, para poder borrarlo después. */
export interface RefMensaje {
  jid: string;
  waMessageId: string;
}

/**
 * Manda un texto sin tumbar el flujo si WhatsApp falla.
 * Devuelve la referencia del mensaje enviado (o null si no salió), para poder
 * borrarlo más tarde si se borra el ticket.
 */
async function enviar(jid: string, text: string, queEs: string): Promise<RefMensaje | null> {
  if (!_sock) {
    logger.warn(`No se envió ${queEs}: el bot no está conectado.`);
    return null;
  }
  try {
    const sent = await _sock.sendMessage(jid, { text });
    return { jid, waMessageId: sent?.key?.id ?? '' };
  } catch (err) {
    logger.warn(`No se pudo enviar ${queEs}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Apunta en la base dónde quedó un aviso que publicó el bot.
 * Si esto falla, no pasa nada grave: solo significa que ese mensaje no se
 * podrá borrar automáticamente después.
 */
export async function registrarAviso(
  supportCaseId: string | null | undefined,
  ref: RefMensaje | null,
  kind: 'grupo' | 'privado',
  destino?: string | null,
): Promise<void> {
  if (!supportCaseId || !ref?.waMessageId) return;
  try {
    await prisma.botMessage.create({
      data: {
        supportCaseId,
        jid: ref.jid,
        waMessageId: ref.waMessageId,
        kind,
        destino: destino ?? null,
      },
    });
  } catch (err) {
    logger.warn(`No pude apuntar el aviso para borrarlo luego: ${(err as Error).message}`);
  }
}

/**
 * Borra de WhatsApp todos los avisos que el bot publicó sobre un ticket
 * (el del grupo interno y los privados de asignación).
 *
 * ⚠️ WhatsApp solo deja borrar mensajes propios y relativamente recientes:
 * uno de hace meses simplemente no se va a poder quitar. Por eso devolvemos
 * cuántos sí y cuántos no, para poder decírselo al usuario con la verdad.
 */
export async function borrarAvisosDeWhatsApp(
  supportCaseId: string,
): Promise<{ borrados: number; fallidos: number; sinBot: boolean }> {
  const avisos = await prisma.botMessage.findMany({ where: { supportCaseId } });
  if (avisos.length === 0) return { borrados: 0, fallidos: 0, sinBot: false };

  if (!_sock) {
    logger.warn('No se borraron los avisos de WhatsApp: el bot no está conectado.');
    // No borramos los registros: así se puede reintentar con el bot prendido.
    return { borrados: 0, fallidos: avisos.length, sinBot: true };
  }

  let borrados = 0;
  let fallidos = 0;
  for (const a of avisos) {
    try {
      await _sock.sendMessage(a.jid, {
        delete: { remoteJid: a.jid, id: a.waMessageId, fromMe: true },
      });
      borrados++;
      logger.info(`🧹 Aviso borrado de WhatsApp (${a.kind}${a.destino ? ' · ' + a.destino : ''}).`);
    } catch (err) {
      fallidos++;
      logger.warn(`No se pudo borrar un aviso (${a.kind}): ${(err as Error).message}`);
    }
  }

  await prisma.botMessage.deleteMany({ where: { supportCaseId } });
  return { borrados, fallidos, sinBot: false };
}

/**
 * Averigua el JID real del técnico PREGUNTÁNDOSELO a WhatsApp.
 *
 * Armarlo a mano es una trampa: México usa `521` + 10 dígitos, pero hay cuentas
 * nuevas que ya son `52` + 10. Si le atinas mal, WhatsApp NO marca error —
 * el mensaje se va al vacío y el log dice que todo salió bien.
 * `onWhatsApp()` nos dice cuál de los dos existe de verdad.
 */
async function jidReal(t: Technician): Promise<string> {
  const respaldo = jidDeTecnico(t);
  const diez = last10(t.number);
  if (!_sock || !diez) return respaldo;

  for (const numero of [`521${diez}`, `52${diez}`]) {
    try {
      const [r] = (await _sock.onWhatsApp(numero)) ?? [];
      if (r?.exists && r.jid) {
        logger.info(`📱 JID de ${t.name}: ${r.jid} (confirmado por WhatsApp)`);
        return r.jid;
      }
    } catch {
      // Probamos con el siguiente formato.
    }
  }
  logger.warn(
    `⚠️  WhatsApp no reconoce el número de ${t.name} (${diez}). ` +
      `Le escribo a ${respaldo} pero puede que no llegue.`,
  );
  return respaldo;
}

/**
 * ¿Este técnico es el dueño del número con el que corre el bot?
 *
 * El bot está enlazado al WhatsApp de un técnico (hoy, el de un técnico). Mandarle
 * un privado sería que WhatsApp se escriba a sí mismo: cae en "Mensajes contigo",
 * no notifica como un chat normal y es facilísimo no verlo. A esa persona no le
 * mandamos privado — ya se entera por el grupo interno y por el dashboard.
 *
 * Si algún día el bot corre con una línea aparte, esto se apaga solo y todos
 * vuelven a recibir su privado. No hay nada que recordar cambiar.
 */
function esElNumeroDelBot(t: Technician): boolean {
  const mio = last10(_sock?.user?.id?.split('@')[0]?.split(':')[0] ?? null);
  return Boolean(mio && mio === last10(t.number));
}

/** Número corto para los comandos: TKT-0042 → 42 */
function corto(ticketNumber?: string | null): string {
  return ticketNumber ? ticketNumber.replace('TKT-', '').replace(/^0+/, '') : '';
}

/**
 * Mensaje suelto al privado de un técnico (recordatorios, avisos varios).
 * Devuelve false si no se pudo (bot desconectado, o es el número del bot).
 */
export async function avisarPrivado(t: Technician, texto: string): Promise<boolean> {
  if (!_sock) {
    logger.warn(`No se envió privado a ${t.name}: el bot no está conectado.`);
    return false;
  }
  if (esElNumeroDelBot(t)) {
    logger.debug(`Privado a ${t.name} omitido: es el número del propio bot.`);
    return false;
  }
  return (await enviar(await jidReal(t), texto, `privado a ${t.name}`)) !== null;
}

/**
 * Avisa al técnico, a su WhatsApp privado, que le tocó un soporte.
 * Si el técnico no está en el catálogo, no truena: solo lo registra.
 */
export async function notificarAsignacion(ticket: {
  /** Id del caso en nuestra base, para apuntar dónde quedó cada aviso. */
  supportCaseId?: string | null;
  ticketNumber?: string | null;
  assignedTo: string;
  client?: string | null;
  company?: string | null;
  summary: string;
  severity?: string | null;
}): Promise<boolean> {
  const tecnico = findTechnicianByName(ticket.assignedTo);

  const n = corto(ticket.ticketNumber);
  const empresa = ticket.company ?? ticket.client ?? 'Sin empresa';
  const prioridad = ticket.severity && ticket.severity !== 'Media'
    ? `\n⚡ Prioridad: *${ticket.severity}*`
    : '';
  // "Esto ya pasó antes": si hay tickets cerrados parecidos, van en el aviso
  // para que el técnico llegue sabiendo cómo se resolvió la vez pasada.
  // Si la búsqueda falla, el aviso sale igual, solo que sin la pista.
  let pista = '';
  if (ticket.supportCaseId) {
    try {
      pista = parecidosTexto(await buscarParecidos(ticket.supportCaseId));
    } catch (err) {
      logger.warn(`No pude buscar tickets parecidos: ${(err as Error).message}`);
    }
  }

  const detalle =
    `🏢 ${empresa}${prioridad}\n\n` +
    `📝 ${ticket.summary}\n\n` +
    (pista ? `${pista}\n\n` : '') +
    `Detalle: \`/ticket ${n}\``;

  // --- 1) Al que le tocó ---
  let ok = false;
  if (tecnico && esElNumeroDelBot(tecnico)) {
    logger.info(
      `📨 ${ticket.ticketNumber} asignado a ${tecnico.name}. No le mando privado: ` +
        `el bot corre con su propio número. Lo ve en el grupo interno y en el dashboard.`,
    );
  } else if (tecnico) {
    const msg =
      `🎫 Se te asignó *${ticket.ticketNumber ?? 'un soporte'}*\n` + detalle +
      '\n\n✅ Al terminar, *responde este mensaje* con _terminado_ y cómo se resolvió.';
    const ref = await enviar(await jidReal(tecnico), msg, `aviso de asignación a ${tecnico.name}`);
    ok = ref !== null;
    if (ok) {
      await registrarAviso(ticket.supportCaseId, ref, 'privado', tecnico.name);
      logger.info(`📨 ${ticket.ticketNumber} asignado a ${tecnico.name} (avisado por privado)`);
    }
  } else {
    logger.warn(`No conozco el número de "${ticket.assignedTo}"; no le avisé directo.`);
  }

  // --- 2) Copia al resto del equipo en rotación, para que nadie se entere tarde ---
  const copia =
    `📋 *${ticket.ticketNumber ?? 'Un soporte'}* se le asignó a *${ticket.assignedTo}*\n` + detalle;

  const otros = tecnicosEnSoporte().filter(
    (t) => t.name !== tecnico?.name && !esElNumeroDelBot(t),
  );
  const avisados: string[] = [];
  for (const t of otros) {
    // Solo apuntamos a quien SÍ recibió. Un log que dice "enviado" cuando no se
    // envió es peor que no tener log: nos costó una hora buscando el error donde
    // no estaba.
    const ref = await enviar(await jidReal(t), copia, `copia de asignación a ${t.name}`);
    if (ref) {
      await registrarAviso(ticket.supportCaseId, ref, 'privado', t.name);
      avisados.push(t.name);
    }
  }
  if (avisados.length) {
    logger.info(`📨 Copia de ${ticket.ticketNumber} enviada a: ${avisados.join(', ')}`);
  }

  return ok;
}

/** Avisa al canal interno que se creó un ticket desde el dashboard. */
export async function notifyManualTicket(ticket: {
  id?: string | null;
  ticketNumber?: string | null;
  client?: string | null;
  technician?: string | null;
  assignedTo?: string | null;
  summary: string;
}): Promise<void> {
  const { jidCanalInterno } = await import('./commands.js');
  const interno = await jidCanalInterno();
  if (!interno) return;

  const n = corto(ticket.ticketNumber);
  const msg =
    `🎫 Ticket creado desde la web: *${ticket.ticketNumber ?? 'sin número'}*\n` +
    `🏢 ${ticket.client ?? 'Sin especificar'}\n` +
    `👨‍🔧 Responsable: ${ticket.assignedTo ?? ticket.technician ?? 'sin asignar'}\n` +
    `📝 ${ticket.summary}\n\n` +
    `Detalle: \`/ticket ${n}\``;

  const ref = await enviar(interno, msg, 'aviso de ticket manual');
  await registrarAviso(ticket.id, ref, 'grupo', 'Soporte Interno');
}
/**
 * avisa al canal interno que se creo un ticket desde el dashboard.
 *
 * Más explicación si hace falta.
 */ 

export async function avisarAlertaMonitoreo(
  texto: string,
  jidDestino?: string | null,
): Promise<boolean> {
  const { jidCanalInterno } = await import('./commands.js');
  const grupo = jidDestino ?? (await jidCanalInterno());
  if (!grupo) {
    logger.warn('No se envió la alerta de monitoreo: no hay canal interno configurado.');
    return false;
  }

  const ref = await enviar(grupo, texto, 'alerta de monitoreo');
  return ref !== null;
}

/**
 * Manda un ARCHIVO (PDF, Excel…) al grupo interno, con un texto al pie.
 * Lo usa el reporte mensual: el día 1 el PDF llega al equipo para revisarlo.
 *
 * `jidDestino` es opcional: solo lo usa /enviarreportes, cuando alguien del
 * equipo ya revisó los PDF y ordena mandarlos al grupo de cada cliente.
 * Sin él, el archivo va al interno como siempre.
 */
export async function enviarDocumentoInterno(
  documento: Buffer,
  fileName: string,
  mimetype: string,
  caption: string,
  jidDestino?: string | null,
): Promise<boolean> {
  if (!_sock) {
    logger.warn(`No se envió ${fileName}: el bot no está conectado.`);
    return false;
  }
  const { jidCanalInterno } = await import('./commands.js');
  const grupo = jidDestino ?? (await jidCanalInterno());
  if (!grupo) {
    logger.warn(`No se envió ${fileName}: no hay canal interno.`);
    return false;
  }
  try {
    await _sock.sendMessage(grupo, { document: documento, fileName, mimetype, caption });
    return true;
  } catch (err) {
    logger.warn(`No se pudo enviar ${fileName}: ${(err as Error).message}`);
    return false;
  }
}
