import 'dotenv/config';

export type LlmProviderName = 'gemini' | 'openai';

function str(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function loadConfig() {
  const llmProvider = str('LLM_PROVIDER', 'gemini').toLowerCase();
  if (llmProvider !== 'gemini' && llmProvider !== 'openai') {
    throw new Error(`LLM_PROVIDER must be "gemini" or "openai", got "${llmProvider}"`);
  }

  return {
    logLevel: str('LOG_LEVEL', 'info'),

    businessName: str('BUSINESS_NAME', 'Belvárosi Magánklinika'),
    timezone: str('TIMEZONE', 'Europe/Budapest'),
    greeting: str('GREETING', 'Jó napot kívánok, a Belvárosi Magánklinika virtuális asszisztense vagyok. Miben segíthetek?'),

    llmProvider: llmProvider as LlmProviderName,

    openai: {
      apiKey: str('OPENAI_API_KEY'),
      model: str('OPENAI_MODEL', 'gpt-4o-mini'),
      reasoningEffort: str('OPENAI_REASONING_EFFORT'),
      baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    },

    gemini: {
      apiKey: str('GEMINI_API_KEY'),
      model: str('GEMINI_MODEL', 'gemini-3.8-flash'),
      reasoningEffort: str('GEMINI_REASONING_EFFORT', 'low'),
      /** With a project and key, Gemini runs on Vertex AI; location "eu" keeps processing inside the EU. */
      vertexProject: str('GEMINI_VERTEX_PROJECT'),
      vertexLocation: str('GEMINI_VERTEX_LOCATION', 'eu'),
      vertexApiKey: str('GEMINI_VERTEX_API_KEY'),
    },
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

export const config: AppConfig = loadConfig();

export function llmConfigured(c: AppConfig = config): boolean {
  if (c.llmProvider === 'openai') return !!c.openai.apiKey;
  return !!c.gemini.apiKey || !!(c.gemini.vertexProject && c.gemini.vertexApiKey);
}
