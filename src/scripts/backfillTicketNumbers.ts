// ============================================================
//  Asigna número de ticket: TKT-0001, TKT-0002, ...
//  Numera del soporte más viejo al más nuevo, así el número
//  respeta la línea del tiempo.
//
//  Uso:
//    npm run backfill:tickets -- --dry     (solo muestra)
//    npm run backfill:tickets              (aplica)
//    npm run backfill:tickets -- --todos   (RENUMERA todo desde 1)
// ============================================================
import { prisma } from '../db/client.js';

const DRY_RUN = process.argv.includes('--dry');
const RENUMERAR_TODO = process.argv.includes('--todos');

async function main(): Promise<void> {
  console.log(DRY_RUN ? '🔍 SIMULACRO — no se modifica nada\n' : '✏️  Asignando números...\n');
  if (RENUMERAR_TODO) console.log('⚠️  Modo --todos: se renumeran TODOS desde TKT-0001\n');

  // A quién le toca número.
  const objetivo = RENUMERAR_TODO ? {} : { ticketNumber: null };
  const casos = await prisma.supportCase.findMany({
    where: objetivo,
    select: { id: true, createdAt: true, client: true, summary: true, ticketNumber: true },
    orderBy: { createdAt: 'asc' },
  });

  if (casos.length === 0) {
    console.log('✅ Todos los soportes ya tienen número. Nada que hacer.');
    return;
  }

  // Si solo numeramos los que faltan, continuamos desde el más alto que exista.
  let siguiente = 1;
  if (!RENUMERAR_TODO) {
    const ultimo = await prisma.supportCase.findFirst({
      where: { ticketNumber: { startsWith: 'TKT-' } },
      orderBy: { ticketNumber: 'desc' },
      select: { ticketNumber: true },
    });
    if (ultimo?.ticketNumber) {
      siguiente = parseInt(ultimo.ticketNumber.replace('TKT-', ''), 10) + 1;
      console.log(`ℹ️  Continuando desde ${ultimo.ticketNumber}\n`);
    }
  }

  const asignaciones = casos.map((c, i) => ({
    id: c.id,
    anterior: c.ticketNumber,
    ticketNumber: `TKT-${String(siguiente + i).padStart(4, '0')}`,
  }));

  console.log(`Se van a numerar ${asignaciones.length} soporte(s):`);
  console.log(`  desde ${asignaciones[0].ticketNumber} hasta ${asignaciones[asignaciones.length - 1].ticketNumber}\n`);

  const muestra = [...asignaciones.slice(0, 3), null, ...asignaciones.slice(-3)];
  for (const a of muestra) {
    if (!a) { console.log('  ...'); continue; }
    const c = casos.find((x) => x.id === a.id)!;
    const flecha = a.anterior ? `${a.anterior} → ` : '';
    console.log(`  ${flecha}${a.ticketNumber}  ${c.createdAt.toISOString().slice(0, 10)}  ${(c.summary ?? '').slice(0, 42)}`);
  }

  if (DRY_RUN) {
    console.log('\n🔍 Simulacro terminado. Corre sin --dry para aplicarlo.');
    return;
  }

  // Al renumerar todo, primero vaciamos los números: si no, el índice
  // `@unique` truena al chocar un número nuevo con uno viejo.
  if (RENUMERAR_TODO) {
    await prisma.supportCase.updateMany({ data: { ticketNumber: null } });
  }

  await prisma.$transaction(
    asignaciones.map(({ id, ticketNumber }) =>
      prisma.supportCase.update({ where: { id }, data: { ticketNumber } }),
    ),
  );

  console.log(`\n✅ Listo: ${asignaciones.length} soporte(s) numerados.`);
}

main()
  .catch((err) => {
    console.error('\n❌ Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
