// ============================================================
//  Cerrar tickets desde WhatsApp
//
//  El técnico ya recibe por privado "🎫 Se te asignó TKT-0042". Ahora
//  puede RESPONDER a ese mismo mensaje con "terminado, se cambió el
//  tóner" y el ticket queda completado con su nota de solución.
//
//  Aquí vive solo la lógica (base de datos). Lo que se lee y se contesta
//  por WhatsApp está en whatsapp/cierrePrivado.ts y en el comando /cerrar.
// ============================================================

import { prisma } from '../db/client.js';

/**
 * Palabras con las que un técnico avisa que acabó. Van al INICIO del
 * mensaje: "terminado", "listo, era el cable", "ya quedó".
 * Se compara sin acentos, así que "quedo" y "quedó" valen igual.
 */
const PALABRAS_CIERRE =
  /^(?:ya\s+)?(terminad[oa]|termine|listo|lista|resuelto|resuelta|solucionado|cerrad[oa]|completad[oa]|quedo|hecho)\b/;

function sinAcentos(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export interface Cierre {
  /** El número de ticket que venía en el texto ("terminado 42"), si venía. */
  numero: string | null;
  /** Lo que escribió después de la palabra: la nota de cómo se resolvió. */
  nota: string | null;
}

/**
 * ¿Este texto es un aviso de "ya terminé"? Devuelve null si no lo es.
 *   "terminado"                     → { numero: null, nota: null }
 *   "listo, se cambió el tóner"     → { numero: null, nota: "se cambió el tóner" }
 *   "terminado 42 era el cable"     → { numero: "42", nota: "era el cable" }
 */
export function leerCierre(texto: string): Cierre | null {
  const limpio = texto.trim();
  const m = sinAcentos(limpio).match(PALABRAS_CIERRE);
  if (!m) return null;

  // Cortamos el texto ORIGINAL (con acentos) a la misma altura.
  let resto = limpio.slice(m[0].length).replace(/^[\s,.:;!-]+/, '');

  // ¿Trae número de ticket enseguida? "42", "#42", "TKT-0042".
  let numero: string | null = null;
  const n = resto.match(/^(?:#|tkt-?)?(\d{1,6})\b/i);
  if (n) {
    numero = n[1];
    resto = resto.slice(n[0].length).replace(/^[\s,.:;!-]+/, '');
  }

  return { numero, nota: resto || null };
}

/** El ticket al que pertenece un aviso que mandó el bot (por su id de WhatsApp). */
export async function casoDeAviso(waMessageId: string | null | undefined) {
  if (!waMessageId) return null;
  const aviso = await prisma.botMessage.findFirst({
    where: { waMessageId },
    select: { supportCaseId: true },
  });
  if (!aviso) return null;
  return prisma.supportCase.findFirst({
    where: { id: aviso.supportCaseId, deletedAt: null },
  });
}

/** Tickets sin cerrar que tiene a su cargo un técnico. */
export async function abiertosDe(responsable: string) {
  return prisma.supportCase.findMany({
    where: { assignedTo: responsable, status: { not: 'completed' }, deletedAt: null },
    orderBy: { startedAt: 'asc' },
    select: { id: true, ticketNumber: true, summary: true },
  });
}

/**
 * Marca un ticket como completado. Lo cierra una PERSONA, así que cuenta
 * como edición manual: la IA ya no le cambia nada después.
 * Si ya traía nota de solución, la nueva se agrega abajo (no se pierde nada).
 */
export async function cerrarTicket(caseId: string, quien: string, nota?: string | null) {
  const caso = await prisma.supportCase.findUniqueOrThrow({ where: { id: caseId } });
  return prisma.supportCase.update({
    where: { id: caseId },
    data: {
      status: 'completed',
      resolvedAt: caso.resolvedAt ?? new Date(),
      technician: quien,
      resolutionNote: unirNotas(caso.resolutionNote, nota),
      manualEditAt: new Date(),
    },
  });
}

/** Nota que llevan los tickets cerrados con /cerrartodos si no se escribe una causa. */
export const NOTA_CIERRE_EN_BLOQUE = 'Cerrado en bloque: ya estaba resuelto.';

/**
 * Los pendientes "de" un técnico, igual que los cuenta /pendientes: los que
 * tiene como responsable, y los viejos (de antes del reparto, sin
 * responsable) donde aparece como técnico.
 */
function whereAbiertosDe(nombre: string) {
  const primerNombre = nombre.split(/\s+/)[0];
  return {
    deletedAt: null,
    status: { not: 'completed' },
    OR: [
      { assignedTo: nombre },
      { assignedTo: null, technician: { contains: primerNombre } },
    ],
  };
}

/** Lo que cerraría /cerrartodos, para enseñarlo antes de confirmar. */
export async function pendientesParaCerrar(nombre: string) {
  return prisma.supportCase.findMany({
    where: whereAbiertosDe(nombre),
    orderBy: { startedAt: 'asc' },
    select: { id: true, ticketNumber: true, summary: true },
  });
}

/**
 * Cierra de un jalón todos los pendientes de un técnico. Para cuando el
 * trabajo se hizo pero nadie le dio /cerrar a cada ticket.
 *
 * A propósito NO toca `technician`: el que atendió el caso se queda como
 * está, si no las estadísticas dirían que todo lo hizo quien mandó el comando.
 * Uno por uno (no updateMany) para no perder la nota que ya tuviera cada uno.
 *
 * La fecha de resolución es la del ÚLTIMO MENSAJE del caso, no la de hoy: el
 * trabajo se hizo entonces, y con "hoy" el tiempo promedio de resolución del
 * reporte se inflaría con los días que el ticket se quedó sin cerrar.
 */
export async function cerrarPendientesDe(nombre: string, nota?: string | null): Promise<number> {
  const causa = nota?.trim() || NOTA_CIERRE_EN_BLOQUE;
  const casos = await prisma.supportCase.findMany({
    where: whereAbiertosDe(nombre),
    select: {
      id: true,
      resolvedAt: true,
      resolutionNote: true,
      messages: { orderBy: { timestamp: 'desc' }, take: 1, select: { timestamp: true } },
    },
  });
  const ahora = new Date();
  await prisma.$transaction(
    casos.map((c) =>
      prisma.supportCase.update({
        where: { id: c.id },
        data: {
          status: 'completed',
          resolvedAt: c.resolvedAt ?? c.messages[0]?.timestamp ?? ahora,
          resolutionNote: unirNotas(c.resolutionNote, causa),
          manualEditAt: ahora,
        },
      }),
    ),
  );
  return casos.length;
}

/** Agrega una nota de solución a un ticket (ya cerrado o no). */
export async function agregarNota(caseId: string, nota: string) {
  const caso = await prisma.supportCase.findUniqueOrThrow({ where: { id: caseId } });
  return prisma.supportCase.update({
    where: { id: caseId },
    data: { resolutionNote: unirNotas(caso.resolutionNote, nota), manualEditAt: new Date() },
  });
}

function unirNotas(vieja: string | null, nueva?: string | null): string | null {
  const n = nueva?.trim();
  if (!n) return vieja;
  return vieja ? `${vieja}\n${n}` : n;
}
