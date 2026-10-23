// ============================================================
//  Alertas de monitoreo: el bot le PREGUNTA a Zabbix.
//
//  Lo natural seria al reves —que Zabbix llame al bot por webhook— pero la
//  red no lo permite: el bot alcanza a Zabbix, Zabbix no alcanza al bot.
//  (Hay dos tuneles con el mismo rango 10.7.0.x y el trafico no cuadra;
//  esta documentado aparte.) Asi que consultamos cada tantos segundos.
//
//  Publica DOS mensajes por incidente: cuando aparece y cuando se resuelve.
//  El segundo es el que mas agradece el cliente: "ya volvio la luz".
// ============================================================
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { avisarAlertaMonitoreo } from '../whatsapp/notifier.js';

/** Donde recordamos que ya avisamos, para no repetir en cada vuelta. */
const ARCHIVO_ESTADO = '.zabbix-avisados.json';

/** Cuanto esperamos a la API. El Zabbix de Acme responde por tunel. */
const TIMEOUT_MS = 30000;

interface ProblemaZabbix {
  eventid: string;
  name: string;
  severity: string;
  clock: string;
  /** Id del disparador. `problem.get` NO devuelve el equipo: hay que pedirlo aparte. */
  objectid: string;
  /** Lo llenamos nosotros con la segunda consulta. */
  hosts?: Array<{ hostid: string; host: string; name: string }>;
}

interface TriggerZabbix {
  triggerid: string;
  hosts?: Array<{ hostid: string; host: string; name: string }>;
}

/** Lo que guardamos en disco de cada problema ya anunciado. */
interface Avisado {
  nombre: string;
  equipo: string;
  desde: number;
  /** Para poder preguntar el estado del UPS tambien al resolverse. */
  hostid?: string;
  /** Cuando se mando el ultimo seguimiento (epoch), para espaciarlos. */
  ultimoSeguimiento?: number;
}

const SEVERIDAD: Record<string, string> = {
  '0': 'No clasificada',
  '1': 'Informativa',
  '2': 'Advertencia',
  '3': 'Promedio',
  '4': 'Alta',
  '5': 'Desastre',
};

// ------------------------------------------------------------------
//  Llamada a la API de Zabbix (JSON-RPC)
// ------------------------------------------------------------------

/**
 * Hace una llamada a la API y devuelve el campo `result`.
 *
 * Usamos los modulos nativos en vez de fetch porque el Zabbix interno tiene
 * certificado autofirmado y asi podemos aceptarlo sin depender de librerias.
 */
export function llamarApi(metodo: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(env.ZABBIX_URL!);
    const cuerpo = JSON.stringify({ jsonrpc: '2.0', method: metodo, params, id: 1 });
    const cliente = url.protocol === 'https:' ? https : http;

    const req = cliente.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        // El certificado del Zabbix interno es autofirmado: si validamos,
        // no se puede consultar. La conexion sigue cifrada.
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json-rpc',
          Authorization: `Bearer ${env.ZABBIX_TOKEN_API}`,
          'Content-Length': Buffer.byteLength(cuerpo),
        },
      },
      (res) => {
        const inicio = Date.now();
        let datos = '';
        res.on('data', (c) => (datos += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(datos) as { result?: unknown; error?: { data?: string; message?: string } };
            if (json.error) {
              reject(new Error(json.error.data ?? json.error.message ?? 'error de Zabbix'));
              return;
            }
            const tardo = Date.now() - inicio;
            if (tardo > 5000) logger.warn(`📡 Zabbix: ${metodo} tardo ${Math.round(tardo / 1000)}s.`);
            resolve(json.result);
          } catch {
            reject(new Error(`respuesta ilegible de Zabbix: ${datos.slice(0, 120)}`));
          }
        });
      },
    );

    // El mensaje dice QUE llamada fallo: con varias consultas por vuelta,
    // un "no respondio" a secas no dice donde buscar.
    req.on('error', (err) =>
      reject(err.message.startsWith(metodo) ? err : new Error(`${metodo}: ${err.message}`)),
    );
    req.setTimeout(TIMEOUT_MS, () =>
      req.destroy(new Error(`${metodo} no respondio en ${TIMEOUT_MS / 1000}s`)),
    );
    req.write(cuerpo);
    req.end();
  });
}

