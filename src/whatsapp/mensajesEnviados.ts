// ============================================================
//  Memoria de los mensajes que MANDA el bot
//
//  El problema: a veces el WhatsApp de quien recibe no puede abrir un
//  mensaje del bot (le falta la llave de cifrado) y se queda en
//  "Esperando el mensaje. Esto puede tomar tiempo.". Su teléfono entonces
//  le pide al bot "reenvíamelo" (un retry). La librería atiende ese
//  pedido llamando a `getMessage(key)`… y si el bot no recuerda qué mandó,
//  no puede reenviarlo y el mensaje se queda esperando PARA SIEMPRE.
//  (Así pasó el 23-sep con el aviso de TKT-0416.)
//
//  Aquí se guarda cada mensaje que sale del bot, para poder devolverlo
//  cuando lo pidan. Se guarda en disco para que un reinicio no lo borre:
//  una laptop dormida puede pedir el reenvío horas después.
// ============================================================

import fs from 'node:fs';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { logger } from '../config/logger.js';

const ARCHIVO = '.mensajes-enviados.json';
/** Tope de mensajes recordados: de sobra para unos días del bot. */
const MAX_MENSAJES = 1000;
/** Pasado esto, un reenvío ya no tiene caso. */
const MAX_EDAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * id del mensaje en WhatsApp → { contenido, fecha }.
 * El contenido va CODIFICADO en el formato binario de WhatsApp (protobuf) y
 * en base64. No se guarda como JSON normal porque los campos binarios (llaves,
 * miniaturas) se echarían a perder y el reenvío saldría corrupto.
 */
let memoria: Map<string, { b64: string; t: number }> | null = null;
let guardadoPendiente: NodeJS.Timeout | null = null;

function cargar(): Map<string, { b64: string; t: number }> {
  if (memoria) return memoria;
  memoria = new Map();
  try {
    const datos = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')) as Record<string, { b64: string; t: number }>;
    for (const [id, v] of Object.entries(datos)) memoria.set(id, v);
  } catch {
    // Primera vez o archivo dañado: se empieza vacío, no pasa nada grave.
  }
  return memoria;
}

/** Tira lo viejo y lo que sobre del tope (los más antiguos primero). */
function podar(m: Map<string, { b64: string; t: number }>): void {
  const limite = Date.now() - MAX_EDAD_MS;
  for (const [id, v] of m) if (v.t < limite) m.delete(id);
  // Un Map recuerda el orden en que se agregó: los primeros son los más viejos.
  while (m.size > MAX_MENSAJES) m.delete(m.keys().next().value as string);
}

/** Escribe a disco, juntando varios cambios seguidos en una sola escritura. */
function programarGuardado(): void {
  if (guardadoPendiente) return;
  guardadoPendiente = setTimeout(() => {
    guardadoPendiente = null;
    try {
      fs.writeFileSync(ARCHIVO, JSON.stringify(Object.fromEntries(cargar())));
    } catch (err) {
      logger.warn(`No pude guardar la memoria de mensajes enviados: ${(err as Error).message}`);
    }
  }, 5000);
}

/** Apunta un mensaje que salió del bot. Los demás se ignoran. */
export function recordarEnviado(msg: WAMessage): void {
  const id = msg.key?.id;
  if (!msg.key?.fromMe || !id || !msg.message) return;
  try {
    const b64 = Buffer.from(proto.Message.encode(msg.message).finish()).toString('base64');
    const m = cargar();
    m.set(id, { b64, t: Date.now() });
    podar(m);
    programarGuardado();
  } catch (err) {
    logger.warn(`No pude recordar el mensaje ${id}: ${(err as Error).message}`);
  }
}

/**
 * Lo que la librería llama cuando alguien pide un reenvío.
 * Devuelve el contenido original, o undefined si no lo tenemos.
 */
export async function obtenerEnviado(key: proto.IMessageKey): Promise<proto.IMessage | undefined> {
  const guardado = key.id ? cargar().get(key.id) : undefined;
  if (!guardado) {
    logger.debug(`Pidieron reenviar ${key.id ?? '?'} pero no lo tengo guardado.`);
    return undefined;
  }
  logger.info(`🔁 Reenviando un mensaje que no se pudo abrir (${key.id}).`);
  return proto.Message.decode(Buffer.from(guardado.b64, 'base64'));
}
