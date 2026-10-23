// ============================================================
//  Evidencia: los archivos que llegan por WhatsApp
//
//  Las fotos que manda el cliente SON la prueba del soporte. Antes solo
//  guardábamos el texto "[imagen]" y el archivo se perdía para siempre.
//  Aquí se descargan y se guardan en disco; en la base queda la ruta.
//
//  Las imágenes NO viven en public/: se sirven por un endpoint con sesión,
//  para que nadie las vea sin haber entrado al dashboard.
// ============================================================
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys';
import { logger } from '../config/logger.js';

/** Carpeta raíz de la evidencia. A la altura del proyecto, fuera de public/. */
export const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');

/**
 * Solo estos tipos, y solo imágenes. Aceptar "lo que venga" es cómo se
 * cuela un archivo ejecutable en el servidor.
 */
const TIPOS_PERMITIDOS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** Tope por archivo. Una captura de pantalla normal pesa menos de 1 MB. */
const MAX_BYTES = 8 * 1024 * 1024;

/** "image/jpeg; codecs=x" → "image/jpeg" */
function mimeLimpio(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0].trim().toLowerCase();
}

/** Carpeta por mes: uploads/evidencia/2026-08/ — para que no se junten miles. */
function carpetaDelMes(fecha: Date): string {
  const mes = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
  return path.join(UPLOADS_DIR, 'evidencia', mes);
}

/**
 * Descarga la imagen de un mensaje de WhatsApp y la guarda en disco.
 *
 * @param messageDbId  id del mensaje en NUESTRA base (un cuid). Se usa como
 *                     nombre de archivo: nunca el nombre que manda el cliente,
 *                     porque un "../../algo" se saldría de la carpeta.
 * @returns ruta relativa para guardar en `Message.mediaUrl`, o null si no aplica.
 */
export async function guardarImagenDeWhatsApp(
  msg: WAMessage,
  messageDbId: string,
): Promise<string | null> {
  const img = msg.message?.imageMessage;
  if (!img) return null;

  const mime = mimeLimpio(img.mimetype) || 'image/jpeg';
  const ext = TIPOS_PERMITIDOS[mime];
  if (!ext) {
    logger.warn(`Evidencia ignorada: tipo no permitido (${mime}).`);
    return null;
  }

  // WhatsApp nos dice el tamaño antes de bajarlo: si es enorme, ni lo intentamos.
  const declarado = Number(img.fileLength ?? 0);
  if (declarado > MAX_BYTES) {
    logger.warn(`Evidencia ignorada: pesa ${(declarado / 1048576).toFixed(1)} MB (tope 8 MB).`);
    return null;
  }

  try {
    const buffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
    if (!buffer?.length) return null;
    if (buffer.length > MAX_BYTES) {
      logger.warn(`Evidencia ignorada: el archivo real pesa más de 8 MB.`);
      return null;
    }

    const carpeta = carpetaDelMes(new Date());
    await fs.mkdir(carpeta, { recursive: true });

    const nombre = `${messageDbId}${ext}`;
    await fs.writeFile(path.join(carpeta, nombre), buffer);

    const relativa = path.relative(UPLOADS_DIR, path.join(carpeta, nombre));
    logger.info(`🖼️  Evidencia guardada: ${relativa} (${(buffer.length / 1024).toFixed(0)} KB)`);
    return relativa;
  } catch (err) {
    // Que no se caiga el bot por una foto: el mensaje ya quedó registrado.
    logger.warn(`No se pudo bajar la imagen: ${(err as Error).message}`);
    return null;
  }
}

/** ¿Este tipo de archivo lo aceptamos? Devuelve la extensión, o null. */
export function extensionPermitida(mime: string | null | undefined): string | null {
  return TIPOS_PERMITIDOS[mimeLimpio(mime)] ?? null;
}

/** Tope de tamaño, expuesto para que el endpoint avise con el mismo número. */
export const MAX_EVIDENCIA_BYTES = MAX_BYTES;

/**
 * Guarda una captura subida A MANO desde el dashboard.
 *
 * @param nombreBase nombre de archivo que generamos nosotros (sin extensión).
 *                   Jamás el que manda el navegador: un "../../algo" se saldría
 *                   de la carpeta.
 * @returns ruta relativa a uploads/, o null si el archivo no pasa el filtro.
 */
export async function guardarCapturaManual(
  buffer: Buffer,
  mime: string,
  nombreBase: string,
): Promise<string | null> {
  const ext = extensionPermitida(mime);
  if (!ext) {
    logger.warn(`Captura rechazada: tipo no permitido (${mime}).`);
    return null;
  }
  if (!buffer?.length || buffer.length > MAX_BYTES) {
    logger.warn(`Captura rechazada: tamaño inválido (${buffer?.length ?? 0} bytes).`);
    return null;
  }

  const carpeta = path.join(carpetaDelMes(new Date()), 'manual');
  await fs.mkdir(carpeta, { recursive: true });

  // El nombre lo ponemos nosotros; solo dejamos pasar caracteres seguros.
  const seguro = nombreBase.replace(/[^a-zA-Z0-9_-]/g, '');
  const destino = path.join(carpeta, `${seguro}${ext}`);
  await fs.writeFile(destino, buffer);

  const relativa = path.relative(UPLOADS_DIR, destino);
  logger.info(`📎 Captura subida: ${relativa} (${(buffer.length / 1024).toFixed(0)} KB)`);
  return relativa;
}

/** Borra un archivo de evidencia del disco. No truena si ya no existe. */
export async function borrarArchivo(relativa: string): Promise<void> {
  const abs = rutaAbsoluta(relativa);
  if (!abs) return;
  try {
    await fs.unlink(abs);
    logger.info(`🗑️  Evidencia borrada del disco: ${relativa}`);
  } catch {
    // Ya no estaba: no pasa nada.
  }
}

/**
 * Convierte la ruta relativa guardada en la base a una ruta absoluta real,
 * comprobando que NO se salga de la carpeta de evidencia.
 * Devuelve null si el valor apunta a otro lado (intento de path traversal).
 */
export function rutaAbsoluta(relativa: string): string | null {
  const abs = path.resolve(UPLOADS_DIR, relativa);
  if (abs !== UPLOADS_DIR && !abs.startsWith(UPLOADS_DIR + path.sep)) {
    logger.warn(`Ruta de evidencia rechazada (se sale de la carpeta): ${relativa}`);
    return null;
  }
  return abs;
}

/** Tipo de contenido a partir de la extensión, para que el navegador la pinte. */
export function tipoDeArchivo(ruta: string): string {
  const ext = path.extname(ruta).toLowerCase();
  const mapa: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  };
  return mapa[ext] ?? 'application/octet-stream';
}
