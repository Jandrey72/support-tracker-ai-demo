// ============================================================
//  Resumen diario al grupo interno (lunes a sábado, 9 a. m.)
//
//  El ⚠️ de "se pasó de tiempo" solo lo veía quien abría el dashboard.
//  Este mensaje lo pone enfrente de todo el equipo cada mañana:
//    - qué tiene pendiente cada responsable, lo vencido primero;
//    - qué se movió ayer (nuevos y cerrados);
//    - si un cliente está repitiendo el mismo problema (idea #3).
//
//  El reloj es el de tareaProgramada.ts: sobrevive a reinicios y no
//  manda el resumen dos veces el mismo día.
// ============================================================

import fs from 'node:fs';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { companyForGroup } from '../config/companies.js';
import { avisarAlertaMonitoreo } from '../whatsapp/notifier.js';
import { prisma } from '../db/client.js';
import {
  antiguedad,
  getProblemasRepetidos,
  slaVencido,
  type ProblemaRepetido,
} from './statsService.js';
import { claveDia, programarTarea } from './tareaProgramada.js';

const MAX_POR_PERSONA = 6;

/** Número corto para los comandos: TKT-0042 → 42 */
function corto(ticketNumber: string | null): string {
  return ticketNumber ? ticketNumber.replace('TKT-', '').replace(/^0+/, '') : '?';
}

