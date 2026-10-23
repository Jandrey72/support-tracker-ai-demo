// ============================================================
//  Reloj reutilizable para tareas que corren a cierta hora.
//
//  Es el mismo truco del resumen semanal (resumenService.ts), sacado a
//  una sola pieza para no copiarlo en cada tarea nueva:
//
//    Cada 10 minutos preguntamos "¿ya toca y aún no lo hice?".
//    Cuando se hace, anotamos en un archivo QUÉ vuelta se hizo
//    (p. ej. "2026-09-23" o "2026-09"). Así un reinicio del bot no la
//    repite ni la corre de horario, como pasaría con un setInterval.
//
//  Si la tarea devuelve false (p. ej. WhatsApp no estaba conectado) NO se
//  anota, y en la siguiente vuelta se reintenta sola.
// ============================================================

import fs from 'node:fs';
import { logger } from '../config/logger.js';

const REVISAR_CADA_MS = 10 * 60 * 1000;

export interface TareaProgramada {
  /** Nombre para el log. */
  nombre: string;
  /** Archivo donde se apunta la última vuelta hecha (en la raíz del proyecto). */
  archivoEstado: string;
  /**
   * Dada la hora actual, devuelve la "vuelta" que toca (su nombre, único),
   * o null si todavía no es hora / hoy no toca.
   */
  vueltaPendiente: (ahora: Date) => string | null;
  /** El trabajo. Devuelve true si salió bien (y entonces se anota). */
  ejecutar: (vuelta: string, ahora: Date) => Promise<boolean>;
}

function leerUltima(archivo: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(archivo, 'utf8')) as { ultimo?: string }).ultimo ?? null;
  } catch {
    return null; // primera vez, o archivo dañado: se trata como "no hecho"
  }
}

function guardarUltima(archivo: string, valor: string): void {
  fs.writeFileSync(archivo, JSON.stringify({ ultimo: valor }, null, 2));
}

/** Fecha local como AAAA-MM-DD. */
export function claveDia(fecha: Date): string {
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return `${fecha.getFullYear()}-${m}-${d}`;
}

/** Revisa UNA vez si toca, y si toca lo hace. Exportada para poder probarla. */
export async function revisarTarea(t: TareaProgramada, ahora = new Date()): Promise<void> {
  const vuelta = t.vueltaPendiente(ahora);
  if (!vuelta) return;
  if (leerUltima(t.archivoEstado) === vuelta) return; // ya se hizo

  const ok = await t.ejecutar(vuelta, ahora);
  if (ok) {
    guardarUltima(t.archivoEstado, vuelta);
    logger.info(`⏰ ${t.nombre}: hecho (${vuelta}).`);
  } else {
    logger.warn(`⏰ ${t.nombre}: no se pudo (${vuelta}); se reintenta en 10 min.`);
  }
}

/** Arranca el reloj de una tarea. */
export function programarTarea(t: TareaProgramada): void {
  const vuelta = (): void => {
    revisarTarea(t).catch((err) => logger.warn(`⏰ ${t.nombre}: ${(err as Error).message}`));
  };
  setTimeout(vuelta, 90_000); // damos tiempo a que WhatsApp conecte
  setInterval(vuelta, REVISAR_CADA_MS);
}
