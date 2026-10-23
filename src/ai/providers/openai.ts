import type {
  AnalysisContext,
  AIAnalysisResult,
  IAIProvider,
} from '../../domain/types.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseAnalysis } from '../prompt.js';

/**
 * Proveedor OpenAI (API Chat Completions).
 */
export class OpenAIProvider implements IAIProvider {
  readonly name = 'openai';
  readonly model: string;

  constructor(
    private readonly apiKey: string,
    model: string,
  ) {
    this.model = model;
  }

  async analyze(context: AnalysisContext): Promise<AIAnalysisResult> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(context) },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? '';

    return parseAnalysis(text);
  }
}