/**
 * Igual que `llamarApi`, pero si falla lo intenta una segunda vez.
 *
 * El enlace con el Zabbix de Acme va por tunel y se pone intermitente:
 * hay vueltas que contestan en un segundo y otras que no contestan en 30.
 * Antes, un solo tropiezo tiraba la vuelta entera y la alerta se retrasaba
 * dos minutos; con un reintento la mayoria de esos tropiezos ni se notan.
 */
async function llamarConReintento(metodo: string, params: unknown): Promise<unknown> {
  try {
    return await llamarApi(metodo, params);
  } catch (err) {
    logger.warn(`📡 Zabbix: ${(err as Error).message}. Reintentando una vez...`);
    await new Promise((r) => setTimeout(r, 3000));
    return llamarApi(metodo, params);
  }
}

/**
 * Problemas activos ahora mismo, ya filtrados por severidad y equipo.
 *
 * Van DOS consultas a proposito: `problem.get` no sabe de equipos, solo
 * devuelve el id del disparador. El nombre del equipo se pide despues con
 * `trigger.get`, que si lo trae. (Mandar `selectHosts` a `problem.get` falla
 * con "unexpected parameter".)
 */
async function problemasActivos(): Promise<ProblemaZabbix[]> {
  const params: Record<string, unknown> = {
    output: ['eventid', 'name', 'severity', 'clock', 'objectid'],
    sortfield: ['eventid'],
    recent: false,
    severities: Array.from(
      { length: 6 - env.ZABBIX_MIN_SEVERITY },
      (_, i) => env.ZABBIX_MIN_SEVERITY + i,
    ),
  };

  const res = (await llamarConReintento('problem.get', params)) as ProblemaZabbix[] | undefined;
  const todos = res ?? [];
  if (todos.length === 0) return [];

  // Segunda consulta: a que equipo pertenece cada disparador.
  const triggers = (await llamarConReintento('trigger.get', {
    triggerids: Array.from(new Set(todos.map((p) => p.objectid))),
    output: ['triggerid'],
    selectHosts: ['hostid', 'host', 'name'],
  })) as TriggerZabbix[] | undefined;

  const equipoDe = new Map<string, Array<{ hostid: string; host: string; name: string }>>();
  for (const t of triggers ?? []) equipoDe.set(t.triggerid, t.hosts ?? []);
  for (const p of todos) p.hosts = equipoDe.get(p.objectid) ?? [];

  if (env.ZABBIX_HOSTS.length === 0) return todos;

  // Filtramos por nombre de equipo aqui y no en la consulta: asi basta con
  // escribir un pedazo del nombre en el .env, sin pelear con hostids.
  const buscados = env.ZABBIX_HOSTS.map((h) => h.toLowerCase());
  return todos.filter((p) =>
    (p.hosts ?? []).some((h) =>
      buscados.some((b) => h.host.toLowerCase().includes(b) || h.name.toLowerCase().includes(b)),
    ),
  );
}

// ------------------------------------------------------------------
//  Estado del UPS (para que el aviso diga algo util)
//
//  Una alerta que solo dice "se fue la luz" no ayuda a decidir. Saber si
//  queda 90% de bateria o 15% cambia por completo la reaccion: se puede
//  esperar, o hay que apagar servidores YA.
//
//  Cada clave se toma si existe; si el equipo no la reporta, simplemente
//  no sale en el mensaje. Asi funciona con cualquier UPS.
// ------------------------------------------------------------------

/** Claves SNMP que nos interesan, tal como estan dadas de alta en Zabbix. */
const CLAVES_UPS = [
  'ups.battery.charge', // % de carga
  'ups.battery.runtime', // minutos restantes (hay que crearla en Zabbix)
  'ups.battery.seconds', // segundos que LLEVA en bateria
  'ups.battery.status', // 2 = normal, 3 = baja, 4 = agotada
  'ups.output.source', // 3 = red electrica, 5 = bateria
];

interface ItemZabbix {
  itemid: string;
  key_: string;
  lastvalue: string;
  lastclock: string;
}

/** Un punto del historial: cuándo y cuánta batería había. */
export interface PuntoCarga {
  clock: number;
  value: number;
}

