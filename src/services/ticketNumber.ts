// ============================================================
//  Números de ticket: TKT-0001, TKT-0042, TKT-0405...
//  Sencillos y corridos, para poder dictarlos o escribirlos
//  rápido en WhatsApp:  /ticket 42
// ============================================================
import { prisma } from '../db/client.js';

/** Convierte "42", "0042" o "TKT-0042" al formato oficial "TKT-0042". */
export function normalizarTicket(texto: string): string | null {
  const limpio = texto.trim().toUpperCase().replace(/^#/, '');
  const m = limpio.match(/^(?:TKT-)?(\d{1,6})$/);
  if (!m) return null;
  return `TKT-${m[1].padStart(4, '0')}`;
}

/** ¿Este texto parece un número de ticket? */
export function pareceTicket(texto: string): boolean {
  return normalizarTicket(texto) !== null;
}

/**
 * Siguiente número libre.
 *
 * OJO: no contamos cuántos registros hay (eso repetía números si borrabas
 * alguno para siempre). Tomamos el MÁS ALTO que existe y le sumamos uno.
 * Como todos llevan 4 dígitos con ceros al inicio, ordenar como texto
 * da el mismo resultado que ordenar como número.
 */
export async function nextTicketNumber(): Promise<string> {
  const ultimo = await prisma.supportCase.findFirst({
    where: { ticketNumber: { startsWith: 'TKT-' } },
    orderBy: { ticketNumber: 'desc' },
    select: { ticketNumber: true },
  });

  const n = ultimo?.ticketNumber
    ? parseInt(ultimo.ticketNumber.replace('TKT-', ''), 10)
    : 0;

  return `TKT-${String((Number.isNaN(n) ? 0 : n) + 1).padStart(4, '0')}`;
}
