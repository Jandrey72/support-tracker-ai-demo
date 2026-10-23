import { prisma } from '../db/client.js';
import { companyForGroup, patronesDeEmpresa, EMPRESA_INTERNA } from '../config/companies.js';

export interface SupportFilters {
  client?: string;
  papelera?: boolean;
  technician?: string;
  status?: string;
  category?: string;
  group?: string;
  ids?: string[];
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  /**
   * Empresa (del catálogo companies.ts). Filtra por los grupos de WhatsApp
   * que pertenecen a esa empresa. Se usa para que cada grupo vea solo lo suyo.
   */
  company?: string;
}

/** Construye el filtro de Prisma a partir de los filtros de la UI. */
function buildWhere(filters: SupportFilters) {
  const where: Record<string, unknown> = {};
  if (filters.client) where.client = { contains: filters.client };
  if (filters.technician) where.technician = { contains: filters.technician };
  if (filters.status) where.status = filters.status;
  if (filters.category) where.category = { name: { contains: filters.category } };
  if (filters.group) where.group = { name: { contains: filters.group } };

  // Filtro por empresa: la empresa se deduce del NOMBRE del grupo, así que
  // buscamos los grupos cuyo nombre contenga alguna de sus palabras clave.
  if (filters.company) {
    const patrones = patronesDeEmpresa(filters.company);
    if (patrones?.length) {
      const porEmpresa = { OR: patrones.map((m) => ({ name: { contains: m } })) };
      // Si ya había filtro de grupo, se respetan los dos (AND).
      where.group = where.group ? { AND: [where.group, porEmpresa] } : porEmpresa;
    }
  }
  if (filters.ids && filters.ids.length) where.id = { in: filters.ids };
  // Búsqueda libre: revisa varios campos a la vez.
  if (filters.search) {
    const q = filters.search;
    where.OR = [
      { summary: { contains: q } },
      { client: { contains: q } },
      { technician: { contains: q } },
      { ticketNumber: { contains: q } },
      { resolutionNote: { contains: q } },
      { site: { contains: q } },
    ];
  }
  if (filters.dateFrom || filters.dateTo) {
    // Si llega una fecha imposible ("99/99/9999") la ignoramos en vez de
    // pasarle un Invalid Date a Prisma, que revienta la consulta.
    const parse = (texto: string, hora: string): Date | null => {
      const d = new Date(`${texto}T${hora}`);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const range: Record<string, Date> = {};
    const desde = filters.dateFrom ? parse(filters.dateFrom, '00:00:00') : null;
    const hasta = filters.dateTo ? parse(filters.dateTo, '23:59:59') : null;
    if (desde) range.gte = desde;
    if (hasta) range.lte = hasta;
    if (Object.keys(range).length) where.createdAt = range;
  }
  if (filters.papelera) {
    where.deletedAt = { not: null };
  } else {
    where.deletedAt = null;
  }
  return where;
}

/**
 * Devuelve los casos de soporte (con su categoria y grupo), mas recientes primero.
 *
 * OJO: NO traemos los mensajes completos, solo cuántos son (`_count`).
 * Traerlos todos significaba cargar ~7000 mensajes en cada refresco del
 * dashboard solo para mostrar un número.
 */
export async function getSupports(filters: SupportFilters = {}) {
  return prisma.supportCase.findMany({
    where: buildWhere(filters),
    include: {
      category: true,
      group: true,
      _count: { select: { messages: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Manda un soporte a la PAPELERA (soft delete): no lo borra de verdad,
 * solo le marca la fecha en `deletedAt`. Se puede recuperar después.
 */
export async function deleteSupport(id: string): Promise<void> {
  await prisma.supportCase.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

/** Saca un soporte de la papelera (lo reactiva). */
export async function recoverSupport(id: string): Promise<void> {
  await prisma.supportCase.update({
    where: { id },
    data: { deletedAt: null },
  });
}

/** Borrado DEFINITIVO: elimina el soporte y todo lo suyo. NO se recupera. */
export async function deleteSupportForever(id: string): Promise<void> {
  await prisma.$transaction([
    prisma.aIAnalysis.deleteMany({ where: { message: { supportCaseId: id } } }),
    prisma.aIAnalysis.deleteMany({ where: { supportCaseId: id } }),
    prisma.message.deleteMany({ where: { supportCaseId: id } }),
    prisma.supportCase.delete({ where: { id } }),
  ]);
}

/** Devuelve la conversacion (mensajes) enlazada a un caso de soporte, en orden. */
export async function getSupportMessages(caseId: string) {
  return prisma.message.findMany({
    where: { supportCaseId: caseId },
    orderBy: { timestamp: 'asc' },
    // Traemos el usuario para poder saber si quien escribio es del equipo.
    include: { user: { select: { waId: true } } },
  });
}

/**
 * ¿El soporte ya se pasó de tiempo? Mismo criterio que el ⚠️ de la tabla
 * del dashboard: abierto más de 24 h, en progreso más de 48 h.
 * Vive en un solo lugar para que el resumen, el dashboard y las
 * estadísticas no cuenten distinto.
 */
export function slaVencido(
  c: { status: string; createdAt: Date },
  ahora: number = Date.now(),
): boolean {
  const horas = (ahora - c.createdAt.getTime()) / 3_600_000;
  return (c.status === 'open' && horas > 24) || (c.status === 'in_progress' && horas > 48);
}

/** Horas (o días) que lleva abierto, en texto corto: "5 h", "3 d". */
export function antiguedad(desde: Date, ahora: number = Date.now()): string {
  const horas = Math.floor((ahora - desde.getTime()) / 3_600_000);
  return horas < 48 ? `${horas} h` : `${Math.floor(horas / 24)} d`;
}

export interface TechnicianStats {
  technician: string;
  total: number;
  open: number;
  in_progress: number;
  completed: number;
  avgResolutionMinutes: number | null;
  slaVencidos: number;
  ultimoSoporte: Date | null;
}

/**
 * Desempeño de cada técnico: cuántos lleva, cómo van, qué tan rápido
 * resuelve y cuántos tiene fuera de tiempo (SLA).
 */
export async function getTechnicianStats(
  filters: SupportFilters = {},
): Promise<TechnicianStats[]> {
  const cases = await prisma.supportCase.findMany({
    where: buildWhere(filters),
    select: {
      technician: true,
      status: true,
      startedAt: true,
      resolvedAt: true,
      createdAt: true,
    },
  });

  const ahora = Date.now();
  const mapa = new Map<string, TechnicianStats & { _msTotal: number; _resueltos: number }>();

  for (const c of cases) {
    const nombre = c.technician?.trim() || 'Sin asignar';
    let t = mapa.get(nombre);
    if (!t) {
      t = {
        technician: nombre,
        total: 0, open: 0, in_progress: 0, completed: 0,
        avgResolutionMinutes: null, slaVencidos: 0, ultimoSoporte: null,
        _msTotal: 0, _resueltos: 0,
      };
      mapa.set(nombre, t);
    }

    t.total++;
    if (c.status === 'open') t.open++;
    else if (c.status === 'in_progress') t.in_progress++;
    else if (c.status === 'completed') t.completed++;

    if (c.resolvedAt) {
      t._msTotal += c.resolvedAt.getTime() - c.startedAt.getTime();
      t._resueltos++;
    }

    if (slaVencido(c, ahora)) t.slaVencidos++;

    if (!t.ultimoSoporte || c.createdAt > t.ultimoSoporte) t.ultimoSoporte = c.createdAt;
  }

  return [...mapa.values()]
    .map(({ _msTotal, _resueltos, ...t }) => ({
      ...t,
      avgResolutionMinutes: _resueltos > 0 ? Math.round(_msTotal / _resueltos / 60000) : null,
    }))
    .sort((a, b) => b.total - a.total);
}

export interface Stats {
  total: number;
  byStatus: { open: number; in_progress: number; completed: number };
  byCategory: Array<{ name: string; count: number }>;
  topTechnicians: Array<{ technician: string; count: number }>;
  byCompany: Array<{ company: string; count: number }>;
  avgResolutionMinutes: number | null;
}

/** Calcula las estadisticas del dashboard. */
export async function getStats(filters: SupportFilters = {}): Promise<Stats> {
  const where = buildWhere(filters);
  // Solo pedimos las columnas que realmente se usan para calcular las
  // estadísticas (nada de `summary`, que es texto largo).
  const cases = await prisma.supportCase.findMany({
    where,
    select: {
      status: true,
      technician: true,
      startedAt: true,
      resolvedAt: true,
      category: { select: { name: true } },
      group: { select: { name: true } },
    },
  });

  const byStatus = { open: 0, in_progress: 0, completed: 0 };
  const categoryCount = new Map<string, number>();
  const techCount = new Map<string, number>();
  const companyCount = new Map<string, number>();
  let totalResolutionMs = 0;
  let resolvedCount = 0;

  for (const c of cases) {
    // Por estado
    if (c.status === 'open') byStatus.open++;
    else if (c.status === 'in_progress') byStatus.in_progress++;
    else if (c.status === 'completed') byStatus.completed++;

    // Por categoria
    const catName = c.category?.name ?? 'Sin categoria';
    categoryCount.set(catName, (categoryCount.get(catName) ?? 0) + 1);

    // Por tecnico
    if (c.technician) {
      techCount.set(c.technician, (techCount.get(c.technician) ?? 0) + 1);
    }

    // Por empresa (se deduce del nombre del grupo)
    const company = companyForGroup(c.group?.name);
    companyCount.set(company, (companyCount.get(company) ?? 0) + 1);

    // Tiempo de resolucion
    if (c.resolvedAt) {
      totalResolutionMs += c.resolvedAt.getTime() - c.startedAt.getTime();
      resolvedCount++;
    }
  }

  const byCategory = [...categoryCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const topTechnicians = [...techCount.entries()]
    .map(([technician, count]) => ({ technician, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const byCompany = [...companyCount.entries()]
    .map(([company, count]) => ({ company, count }))
    .sort((a, b) => b.count - a.count);

  const avgResolutionMinutes =
    resolvedCount > 0
      ? Math.round(totalResolutionMs / resolvedCount / 60000)
      : null;

  return {
    total: cases.length,
    byStatus,
    byCategory,
    topTechnicians,
    byCompany,
    avgResolutionMinutes,
  };
}

// ============================================================
//  Problemas que se repiten
// ============================================================

export interface ProblemaRepetido {
  empresa: string;
  categoria: string;
  total: number;
  abiertos: number;
  /** Números de ticket, del más nuevo al más viejo. */
  tickets: string[];
  /** Sitios mencionados (si la IA o alguien los llenó). */
  sitios: string[];
  ultimo: Date;
}

/**
 * Busca empresas con varios soportes de la MISMA categoría en poco tiempo.
 * Eso casi nunca es mala suerte: es un equipo o una red que pide una
 * solución de fondo (y una oportunidad de venderla).
 *
 * El grupo interno no cuenta, y los soportes sin categoría (o con "Otro")
 * tampoco: sin categoría no se puede decir que "es lo mismo".
 */
export async function getProblemasRepetidos(
  dias: number,
  minimo: number,
): Promise<ProblemaRepetido[]> {
  const desde = new Date(Date.now() - dias * 86_400_000);
  const casos = await prisma.supportCase.findMany({
    where: { deletedAt: null, createdAt: { gte: desde }, categoryId: { not: null } },
    select: {
      ticketNumber: true,
      status: true,
      site: true,
      createdAt: true,
      category: { select: { name: true } },
      group: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const mapa = new Map<string, ProblemaRepetido>();
  for (const c of casos) {
    const empresa = companyForGroup(c.group?.name);
    if (empresa === EMPRESA_INTERNA || !c.category) continue;
    // "Otro" es un cajón de sastre: 10 soportes de "Otro" no son el mismo problema.
    if (/^otros?$/i.test(c.category.name.trim())) continue;

    const llave = `${empresa}|${c.category.name}`;
    let p = mapa.get(llave);
    if (!p) {
      p = { empresa, categoria: c.category.name, total: 0, abiertos: 0, tickets: [], sitios: [], ultimo: c.createdAt };
      mapa.set(llave, p);
    }
    p.total++;
    if (c.status !== 'completed') p.abiertos++;
    if (c.ticketNumber) p.tickets.push(c.ticketNumber);
    if (c.site && !p.sitios.includes(c.site)) p.sitios.push(c.site);
  }

  return [...mapa.values()]
    .filter((p) => p.total >= minimo)
    .sort((a, b) => b.total - a.total);
}

// ============================================================
//  Vista por técnico
// ============================================================

/**
 * Los soportes "de" un técnico: los que tiene asignados como responsable.
 * Los casos viejos (de antes del reparto) no tienen responsable; para esos
 * cae a `technician`, buscando por su primer nombre ("Luis" encuentra a
 * "Luis Nuevo", que así quedó guardado en el histórico).
 */
function whereDelTecnico(nombre: string) {
  const primerNombre = nombre.split(/\s+/)[0];
  return {
    deletedAt: null,
    OR: [
      { assignedTo: nombre },
      { assignedTo: null, technician: { contains: primerNombre } },
    ],
  };
}

export async function getVistaTecnico(nombre: string) {
  const ahora = new Date();
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

  const casos = await prisma.supportCase.findMany({
    where: whereDelTecnico(nombre),
    select: {
      id: true,
      ticketNumber: true,
      summary: true,
      status: true,
      severity: true,
      createdAt: true,
      startedAt: true,
      resolvedAt: true,
      category: { select: { name: true } },
      group: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const conEmpresa = casos.map((c) => ({
    ...c,
    empresa: companyForGroup(c.group?.name),
    categoria: c.category?.name ?? 'Sin categoría',
    vencido: slaVencido(c, ahora.getTime()),
  }));

  const pendientes = conEmpresa
    .filter((c) => c.status !== 'completed')
    // Los vencidos primero; dentro de cada grupo, el más viejo primero.
    .sort((a, b) => Number(b.vencido) - Number(a.vencido) || a.createdAt.getTime() - b.createdAt.getTime());

  const delMes = conEmpresa.filter((c) => c.createdAt >= inicioMes);
  const cerradosMes = delMes.filter((c) => c.resolvedAt);
  const promedioMin = cerradosMes.length
    ? Math.round(
        cerradosMes.reduce((s, c) => s + (c.resolvedAt!.getTime() - c.startedAt.getTime()), 0) /
          cerradosMes.length /
          60000,
      )
    : null;

  const contar = (lista: typeof conEmpresa, campo: 'empresa' | 'categoria') => {
    const m = new Map<string, number>();
    for (const c of lista) m.set(c[campo], (m.get(c[campo]) ?? 0) + 1);
    return [...m.entries()].map(([nombre, total]) => ({ nombre, total })).sort((a, b) => b.total - a.total);
  };

  // Últimos 6 meses, para ver la tendencia.
  const porMes: Array<{ mes: string; total: number; cerrados: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const ini = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
    const fin = new Date(ahora.getFullYear(), ahora.getMonth() - i + 1, 1);
    const delRango = conEmpresa.filter((c) => c.createdAt >= ini && c.createdAt < fin);
    porMes.push({
      mes: ini.toLocaleDateString('es-MX', { month: 'short', year: '2-digit' }),
      total: delRango.length,
      cerrados: delRango.filter((c) => c.status === 'completed').length,
    });
  }

  return {
    nombre,
    pendientes,
    vencidos: pendientes.filter((c) => c.vencido).length,
    mes: {
      total: delMes.length,
      cerrados: delMes.filter((c) => c.status === 'completed').length,
      promedioMin,
      porEmpresa: contar(delMes, 'empresa'),
      porCategoria: contar(delMes, 'categoria'),
    },
    historico: {
      total: conEmpresa.length,
      cerrados: conEmpresa.filter((c) => c.status === 'completed').length,
    },
    porMes,
    ultimosCerrados: conEmpresa.filter((c) => c.status === 'completed').slice(0, 10),
  };
}

// ============================================================
//  Datos del reporte mensual de un cliente
// ============================================================

/** AAAA-MM-DD en hora local (lo que espera buildWhere). */
function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Todo lo que lleva el reporte mensual de UNA empresa.
 * `mes` va de 0 (enero) a 11 (diciembre), como en Date de JavaScript.
 */
export async function getDatosReporteMensual(empresa: string, anio: number, mes: number) {
  const desde = new Date(anio, mes, 1);
  const hasta = new Date(anio, mes + 1, 0); // último día del mes

  const casos = await prisma.supportCase.findMany({
    where: buildWhere({ company: empresa, dateFrom: ymdLocal(desde), dateTo: ymdLocal(hasta) }),
    include: {
      category: true,
      group: true,
      _count: { select: { messages: true, evidencias: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const cerrados = casos.filter((c) => c.status === 'completed');
  const conTiempo = cerrados.filter((c) => c.resolvedAt);
  const promedioMin = conTiempo.length
    ? Math.round(
        conTiempo.reduce((s, c) => s + (c.resolvedAt!.getTime() - c.startedAt.getTime()), 0) /
          conTiempo.length /
          60000,
      )
    : null;

  const contar = (valor: (c: (typeof casos)[number]) => string) => {
    const m = new Map<string, number>();
    for (const c of casos) m.set(valor(c), (m.get(valor(c)) ?? 0) + 1);
    return [...m.entries()].map(([nombre, total]) => ({ nombre, total })).sort((a, b) => b.total - a.total);
  };

  return {
    empresa,
    desde,
    hasta,
    casos,
    totales: {
      total: casos.length,
      cerrados: cerrados.length,
      pendientes: casos.length - cerrados.length,
      promedioMin,
      mensajes: casos.reduce((s, c) => s + c._count.messages, 0),
      evidencias: casos.reduce((s, c) => s + c._count.evidencias, 0),
    },
    porCategoria: contar((c) => c.category?.name ?? 'Sin categoría'),
    porTecnico: contar((c) => c.assignedTo || c.technician || 'Sin asignar'),
  };
}

export type DatosReporteMensual = Awaited<ReturnType<typeof getDatosReporteMensual>>;
