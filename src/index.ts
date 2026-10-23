import './config/silenceNoise.js'; // debe ir primero: silencia ruido de libsignal
import fs from 'node:fs';
import { logger } from './config/logger.js';
import { env } from './config/env.js';
import { startBot } from './whatsapp/socket.js';
import { startWebServer } from './api/server.js';
import { disconnectDb } from './db/client.js';
import { iniciarVigilanciaZabbix } from './services/zabbixService.js';
import { iniciarResumenSemanal } from './services/resumenService.js';
import { iniciarRecordatorioAusencias } from './services/availabilityService.js';
import { iniciarResumenDiario } from './services/resumenDiarioService.js';
import { iniciarReporteMensual } from './services/reporteMensualService.js';

const LOCK_FILE = '.bot.lock';

function checkLock(): void {
  if (!fs.existsSync(LOCK_FILE)) return;
  const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
  try {
    process.kill(pid, 0); // no mata el proceso, solo verifica si existe
    logger.error(
      `\n❌ Ya hay una instancia del bot corriendo (PID ${pid}).\n` +
      '   Cierra esa terminal (Ctrl+C) antes de arrancar una nueva.\n' +
      '   Si el proceso ya no existe, borra el archivo ".bot.lock" manualmente.\n',
    );
    process.exit(1);
  } catch {
    // El proceso con ese PID ya no existe; el lock es basura de un crash anterior.
    fs.unlinkSync(LOCK_FILE);
  }
}

function writeLock(): void {
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function removeLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ya no existe */ }
}

async function main(): Promise<void> {
  checkLock();
  writeLock();
  logger.info('🚀 Iniciando Support Tracker AI...');
  logger.info(`   Proveedor de IA configurado: ${env.AI_PROVIDER}`);
  logger.info(
    env.MONITORED_GROUPS.length > 0
      ? `   Grupos monitoreados: ${env.MONITORED_GROUPS.join(', ')}`
      : '   Monitoreando TODOS los grupos.',
  );

  // Levantamos el dashboard web y el bot de WhatsApp en paralelo.
  startWebServer();
  iniciarVigilanciaZabbix();
  iniciarResumenSemanal();
  iniciarResumenDiario();
  iniciarReporteMensual();
  iniciarRecordatorioAusencias();
  await startBot();
}

// Cierre ordenado (Ctrl+C).
async function shutdown(signal: string): Promise<void> {
  logger.info(`\nRecibida senal ${signal}. Cerrando...`);
  removeLock();
  await disconnectDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