/**
 * Estima cuánto aguanta la batería mirando qué tan rápido está bajando.
 *
 * El Tripp Lite del Corporativo NO reporta los minutos restantes (probado
 * el 22-sep-2026: noSuchName en SNMPv1, noAccess en SNMPv2). Pero sí da el
 * porcentaje cada minuto, y con dos lecturas se saca la pendiente:
 * si cae 4% por minuto y va en 80%, le quedan unos 20 minutos.
 *
 * Es una estimación basada en el consumo REAL de este momento, que suele
 * pegarle mejor que la cuenta del propio UPS. Devuelve undefined cuando no
 * hay elementos para calcular: por eso nunca inventa un número.
 */
export function calcularAutonomia(puntos: PuntoCarga[], cargaActual: number): number | undefined {
  if (puntos.length < 2 || cargaActual <= 0) return undefined;

  const orden = [...puntos].sort((a, b) => a.clock - b.clock);
  const primero = orden[0];
  const ultimo = orden[orden.length - 1];

  const minutos = (ultimo.clock - primero.clock) / 60;
  const caida = primero.value - ultimo.value;

  // Menos de 2 minutos de historia, o la batería no está bajando (se está
  // cargando, o el consumo es tan bajo que aún no se nota): no estimamos.
  if (minutos < 2 || caida <= 0) return undefined;

  const porMinuto = caida / minutos;
  const restantes = Math.round(cargaActual / porMinuto);

  // Un número absurdo (más de un día) significa que la caída fue un
  // redondeo, no una tendencia. Mejor no decir nada que decir una tontería.
  if (restantes < 1 || restantes > 1440) return undefined;
  return restantes;
}

export interface EstadoUps {
  carga?: number;
  minutosRestantes?: number;
  /** true si la autonomía la calculamos nosotros, no la reportó el UPS. */
  estimada?: boolean;
  segundosEnBateria?: number;
  estadoBateria?: number;
  fuente?: number;
}

/** Lee del UPS lo que Zabbix tenga. Nunca truena: si falla, no hay extra. */
async function estadoUps(hostid?: string | null): Promise<EstadoUps | null> {
  if (!hostid) return null;
  try {
    const items = (await llamarApi('item.get', {
      output: ['itemid', 'key_', 'lastvalue', 'lastclock'],
      hostids: hostid,
      filter: { key_: CLAVES_UPS },
    })) as ItemZabbix[] | undefined;

    if (!items?.length) return null;

    const valor = (clave: string): number | undefined => {
      const i = items.find((x) => x.key_ === clave);
      if (!i || i.lastvalue === '' || i.lastclock === '0') return undefined;
      const n = Number(i.lastvalue);
      return Number.isFinite(n) ? n : undefined;
    };

    const u: EstadoUps = {
      carga: valor('ups.battery.charge'),
      minutosRestantes: valor('ups.battery.runtime'),
      segundosEnBateria: valor('ups.battery.seconds'),
      estadoBateria: valor('ups.battery.status'),
      fuente: valor('ups.output.source'),
    };

    // Si el UPS no da los minutos restantes y está corriendo con batería,
    // los calculamos con el historial del porcentaje.
    const enBateria = u.fuente === 5 || (u.segundosEnBateria ?? 0) > 0;
    if (u.minutosRestantes === undefined && enBateria && u.carga !== undefined) {
      const item = items.find((x) => x.key_ === 'ups.battery.charge');
      const estimada = await estimarAutonomia(item?.itemid, u.carga);
      if (estimada !== undefined) {
        u.minutosRestantes = estimada;
        u.estimada = true;
      }
    }

    return u;
  } catch (err) {
    logger.warn(`📡 Zabbix: no pude leer el estado del UPS: ${(err as Error).message}`);
    return null;
  }
}

/** Trae el historial del porcentaje de batería y lo manda a calcular. */
async function estimarAutonomia(
  itemidCarga: string | undefined,
  cargaActual: number,
): Promise<number | undefined> {
  if (!itemidCarga) return undefined;
  try {
    const desde = Math.floor(Date.now() / 1000) - 30 * 60; // media hora basta

    // La carga puede estar guardada como entero (3) o como decimal (0),
    // segun como se dio de alta la metrica. Probamos las dos.
    for (const tipo of [3, 0]) {
      const filas = (await llamarApi('history.get', {
        output: ['clock', 'value'],
        itemids: itemidCarga,
        history: tipo,
        time_from: desde,
        sortfield: 'clock',
        sortorder: 'ASC',
        limit: 200,
      })) as Array<{ clock: string; value: string }> | undefined;

      if (filas?.length) {
        const puntos = filas.map((f) => ({ clock: Number(f.clock), value: Number(f.value) }));
        return calcularAutonomia(puntos, cargaActual);
      }
    }
    return undefined;
  } catch (err) {
    logger.warn(`📡 Zabbix: no pude estimar la autonomia: ${(err as Error).message}`);
    return undefined;
  }
}

