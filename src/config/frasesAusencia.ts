// ============================================================
//  FRASES para los avisos de disponibilidad (solo grupo interno)
//
//  ➡️ Edita esta lista cuando se te ocurra una mejor. Es un catálogo:
//     agregar una frase NO requiere tocar el resto del programa.
//
//  Comodines que puedes usar en cualquier frase:
//    {ausente}  → quien se va o regresa      (ej. "Ana")
//    {presente} → quien se queda solo        (ej. "Luis")
//    {motivo}   → lo que escribió al salir   (ej. "a sitio en Demo")
//
//  ⚠️ NUNCA se publican en un grupo de cliente. Solo en Soporte Interno.
// ============================================================

/** Cuando alguien se marca ausente y QUEDA un compañero solo. */
export const AL_SALIR_QUEDA_UNO = [
  '🚪 *{ausente}* se fue.\n{presente}, quedas tú solito. Échale ganas, campeón 💪\n_Los soportes no se atienden solos._',
  '🚪 *{ausente}* abandonó la partida.\n{presente} entra en modo supervivencia 🎮',
  '🚪 *{ausente}* salió.\n{presente}, hoy tú eres el departamento de sistemas completo 🫡',
  '🚪 Se fue *{ausente}*.\n{presente}: 1 persona, 0 refuerzos, ∞ tickets. Tú puedes 🔥',
  '🚪 *{ausente}* está fuera.\n{presente}, esto no es una carga de trabajo, es una *oportunidad de crecimiento* ✨',
  '🚪 *{ausente}* salió del chat.\n{presente} ha sido ascendido a *Único Responsable de Todo* (sin aumento) 📈',
  '🚪 *{ausente}* se fue a la calle.\n{presente}, respira. Ya casi es viernes... no, es cierto, no 😌',
  '🚪 POV: eres *{presente}* y *{ausente}* acaba de salir 🎥',
  '🚪 *{ausente}* no está disponible.\n{presente}, el equipo confía en ti. El equipo eres tú ⚡',
  '🚪 *{ausente}* salió por {motivo}.\n{presente} queda a cargo del imperio 👑',
  '🚪 *{ausente}* se fue.\n{presente}, recuerda: la presión hace diamantes 💎 (y también hace renunciar, pero no pensemos en eso)',
  '🚪 *{ausente}* activó modo fantasma 👻\n{presente}, los tickets ahora son todos tuyos. De nada.',
  '🚪 Se reporta la ausencia de *{ausente}*.\n{presente} pasa oficialmente de técnico a *héroe* 🦸',
  '🚪 *{ausente}* out.\n{presente} in. Que empiece el espectáculo 🍿',
];

/** Cuando alguien se marca ausente y NO queda nadie disponible. */
export const AL_SALIR_NADIE_QUEDA = [
  '🚪 *{ausente}* también se fue.\n⚠️ No queda nadie disponible. Los soportes van a caer *sin asignar*.',
  '🚪 Con *{ausente}* fuera, el equipo disponible es: nadie 🫥\nLos tickets nuevos quedan sin dueño hasta que alguien regrese.',
  '🚪 *{ausente}* salió y apagó la luz 💡\n⚠️ Nadie disponible: lo que entre queda esperando.',
];

/** Cuando alguien vuelve y su compañero ya la estaba sufriendo. */
export const AL_VOLVER = [
  '✅ *{ausente}* ya volvió.\n{presente}, ya puedes respirar. El sufrimiento fue temporal 😮‍💨',
  '✅ Regresó *{ausente}*.\n{presente} sobrevivió. Merece un aplauso 👏',
  '✅ *{ausente}* está de vuelta.\nSe reanuda el reparto justo de tickets. La explotación se divide entre dos 🤝',
  '✅ *{ausente}* volvió al ruedo 🐂\n{presente}, tu turno de héroe terminó.',
  '✅ *{ausente}* reapareció.\n{presente}, ya no eres el departamento completo. Bienvenido de vuelta a la normalidad 🙏',
  '✅ *{ausente}* ya está disponible.\nEl equipo vuelve a ser un equipo 🧩',
  '✅ Volvió *{ausente}*.\n{presente} ya puede ir por su café sin culpa ☕',
];

/** Cuando vuelve alguien y era el ÚNICO ausente... o el primero en volver. */
export const AL_VOLVER_SIN_NADIE = [
  '✅ *{ausente}* volvió y ya hay quien atienda. Se acabó la temporada de tickets huérfanos 🎟️',
  '✅ *{ausente}* está de vuelta. Ya hay alguien al volante 🚗',
];

/** Cuando entra un soporte y NADIE está disponible. */
export const SOPORTE_SIN_NADIE = [
  '⚠️ Entró un soporte y no hay nadie disponible.\nQueda *sin asignar*: el primero que vuelva lo toma 🎫',
  '⚠️ Soporte nuevo sin dueño: todo el equipo está fuera.\nAhí les encarga el cliente 👀',
  '⚠️ Llegó trabajo y la oficina está vacía 🏚️\nTicket registrado sin responsable.',
];

/**
 * Elige una frase al azar y la rellena.
 * Evita repetir la última usada de esa misma lista: no hay nada menos
 * gracioso que el mismo chiste dos veces seguidas.
 */
const ultimas = new Map<string[], number>();

export function frase(
  lista: string[],
  datos: { ausente: string; presente?: string | null; motivo?: string | null },
): string {
  let i = Math.floor(Math.random() * lista.length);
  if (lista.length > 1 && i === ultimas.get(lista)) i = (i + 1) % lista.length;
  ultimas.set(lista, i);

  return lista[i]
    .replaceAll('{ausente}', datos.ausente)
    .replaceAll('{presente}', datos.presente ?? 'el equipo')
    .replaceAll('{motivo}', datos.motivo ?? 'pendientes');
}
