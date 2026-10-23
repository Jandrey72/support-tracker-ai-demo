import { prisma } from '../db/client.js';
import { env } from '../config/env.js';
import type { AIAnalysisResult } from '../domain/types.js';
import { nextTicketNumber } from './ticketNumber.js';
import { elegirTecnico } from './assignmentService.js';
import { notificarAsignacion } from '../whatsapp/notifier.js';
import { companyForGroup } from '../config/companies.js';
import { normalizarCategoria } from '../ai/prompt.js';
import { avisarAlEquipo } from './availabilityService.js';
import { SOPORTE_SIN_NADIE, frase } from '../config/frasesAusencia.js';
import { palabrasClave } from './parecidosService.js';

/**
 * Ventanas para decidir si un mensaje continúa un caso ya abierto.
 *
 * Antes era una sola de 6 h contra CUALQUIER caso abierto del grupo, y eso
 * metía problemas distintos en el mismo ticket. Ahora:
 *  - misma categoría → se permite una ventana amplia (es el mismo tema);
 *  - categoría distinta o desconocida → ventana corta (probablemente
 *    es la misma conversación, pero no arrastramos cosas ajenas).
 */
const VENTANA_MISMA_CATEGORIA_MS = 4 * 60 * 60 * 1000; // 4 horas
const VENTANA_CORTA_MS = 45 * 60 * 1000; // 45 minutos

/** Orden del ciclo de vida: nunca se retrocede solo. */
const ORDEN_ESTADO: Record<string, number> = {
  open: 0,
  in_progress: 1,
  completed: 2,
};

/**
 * Decide el estado nuevo. La IA puede AVANZAR el caso (abierto →
 * en progreso → completado), pero nunca regresarlo: si una persona ya lo
 * movió, un mensaje suelto no debe echar atrás ese avance.
 */
function avanzarEstado(actual: string, propuesto: string): string {
  const a = ORDEN_ESTADO[actual] ?? 0;
  const p = ORDEN_ESTADO[propuesto] ?? 0;
  return p > a ? propuesto : actual;
}

/**
 * Busca el caso en curso al que pertenece este mensaje.
 * Devuelve null si conviene abrir uno nuevo.
 */
