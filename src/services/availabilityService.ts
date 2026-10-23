// ============================================================
//  Disponibilidad del equipo de soporte
//
//  Problema que resuelve: si Luis sale a sitio, el reparto le seguía
//  asignando tickets que nadie estaba viendo. Ahora cada quien puede
//  decir "no estoy" y el bot reparte solo entre los que sí están.
//
//  El estado vive en la BASE (tabla TechnicianStatus), no en memoria:
//  si el bot se reinicia, nadie "regresa" solo por accidente.
// ============================================================

import { prisma } from '../db/client.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { avisarPrivado, avisarAlertaMonitoreo } from '../whatsapp/notifier.js';
import {
  tecnicosEnSoporte,
  findTechnicianByName,
  type Technician,
} from '../config/technicians.js';

export interface EstadoTecnico {
  name: string;
  disponible: boolean;
  motivo: string | null;
  desde: Date | null;
}

/**
 * Estado de TODO el equipo de soporte.
 * Quien no tenga renglón en la tabla se considera disponible: así el
 * bot funciona igual que siempre hasta que alguien se marque ausente.
 */
export async function estadoDelEquipo(): Promise<EstadoTecnico[]> {
  const filas = await prisma.technicianStatus.findMany();
  const porNombre = new Map(filas.map((f) => [f.name, f]));

  return tecnicosEnSoporte().map((t) => {
    const fila = porNombre.get(t.name);
    return {
      name: t.name,
      disponible: fila?.disponible ?? true,
      motivo: fila?.motivo ?? null,
      desde: fila?.desde ?? null,
    };
  });
}

/** Los que SÍ están disponibles ahora mismo (para el reparto). */
export async function tecnicosDisponibles(): Promise<Technician[]> {
  const estado = await estadoDelEquipo();
  const fuera = new Set(estado.filter((e) => !e.disponible).map((e) => e.name));
  return tecnicosEnSoporte().filter((t) => !fuera.has(t.name));
}

/** ¿Está disponible este técnico? (nombre tal como está en el catálogo) */
export async function estaDisponible(name: string | null | undefined): Promise<boolean> {
  if (!name) return false;
  const fila = await prisma.technicianStatus.findUnique({ where: { name } });
  return fila?.disponible ?? true;
}

/**
 * Marca a alguien como ausente o disponible.
 * Devuelve null si el nombre no está en el catálogo del equipo.
 */
export async function marcarDisponibilidad(
  nombre: string,
  disponible: boolean,
  motivo?: string | null,
): Promise<EstadoTecnico | null> {
  const tecnico = findTechnicianByName(nombre);
  if (!tecnico) return null;

  const fila = await prisma.technicianStatus.upsert({
    where: { name: tecnico.name },
    update: { disponible, motivo: disponible ? null : (motivo ?? null), desde: new Date(), avisadoAt: null },
    create: { name: tecnico.name, disponible, motivo: disponible ? null : (motivo ?? null) },
  });

  logger.info(
    `👤 ${tecnico.name} ahora está ${disponible ? 'DISPONIBLE' : 'AUSENTE'}` +
      (fila.motivo ? ` (${fila.motivo})` : ''),
  );

  return {
    name: fila.name,
    disponible: fila.disponible,
    motivo: fila.motivo,
    desde: fila.desde,
  };
}

/**
 * Avisa del cambio de disponibilidad a donde diga AVISO_AUSENCIA.
 *
 * Por defecto va por PRIVADO a los otros técnicos: que alguien salga a
 * comer es asunto del equipo de soporte, no del grupo interno completo.
 *
 * @param excepto Nombre de quien hizo el cambio (a él no se le avisa).
 */
export async function avisarAlEquipo(texto: string, excepto?: string | null): Promise<void> {
  if (env.AVISO_AUSENCIA === 'off') return;

  if (env.AVISO_AUSENCIA === 'grupo') {
    await avisarAlertaMonitoreo(texto);
    return;
  }

  for (const t of tecnicosEnSoporte()) {
    if (excepto && t.name === excepto) continue;
    await avisarPrivado(t, texto);
  }
}

