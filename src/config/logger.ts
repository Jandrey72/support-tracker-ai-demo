import winston from 'winston';
import { env } from './env.js';

/**
 * Logger central de la aplicacion.
 * - En consola: colores y formato legible.
 * - En archivo (logs/app.log): historial persistente.
 */
const { combine, timestamp, printf, colorize, errors } = winston.format;

const consoleFormat = printf(({ level, message, timestamp: ts, stack }) => {
  return `${ts} [${level}] ${stack || message}`;
});

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
  ),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), consoleFormat),
    }),
    new winston.transports.File({
      filename: 'logs/app.log',
      format: combine(winston.format.json()),
    }),
  ],
});