async function buscarCasoEnCurso(groupDbId: string, categoryId: string | null) {
  const ahora = Date.now();

  // 1) Mismo tema (misma categoría): es la continuación natural.
  if (categoryId) {
    const mismoTema = await prisma.supportCase.findFirst({
      where: {
        groupId: groupDbId,
        categoryId,
        status: { not: 'completed' },
        deletedAt: null,
        updatedAt: { gte: new Date(ahora - VENTANA_MISMA_CATEGORIA_MS) },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (mismoTema) return mismoTema;
  }

  // 2) Conversación inmediata. Solo si NO choca de categoría: un problema
  //    de Redes no debe caer dentro de un ticket de Impresoras aunque
  //    hayan ocurrido con minutos de diferencia.
  const reciente = await prisma.supportCase.findFirst({
    where: {
      groupId: groupDbId,
      status: { not: 'completed' },
      deletedAt: null,
      updatedAt: { gte: new Date(ahora - VENTANA_CORTA_MS) },
      // Si el mensaje trae categoría, el caso reciente debe tener la misma
      // o ninguna. Si no trae, se acepta cualquiera.
      ...(categoryId ? { OR: [{ categoryId }, { categoryId: null }] } : {}),
    },
    orderBy: { updatedAt: 'desc' },
  });

  return reciente;
}

/** Hasta cuántos días atrás buscamos un ticket abierto que diga lo mismo. */
const VENTANA_PARECIDO_MS = 3 * 24 * 60 * 60 * 1000; // 3 días

/**
 * Última red antes de abrir un ticket nuevo: ¿este grupo ya tiene uno
 * ABIERTO que hable de lo mismo?
 *
 * Atrapa lo que las ventanas no ven: "sigue sin imprimir" al día siguiente
 * (pasaron más de 4 h), o la IA le puso otra categoría al segundo mensaje
 * (Redes vs VPN/Firewall). Compara palabras del resumen, igual que "esto ya
 * pasó antes" (parecidosService), pero contra los ABIERTOS de este grupo.
 */
async function buscarAbiertoParecido(groupDbId: string, summary?: string | null) {
  const clave = palabrasClave(summary);
  // Con menos de 2 palabras útiles no hay con qué comparar.
  if (clave.size < 2) return null;

  const abiertos = await prisma.supportCase.findMany({
    where: {
      groupId: groupDbId,
      status: { not: 'completed' },
      deletedAt: null,
      updatedAt: { gte: new Date(Date.now() - VENTANA_PARECIDO_MS) },
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });

  let mejor: (typeof abiertos)[number] | null = null;
  let mejorPuntaje = 0;
  for (const caso of abiertos) {
    const suyas = palabrasClave(caso.summary);
    const enComun = [...clave].filter((p) => suyas.has(p)).length;
    // Más estricto que "esto ya pasó antes": aquí un error MEZCLA dos
    // problemas en un ticket, así que pedimos 2+ palabras y que compartan
    // al menos la mitad de las del texto más corto.
    if (enComun < 2) continue;
    const puntaje = enComun / Math.min(clave.size, suyas.size);
    if (puntaje >= 0.5 && puntaje > mejorPuntaje) {
      mejor = caso;
      mejorPuntaje = puntaje;
    }
  }
  return mejor;
}

/**
 * Caso en curso para un mensaje del EQUIPO técnico.
 *
 * Un técnico responde, no pide soporte: "me ayuda reiniciando el iPad"
 * abrió un ticket aparte (la IA lo clasificó como Hardware y el caso real
 * era de Redes). Por eso aquí NO se mira la categoría: el mensaje se suma
 * al último caso abierto del grupo dentro de la ventana amplia, o a nada.
 */
async function buscarCasoParaTecnico(groupDbId: string) {
  return prisma.supportCase.findFirst({
    where: {
      groupId: groupDbId,
      status: { not: 'completed' },
      deletedAt: null,
      updatedAt: { gte: new Date(Date.now() - VENTANA_MISMA_CATEGORIA_MS) },
    },
    orderBy: { updatedAt: 'desc' },
  });
}

/** Crea la categoria si no existe y devuelve su id (o null). */
async function upsertCategory(nombreIA?: string | null): Promise<string | null> {
  const name = normalizarCategoria(nombreIA);
  if (!name) return null;
  const category = await prisma.supportCategory.upsert({
    where: { name },
    update: {},
    create: { name },
  });
  return category.id;
}

export interface ProcessArgs {
  messageDbId: string;
  groupDbId: string;
  result: AIAnalysisResult;
  /** Numero de WhatsApp de quien escribe; se usa como identificador del cliente. */
  clientNumber?: string | null;
  /** Nombre del tecnico de Mi Empresa que escribio (si aplica). */
  technicianName?: string | null;
  provider: string;
  model: string;
  /** Quien escribe es del equipo Mi Empresa: puede sumarse a un caso, nunca abrirlo. */
  isTech: boolean;
}

export interface ProcessResult {
  qualifies: boolean;
  supportCaseId: string | null;
  action: 'created' | 'updated' | 'none';
  /** Número legible del ticket (TKT-0042), para avisarlo en el grupo. */
  ticketNumber: string | null;
  /** Técnico responsable, para nombrarlo en el aviso del grupo interno. */
  assignedTo: string | null;
}

/**
 * Convierte un analisis de la IA en un caso de soporte:
 * - Si es soporte y supera la confianza minima, crea o actualiza un SupportCase.
 * - Enlaza el mensaje al caso.
 * - Siempre guarda el AIAnalysis (auditoria/trazabilidad).
 */
export async function processAnalysis(
  args: ProcessArgs,
): Promise<ProcessResult> {
  const { messageDbId, groupDbId, result, clientNumber, technicianName, provider, model, isTech } =
    args;

  // El cliente es el numero de WhatsApp de quien escribe (si esta disponible);
  // si no, caemos al nombre que haya podido identificar la IA.
  const clientValue = clientNumber ?? result.client ?? null;

  // El tecnico es quien del equipo escribio (identificado por numero);
  // si no, el que haya podido identificar la IA por el texto.
  const technicianValue = technicianName ?? result.technician ?? null;

  const qualifies = result.isSupport && result.confidence >= env.MIN_CONFIDENCE;
  let supportCaseId: string | null = null;
  let action: ProcessResult['action'] = 'none';
  let ticketNumber: string | null = null;
  let assignedTo: string | null = null;

  if (qualifies) {
    const categoryId = await upsertCategory(result.category);
    const propuesto = result.status ?? 'open';

    // ¿Es continuación de un caso que ya está en curso en este grupo?
    const existing = isTech
      ? await buscarCasoParaTecnico(groupDbId)
      : (await buscarCasoEnCurso(groupDbId, categoryId)) ??
        (await buscarAbiertoParecido(groupDbId, result.summary));

    if (existing && isTech) {
      // El técnico deja constancia de que atendió (y puede avanzar el
      // estado), pero su mensaje NO reescribe el resumen ni la categoría:
      // "me ayuda reiniciando" no es el problema, es parte de la solución.
      const estado = existing.manualEditAt
        ? existing.status
        : avanzarEstado(existing.status, propuesto);
      const updated = await prisma.supportCase.update({
        where: { id: existing.id },
        data: {
          technician: technicianValue ?? existing.technician,
          status: estado,
          confidence: Math.max(existing.confidence, result.confidence),
          resolvedAt:
            estado === 'completed' ? (existing.resolvedAt ?? new Date()) : existing.resolvedAt,
        },
      });
      supportCaseId = updated.id;
      ticketNumber = updated.ticketNumber;
      assignedTo = updated.assignedTo;
      action = 'updated';
    } else if (isTech) {
      // Técnico sin caso abierto: no se inventa un ticket. Si de verdad era
      // un soporte (p. ej. lo pidieron por teléfono), se da de alta a mano.
      action = 'none';
    } else if (existing) {
      const bloqueado = existing.manualEditAt !== null;
      const estado = avanzarEstado(existing.status, propuesto);

      const updated = await prisma.supportCase.update({
        where: { id: existing.id },
        data: bloqueado
          ? {
              // Alguien lo editó a mano: la IA NO pisa su trabajo.
              // Solo dejamos constancia de que hubo más movimiento.
              confidence: Math.max(existing.confidence, result.confidence),
            }
          : {
              // El cliente original manda; solo lo llenamos si estaba vacío.
              client: existing.client ?? clientValue,
              // Quién actuó por última vez (NO cambia al responsable).
              technician: technicianValue ?? existing.technician,
              summary: result.summary ?? existing.summary,
              categoryId: categoryId ?? existing.categoryId,
              status: estado,
              confidence: Math.max(existing.confidence, result.confidence),
              resolvedAt:
                estado === 'completed' ? (existing.resolvedAt ?? new Date()) : null,
            },
      });
      supportCaseId = updated.id;
      ticketNumber = updated.ticketNumber;
      assignedTo = updated.assignedTo;
      action = 'updated';
    } else {
      // Caso nuevo: se le asigna responsable. Si un técnico ya está
      // atendiendo, se queda con él; si no, al que traiga menos carga.
      const responsable = await elegirTecnico(technicianValue);

      const created = await prisma.supportCase.create({
        data: {
          groupId: groupDbId,
          client: clientValue,
          technician: technicianValue,
          assignedTo: responsable?.name ?? null,
          summary: result.summary ?? 'Soporte detectado',
          categoryId,
          status: propuesto,
          confidence: result.confidence,
          resolvedAt: propuesto === 'completed' ? new Date() : null,
          ticketNumber: await nextTicketNumber(),
        },
        include: { group: true },
      });
      supportCaseId = created.id;
      ticketNumber = created.ticketNumber;
      assignedTo = created.assignedTo;

      // Nadie disponible: el ticket queda sin dueño y el equipo se entera.
      if (!responsable && created.status !== 'completed') {
        void avisarAlEquipo(
          `${frase(SOPORTE_SIN_NADIE, { ausente: '' })}\n\n` +
            `🎫 *${created.ticketNumber}* · ${companyForGroup(created.group.name)}\n` +
            `_${created.summary}_`,
        );
      }

      // Avisarle por privado al que le tocó (sin frenar el flujo si falla).
      if (responsable && created.status !== 'completed') {
        void notificarAsignacion({
          supportCaseId: created.id,
          ticketNumber: created.ticketNumber,
          assignedTo: responsable.name,
          client: created.client,
          company: companyForGroup(created.group.name),
          summary: created.summary,
          severity: created.severity,
        });
      }
      action = 'created';
    }

    // Enlazamos el mensaje al caso (evidencia).
    if (supportCaseId) {
      await prisma.message.update({
        where: { id: messageDbId },
        data: { supportCaseId },
      });
    }
  }

  // Auditoria: guardamos SIEMPRE el analisis (haya sido soporte o no).
  await prisma.aIAnalysis.upsert({
    where: { messageId: messageDbId },
    update: {},
    create: {
      messageId: messageDbId,
      supportCaseId,
      provider,
      model,
      isSupport: result.isSupport,
      confidence: result.confidence,
      rawResponse: JSON.stringify(result),
    },
  });

  return { qualifies, supportCaseId, action, ticketNumber, assignedTo };
}
