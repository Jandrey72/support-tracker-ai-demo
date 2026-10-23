import type {
  AnalysisContext,
  AIAnalysisResult,
  IAIProvider,
} from '../../domain/types.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseAnalysis } from '../prompt.js';

/**
 * Proveedor Google Gemini (API generateContent).
 */
export class GeminiProvider implements IAIProvider {
  readonly name = 'gemini';
  readonly model: string;

  constructor(
    private readonly apiKey: string,
    model: string,
  ) {
    this.model = model;
  }

  async analyze(context: AnalysisContext): Promise<AIAnalysisResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(context) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 512,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');

    return parseAnalysis(text);
  }
}
