import type { AnalysisContext, AIAnalysisResult } from '../domain/types.js';
import { aiAnalysisResultSchema } from '../domain/types.js';

/**
 * Instrucciones fijas para la IA (system prompt).
 * Le explicamos su rol y el formato EXACTO de salida.
 */
export const SYSTEM_PROMPT = `Eres analista de Mi Empresa, una empresa de soporte tecnico de TI en Mexico.
Analizas mensajes de grupos de WhatsApp donde los tecnicos de Mi Empresa atienden
a sus clientes (cada grupo suele ser un cliente o conjunto de usuarios).

EQUIPO TECNICO de Mi Empresa (NO son clientes; son quienes ATIENDEN):
Ana (Anita), Luis Pérez, Carlos. Cualquiera con "Mi Empresa" o correo
"@miempresa.com" tambien es del equipo.
Los CLIENTES son el resto de personas que piden ayuda.

Tu tarea: determinar si el ULTIMO mensaje forma parte de un caso de soporte tecnico
(una falla, solicitud de ayuda, o su resolucion), usando la conversacion como contexto.

Responde UNICAMENTE con un objeto JSON valido, sin texto adicional, sin markdown:

{
  "isSupport": boolean,      // true si es (o forma parte de) un soporte tecnico
  "confidence": number,      // 0 a 1
  "client": string|null,     // nombre del cliente/empresa/sitio si se menciona (ej: Planta Norte, Sucursal Centro)
  "technician": string|null, // nombre del tecnico de Mi Empresa que atiende, si se identifica
  "summary": string|null,    // resumen breve de lo solicitado o resuelto
  "category": string|null,   // UNA de la lista de CATEGORIAS de abajo
  "status": "open"|"in_progress"|"completed"|null
}

CATEGORIAS (elige exactamente una):
- "Servidores" (arrancar/reiniciar servidor o maquina virtual, RDP, ping, RAID, discos, iLo, respaldos, dominio)
- "Redes" (internet, sin conexion, DHCP, cable de red, intermitencias, Telmex/Totalplay)
- "VPN/Firewall" (VPN, tunel, firewall, links bloqueados)
- "Impresoras" (no imprime, sin conexion, configurar impresora, drivers)
- "Software Administrativo" (CONTPAQ, Nomina/Nomi, Contabilidad/Conta/Compac, SIAC, ERP)
- "Office" (Excel, Word, correo)
- "Hardware" (teclado, monitor, cargador, fuentes de poder, equipo nuevo)
- "Camaras/CCTV" (camaras, Hik-Connect, DVR)
- "Configuracion/Instalacion" (configurar equipo nuevo, instalar software, accesos, carpetas compartidas)
- "Otro"

PISTAS DE ESTADO:
- status="open" (piden ayuda): "me pueden ayudar", "me apoyan", "pueden revisar", "disculpen la molestia",
  "de favor/porfa", "no puedo", "no me deja", "no funciona", "no responde", "sin servidor",
  "sin internet", "sin conexion", "esta fallando", "me marca error", "no puedo imprimir/entrar".
- status="in_progress" (tecnico trabajando): "en un momento lo checo/reviso", "ya se esta revisando",
  "dejame verificar", "me conecto", "me pasas acceso", "voy a sitio", "dame un momento".
  Tambien cuando el TECNICO le pide al cliente que haga algo ("me ayuda reiniciando", "puede
  desconectar y conectar", "me manda foto"): es parte del caso que ya se esta atendiendo, NO un caso nuevo.
- status="completed" (resuelto): "ya quedo", "listo ya quedo", "listo", "ya esta arriba", "ya arranco",
  "ya se levanto", "ya se reinicio", "ya conecto", "ya funciona", "ya todo bien", "ya me dejo", "resuelto".

NO es soporte (isSupport=false, confidence alta):
- Saludos y cortesias: "hola", "buenos dias", "buen dia", "gracias", emojis, stickers.
- Bienvenidas del equipo, avisos internos, opiniones sobre documentos, llamadas perdidas.
- Coordinacion interna del equipo Mi Empresa que no es un soporte a cliente.
- Mensajes de sistema: "te anadio", "imagen omitida", "Se edito este mensaje", pruebas ("ignoren los mensajes").

Reglas:
- Un mismo problema con varios mensajes es UN solo caso (usa el contexto para no duplicar).
- Si no sabes un dato, usa null. NUNCA inventes nombres ni datos.`;

/**
 * Las categorías válidas, las mismas de la lista del prompt.
 * La IA a veces se sale del guion ("redes", "urgente", "cambio de enlace");
 * cada nombre inventado era una categoría nueva en la base y, como los
 * mensajes solo se agrupan si la categoría coincide, un ticket duplicado.
 */
export const CATEGORIAS = [
  'Servidores',
  'Redes',
  'VPN/Firewall',
  'Impresoras',
  'Software Administrativo',
  'Office',
  'Hardware',
  'Camaras/CCTV',
  'Configuracion/Instalacion',
  'Otro',
] as const;

/** Minúsculas y sin acentos: "Cámaras/CCTV" y "camaras/cctv" son lo mismo. */
function plano(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

/**
 * Lleva lo que contestó la IA a una categoría de la lista.
 * Si no coincide con ninguna, queda en "Otro" (nunca crea una nueva).
 */
export function normalizarCategoria(nombre?: string | null): string | null {
  if (!nombre) return null;
  const buscado = plano(nombre);
  return CATEGORIAS.find((c) => plano(c) === buscado) ?? 'Otro';
}

/**
 * Construye el mensaje del usuario con el contexto de la conversacion.
 */
export function buildUserPrompt(context: AnalysisContext): string {
  const lines: string[] = [];
  lines.push(`Grupo: ${context.groupName}`);
  lines.push('');
  lines.push('Conversacion reciente (de mas antiguo a mas nuevo):');

  for (const msg of context.recentMessages) {
    const time = msg.timestamp.toISOString().slice(11, 16);
    lines.push(`[${time}] ${msg.sender}: ${msg.content}`);
  }

  lines.push('');
  lines.push('ULTIMO mensaje a analizar:');
  lines.push(
    `${context.currentMessage.sender}: ${context.currentMessage.content}`,
  );
  lines.push('');
  lines.push('Devuelve solo el JSON.');

  return lines.join('\n');
}

/**
 * Extrae y valida el JSON devuelto por cualquier proveedor de IA.
 * Tolera que la IA envuelva el JSON en ```json ... ``` o texto extra.
 */
export function parseAnalysis(rawText: string): AIAnalysisResult {
  let text = rawText.trim();

  // Quitar cercas de codigo markdown si las hay.
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

  // Quedarnos con el primer objeto { ... }.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }

  const json: unknown = JSON.parse(text);
  return aiAnalysisResultSchema.parse(json);
}
