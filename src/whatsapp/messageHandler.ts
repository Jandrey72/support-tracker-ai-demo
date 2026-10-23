import type { WASocket, proto } from '@whiskeysockets/baileys';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { saveMessage, getRecentMessages, setMediaUrl } from '../services/messageService.js';
import { guardarImagenDeWhatsApp } from '../services/mediaService.js';
import { getAIProvider } from '../ai/aiService.js';
import { processAnalysis } from '../services/supportService.js';
import { handleCommand, jidCanalInterno } from './commands.js';
import { atenderPrivado } from './cierrePrivado.js';
import { leerCierre } from '../services/cierreService.js';
import { registrarAviso } from './notifier.js';
import { companyForGroup } from '../config/companies.js';
import { recordarLid, numeroDeLid } from '../services/lidMapService.js';
import {
  findTechnicianByNumber,
  looksLikeTechnicianName,
  last10,
  type Technician,
} from '../config/technicians.js';
import type { AnalysisContext } from '../domain/types.js';

/** Cache de nombres de grupo para no pedir la metadata en cada mensaje. */
const groupNameCache = new Map<string, string>();

async function getGroupName(sock: WASocket, jid: string): Promise<string> {
  const cached = groupNameCache.get(jid);
  if (cached) return cached;
  try {
    const meta = await sock.groupMetadata(jid);
    groupNameCache.set(jid, meta.subject);
    return meta.subject;
  } catch {
    return jid;
  }
}

/**
 * Extrae texto y tipo de un mensaje de WhatsApp.
 * Soporta texto, imagen, video, documento y audio.
 */
function extractContent(
  message: proto.IMessage | null | undefined,
): { content: string; type: string } | null {
  if (!message) return null;

  if (message.conversation) {
    return { content: message.conversation, type: 'text' };
  }
  if (message.extendedTextMessage?.text) {
    return { content: message.extendedTextMessage.text, type: 'text' };
  }
  if (message.imageMessage) {
    return { content: message.imageMessage.caption || '[imagen]', type: 'image' };
  }
  if (message.videoMessage) {
    return { content: message.videoMessage.caption || '[video]', type: 'video' };
  }
  if (message.documentMessage) {
    const label =
      message.documentMessage.caption ||
      message.documentMessage.fileName ||
      '[documento]';
    return { content: label, type: 'document' };
  }
  if (message.audioMessage) {
    return { content: '[audio]', type: 'audio' };
  }
  return null;
}

/** Convierte el timestamp de WhatsApp (segundos, a veces tipo Long) a Date. */
function toDate(ts: number | { toString(): string } | null | undefined): Date {
  if (ts == null) return new Date();
  const seconds = typeof ts === 'number' ? ts : Number(ts.toString());
  return new Date(seconds * 1000);
}

/**
 * Extrae el numero de un JID de WhatsApp.
 * Ej: "5214771234567:12@s.whatsapp.net" -> "5214771234567"
 */
function jidToNumber(jid?: string | null): string | null {
  if (!jid) return null;
  const num = jid.split('@')[0].split(':')[0].trim();
  return num || null;
}

/** ¿Debemos monitorear este grupo segun la config MONITORED_GROUPS? */
function isMonitored(groupName: string): boolean {
  if (env.MONITORED_GROUPS.length === 0) return true; // vacio = todos
  const lower = groupName.toLowerCase();
  return env.MONITORED_GROUPS.some((g) => lower.includes(g.toLowerCase()));
}

/**
 * Procesa el lote de mensajes entrantes: filtra, extrae y guarda.
 * (La llamada a la IA se conectara aqui en la siguiente fase.)
 */
