import { prisma } from '../db/client.js';

/**
 * Guarda o actualiza un grupo por su JID de WhatsApp.
 */
export async function upsertGroup(waId: string, name: string) {
  return prisma.group.upsert({
    where: { waId },
    update: { name },
    create: { waId, name },
  });
}

/**
 * Guarda o actualiza un usuario (remitente) por su JID.
 */
export async function upsertUser(waId: string, name?: string | null) {
  return prisma.user.upsert({
    where: { waId },
    update: name ? { name } : {},
    create: { waId, name: name ?? null },
  });
}

export interface IncomingMessage {
  waMessageId: string;
  groupWaId: string;
  groupName: string;
  senderWaId: string | null;
  senderName: string | null;
  content: string;
  type: string;
  timestamp: Date;
}

/**
 * Persiste un mensaje entrante, creando de paso su grupo y usuario si no existen.
 * Usa upsert por waMessageId para no duplicar si el mismo mensaje llega dos veces.
 */
export async function saveMessage(msg: IncomingMessage) {
  const group = await upsertGroup(msg.groupWaId, msg.groupName);

  let userId: string | null = null;
  if (msg.senderWaId) {
    const user = await upsertUser(msg.senderWaId, msg.senderName);
    userId = user.id;
  }

  return prisma.message.upsert({
    where: { waId: msg.waMessageId },
    update: {},
    create: {
      waId: msg.waMessageId,
      content: msg.content,
      type: msg.type,
      senderName: msg.senderName,
      timestamp: msg.timestamp,
      groupId: group.id,
      userId,
    },
  });
}

/**
 * Deja pegada al mensaje la ruta del archivo de evidencia que se descargó.
 * La ruta es relativa a la carpeta uploads/ (ver services/mediaService.ts).
 */
export async function setMediaUrl(messageId: string, mediaUrl: string) {
  return prisma.message.update({
    where: { id: messageId },
    data: { mediaUrl },
  });
}

/**
 * Devuelve los mensajes mas recientes de un grupo (para dar contexto a la IA).
 */
export async function getRecentMessages(groupId: string, limit = 15) {
  const messages = await prisma.message.findMany({
    where: { groupId },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
  // Los devolvemos en orden cronologico (mas viejo primero).
  return messages.reverse();
}
