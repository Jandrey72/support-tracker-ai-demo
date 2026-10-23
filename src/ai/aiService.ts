import type { IAIProvider } from '../domain/types.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ClaudeProvider } from './providers/claude.js';
import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { GroqProvider } from './providers/groq.js';

/**
 * Crea el proveedor de IA segun AI_PROVIDER.
 * Devuelve null (con aviso) si falta la API key, para que el bot
 * siga guardando mensajes aunque la IA no este configurada.
 */
function createProvider(): IAIProvider | null {
  switch (env.AI_PROVIDER) {
    case 'claude':
      if (!env.CLAUDE_API_KEY) return warnMissing('CLAUDE_API_KEY');
      return new ClaudeProvider(env.CLAUDE_API_KEY, env.CLAUDE_MODEL);

    case 'openai':
      if (!env.OPENAI_API_KEY) return warnMissing('OPENAI_API_KEY');
      return new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL);

    case 'gemini':
      if (!env.GEMINI_API_KEY) return warnMissing('GEMINI_API_KEY');
      return new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL);

    case 'deepseek':
      if (!env.DEEPSEEK_API_KEY) return warnMissing('DEEPSEEK_API_KEY');
      return new DeepSeekProvider(env.DEEPSEEK_API_KEY, env.DEEPSEEK_MODEL);

    case 'groq':
      if (!env.GROQ_API_KEY) return warnMissing('GROQ_API_KEY');
      return new GroqProvider(env.GROQ_API_KEY, env.GROQ_MODEL);

    default:
      return null;
  }
}

function warnMissing(key: string): null {
  logger.warn(
    `⚠️  Falta ${key} en tu .env. La IA quedara DESACTIVADA: se guardaran los mensajes pero no se detectaran soportes automaticamente.`,
  );
  return null;
}

// Creamos el proveedor una sola vez (singleton).
let provider: IAIProvider | null | undefined;

export function getAIProvider(): IAIProvider | null {
  if (provider === undefined) {
    provider = createProvider();
    if (provider) {
      logger.info(
        `🧠 IA activa: proveedor "${provider.name}", modelo "${provider.model}".`,
      );
    }
  }
  return provider;
}