export async function handleIncomingMessages(
  sock: WASocket,
  upsert: { messages: proto.IWebMessageInfo[]; type: string },
): Promise<void> {
  if (upsert.type !== 'notify') return;

  for (const msg of upsert.messages) {
    try {
      // Nota: SI procesamos los mensajes propios (fromMe), porque el dueño del
      // numero tambien puede ser un tecnico dando soporte en el grupo.
      const jid = msg.key.remoteJid;
      if (!jid || !msg.key.id) continue;

      // --- Chat privado con el bot ---
      // Solo atendemos a gente del equipo: COMANDOS (p. ej. /ausente sin
      // anunciarlo en el grupo) y el "terminado" para cerrar tickets
      // (cierrePrivado.ts). Lo demás ni se guarda ni se analiza: un
      // privado no es un soporte y no queremos registrar conversaciones
      // personales. Los mensajes propios (fromMe) se ignoran: el bot se
      // escribiría a sí mismo.
      if (!jid.endsWith('@g.us')) {
        if (msg.key.fromMe) continue;
        const texto = extractContent(msg.message)?.content?.trim();
        if (!texto) continue;
        // ¿Está respondiendo a un mensaje? (deslizar → responder)
        const citadoId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null;
        const esComando = texto.startsWith('/');
        // Filtro barato ANTES de buscar en la base: o es comando, o responde
        // a algo, o empieza como un "terminado". Si no, es charla: fuera.
        if (!esComando && !citadoId && !leerCierre(texto)) continue;

        // El número puede venir en el propio JID, en senderPn, o solo como
        // @lid: en ese caso lo buscamos en lo aprendido en los grupos.
        const kp = msg.key as proto.IMessageKey & { senderPn?: string | null };
        const numero =
          jidToNumber(kp.senderPn) ??
          (jid.endsWith('@lid') ? await numeroDeLid(jid) : jidToNumber(jid));

        const quien = findTechnicianByNumber(numero);
        if (!quien) {
          logger.info(
            `🚫 Comando por privado ignorado: ${jid} (número: ${numero ?? 'desconocido'}) ` +
              'no está en el catálogo del equipo.',
          );
          continue;
        }

        logger.info(`💬 [privado] ${quien.name}: ${texto.slice(0, 80)}`);
        if (esComando) await handleCommand(sock, jid, texto, quien.name);
        else await atenderPrivado(sock, jid, quien.name, texto, citadoId);
        continue;
      }
      // --- De aquí para abajo, solo grupos ---

      const extracted = extractContent(msg.message);
      if (!extracted) continue;

      const groupName = await getGroupName(sock, jid);
      if (!isMonitored(groupName)) continue;

      const senderWaId = msg.key.participant ?? null;
      const senderName = msg.pushName ?? (msg.key.fromMe ? 'Yo (dueño)' : null);
      const timestamp = toDate(msg.messageTimestamp);
      const sender = senderName ?? senderWaId ?? '???';

      // Numero REAL de WhatsApp de quien escribe.
      // WhatsApp enmascara el participante con un @lid; el numero real viene
      // en participantPn. Para mensajes propios usamos el numero del bot.
      const key = msg.key as proto.IMessageKey & { participantPn?: string | null };
      const senderNumber = msg.key.fromMe
        ? jidToNumber(sock.user?.id)
        : jidToNumber(key.participantPn) ?? jidToNumber(senderWaId);

      // Aprendemos la pareja @lid ↔ numero para poder reconocerlo por privado.
      void recordarLid(senderWaId, senderNumber, senderName);

      // ¿Quien escribe es del equipo tecnico? (por numero, o respaldo por nombre)
      const technician = findTechnicianByNumber(senderNumber);
      const isTech =
        technician !== null ||
        Boolean(msg.key.fromMe) ||
        looksLikeTechnicianName(senderName);
      const technicianName =
        technician?.name ?? (isTech ? senderName : null);

      // El cliente es el numero de quien escribe, SOLO si no es del equipo.
      const clientNumber = isTech ? null : senderNumber;

      const saved = await saveMessage({
        waMessageId: msg.key.id,
        groupWaId: jid,
        groupName,
        senderWaId,
        senderName,
        content: extracted.content,
        type: extracted.type,
        timestamp,
      });

      // Si el mensaje trae foto, la bajamos y la pegamos al registro: ESA es
      // la evidencia que justifica el cobro. Va sin await a propósito, para no
      // frenar el análisis del mensaje mientras se descarga.
      if (extracted.type === 'image') {
        void guardarImagenDeWhatsApp(msg, saved.id)
          .then((ruta) => (ruta ? setMediaUrl(saved.id, ruta) : null))
          .catch((err) => logger.warn(`Evidencia no guardada: ${(err as Error).message}`));
      }

      const shownSender = technicianName ?? senderNumber ?? sender;
      logger.info(
        `💬 [${groupName}] ${shownSender}: ${extracted.content.slice(0, 80)}`,
      );

      // ¿Es un comando (/algo)? Solo lo atendemos si lo escribe el EQUIPO
      // Mi Empresa, para no mostrarle estadisticas internas a un cliente.
      if (extracted.content.startsWith('/')) {
        if (isTech) {
          await handleCommand(sock, jid, extracted.content, technicianName);
        }
      } else {
        // Analisis con IA (si esta configurada).
        await analyzeMessage(
          sock,
          jid,
          saved.id,
          saved.groupId,
          groupName,
          // A la IA le pasamos el NOMBRE (para que reconozca al tecnico).
          { sender, content: extracted.content, timestamp },
          clientNumber,
          technicianName,
          isTech,
        );
      }
    } catch (err) {
      logger.error(err);
    }
  }
}

