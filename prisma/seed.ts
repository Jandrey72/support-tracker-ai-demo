// ============================================================
//  Datos de ejemplo para probar el dashboard sin WhatsApp.
//  Todo es inventado: empresas, personas y mensajes.
//
//  Uso:  npm run db:push && npm run db:seed
// ============================================================
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const GRUPOS = [
  { name: 'Soporte Acme', waId: '120000000000000001@g.us' },
  { name: 'Soporte Colegio Demo', waId: '120000000000000002@g.us' },
  { name: 'Soporte Grupo Delta', waId: '120000000000000003@g.us' },
  { name: 'Soporte Logística Beta', waId: '120000000000000004@g.us' },
  { name: 'Soporte Clínica Gamma', waId: '120000000000000005@g.us' },
];

const CATEGORIAS = [
  'Servidores', 'Redes', 'VPN/Firewall', 'Impresoras', 'Software Administrativo',
  'Office', 'Hardware', 'Camaras/CCTV', 'Configuracion/Instalacion', 'Otro',
];

const TECNICOS = ['Ana', 'Luis Pérez'];
const SITIOS = ['Planta Norte', 'Planta Sur', 'Oficinas Centro', 'Sucursal Poniente', null];
const SEVERIDADES = ['Alta', 'Media', 'Baja'];

// Pedido del cliente → lo que respondió el técnico.
const CASOS: Array<[string, string, string]> = [
  ['Servidores', 'No podemos entrar por escritorio remoto al servidor del ERP', 'Se reinició el servicio y ya entra'],
  ['Redes', 'Se cayó el internet en todo el piso de abajo', 'Era el módem del proveedor, ya quedó'],
  ['VPN/Firewall', 'La VPN de la planta no conecta desde la mañana', 'Se actualizó la lista de IPs permitidas en el firewall'],
  ['Impresoras', 'La impresora de recepción no imprime', 'Se reinstaló el driver y ya imprime'],
  ['Software Administrativo', 'El sistema de nómina marca error al timbrar', 'Se renovó el certificado y ya timbra'],
  ['Office', 'No me llega el correo desde ayer', 'El buzón estaba lleno, se archivó'],
  ['Hardware', 'Se apagó el monitor de caja y no prende', 'Se cambió el cable de corriente'],
  ['Camaras/CCTV', 'Una cámara del estacionamiento no se ve', 'Se reconectó el cable PoE en el switch'],
  ['Configuracion/Instalacion', 'Llegó una laptop nueva para contabilidad', 'Se configuró con usuario y carpetas compartidas'],
  ['Servidores', 'El respaldo de anoche marcó error', 'Se liberó espacio en el disco de respaldos'],
  ['Redes', 'El WiFi de la sala de juntas está muy lento', 'Se cambió el canal del access point'],
  ['VPN/Firewall', 'No abre la página del banco', 'Se agregó el sitio a la lista permitida'],
];

const pick = <T>(arr: T[], i: number): T => arr[i % arr.length];

async function main() {
  // Empezamos de cero para que la demo siempre se vea igual.
  await prisma.aIAnalysis.deleteMany();
  await prisma.message.deleteMany();
  await prisma.supportCase.deleteMany();
  await prisma.supportCategory.deleteMany();
  await prisma.group.deleteMany();

  const grupos = await Promise.all(GRUPOS.map((g) => prisma.group.create({ data: g })));
  const categorias = new Map<string, string>();
  for (const name of CATEGORIAS) {
    const c = await prisma.supportCategory.create({ data: { name } });
    categorias.set(name, c.id);
  }

  const ahora = Date.now();
  const DIA = 24 * 60 * 60 * 1000;
  const TOTAL = 48;

  for (let i = 0; i < TOTAL; i++) {
    const [categoria, pedido, solucion] = pick(CASOS, i);
    const grupo = pick(grupos, i * 3 + (i % 2));
    const tecnico = pick(TECNICOS, i);
    const inicio = new Date(ahora - (i * 0.6 + (i % 5) * 0.3) * DIA);
    // Los más recientes siguen abiertos; los viejos ya se cerraron.
    const status = i < 4 ? 'open' : i < 8 ? 'in_progress' : 'completed';
    const resuelto = status === 'completed' ? new Date(inicio.getTime() + (1 + (i % 6)) * 60 * 60 * 1000) : null;

    const caso = await prisma.supportCase.create({
      data: {
        ticketNumber: `TKT-${String(TOTAL - i).padStart(4, '0')}`,
        client: grupo.name.replace('Soporte ', ''),
        technician: tecnico,
        assignedTo: tecnico,
        summary: pedido,
        resolutionNote: resuelto ? solucion : null,
        status,
        confidence: 0.7 + (i % 3) * 0.1,
        severity: pick(SEVERIDADES, i + 1),
        site: pick(SITIOS, i),
        interactionType: 'Soporte técnico',
        startedAt: inicio,
        resolvedAt: resuelto,
        createdAt: inicio,
        groupId: grupo.id,
        categoryId: categorias.get(categoria),
      },
    });

    // La conversación que dio origen al ticket.
    const mensajes: Array<[string, string, number]> = [
      ['Cliente de ejemplo', pedido, 0],
      [tecnico, 'Enterado, lo reviso en este momento', 4],
    ];
    if (resuelto) mensajes.push([tecnico, `Listo: ${solucion.toLowerCase()}`, 60]);

    for (const [k, [quien, texto, minutos]] of mensajes.entries()) {
      await prisma.message.create({
        data: {
          waId: `demo-${i}-${k}`,
          content: texto,
          senderName: quien,
          timestamp: new Date(inicio.getTime() + minutos * 60 * 1000),
          groupId: grupo.id,
          supportCaseId: caso.id,
        },
      });
    }
  }

  console.log(`Listo: ${TOTAL} tickets de ejemplo en ${GRUPOS.length} grupos.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