const ESTADO_BATERIA: Record<number, string> = {
  1: 'desconocido',
  2: 'normal',
  3: 'BAJA',
  4: 'AGOTADA',
};

const FUENTE: Record<number, string> = {
  1: 'otra',
  2: 'ninguna',
  3: 'red eléctrica',
  4: 'bypass',
  5: 'batería',
  6: 'elevador',
  7: 'reductor',
};

/** Minutos "3 min" / "1 h 5 min". */
function minutos(min: number): string {
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Bloque tecnico, para el grupo interno. */
export function upsTecnico(u: EstadoUps | null): string {
  if (!u) return '';
  const l: string[] = [];
  if (u.carga !== undefined) l.push(`🔋 Batería: ${u.carga}%`);
  if (u.minutosRestantes !== undefined && u.minutosRestantes > 0)
    l.push(`⏳ Autonomía: ~${minutos(u.minutosRestantes)}${u.estimada ? ' _(estimada)_' : ''}`);
  if (u.segundosEnBateria !== undefined && u.segundosEnBateria > 0)
    l.push(`⏱️ Lleva ${minutos(Math.max(1, Math.round(u.segundosEnBateria / 60)))} en batería`);
  if (u.estadoBateria !== undefined && u.estadoBateria !== 2)
    l.push(`⚠️ Estado de batería: ${ESTADO_BATERIA[u.estadoBateria] ?? u.estadoBateria}`);
  if (u.fuente !== undefined) l.push(`🔌 Tomando de: ${FUENTE[u.fuente] ?? u.fuente}`);
  return l.length ? `\n\n${l.join('\n')}` : '';
}

/** Seguimiento para el cliente: sin el nombre crudo del disparador. */
export function clienteSeguimiento(a: Avisado, ahora: number, ups: EstadoUps): string {
  return (
    `🔄 *Seguimos sin energía*\n` +
    `${a.equipo}\n\n` +
    `Lleva ${duracion(a.desde, ahora)}.` +
    upsCliente(ups) +
    `\n\nSeguimos al pendiente y les avisamos en cuanto se normalice.`
  );
}

/**
 * Para el cliente va el MISMO detalle que al grupo interno.
 *
 * Lo pidió el equipo: ver la batería y de dónde está tomando la energía le
 * sirve igual al cliente para decidir si apaga equipos. Lo que no se le
 * manda es la severidad ni el nombre crudo del disparador; los números del
 * UPS no son jerga, son justo lo que quiere saber quien está sin luz.
 */
export function upsCliente(u: EstadoUps | null): string {
  return upsTecnico(u);
}

// ------------------------------------------------------------------
//  Memoria de lo ya avisado
// ------------------------------------------------------------------

function leerEstado(): Record<string, Avisado> {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO_ESTADO, 'utf8')) as Record<string, Avisado>;
  } catch {
    return {};
  }
}

function guardarEstado(estado: Record<string, Avisado>): void {
  try {
    fs.writeFileSync(ARCHIVO_ESTADO, JSON.stringify(estado, null, 2));
  } catch (err) {
    logger.warn(`No pude guardar el estado de Zabbix: ${(err as Error).message}`);
  }
}

// ------------------------------------------------------------------
//  Textos (en lenguaje de cliente, no el crudo de Zabbix)
// ------------------------------------------------------------------