/**
 * Envia el mensaje (con su contexto) a la IA y actualiza el registro de soportes.
 * Los errores de IA se registran pero no detienen el bot.
 */
async function analyzeMessage(
  sock: WASocket,
  jid: string,
  messageDbId: string,
  groupDbId: string,
  groupName: string,
  current: AnalysisContext['currentMessage'],
  clientNumber: string | null,
  technicianName: string | null,
  isTech: boolean,
): Promise<void> {
  const provider = getAIProvider();
  if (!provider) return; // IA no configurada

  try {
    const recent = await getRecentMessages(groupDbId, 12);
    const context: AnalysisContext = {
      groupName,
      currentMessage: current,
      recentMessages: recent.map((m) => ({
        sender: m.senderName ?? 'Desconocido',
        content: m.content,
        timestamp: m.timestamp,
      })),
    };

    const result = await provider.analyze(context);
    const outcome = await processAnalysis({
      messageDbId,
      groupDbId,
      result,
      clientNumber,
      technicianName,
      provider: provider.name,
      model: provider.model,
      isTech,
    });

    if (outcome.qualifies && outcome.action === 'none') {
      logger.info(`↪️  [${groupName}] mensaje del equipo sin caso abierto: no se crea ticket.`);
    } else if (outcome.qualifies) {
      const verb = outcome.action === 'created' ? '🆕 Nuevo soporte' : '🔄 Soporte actualizado';
      logger.info(
        `${verb} [${groupName}] cliente="${clientNumber ?? result.client ?? '?'}" tecnico="${technicianName ?? result.technician ?? '?'}" estado=${result.status ?? 'open'} (confianza ${(result.confidence * 100).toFixed(0)}%)`,
      );

      // Avisamos el número SOLO en el canal interno de Mi Empresa.
      // Nunca en el grupo del cliente: él no debe ver cómo lo registramos.
      // Apagado por defecto (AVISO_POR_TICKET): el equipo lo ve en el
      // resumen semanal y el responsable ya recibe su privado.
      if (env.AVISO_POR_TICKET && outcome.action === 'created' && outcome.ticketNumber) {
        const interno = await jidCanalInterno();
        if (interno) {
          const corto = outcome.ticketNumber.replace('TKT-', '').replace(/^0+/, '');
          const empresa = companyForGroup(groupName);
          const enviado = await sock.sendMessage(interno, {
            text:
              `🎫 Nuevo soporte *${outcome.ticketNumber}*\n` +
              `🏢 ${empresa}  ·  💬 ${groupName}\n` +
              `👨‍🔧 Responsable: *${outcome.assignedTo ?? 'sin asignar'}*\n` +
              `_${result.summary ?? 'Soporte detectado'}_\n\n` +
              `Detalle: \`/ticket ${corto}\`   ·   PDF: \`/exportar ${corto} pdf\``,
          });

          // Apuntamos dónde quedó, para poder borrarlo si se borra el ticket.
          await registrarAviso(
            outcome.supportCaseId,
            enviado?.key?.id ? { jid: interno, waMessageId: enviado.key.id } : null,
            'grupo',
            'Soporte Interno',
          );
        }
      }
    }
  } catch (err) {
    logger.error(`Error analizando mensaje con IA: ${(err as Error).message}`);
  }
}