/** Lo pendiente, agrupado por responsable, con lo vencido primero. */
export async function pendientesText(): Promise<string> {
  const ahora = Date.now();
  const abiertos = await prisma.supportCase.findMany({
    where: { deletedAt: null, status: { not: 'completed' } },
    select: {
      ticketNumber: true,
      summary: true,
      status: true,
      severity: true,
      createdAt: true,
      assignedTo: true,
      technician: true,
      group: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (abiertos.length === 0) return '✅ *No hay soportes pendientes.* ¡Equipo al día!';

  // Por responsable. Los casos viejos sin responsable caen a `technician`.
  const porPersona = new Map<string, typeof abiertos>();
  for (const c of abiertos) {
    const quien = c.assignedTo || c.technician || 'Sin asignar';
    porPersona.set(quien, [...(porPersona.get(quien) ?? []), c]);
  }

  const vencidosTotal = abiertos.filter((c) => slaVencido(c, ahora)).length;
  let t =
    `📌 *Pendientes:* ${abiertos.length}` +
    (vencidosTotal ? `   ⚠️ *${vencidosTotal} fuera de tiempo*` : '   ✅ ninguno vencido') +
    '\n';

  // Primero quien trae más vencidos; "Sin asignar" siempre al final.
  const personas = [...porPersona.entries()].sort(([a, la], [b, lb]) => {
    if (a === 'Sin asignar') return 1;
    if (b === 'Sin asignar') return -1;
    const va = la.filter((c) => slaVencido(c, ahora)).length;
    const vb = lb.filter((c) => slaVencido(c, ahora)).length;
    return vb - va || lb.length - la.length;
  });

  for (const [quien, lista] of personas) {
    const vencidos = lista.filter((c) => slaVencido(c, ahora));
    t += `\n👨‍🔧 *${quien}* — ${lista.length}${vencidos.length ? ` (⚠️ ${vencidos.length})` : ''}\n`;

    const ordenados = [...vencidos, ...lista.filter((c) => !slaVencido(c, ahora))];
    for (const c of ordenados.slice(0, MAX_POR_PERSONA)) {
      const marca = slaVencido(c, ahora) ? '⚠️' : c.status === 'in_progress' ? '🔄' : '🆕';
      const alta = c.severity === 'Alta' ? ' 🔥' : '';
      t +=
        `  ${marca} \`${corto(c.ticketNumber)}\` ${companyForGroup(c.group?.name)} · ` +
        `${c.summary.slice(0, 55)}${c.summary.length > 55 ? '…' : ''} _(${antiguedad(c.createdAt, ahora)})_${alta}\n`;
    }
    if (lista.length > MAX_POR_PERSONA) t += `  _…y ${lista.length - MAX_POR_PERSONA} más._\n`;
  }
  return t.trimEnd();
}

/** Lo que pasó ayer: nuevos y cerrados. */
async function ayerText(hoy: Date): Promise<string> {
  const ini = new Date(hoy);
  ini.setDate(ini.getDate() - 1);
  ini.setHours(0, 0, 0, 0);
  const fin = new Date(hoy);
  fin.setHours(0, 0, 0, 0);

  const [nuevos, cerrados] = await Promise.all([
    prisma.supportCase.count({ where: { deletedAt: null, createdAt: { gte: ini, lt: fin } } }),
    prisma.supportCase.count({ where: { deletedAt: null, resolvedAt: { gte: ini, lt: fin } } }),
  ]);
  return `📅 *Ayer:* ${nuevos} nuevo(s) · ${cerrados} cerrado(s)`;
}

// ------------------------------------------------------------
//  Problemas repetidos (idea #3)
// ------------------------------------------------------------

const ARCHIVO_REPETIDOS = '.repetidos-avisados.json';

/** Lo que ya se avisó: "Empresa|Categoría" → cuántos eran cuando se avisó. */
function leerAvisados(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO_REPETIDOS, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

export function repetidosText(lista: ProblemaRepetido[], titulo: string): string {
  if (lista.length === 0) return '';
  const lineas = lista.map((p) => {
    const sitios = p.sitios.length ? ` · ${p.sitios.slice(0, 3).join(', ')}` : '';
    const tickets = p.tickets.slice(0, 5).map(corto).join(', ');
    return (
      `  • *${p.empresa}* — ${p.categoria}: *${p.total}* en ${env.REPETIDOS_DIAS} días` +
      `${p.abiertos ? ` (${p.abiertos} abiertos)` : ''}${sitios}\n     Tickets: ${tickets}`
    );
  });
  return (
    `${titulo}\n${lineas.join('\n')}\n` +
    '_Si se repite, conviene proponer una solución de fondo._'
  );
}

/**
 * Los repetidos que HAY QUE AVISAR hoy: los nuevos, y los que crecieron
 * otro "bloque" desde el último aviso (3 → 6 → 9…). Así el aviso no sale
 * igual todos los días, pero tampoco se olvida si el problema empeora.
 */
async function repetidosNuevos(): Promise<{ lista: ProblemaRepetido[]; guardar: () => void }> {
  const actuales = await getProblemasRepetidos(env.REPETIDOS_DIAS, env.REPETIDOS_MINIMO);
  const avisados = leerAvisados();

  const lista = actuales.filter((p) => {
    const antes = avisados[`${p.empresa}|${p.categoria}`];
    return antes === undefined || p.total >= antes + env.REPETIDOS_MINIMO;
  });

  const guardar = (): void => {
    // Solo guardamos los que siguen activos: si uno baja del mínimo y luego
    // vuelve a subir, es una racha nueva y se vuelve a avisar.
    const nuevo: Record<string, number> = {};
    for (const p of actuales) {
      const llave = `${p.empresa}|${p.categoria}`;
      nuevo[llave] = lista.includes(p) ? p.total : (avisados[llave] ?? p.total);
    }
    fs.writeFileSync(ARCHIVO_REPETIDOS, JSON.stringify(nuevo, null, 2));
  };
  return { lista, guardar };
}

// ------------------------------------------------------------
//  El mensaje completo y su reloj
// ------------------------------------------------------------

export async function armarResumenDiario(hoy = new Date()): Promise<{ texto: string; guardar: () => void }> {
  const fecha = hoy.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  const repetidos = await repetidosNuevos();
  const bloqueRepetidos = repetidosText(repetidos.lista, '🔁 *Ojo, esto se está repitiendo:*');

  const texto =
    `☀️ *Buenos días — ${fecha}*\n\n` +
    `${await ayerText(hoy)}\n\n` +
    `${await pendientesText()}` +
    (bloqueRepetidos ? `\n\n${bloqueRepetidos}` : '') +
    '\n\n_Detalle de uno: `/ticket 42` · Todo: `/pendientes`_';

  return { texto, guardar: repetidos.guardar };
}

export function iniciarResumenDiario(): void {
  if (!env.RESUMEN_DIARIO) {
    logger.info('☀️  Resumen diario apagado (RESUMEN_DIARIO=false).');
    return;
  }
  logger.info(`☀️  Resumen diario: lunes a sábado desde las ${env.RESUMEN_DIARIO_HORA}:00.`);

  programarTarea({
    nombre: 'Resumen diario',
    archivoEstado: '.resumen-diario.json',
    vueltaPendiente: (ahora) => {
      if (ahora.getDay() === 0) return null; // domingo no
      if (ahora.getHours() < env.RESUMEN_DIARIO_HORA) return null;
      return claveDia(ahora);
    },
    ejecutar: async (_vuelta, ahora) => {
      const { texto, guardar } = await armarResumenDiario(ahora);
      const ok = await avisarAlertaMonitoreo(texto);
      // Los repetidos se apuntan como "avisados" SOLO si el mensaje salió.
      if (ok) guardar();
      return ok;
    },
  });
}
