/**
 * Script de enriquecimiento: pasa los SupportCase sin categoría por Groq
 * para asignarles categoría y mejorar el resumen.
 *
 * Uso: npm run enrich
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const RULES: Array<{ category: string; keywords: string[] }> = [
  { category: 'Servidores',               keywords: ['servidor', 'vm ', 'virtual', 'rdp', 'raid', 'ilo', 'respaldo', 'backup', 'arrancar', 'reiniciar', 'maquina', 'host', 'hypervisor', 'proxmox', 'vmware'] },
  { category: 'VPN/Firewall',             keywords: ['vpn', 'firewall', 'tunel', 'tunnel', 'mikrotik', 'acceso remoto', 'wireguard', 'openVPN'] },
  { category: 'Redes',                    keywords: ['internet', 'red ', 'dhcp', 'cable de red', 'telmex', 'totalplay', 'intermitencia', 'sin internet', 'sin conexion', 'switch', 'router', 'conectividad', 'ethernet'] },
  { category: 'Impresoras',               keywords: ['impres', 'printer', 'driver', 'toner', 'cartucho'] },
  { category: 'Software Administrativo',  keywords: ['contpaq', 'nomina', 'nomi', 'contabilidad', 'conta', 'compac', 'siac', 'erp', 'administrativo', 'factur', 'cfdi', 'sat'] },
  { category: 'Office',                   keywords: ['excel', 'word', 'correo', 'outlook', 'office', 'teams', 'sharepoint', 'onedrive', 'microsoft 365'] },
  { category: 'Hardware',                 keywords: ['teclado', 'monitor', 'cargador', 'fuente de poder', 'laptop', 'mouse', 'pantalla', 'bateria', 'memoria ram', 'disco duro', 'hardware'] },
  { category: 'Camaras/CCTV',            keywords: ['camara', 'cctv', 'hik', 'dvr', 'nvr', 'grabacion', 'vigilancia', 'hik-connect'] },
  { category: 'Configuracion/Instalacion', keywords: ['configurar', 'instalar', 'instalacion', 'configuracion', 'carpeta compartida', 'usuario nuevo', 'alta de usuario', 'permisos', 'acceso'] },
];

function classifyByKeywords(summary: string): string {
  const lower = summary.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some(k => lower.includes(k))) {
      return rule.category;
    }
  }
  return 'Otro';
}

async function getOrCreateCategory(name: string) {
  return prisma.supportCategory.upsert({
    where: { name },
    update: {},
    create: { name },
  });
}

async function main() {
  const pending = await prisma.supportCase.findMany({
    where: {
      deletedAt: null,
      OR: [
        { categoryId: null },
        { category: { name: { in: ['Sin clasificar', 'Múltiple / revisar'] } } },
      ],
    },
    select: { id: true, summary: true, client: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n🔍 Registros sin categoría: ${pending.length}`);

  if (pending.length === 0) {
    console.log('✅ Nada que enriquecer.');
    return;
  }

  let ok = 0;
  let errors = 0;

  for (let i = 0; i < pending.length; i++) {
    const rec = pending[i];
    const progress = `[${i + 1}/${pending.length}]`;

    if (!rec.summary || rec.summary.trim().length < 5) {
      console.log(`${progress} ⏭  Sin resumen suficiente — omitido (${rec.id})`);
      continue;
    }

    try {
      const category = classifyByKeywords(rec.summary);
      const cat = await getOrCreateCategory(category);

      await prisma.supportCase.update({
        where: { id: rec.id },
        data: { categoryId: cat.id },
      });

      console.log(`${progress} ✅ [${category}] ${rec.client ?? '?'} — ${rec.summary.slice(0, 80)}`);
      ok++;
    } catch (err) {
      console.error(`${progress} ❌ Error en ${rec.id}:`, (err as Error).message);
      errors++;
    }
  }

  console.log(`\n📊 Resultado: ${ok} enriquecidos, ${errors} errores de ${pending.length} total.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
