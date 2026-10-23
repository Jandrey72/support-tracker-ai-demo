// ============================================================
//  Reparto de soportes entre el equipo
//  Regla: le toca al técnico con MENOS tickets abiertos.
//  Así la carga se equilibra sola, sin llevar turnos a mano.
// ============================================================
import { prisma } from '../db/client.js';
import { tecnicosEnSoporte, type Technician } from '../config/technicians.js';
import { tecnicosDisponibles } from './availabilityService.js';
import { logger } from '../config/logger.js';

/** Cuántos tickets sin cerrar trae cada técnico ahora mismo. */
export async function cargaActual(): Promise<Map<string, number>> {
  const abiertos = await prisma.supportCase.groupBy({
    by: ['assignedTo'],
    where: {
      deletedAt: null,
      status: { not: 'completed' },
      assignedTo: { not: null },
    },
    _count: { _all: true },
  });

  const carga = new Map<string, number>();
  for (const t of tecnicosEnSoporte()) carga.set(t.name, 0);
  for (const fila of abiertos) {
    if (fila.assignedTo) carga.set(fila.assignedTo, fila._count._all);
  }
  return carga;
}

/**
 * Elige a quién le toca el siguiente soporte.
 *
 * @param preferido Si un técnico ya está atendiendo (escribió en el grupo),
 *                  se le deja a él: quien ya le entró es el dueño natural.
 */
export async function elegirTecnico(preferido?: string | null): Promise<Technician | null> {
  // Solo entran al reparto los que están disponibles: quien salió a sitio
  // no debe recibir tickets que no va a ver.
  const candidatos = await tecnicosDisponibles();
  if (candidatos.length === 0) {
    logger.warn('Reparto → nadie disponible: el ticket queda SIN ASIGNAR.');
    return null;
  }

  // Si quien está atendiendo es del equipo de soporte, se queda con el ticket.
  if (preferido) {
    const suyo = candidatos.find(
      (t) => t.name.toLowerCase() === preferido.trim().toLowerCase(),
    );
    if (suyo) return suyo;
  }

  const carga = await cargaActual();

  // El menos cargado. Si empatan, el primero de la lista (orden estable).
  let elegido = candidatos[0];
  let menor = carga.get(elegido.name) ?? 0;
  for (const t of candidatos.slice(1)) {
    const n = carga.get(t.name) ?? 0;
    if (n < menor) {
      elegido = t;
      menor = n;
    }
  }

  logger.debug(
    `Reparto → ${elegido.name} (${menor} abiertos). Carga: ` +
      [...carga.entries()].map(([n, c]) => `${n}=${c}`).join(', '),
  );
  return elegido;
}
