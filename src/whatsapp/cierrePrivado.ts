// ============================================================
//  "Terminado" por privado
//
//  Cómo lo usa el técnico:
//   1. Le llega "🎫 Se te asignó TKT-0042 ..."
//   2. Lo RESPONDE (deslizar → responder) con "terminado, era el cable".
//   3. El bot cierra el ticket, guarda "era el cable" como solución y le
//      confirma. Si no dijo cómo se resolvió, se lo pregunta; respondiendo
//      a esa confirmación, la nota se pega al ticket.
//
//  Sin responder a nada también funciona:
//   - "terminado 42 era el cable" → cierra ese número.
//   - "terminado" a secas → si tiene UN solo ticket abierto, ese; si tiene
//     varios, le contesta la lista para que elija.
//
//  Esto es seguro porque el bot tiene su PROPIO número: este privado es un
//  chat solo con el bot, no el chat personal de nadie. (Si algún día el bot
//  volviera a correr con el número de una persona, un "listo, ya llegué"
//  podría cerrar un ticket: habría que volver a exigir número o respuesta.)
//
//  Lo demás se ignora: un privado no es un soporte y no registramos
//  charla personal.
// ============================================================

import type { WASocket } from '@whiskeysockets/baileys';
import type { SupportCase } from '@prisma/client';
import { logger } from '../config/logger.js';
import { prisma } from '../db/client.js';
import { findTechnicianByName } from '../config/technicians.js';
import { normalizarTicket } from '../services/ticketNumber.js';
import {
  leerCierre,
  casoDeAviso,
  abiertosDe,
  cerrarTicket,
  agregarNota,
} from '../services/cierreService.js';
import { registrarAviso, avisarPrivado } from './notifier.js';

/** Número corto para escribir: TKT-0042 → 42 */
function corto(ticketNumber?: string | null): string {
  return ticketNumber ? ticketNumber.replace('TKT-', '').replace(/^0+/, '') : '?';
}

/** Contesta en el privado y apunta el mensaje para que se pueda responder. */
async function contestar(
  sock: WASocket,
  jid: string,
  texto: string,
  caso?: { id: string } | null,
  quien?: string,
): Promise<void> {
  try {
    const sent = await sock.sendMessage(jid, { text: texto });
    // Si va ligado a un ticket, lo apuntamos: así, si el técnico RESPONDE
    // a esta confirmación, sabemos de qué ticket habla.
    if (caso && sent?.key?.id) {
      await registrarAviso(caso.id, { jid, waMessageId: sent.key.id }, 'privado', quien);
    }
  } catch (err) {
    logger.warn(`No pude contestar el privado: ${(err as Error).message}`);
  }
}

/**
 * Atiende un mensaje privado de un técnico que NO es comando.
 * @param citadoId id de WhatsApp del mensaje al que respondió (si respondió a uno)
 * @returns true si era para nosotros (un cierre o una nota), false si no.
 */
export async function atenderPrivado(
  sock: WASocket,
  jid: string,
  quien: string,
  texto: string,
  citadoId?: string | null,
): Promise<boolean> {
  const cierre = leerCierre(texto);
  const citado = await casoDeAviso(citadoId);

  // --- 1) Respondió a un aviso del bot: ya sabemos de qué ticket habla ---
  if (citado) {
    if (cierre) {
      await cerrarYConfirmar(sock, jid, quien, citado, cierre.nota);
    } else if (citado.status === 'completed') {
      // Ya estaba cerrado: lo que escribe es CÓMO se resolvió.
      await agregarNota(citado.id, texto);
      await contestar(sock, jid, `📝 Guardé la solución en *${citado.ticketNumber}*. ¡Gracias!`);
      logger.info(`📝 ${quien} agregó la solución de ${citado.ticketNumber} por privado.`);
    } else {
      // "Voy para allá" respondiendo al aviso: es plática del ticket, no
      // un cierre. No contestamos para no llenarle el chat de avisos.
      return false;
    }
    return true;
  }

  // Sin respuesta a un aviso, solo nos importa si es un "terminado".
  if (!cierre) return false;

  // --- 2) "terminado 42 ..." ---
  if (cierre.numero) {
    const num = normalizarTicket(cierre.numero);
    const caso = num
      ? await prisma.supportCase.findFirst({ where: { ticketNumber: num, deletedAt: null } })
      : null;
    if (!caso) {
      await contestar(sock, jid, `🤔 No encuentro el ticket *${cierre.numero}*. Revisa el número.`);
      return true;
    }
    // Ya cerrado y sin responder a su aviso: no lo tocamos. Puede que el
    // número no fuera un ticket ("listo 5 minutos" → ticket 5).
    if (caso.status === 'completed') {
      await contestar(sock, jid, `ℹ️ *${caso.ticketNumber}* ya estaba cerrado; no cambié nada.`);
      return true;
    }
    await cerrarYConfirmar(sock, jid, quien, caso, cierre.nota);
    return true;
  }

  // --- 3) "terminado" a secas: si solo trae uno abierto, es ese ---
  const mios = await abiertosDe(quien);
  if (mios.length === 1) {
    const caso = await prisma.supportCase.findUniqueOrThrow({ where: { id: mios[0].id } });
    await cerrarYConfirmar(sock, jid, quien, caso, cierre.nota);
  } else if (mios.length === 0) {
    await contestar(
      sock, jid,
      '🙌 No tienes tickets abiertos a tu nombre.\n' +
        'Si terminaste uno de otra persona, escribe el número: `terminado 42`',
    );
  } else {
    const lista = mios
      .slice(0, 10)
      .map((c) => `• *${corto(c.ticketNumber)}* — ${c.summary.slice(0, 60)}`)
      .join('\n');
    await contestar(
      sock, jid,
      `📋 Tienes ${mios.length} abierto(s). ¿Cuál terminaste?\n\n${lista}\n\n` +
        'Respóndeme el aviso de ese ticket con *terminado*, o escribe `terminado 42`.',
    );
  }
  return true;
}

async function cerrarYConfirmar(
  sock: WASocket,
  jid: string,
  quien: string,
  caso: SupportCase,
  nota: string | null,
): Promise<void> {
  const yaEstaba = caso.status === 'completed';
  const cerrado = await cerrarTicket(caso.id, quien, nota);
  logger.info(`✅ ${quien} cerró ${cerrado.ticketNumber} por privado.`);

  const titulo = yaEstaba
    ? `ℹ️ *${cerrado.ticketNumber}* ya estaba cerrado.`
    : `✅ *${cerrado.ticketNumber}* cerrado. ¡Buen trabajo!`;

  if (cerrado.resolutionNote) {
    await contestar(sock, jid, `${titulo}\n📝 Solución: ${cerrado.resolutionNote}`);
  } else {
    // Sin nota: la pedimos. Respondiendo a ESTE mensaje se guarda en el
    // ticket (para el reporte del cliente y para "esto ya pasó antes").
    await contestar(
      sock, jid,
      `${titulo}\n\n¿Cómo se resolvió? *Respóndeme este mensaje* con la solución ` +
        'y la guardo en el ticket.',
      cerrado,
      quien,
    );
  }

  // Si lo cerró alguien que no era el responsable, el responsable se entera.
  if (!yaEstaba && caso.assignedTo && caso.assignedTo !== quien) {
    const responsable = findTechnicianByName(caso.assignedTo);
    if (responsable) {
      void avisarPrivado(
        responsable,
        `👌 *${quien}* cerró *${cerrado.ticketNumber}* (estaba a tu nombre).`,
      );
    }
  }
}
