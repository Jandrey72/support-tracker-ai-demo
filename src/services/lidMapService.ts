// ============================================================
//  Equivalencia @lid ↔ número de WhatsApp
//
//  WhatsApp ya no siempre manda el número: en su lugar viene un
//  identificador nuevo (`...@lid`). En los GRUPOS llegan los dos datos
//  juntos, así que ahí aprendemos la pareja y la guardamos. En un chat
//  PRIVADO solo llega el @lid: sin este mapa, el bot no sabe quién le
//  escribe y descarta el mensaje (fue justo lo que pasó con /equipo).
// ============================================================

import { prisma } from '../db/client.js';
import { logger } from '../config/logger.js';

/** Apunta que este @lid corresponde a este número. Solo si trae los dos. */
export async function recordarLid(
  lidJid: string | null | undefined,
  numero: string | null | undefined,
  name?: string | null,
): Promise<void> {
  if (!lidJid?.endsWith('@lid') || !numero) return;
  try {
    const previo = await prisma.lidMap.findUnique({ where: { lid: lidJid } });
    await prisma.lidMap.upsert({
      where: { lid: lidJid },
      update: { numero, name: name ?? undefined },
      create: { lid: lidJid, numero, name: name ?? null },
    });
    if (!previo) logger.info(`🔗 Aprendido: ${lidJid} = ${numero}${name ? ` (${name})` : ''}`);
  } catch (err) {
    logger.debug(`No se pudo guardar el lid ${lidJid}: ${(err as Error).message}`);
  }
}

/** ¿De quién es este @lid? Devuelve el número, o null si nunca lo vimos. */
export async function numeroDeLid(lidJid: string): Promise<string | null> {
  const fila = await prisma.lidMap.findUnique({ where: { lid: lidJid } });
  return fila?.numero ?? null;
}