/** Los compañeros a los que se les avisaría (para decir "ya le avisé a X"). */
export function companeros(excepto?: string | null): string[] {
  return tecnicosEnSoporte()
    .filter((t) => !excepto || t.name !== excepto)
    .map((t) => t.name);
}

/** Texto corto de cuánto lleva fuera: "2 h 15 min". */
export function desdeHace(desde: Date | null): string {
  if (!desde) return '';
  const min = Math.floor((Date.now() - desde.getTime()) / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

// ------------------------------------------------------------
//  Recordatorio: "oye, sigues marcado como ausente"
//
//  El olvido clásico es salir el viernes y volver el lunes sin quitarlo:
//  el compañero carga con todo el fin de semana. Cada media hora se revisa
//  quién lleva demasiado tiempo fuera y se le manda UN privado; `avisadoAt`
//  evita que se convierta en spam.
// ------------------------------------------------------------

const REVISAR_CADA_MS = 30 * 60 * 1000;

/**
 * ¿Es horario de silencio? Soporta que cruce la medianoche (21 → 8).
 * Si DESDE y HASTA son iguales, no hay silencio.
 */
export function enSilencio(hora: number, desde: number, hasta: number): boolean {
  if (desde === hasta) return false;
  return desde < hasta ? hora >= desde && hora < hasta : hora >= desde || hora < hasta;
}

async function revisarAusencias(): Promise<void> {
  const horas = env.AUSENCIA_RECORDATORIO_HORAS;
  if (horas <= 0) return;

  // De noche no se manda nada. Tampoco se apunta como "avisado", así que
  // en la primera vuelta después de las 8:00 sale el recordatorio pendiente.
  if (enSilencio(new Date().getHours(), env.AUSENCIA_SILENCIO_DESDE, env.AUSENCIA_SILENCIO_HASTA)) return;

  const limite = new Date(Date.now() - horas * 60 * 60 * 1000);
  const ausentes = await prisma.technicianStatus.findMany({
    where: {
      disponible: false,
      desde: { lte: limite },
      OR: [{ avisadoAt: null }, { avisadoAt: { lte: limite } }],
    },
  });

  for (const a of ausentes) {
    const tecnico = findTechnicianByName(a.name);
    if (!tecnico) continue;

    const ok = await avisarPrivado(
      tecnico,
      `👋 Oye ${a.name}, sigues marcado como *ausente* desde hace ${desdeHace(a.desde)}` +
        `${a.motivo ? ` (${a.motivo})` : ''}.\n\n` +
        'Si ya estás de vuelta, manda `/disponible` en el grupo interno para que te ' +
        'vuelvan a llegar soportes. Si sigues fuera, ignora este mensaje 🙂',
    );

    // Se anota aunque no se haya podido enviar: si el bot está caído o es su
    // propio número, no tiene caso reintentar cada media hora.
    await prisma.technicianStatus.update({
      where: { name: a.name },
      data: { avisadoAt: new Date() },
    });
    if (ok) logger.info(`👤 Recordatorio de ausencia enviado a ${a.name}.`);
  }
}

/** Arranca el recordatorio de ausencias. */
export function iniciarRecordatorioAusencias(): void {
  if (env.AUSENCIA_RECORDATORIO_HORAS <= 0) {
    logger.info('👤 Recordatorio de ausencias apagado (AUSENCIA_RECORDATORIO_HORAS=0).');
    return;
  }
  logger.info(
    `👤 Recordatorio de ausencias: aviso por privado tras ${env.AUSENCIA_RECORDATORIO_HORAS} h fuera ` +
      `(en silencio de ${env.AUSENCIA_SILENCIO_DESDE}:00 a ${env.AUSENCIA_SILENCIO_HASTA}:00).`,
  );
  const vuelta = (): void => {
    revisarAusencias().catch((err) => logger.warn(`👤 Ausencias: ${(err as Error).message}`));
  };
  setTimeout(vuelta, 120_000);
  setInterval(vuelta, REVISAR_CADA_MS);
}
