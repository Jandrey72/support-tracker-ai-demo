// ============================================================
//  "Esto ya pasó antes"
//
//  Cuando entra un soporte, buscamos tickets YA CERRADOS que se le
//  parezcan, para que el técnico vea cómo se resolvió la vez pasada.
//  Es una base de conocimiento que se arma sola, sin escribir manuales.
//
//  Cómo se decide que dos soportes "se parecen" (sin IA, a propósito:
//  es gratis, instantáneo y no gasta llamadas de Groq):
//   1. Se limpian los textos: minúsculas, sin acentos, sin palabras
//      vacías ("el", "para", "favor"...).
//   2. Se cuentan las palabras que comparten.
//   3. Suben puntos si es la misma categoría y la misma empresa.
// ============================================================

import { prisma } from '../db/client.js';
import { companyForGroup } from '../config/companies.js';

/** Palabras que aparecen en todo y no dicen nada del problema. */
const PALABRAS_VACIAS = new Set([
  'para', 'como', 'esta', 'este', 'esto', 'estos', 'estas', 'pero', 'porque', 'cuando',
  'donde', 'desde', 'hasta', 'sobre', 'entre', 'tiene', 'tienen', 'tenia', 'hace', 'hacer',
  'puede', 'pueden', 'favor', 'apoyo', 'ayuda', 'ayudan', 'buen', 'buenas', 'buenos', 'dias',
  'tardes', 'noches', 'gracias', 'saludos', 'cliente', 'usuario', 'solicita', 'solicito',
  'reporta', 'reportan', 'indica', 'menciona', 'soporte', 'problema', 'problemas', 'caso',
  'equipo', 'favor', 'ahora', 'todavia', 'sigue', 'siguen', 'tambien', 'mismo', 'misma',
  'algun', 'alguna', 'nada', 'todo', 'todos', 'toda', 'todas', 'otro', 'otra', 'otros',
  'muy', 'mas', 'menos', 'ya', 'aun', 'solo', 'sus', 'les', 'nos', 'que', 'con', 'por',
  'una', 'uno', 'unos', 'unas', 'del', 'los', 'las', 'the', 'fue', 'son', 'ser', 'hay',
  'realizo', 'realiza', 'revisar', 'revisa', 'reviso', 'tecnico',
]);

/** Texto → conjunto de palabras que sí dicen algo. */
export function palabrasClave(texto: string | null | undefined): Set<string> {
  if (!texto) return new Set();
  const limpio = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos: "impresión" → "impresion"
    .replace(/[^a-z0-9ñ\s]/g, ' ');
  return new Set(
    limpio
      .split(/\s+/)
      // 3 letras dejan pasar siglas útiles (vpn, dns, ups, nas, ip se queda fuera).
      .filter((p) => p.length >= 3 && !PALABRAS_VACIAS.has(p)),
  );
}

export interface Parecido {
  id: string;
  ticketNumber: string | null;
  summary: string;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  empresa: string;
  categoria: string | null;
  /** 0 a 1: qué tanto se parece. */
  puntaje: number;
  /** Palabras que tienen en común (para explicar POR QUÉ se sugiere). */
  enComun: string[];
}

/**
 * Tickets cerrados parecidos a un caso.
 * @param caseId el caso nuevo (se excluye a sí mismo)
 */
export async function buscarParecidos(caseId: string, limite = 3): Promise<Parecido[]> {
  const caso = await prisma.supportCase.findUnique({
    where: { id: caseId },
    select: {
      summary: true,
      categoryId: true,
      createdAt: true,
      group: { select: { name: true } },
    },
  });
  if (!caso) return [];

  const clave = palabrasClave(caso.summary);
  if (clave.size === 0) return [];
  const empresa = companyForGroup(caso.group?.name);

  // Solo lo ANTERIOR al caso (es "ya pasó antes", no "pasó después") y
  // del último año: una solución de hace 3 años probablemente ya no aplica
  // (otro equipo, otra versión, otra red).
  const haceUnAnio = new Date(caso.createdAt.getTime() - 365 * 86_400_000);
  const candidatos = await prisma.supportCase.findMany({
    where: {
      id: { not: caseId },
      status: 'completed',
      deletedAt: null,
      createdAt: { gte: haceUnAnio, lt: caso.createdAt },
    },
    select: {
      id: true,
      ticketNumber: true,
      summary: true,
      resolutionNote: true,
      resolvedAt: true,
      categoryId: true,
      category: { select: { name: true } },
      group: { select: { name: true } },
    },
  });

  const resultados: Parecido[] = [];
  for (const c of candidatos) {
    const suyas = palabrasClave(`${c.summary} ${c.resolutionNote ?? ''}`);
    const enComun = [...clave].filter((p) => suyas.has(p));
    // Una sola palabra en común es casualidad ("impresora" sale en todo).
    if (enComun.length < 2) continue;

    let puntaje = enComun.length / Math.min(clave.size, suyas.size);
    const mismaEmpresa = companyForGroup(c.group?.name) === empresa;
    if (caso.categoryId && c.categoryId === caso.categoryId) puntaje += 0.2;
    if (mismaEmpresa) puntaje += 0.1;
    // Un ticket que dice CÓMO se resolvió vale más que uno que no.
    if (c.resolutionNote) puntaje += 0.1;

    resultados.push({
      id: c.id,
      ticketNumber: c.ticketNumber,
      summary: c.summary,
      resolutionNote: c.resolutionNote,
      resolvedAt: c.resolvedAt,
      empresa: companyForGroup(c.group?.name),
      categoria: c.category?.name ?? null,
      puntaje: Math.min(1, puntaje),
      enComun,
    });
  }

  return resultados
    .filter((r) => r.puntaje >= 0.35)
    .sort((a, b) => b.puntaje - a.puntaje)
    .slice(0, limite);
}

/** Los parecidos en texto de WhatsApp (vacío si no hay ninguno). */
export function parecidosTexto(lista: Parecido[]): string {
  if (lista.length === 0) return '';
  const lineas = lista.map((p) => {
    const n = p.ticketNumber?.replace('TKT-', '').replace(/^0+/, '') ?? '';
    const como = p.resolutionNote
      ? `\n     🔧 ${p.resolutionNote.slice(0, 140)}`
      : '';
    return `  • *${p.ticketNumber ?? 's/n'}* (${p.empresa}) ${p.summary.slice(0, 90)}${como}\n     ↪ \`/ticket ${n}\``;
  });
  return `💡 *Esto ya pasó antes:*\n${lineas.join('\n')}`;
}
