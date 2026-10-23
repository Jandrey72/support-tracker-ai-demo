import 'dotenv/config';
import { z } from 'zod';

/**
 * Validamos TODAS las variables de entorno al arrancar.
 * Si falta algo importante o esta mal escrito, el programa avisa
 * de inmediato con un mensaje claro en vez de fallar a mitad de camino.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),

  AI_PROVIDER: z
    .enum(['claude', 'openai', 'gemini', 'deepseek', 'groq'])
    .default('claude'),

  CLAUDE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),

  // Modelo por proveedor (opcional). Por defecto usamos opciones economicas
  // adecuadas para clasificar mensajes en volumen.
  CLAUDE_MODEL: z.string().default('claude-haiku-4-5'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),

  MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),

  // ¿Publicar "🎫 Nuevo soporte" en el grupo interno por CADA ticket?
  // Apagado por defecto: hacía mucho ruido. El técnico igual recibe su
  // privado cuando le asignan uno, y el equipo ve todo en el resumen semanal.
  // Ojo: z.coerce.boolean() convierte "false" en true, por eso va como texto.
  AVISO_POR_TICKET: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ¿Dónde se avisa que alguien salió o volvió?
  //   privado = por WhatsApp privado a los OTROS técnicos (por defecto)
  //   grupo   = en el grupo interno (lo ve todo el equipo, incluida la
  //             gente que no es de soporte: hace ruido)
  //   off     = no se avisa a nadie
  AVISO_AUSENCIA: z.enum(['privado', 'grupo', 'off']).default('privado'),

  // Horas que alguien puede estar marcado ausente antes de que el bot le
  // mande un privado recordándoselo. 0 = nunca recordar.
  AUSENCIA_RECORDATORIO_HORAS: z.coerce.number().min(0).default(4),
  // Horario en que el bot NO manda ese recordatorio (hora local, 0-23).
  // Por defecto de 21:00 a 8:00: un "sigues ausente" a la 1 a. m. solo
  // despierta a la gente. El que caiga de noche sale a la mañana siguiente.
  AUSENCIA_SILENCIO_DESDE: z.coerce.number().int().min(0).max(23).default(21),
  AUSENCIA_SILENCIO_HASTA: z.coerce.number().int().min(0).max(23).default(8),

  // --- Resumen semanal al grupo interno ---
  RESUMEN_SEMANAL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Día de la semana en que se publica: 0 = domingo, 1 = lunes … 6 = sábado.
  RESUMEN_DIA: z.coerce.number().int().min(0).max(6).default(1),
  // Hora (0-23, hora local del servidor) a partir de la cual se publica.
  RESUMEN_HORA: z.coerce.number().int().min(0).max(23).default(9),

  // --- Resumen diario al grupo interno (lunes a sábado) ---
  // Lo pendiente de cada quien y lo que ya se pasó de tiempo (SLA).
  RESUMEN_DIARIO: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  RESUMEN_DIARIO_HORA: z.coerce.number().int().min(0).max(23).default(9),

  // --- Reporte mensual por cliente (PDF) ---
  // El día 1 de cada mes arma un PDF por empresa con el mes anterior y lo
  // deja en el grupo INTERNO para revisarlo antes de mandárselo al cliente.
  REPORTE_MENSUAL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  REPORTE_MENSUAL_HORA: z.coerce.number().int().min(0).max(23).default(9),

  // --- Detector de problemas repetidos ---
  // Si una empresa junta este número de soportes de la MISMA categoría en
  // los últimos REPETIDOS_DIAS días, se avisa en el grupo interno.
  REPETIDOS_MINIMO: z.coerce.number().int().min(2).default(3),
  REPETIDOS_DIAS: z.coerce.number().int().min(1).default(30),

  // Auth del dashboard (opcional). Si no se define, el dashboard es público.
  // Recomendado: usar DASHBOARD_PASS_HASH (genéralo con `npm run pass`).
  // DASHBOARD_PASS (texto plano) sigue funcionando pero es menos seguro.
  DASHBOARD_USER: z.string().optional(),
  DASHBOARD_PASS: z.string().optional(),
  DASHBOARD_PASS_HASH: z.string().optional(),

  // Secreto para firmar las cookies de sesión. Si no se define, se genera
  // uno al azar y se guarda en el archivo .session-secret
  SESSION_SECRET: z.string().min(32).optional(),

  // JID del grupo de WhatsApp donde notificar tickets manuales (opcional).
  // Ejemplo: 120363xxxxxxxx@g.us
  NOTIFICATION_GROUP: z.string().optional(),

  // Token que debe mandar Zabbix para poder publicar alertas por WhatsApp.
  // Si no se define, el endpoint de alertas queda apagado: preferimos no
  // recibir nada antes que dejar una puerta abierta al grupo del cliente.
  // Genera uno con: openssl rand -hex 24
  ZABBIX_TOKEN: z.string().optional(),

  // --- Vigilancia de Zabbix (el bot le pregunta a Zabbix) ---
  // URL completa de la API, normalmente .../zabbix/api_jsonrpc.php
  ZABBIX_URL: z.string().optional(),
  // Token de API de Zabbix (Usuarios -> Tokens de API). Usar un usuario de
  // SOLO LECTURA: este token vive en un archivo.
  ZABBIX_TOKEN_API: z.string().optional(),
  // Cada cuanto preguntar. 120s le sobra para un corte de energia.
  ZABBIX_POLL_SECONDS: z.coerce.number().min(30).default(120),
  // Severidad minima a anunciar (0 a 5). 3 = Promedio, 4 = Alta, 5 = Desastre.
  ZABBIX_MIN_SEVERITY: z.coerce.number().min(0).max(5).default(3),
  // Equipos a vigilar, separados por coma. Basta un pedazo del nombre.
  // Vacio = todos los que vea el usuario del token.
  // Grupo del CLIENTE donde publicar un aviso en lenguaje llano, ademas del
  // interno. Vacio = solo se publica en el grupo interno.
  // ⚠️ Con esto el bot escribe en un grupo de cliente: es una decision de
  // negocio, no un ajuste. Ejemplo: 5210000000000-1600000000@g.us
  ZABBIX_GRUPO_CLIENTE: z.string().optional(),

  // Cada cuantos minutos mandar un seguimiento MIENTRAS dura un corte de
  // energia ("sigue sin luz, bateria al 60%"). 0 = sin seguimientos.
  // Sin esto el equipo solo se entera al principio y al final: justo cuando
  // hay que decidir si apagar servidores, nadie sabe como va la bateria.
  ZABBIX_SEGUIMIENTO_MINUTOS: z.coerce.number().min(0).default(10),

  ZABBIX_HOSTS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),

  MONITORED_GROUPS: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(',')
            .map((g) => g.trim())
            .filter(Boolean)
        : [],
    ),

  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'debug'])
    .default('info'),

  // Puerto del dashboard web.
  PORT: z.coerce.number().default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    '\n❌ Error en las variables de entorno (.env):\n',
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
