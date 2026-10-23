// ============================================================
//  Autenticación del dashboard
//  - Contraseña guardada como HASH (scrypt), nunca en texto plano.
//  - Sesión con cookie firmada (HMAC) que expira sola.
//  - Protección contra fuerza bruta (bloqueo tras varios intentos).
//  - Comparaciones en tiempo constante (evita timing attacks).
// ============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const COOKIE_NAME = 'st_session';
const SESSION_HOURS = 12;
const SECRET_FILE = path.join(process.cwd(), '.session-secret');

// --- Secreto de sesión -------------------------------------------------
// Se guarda en un archivo local para que las sesiones sobrevivan a un
// reinicio. Es independiente de la contraseña (buena práctica).
function loadOrCreateSecret(): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (s.length >= 32) return s;
    }
  } catch { /* se regenera abajo */ }
  const secret = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  } catch (err) {
    logger.warn(`No se pudo guardar el secreto de sesión: ${(err as Error).message}`);
  }
  return secret;
}

const SECRET = loadOrCreateSecret();

// --- Hash de contraseña (scrypt) --------------------------------------
/** Genera el hash de una contraseña. Formato: scrypt$<salt hex>$<hash hex> */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Compara una contraseña contra su hash, en tiempo constante. */
function verifyPassword(plain: string, stored: string): boolean {
  try {
    const [algo, saltHex, hashHex] = stored.split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const derived = crypto.scryptSync(plain, Buffer.from(saltHex, 'hex'), 64);
    return safeEqual(derived, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

/** Comparación en tiempo constante que no revienta con longitudes distintas. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // Igual hacemos una comparación para no delatar la diferencia por tiempo.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// --- Configuración de credenciales -------------------------------------
/** true si el dashboard está protegido (hay usuario configurado). */
export function authEnabled(): boolean {
  return Boolean(env.DASHBOARD_USER);
}

/** Valida usuario + contraseña contra lo configurado en .env */
function checkCredentials(user: string, pass: string): boolean {
  if (!env.DASHBOARD_USER) return false;

  const userOk = safeEqual(
    Buffer.from(user ?? '', 'utf8'),
    Buffer.from(env.DASHBOARD_USER, 'utf8'),
  );

  let passOk = false;
  if (env.DASHBOARD_PASS_HASH) {
    passOk = verifyPassword(pass ?? '', env.DASHBOARD_PASS_HASH);
  } else if (env.DASHBOARD_PASS) {
    passOk = safeEqual(
      Buffer.from(pass ?? '', 'utf8'),
      Buffer.from(env.DASHBOARD_PASS, 'utf8'),
    );
  }

  // Se evalúan ambos siempre (sin cortocircuito) para no filtrar por tiempo
  // si el usuario existe o no.
  return userOk && passOk;
}

// --- Bloqueo por fuerza bruta ------------------------------------------
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000; // 15 minutos
const attempts = new Map<string, { count: number; until: number }>();

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'desconocido';
}

/**
 * ¿La petición viene de esta misma computadora?
 * Desde localhost NO bloqueamos por intentos fallidos: es el dueño
 * probando en su propia máquina. Desde fuera sí se bloquea.
 */
function isLocalhost(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** Devuelve los minutos que faltan de bloqueo, o 0 si no está bloqueado. */
function lockedFor(ip: string): number {
  if (isLocalhost(ip)) return 0; // nunca bloqueamos al dueño en su propia Mac
  const rec = attempts.get(ip);
  if (!rec) return 0;
  if (Date.now() > rec.until) { attempts.delete(ip); return 0; }
  if (rec.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((rec.until - Date.now()) / 60000);
}

function registerFailure(ip: string): void {
  if (isLocalhost(ip)) return;
  const rec = attempts.get(ip) ?? { count: 0, until: 0 };
  rec.count++;
  rec.until = Date.now() + LOCK_MS;
  attempts.set(ip, rec);
}

function clearFailures(ip: string): void {
  attempts.delete(ip);
}

// Limpieza periódica para que el Map no crezca sin límite.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (now > rec.until) attempts.delete(ip);
}, 10 * 60 * 1000).unref();

// --- Token de sesión ----------------------------------------------------
function sign(data: string): string {
  return crypto.createHmac('sha256', SECRET).update(data).digest('hex');
}

function createToken(user: string): string {
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${Buffer.from(user).toString('base64url')}.${expires}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 4) return false;
    const [userB64, expiresStr, nonce, sig] = parts;
    const payload = `${userB64}.${expiresStr}.${nonce}`;

    if (!safeEqual(Buffer.from(sig, 'hex'), Buffer.from(sign(payload), 'hex'))) return false;
    if (Date.now() > Number(expiresStr)) return false;

    const user = Buffer.from(userB64, 'base64url').toString('utf8');
    return user === env.DASHBOARD_USER;
  } catch {
    return false;
  }
}

function readCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=');
  }
  return null;
}

function cookieOptions(maxAgeSeconds: number, req: Request): string {
  // Secure solo cuando la conexión es HTTPS; en localhost rompería el login.
  const isHttps = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  return [
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=${maxAgeSeconds}`,
    isHttps ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

/** true si la petición trae una sesión válida. */
export function isAuthenticated(req: Request): boolean {
  if (!authEnabled()) return true;
  const token = readCookie(req);
  return Boolean(token && verifyToken(token));
}

// --- Handlers -----------------------------------------------------------
export function loginHandler(req: Request, res: Response): void {
  const ip = clientIp(req);

  const minutes = lockedFor(ip);
  if (minutes > 0) {
    logger.warn(`🔒 Login bloqueado por intentos fallidos desde ${ip}`);
    res.status(429).json({
      error: `Demasiados intentos fallidos. Intenta de nuevo en ${minutes} minuto(s).`,
    });
    return;
  }

  const { user, pass } = (req.body ?? {}) as { user?: string; pass?: string };

  if (!authEnabled()) {
    res.status(400).json({ error: 'El dashboard no tiene autenticación configurada.' });
    return;
  }

  if (!checkCredentials(user ?? '', pass ?? '')) {
    registerFailure(ip);
    logger.warn(`❌ Intento de login fallido desde ${ip} (usuario: "${user ?? ''}")`);

    let error = 'Usuario o contraseña incorrectos.';
    if (!isLocalhost(ip)) {
      const left = MAX_ATTEMPTS - (attempts.get(ip)?.count ?? 0);
      if (left > 0) error += ` Te quedan ${left} intento(s).`;
    }
    res.status(401).json({ error });
    return;
  }

  clearFailures(ip);
  const token = createToken(env.DASHBOARD_USER!);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${cookieOptions(SESSION_HOURS * 3600, req)}`);
  logger.info(`✅ Login exitoso (${env.DASHBOARD_USER}) desde ${ip}`);
  res.json({ ok: true });
}

export function logoutHandler(req: Request, res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieOptions(0, req)}`);
  res.json({ ok: true });
}

/** Dice si hay sesión activa. Lo usa la pantalla de login para no rebotar. */
export function meHandler(req: Request, res: Response): void {
  res.json({
    authEnabled: authEnabled(),
    authenticated: isAuthenticated(req),
    user: isAuthenticated(req) ? (env.DASHBOARD_USER ?? null) : null,
  });
}

// --- Middleware ---------------------------------------------------------
/** Rutas que se pueden ver sin haber iniciado sesión. */
const PUBLIC_PATHS = new Set([
  '/login.html',
  '/api/auth/login',
  '/api/auth/me',
  '/api/auth/logout',
]);

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled()) { next(); return; }
  if (PUBLIC_PATHS.has(req.path)) { next(); return; }
  if (isAuthenticated(req)) { next(); return; }

  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Sesión expirada o no iniciada' });
  } else {
    res.redirect('/login.html');
  }
}

/** Cabeceras de seguridad + anti-caché para el HTML. */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // El HTML y la API nunca se cachean: así no se ve un dashboard viejo
  // después de cerrar sesión ni datos desactualizados.
  if (req.path === '/' || req.path.endsWith('.html') || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}
