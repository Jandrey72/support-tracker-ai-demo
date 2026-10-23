// ============================================================
//  EQUIPO TÉCNICO de Mi Empresa
//  Se identifica a cada quien por su NÚMERO de WhatsApp.
//  ➡️ Edita esta lista cuando cambie el equipo.
// ============================================================

export interface Technician {
  name: string;
  /** 10 dígitos, sin lada de país. */
  number: string;
  /**
   * ¿Está en la rotación de soporte?
   * Solo a estos se les asignan tickets automáticamente. Los demás
   * siguen reconociéndose cuando escriben, pero no reciben asignaciones.
   */
  enSoporte: boolean;
}

export const TECHNICIANS: Technician[] = [
  { name: 'Ana', number: '5500000001', enSoporte: true }, // cambió de número 2026-08-24
  { name: 'Luis Pérez', number: '5500000002', enSoporte: true },
  { name: 'Carlos', number: '5500000003', enSoporte: false },
];

/** Los que sí reciben soportes asignados. */
export function tecnicosEnSoporte(): Technician[] {
  return TECHNICIANS.filter((t) => t.enSoporte);
}

/** Pistas por nombre, como respaldo si no llega el número. */
export const TECHNICIAN_NAME_HINTS = [
  'mi empresa',
  'miempresa',
  'luis',
  'carlos',
  'ana',
  'anita',
];

/** Deja solo dígitos y toma los últimos 10 (ignora lada 52/521). */
export function last10(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Busca al técnico por su número (comparando los últimos 10 dígitos). */
export function findTechnicianByNumber(number: string | null): Technician | null {
  const n = last10(number);
  if (!n) return null;
  return TECHNICIANS.find((t) => last10(t.number) === n) ?? null;
}

/** Busca al técnico por su nombre exacto (el que guardamos en la BD). */
export function findTechnicianByName(name: string | null | undefined): Technician | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  return TECHNICIANS.find((t) => t.name.toLowerCase() === lower) ?? null;
}

/** ¿El nombre parece de alguien del equipo? (respaldo) */
export function looksLikeTechnicianName(name: string | null): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return TECHNICIAN_NAME_HINTS.some((h) => lower.includes(h));
}

/**
 * JID de WhatsApp para escribirle al privado.
 *
 * ⚠️ México usa `521` + 10 dígitos, NO `52`. Se comprueba en los números que
 * guarda el bot de los clientes (ej. 5213310165780). Con `52` el mensaje se va
 * a un JID inexistente y WhatsApp **no devuelve error**: parece enviado y nunca
 * llega. Esto último costó una tarde de "el aviso no me llega".
 *
 * Aun así, prefiere `jidReal()` de notifier.ts, que se lo pregunta a WhatsApp.
 */
export function jidDeTecnico(t: Technician): string {
  return `521${last10(t.number)}@s.whatsapp.net`;
}
