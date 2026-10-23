// Arranca SOLO el dashboard web (sin el bot de WhatsApp).
// Util para practicar/editar el dashboard sin disparar reconexiones.
// Correr con: npm run dashboard
import './config/silenceNoise.js';
import { logger } from './config/logger.js';
import { startWebServer } from './api/server.js';

logger.info('🎨 Modo dashboard (sin bot de WhatsApp).');
startWebServer();
