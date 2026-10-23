/**
 * Silencia el ruido interno de la librería de cifrado de WhatsApp (libsignal),
 * que imprime volcados como "Closing session: SessionEntry {...}" directo a la
 * consola. Son inofensivos —es el protocolo rotando sus llaves— pero ensucian
 * la terminal y parecen errores.
 *
 * Este archivo debe importarse ANTES que nada (ver src/index.ts).
 */
const NOISE_PATTERNS = [
  'Closing session',
  'Closing open session',
  'Closing stale open session',
  'SessionEntry',
  'Bad MAC',
  'Failed to decrypt',
  'Session error',
  'No session found',
  'Removing old closed session',
  'Old closed session',
];

/** ¿Alguno de los argumentos es ruido de libsignal? */
function isNoise(args: unknown[]): boolean {
  for (const arg of args) {
    if (typeof arg === 'string' && NOISE_PATTERNS.some((p) => arg.includes(p))) {
      return true;
    }
    // A veces el volcado viene como objeto SessionEntry, no como texto.
    if (arg && typeof arg === 'object') {
      const nombre = arg.constructor?.name;
      if (nombre === 'SessionEntry' || nombre === 'SessionRecord') return true;
    }
  }
  return false;
}

// libsignal usa varios métodos, no solo log/error.
const METODOS = ['log', 'error', 'warn', 'info', 'debug', 'trace'] as const;

for (const metodo of METODOS) {
  const original = console[metodo].bind(console);
  console[metodo] = (...args: unknown[]): void => {
    if (isNoise(args)) return;
    original(...args);
  };
}
