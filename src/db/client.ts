import { PrismaClient } from '@prisma/client';

/**
 * Cliente unico de Prisma (patron singleton).
 * Reutilizamos una sola conexion a la base de datos en toda la app
 * para no abrir conexiones de mas.
 */
export const prisma = new PrismaClient();

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
