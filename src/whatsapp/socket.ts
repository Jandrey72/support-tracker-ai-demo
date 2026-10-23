import baileys, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { logger } from '../config/logger.js';
import { handleIncomingMessages } from './messageHandler.js';
import { setBotStatus, isManualStop, setCurrentSock } from './botState.js';
import { setNotifierSock } from './notifier.js';
import { recordarEnviado, obtenerEnviado } from './mensajesEnviados.js';

// Baileys se distribuye como CommonJS; tomamos el export por defecto de forma robusta.
const makeWASocket =
  (baileys as unknown as { default?: typeof baileys }).default ?? baileys;

/** Carpeta donde se guardan las credenciales de la sesion de WhatsApp. */
const AUTH_FOLDER = 'auth_session';

// Reconexion con espera creciente (backoff) para no "martillar" a WhatsApp.
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 60_000; // tope de 60s

/**
 * Arranca el bot de WhatsApp:
 * - Persiste la sesion en disco (no vuelves a escanear el QR cada vez).
 * - Muestra el QR en la terminal la primera vez.
 * - Se reconecta solo si se cae la conexion.
 */
export async function startBot(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    // Silenciamos el logger interno de Baileys; usamos el nuestro (Winston).
    logger: pino({ level: 'silent' }),
    browser: ['Support Tracker AI', 'Chrome', '1.0.0'],
    // Cuando alguien no puede abrir un mensaje del bot ("Esperando el
    // mensaje…"), su WhatsApp pide que se lo reenvíen y la librería llama
    // aquí. Sin esto devolvía vacío y el mensaje se quedaba esperando siempre.
    getMessage: obtenerEnviado,
  });

  // Guardar credenciales cada vez que cambien (mantiene viva la sesion).
  sock.ev.on('creds.update', saveCreds);

  // Estado de la conexion (QR, abierta, cerrada).
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('📱 Escanea este codigo QR con WhatsApp:');
      logger.info('   WhatsApp > Dispositivos vinculados > Vincular dispositivo');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      logger.info('✅ Bot conectado a WhatsApp correctamente.');
      setBotStatus('connected');
      setCurrentSock(sock);
      setNotifierSock(sock);
    }

    if (connection === 'close') {
      setBotStatus('disconnected');
      setCurrentSock(null);
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })
        ?.output?.statusCode;

      // Sesion cerrada desde el telefono: hay que volver a escanear.
      if (statusCode === DisconnectReason.loggedOut) {
        logger.warn(
          '🚪 Sesion cerrada desde el telefono. Borra la carpeta "auth_session" y vuelve a escanear el QR.',
        );
        return;
      }

      // Otra sesion tomo el lugar: NO reconectamos (evita el bucle 440).
      if (statusCode === DisconnectReason.connectionReplaced) {
        setBotStatus('conflict');
        logger.error(
          '⚠️  CONFLICTO: Otra sesion de WhatsApp tomó el lugar de este bot.\n' +
          '   Solución: cierra WhatsApp Web en el navegador y asegúrate de\n' +
          '   correr el bot en UNA sola terminal. Luego usa el botón "Encender bot" en el dashboard.',
        );
        return;
      }

      // Detenido manualmente desde el dashboard: no reconectar.
      if (isManualStop()) {
        logger.info('🛑 Bot detenido manualmente.');
        return;
      }

      // Caida normal (red, timeout, restart, 405): reconectamos con espera creciente.
      reconnectAttempts++;
      const delay = Math.min(3000 * reconnectAttempts, MAX_RECONNECT_DELAY_MS);

      if (reconnectAttempts >= 6) {
        logger.warn(
          `⚠️  Conexion cerrada (codigo ${statusCode}) por ${reconnectAttempts}ª vez. ` +
            'WhatsApp podria estar limitando la conexion. Si no conecta, DETEN el bot ' +
            '(Ctrl+C), espera unos minutos y vuelve a arrancar.',
        );
      }

      logger.warn(
        `⚠️  Conexion cerrada (codigo ${statusCode}). Reintentando en ${delay / 1000}s...`,
      );
      setTimeout(() => {
        startBot().catch((err) => logger.error(err));
      }, delay);
    }
  });

  // Mensajes entrantes. Por aquí también pasa, marcado como 'append', cada
  // mensaje que MANDA el bot: se apunta para poder reenviarlo si lo piden.
  sock.ev.on('messages.upsert', (upsert) => {
    for (const m of upsert.messages) recordarEnviado(m);

    // Separamos por chat y cada chat espera su turno (ver enFila).
    const porChat = new Map<string, typeof upsert.messages>();
    for (const m of upsert.messages) {
      const chat = m.key.remoteJid ?? '';
      porChat.set(chat, [...(porChat.get(chat) ?? []), m]);
    }
    for (const [chat, messages] of porChat) {
      enFila(chat, () => handleIncomingMessages(sock, { ...upsert, messages }));
    }
  });

  return sock;
}

/**
 * Una fila por chat: los mensajes de un MISMO grupo se procesan uno detrás
 * de otro; los de grupos distintos siguen en paralelo.
 *
 * Por qué: el cliente manda "buenas" + "no imprime" + "es urgente" en 3
 * segundos. Sin fila, los tres van a la IA a la vez, los tres preguntan
 * "¿hay caso abierto?" antes de que alguno lo cree, y salen 3 tickets.
 * Eso es una CONDICIÓN DE CARRERA. Con fila, el segundo ya encuentra el
 * ticket que creó el primero y se suma a él.
 */
const filas = new Map<string, Promise<void>>();

function enFila(chat: string, tarea: () => Promise<void>): void {
  const anterior = filas.get(chat) ?? Promise.resolve();
  // Si la tarea anterior falló, la siguiente corre igual (catch antes del then).
  const actual = anterior
    .catch(() => {})
    .then(tarea)
    .catch((err) => {
      logger.error(err);
    });
  filas.set(chat, actual);
  // Al terminar, si nadie más se formó, quitamos la fila para no acumular memoria.
  void actual.finally(() => {
    if (filas.get(chat) === actual) filas.delete(chat);
  });
}
