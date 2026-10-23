// ============================================================
//  Resumen semanal de soportes al grupo interno.
//
//  Reemplaza al aviso "🎫 Nuevo soporte" por cada ticket, que hacía
//  mucho ruido. Una vez por semana (lunes 9 a. m. por defecto) publica
//  lo que pasó la semana anterior, de lunes a domingo.
//
//  Por qué NO es un setInterval de 7 días: ese conteo arranca cuando
//  arranca el bot, y cada reinicio lo corre de día. En cambio, cada
//  10 minutos preguntamos "¿ya toca y aún no lo mando?", y anotamos en
//  un archivo cuándo se mandó. Es el mismo truco de zabbixService.
// ============================================================

import fs from 'node:fs';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { avisarAlertaMonitoreo } from '../whatsapp/notifier.js';
import { semanaText } from '../whatsapp/commands.js';
import { getSupports } from './statsService.js';

const ARCHIVO_ESTADO = '.resumen-semanal.json';
const REVISAR_CADA_MS = 10 * 60 * 1000;

/** Fecha local como texto AAAA-MM-DD (sirve de "nombre" de la semana). */
function clave(fecha: Date): string {
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return `${fecha.getFullYear()}-${m}-${d}`;
}

/** El momento de esta semana en que toca publicar (p. ej. lunes 09:00). */
function momentoDeEstaSemana(ahora: Date): Date {
  const m = new Date(ahora);
  const atras = (ahora.getDay() - env.RESUMEN_DIA + 7) % 7;
  m.setDate(m.getDate() - atras);
  m.setHours(env.RESUMEN_HORA, 0, 0, 0);
  return m;
}

function leerUltimo(): string | null {
  try {
    return (JSON.parse(fs.readFileSync(ARCHIVO_ESTADO, 'utf8')) as { ultimo?: string }).ultimo ?? null;
  } catch {
    return null; // primera vez, o archivo dañado: se tratará como "no enviado"
  }
}

function guardarUltimo(valor: string): void {
  fs.writeFileSync(ARCHIVO_ESTADO, JSON.stringify({ ultimo: valor }, null, 2));
}

/** Arma el texto: la semana anterior completa + lo que sigue abierto hoy. */
async function armarResumen(momento: Date): Promise<string> {
  // Los 7 días que terminan justo antes del día de publicación.
  const hasta = new Date(momento);
  hasta.setHours(0, 0, 0, 0);
  hasta.setMilliseconds(-1); // un instante antes de medianoche: domingo 23:59:59
  const desde = new Date(hasta);
  desde.setDate(desde.getDate() - 6);
  desde.setHours(0, 0, 0, 0);

  const semana = await semanaText(null, { desde, hasta });

  // Lo pendiente importa más que lo ya hecho: con qué arranca la semana.
  const abiertos = (await getSupports()).filter((c) => c.status !== 'completed');
  const pendientes =
    abiertos.length === 0
      ? '✅ No quedan soportes abiertos.'
      : `⏳ *Siguen abiertos:* ${abiertos.length}\n` +
        abiertos
          .slice(0, 10)
          .map((c) => `  • ${c.ticketNumber ?? ''} ${c.summary.slice(0, 60)} — ${c.assignedTo ?? 'sin asignar'}`)
          .join('\n') +
        (abiertos.length > 10 ? `\n  _…y ${abiertos.length - 10} más._` : '');

  return `🗓️ *Resumen semanal de soportes*\n\n${semana}\n\n${pendientes}`;
}

async function revisar(): Promise<void> {
  const ahora = new Date();
  const momento = momentoDeEstaSemana(ahora);
  if (ahora < momento) return; // todavía no es la hora
  if (leerUltimo() === clave(momento)) return; // ya se mandó esta semana

  const ok = await avisarAlertaMonitoreo(await armarResumen(momento));
  if (ok) {
    guardarUltimo(clave(momento));
    logger.info('🗓️  Resumen semanal publicado en el grupo interno.');
  } else {
    // No se anota: en la siguiente vuelta lo vuelve a intentar.
    logger.warn('🗓️  Resumen semanal NO se pudo publicar; se reintenta en 10 min.');
  }
}

/** Arranca el reloj del resumen. Si RESUMEN_SEMANAL=false, no hace nada. */
export function iniciarResumenSemanal(): void {
  if (!env.RESUMEN_SEMANAL) {
    logger.info('🗓️  Resumen semanal apagado (RESUMEN_SEMANAL=false).');
    return;
  }

  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  logger.info(`🗓️  Resumen semanal: cada ${dias[env.RESUMEN_DIA]} desde las ${env.RESUMEN_HORA}:00.`);

  const vuelta = (): void => {
    revisar().catch((err) => logger.warn(`🗓️  Resumen semanal: ${(err as Error).message}`));
  };

  setTimeout(vuelta, 60_000); // damos tiempo a que WhatsApp conecte
  setInterval(vuelta, REVISAR_CADA_MS);
}
