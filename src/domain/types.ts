import { z } from 'zod';

/**
 * Estructura EXACTA que la IA debe devolver al analizar un mensaje.
 * Validamos con Zod: si la IA responde algo mal formado, lo detectamos
 * y no corrompemos la base de datos.
 */
export const aiAnalysisResultSchema = z.object({
  // ¿Este mensaje es (o forma parte de) un soporte tecnico?
  isSupport: z.boolean(),

  // Que tan segura esta la IA (0 a 1).
  confidence: z.number().min(0).max(1),

  // Datos del soporte (pueden venir vacios si aun no se sabe).
  client: z.string().nullable().optional(),
  technician: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  category: z.string().nullable().optional(),

  // Estado del caso.
  status: z
    .enum(['open', 'in_progress', 'completed'])
    .nullable()
    .optional(),
});

export type AIAnalysisResult = z.infer<typeof aiAnalysisResultSchema>;

/**
 * Contexto que le pasamos a la IA: el mensaje actual mas los
 * mensajes recientes del mismo grupo, para que entienda la conversacion.
 */
export interface AnalysisContext {
  groupName: string;
  currentMessage: {
    sender: string;
    content: string;
    timestamp: Date;
  };
  recentMessages: Array<{
    sender: string;
    content: string;
    timestamp: Date;
  }>;
}

/**
 * Interfaz que TODO proveedor de IA debe cumplir.
 * Asi podemos cambiar entre Claude, OpenAI, Gemini o DeepSeek
 * sin tocar el resto del sistema (Repository/Strategy Pattern).
 */
export interface IAIProvider {
  readonly name: string;
  readonly model: string;
  analyze(context: AnalysisContext): Promise<AIAnalysisResult>;
}