function reloj(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function duracion(desde: number, hasta: number): string {
  const min = Math.max(1, Math.round((hasta - desde) / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

function nombreEquipo(p: ProblemaZabbix): string {
  return p.hosts?.[0]?.name ?? p.hosts?.[0]?.host ?? 'Equipo';
}

// --- Para el equipo de Mi Empresa: con severidad y datos crudos ---

function internoNuevo(p: ProblemaZabbix, ups: EstadoUps | null): string {
  const nivel = SEVERIDAD[p.severity] ?? p.severity;
  const icono = Number(p.severity) >= 4 ? '🔴' : '🟠';
  return (
    `${icono} *${p.name}*\n` +
    `${nombreEquipo(p)}\n\n` +
    `Detectado: ${reloj(Number(p.clock))}\n` +
    `Severidad: ${nivel}` +
    upsTecnico(ups)
  );
}

function internoResuelto(a: Avisado, ahora: number, ups: EstadoUps | null): string {
  return (
    `✅ *Restablecido* — ${a.nombre}\n` +
    `${a.equipo}\n\n` +
    `Duró ${duracion(a.desde, ahora)}.` +
    upsTecnico(ups)
  );
}

/** Recordatorio mientras el corte sigue: lo que importa es la batería. */
export function internoSeguimiento(a: Avisado, ahora: number, ups: EstadoUps): string {
  return (
    `🔄 *Sigue el corte* — ${a.nombre}\n` +
    `${a.equipo}\n\n` +
    `Lleva ${duracion(a.desde, ahora)}.` +
    upsTecnico(ups)
  );
}

// --- Para el cliente: sin jerga, y diciendo que ya estamos encima ---
//
// El cliente no necesita saber la severidad ni el nombre del disparador; lo
// que agradece es enterarse de que pasa algo y de que alguien lo esta viendo.

function clienteNuevo(p: ProblemaZabbix, ups: EstadoUps | null): string {
  return (
    `⚠️ *Aviso de monitoreo*\n` +
    `${nombreEquipo(p)}\n\n` +
    `${p.name}\n` +
    `Detectado: ${reloj(Number(p.clock))}` +
    upsCliente(ups) +
    `\n\nYa estamos al tanto y lo estamos revisando. ` +
    `Les avisamos en cuanto se normalice.`
  );
}

function clienteResuelto(a: Avisado, ahora: number, ups: EstadoUps | null): string {
  return (
    `✅ *Ya se normalizó*\n` +
    `${a.equipo}\n\n` +
    `${a.nombre}\n` +
    `Duración: ${duracion(a.desde, ahora)}.` +
    upsCliente(ups) +
    `\n\nEl servicio está funcionando con normalidad.`
  );
}

// ------------------------------------------------------------------
//  El ciclo
// ------------------------------------------------------------------

let primeraVuelta = true;

async function revisar(): Promise<void> {
  const activos = await problemasActivos();
  const estado = leerEstado();
  const ahora = Math.floor(Date.now() / 1000);
  const vistos = new Set(activos.map((p) => p.eventid));

  // En el PRIMER arranque de todos NO anunciamos lo que ya estaba: si el bot
  // lleva dias apagado, soltaria una avalancha de alertas viejas.
  //
  // ⚠️ Antes la condicion era "la memoria esta vacia", y eso mordia: cuando
  // todo se resuelve, la memoria queda vacia, y el siguiente reinicio se
  // tragaba en silencio cualquier problema activo (paso el 22-sep con una
  // prueba). Ahora mira si el ARCHIVO existe: vacio no es lo mismo que nuevo.
  if (primeraVuelta && !fs.existsSync(ARCHIVO_ESTADO)) {
    for (const p of activos) {
      estado[p.eventid] = {
        nombre: p.name,
        equipo: p.hosts?.[0]?.name ?? p.hosts?.[0]?.host ?? 'Equipo',
        desde: Number(p.clock),
      };
    }
    guardarEstado(estado);
    logger.info(`📡 Zabbix: ${activos.length} problema(s) activo(s) al arrancar; no se anuncian.`);
    primeraVuelta = false;
    return;
  }
  primeraVuelta = false;

  const grupoCliente = env.ZABBIX_GRUPO_CLIENTE;

  // --- Nuevos ---
  for (const p of activos) {
    if (estado[p.eventid]) continue;

    // Primero el interno: si algo falla al publicarle al cliente, al menos el
    // equipo ya se entero.
    const ups = await estadoUps(p.hosts?.[0]?.hostid);

    const ok = await avisarAlertaMonitoreo(internoNuevo(p, ups));
    if (grupoCliente) await avisarAlertaMonitoreo(clienteNuevo(p, ups), grupoCliente);

    estado[p.eventid] = {
      nombre: p.name,
      equipo: nombreEquipo(p),
      desde: Number(p.clock),
      hostid: p.hosts?.[0]?.hostid,
    };
    logger.info(
      `📡 Zabbix: alerta nueva "${p.name}" ${ok ? 'publicada' : 'NO publicada'}` +
        `${grupoCliente ? ' (interno + cliente)' : ' (solo interno)'}.`,
    );
  }

  // --- Seguimiento de los que SIGUEN activos ---
  //
  // El primer aviso sale cuando la bateria aun esta al 100%: ahi todavia no
  // se puede estimar cuanto aguanta. Estos recordatorios son los que de
  // verdad sirven para decidir si hay que apagar servidores.
  const cadaMin = env.ZABBIX_SEGUIMIENTO_MINUTOS;
  if (cadaMin > 0) {
    // UN seguimiento por EQUIPO, no por problema. En un corte real se
    // disparan tres iniciadores del mismo UPS ("en bateria", "mas de 5
    // minutos", "bateria baja") y saldrian tres mensajes identicos cada
    // vuelta. Nos quedamos con el problema mas viejo de cada equipo, que es
    // el que lleva la cuenta real de cuanto lleva el corte.
    const porEquipo = new Map<string, ProblemaZabbix>();
    for (const p of activos) {
      const hostid = p.hosts?.[0]?.hostid;
      if (!hostid) continue;
      const previo = porEquipo.get(hostid);
      if (!previo || Number(p.clock) < Number(previo.clock)) porEquipo.set(hostid, p);
    }

    for (const p of porEquipo.values()) {
      const a = estado[p.eventid];
      if (!a?.hostid) continue;

      const ultimo = a.ultimoSeguimiento ?? a.desde;
      if (ahora - ultimo < cadaMin * 60) continue;

      const ups = await estadoUps(a.hostid);
      // Solo mientras corra con bateria: si ya volvio la luz, el aviso de
      // recuperacion se encarga y este seria ruido.
      const enBateria = ups && (ups.fuente === 5 || (ups.segundosEnBateria ?? 0) > 0);
      if (!enBateria) continue;

      await avisarAlertaMonitoreo(internoSeguimiento(a, ahora, ups));
      if (grupoCliente) await avisarAlertaMonitoreo(clienteSeguimiento(a, ahora, ups), grupoCliente);
      a.ultimoSeguimiento = ahora;
      logger.info(`📡 Zabbix: seguimiento de "${a.nombre}" publicado (bateria ${ups.carga ?? '?'}%).`);
    }
  }

  // --- Resueltos: los que teniamos y ya no aparecen ---
  for (const [id, a] of Object.entries(estado)) {
    if (vistos.has(id)) continue;
    const ups = await estadoUps(a.hostid);
    const ok = await avisarAlertaMonitoreo(internoResuelto(a, ahora, ups));
    if (grupoCliente) await avisarAlertaMonitoreo(clienteResuelto(a, ahora, ups), grupoCliente);
    delete estado[id];
    logger.info(`📡 Zabbix: recuperacion de "${a.nombre}" ${ok ? 'publicada' : 'NO publicada'}.`);
  }

  guardarEstado(estado);
}

/**
 * Arranca la vigilancia. Si faltan las variables del .env no hace nada:
 * el resto del bot sigue funcionando igual.
 */
export function iniciarVigilanciaZabbix(): void {
  if (!env.ZABBIX_URL || !env.ZABBIX_TOKEN_API) {
    logger.info('📡 Zabbix: sin configurar (falta ZABBIX_URL o ZABBIX_TOKEN_API). Vigilancia apagada.');
    return;
  }

  const cada = env.ZABBIX_POLL_SECONDS * 1000;
  logger.info(
    `📡 Zabbix: vigilando cada ${env.ZABBIX_POLL_SECONDS}s` +
      (env.ZABBIX_HOSTS.length ? ` · equipos: ${env.ZABBIX_HOSTS.join(', ')}` : ' · todos los equipos') +
      ` · severidad minima: ${SEVERIDAD[String(env.ZABBIX_MIN_SEVERITY)]}` +
      (env.ZABBIX_GRUPO_CLIENTE ? ' · avisa TAMBIEN al grupo del cliente' : ' · solo grupo interno'),
  );

  const vuelta = (): void => {
    revisar().catch((err) => logger.warn(`📡 Zabbix: ${(err as Error).message}`));
  };

  setTimeout(vuelta, 10_000); // damos tiempo a que WhatsApp conecte
  setInterval(vuelta, cada);
}
