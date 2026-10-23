import type {
  AnalysisContext,
  AIAnalysisResult,
  IAIProvider,
} from '../../domain/types.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseAnalysis } from '../prompt.js';

/**
 * Proveedor Claude (API de Anthropic).
 * Usa fetch nativo; no requiere SDK.
 */
export class ClaudeProvider implements IAIProvider {
  readonly name = 'claude';
  readonly model: string;

  constructor(
    private readonly apiKey: string,
    model: string,
  ) {
    this.model = model;
  }

  async analyze(context: AnalysisContext): Promise<AIAnalysisResult> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(context) }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Claude API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .map((block) => block.text ?? '')
      .join('');

    return parseAnalysis(text);
  }
}
