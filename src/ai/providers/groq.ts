import type {
  AnalysisContext,
  AIAnalysisResult,
  IAIProvider,
} from '../../domain/types.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseAnalysis } from '../prompt.js';

/**
 * Proveedor Groq (API compatible con OpenAI, modelos Llama, capa gratuita).
 */
export class GroqProvider implements IAIProvider {
  readonly name = 'groq';
  readonly model: string;

  constructor(
    private readonly apiKey: string,
    model: string,
  ) {
    this.model = model;
  }

  async analyze(context: AnalysisContext): Promise<AIAnalysisResult> {
    const res = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          // Los modelos que "razonan" (gpt-oss) gastan tokens PENSANDO antes
          // de contestar, y salen del mismo límite. Con 512 a veces no les
          // alcanzaba para escribir el JSON y el mensaje se perdía
          // ("max completion tokens reached before generating a valid
          // document", 23-sep). Medido ese día: con razonamiento "low" usa
          // 105-179 tokens (con el "medium" de antes, 212-319 y a veces más).
          // 1024 deja margen de sobra. No subirlo de más: Groq APARTA el
          // max_tokens completo de su límite de 8000 tokens por minuto, y
          // con varios mensajes seguidos el bot chocaría con ese límite.
          max_tokens: 1024,
          // Clasificar un mensaje no requiere pensar mucho: menos razonamiento
          // = más rápido y menos riesgo de quedarse sin espacio. Solo se manda
          // a modelos que lo aceptan; a uno que no razona le daría error.
          ...(this.model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(context) },
          ],
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`Groq API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? '';

    return parseAnalysis(text);
  }
}
