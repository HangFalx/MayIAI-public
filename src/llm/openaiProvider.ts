import { config } from '../config';
import { createLogger, type Logger } from '../utils/logger';
import type { ChatMessage, LlmEvent, LlmProvider, StreamOptions, ToolCall, ToolDefinition } from './types';

interface Usage {
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cached_content_token_count?: number;
}

interface ChatCompletionChunk {
  usage?: Usage | null;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
        extra_content?: unknown;
      }>;
    };
    finish_reason?: string | null;
  }>;
}

export interface OpenAiCompatibleOptions {
  name: string;
  baseUrl: string;
  /** Authentication headers of the provider. */
  authHeaders: Record<string, string>;
  model: string;
  /** Merged into the request body (provider-specific fields). */
  extraBody?: Record<string, unknown>;
  /** Send OpenAI-only fields (`strict`, `parallel_tool_calls`). */
  openAiOnlyFields: boolean;
}

export function openAiOptions(): OpenAiCompatibleOptions {
  return {
    name: 'openai',
    baseUrl: config.openai.baseUrl,
    authHeaders: { Authorization: `Bearer ${config.openai.apiKey}` },
    model: config.openai.model,
    // Reasoning models reject max_tokens; their effort setting keeps replies short and fast instead.
    extraBody: config.openai.reasoningEffort ? { reasoning_effort: config.openai.reasoningEffort } : { max_tokens: 250 },
    openAiOnlyFields: true,
  };
}

/** Gemini on Vertex AI (EU) when configured, else the Gemini Developer API. */
export function geminiVertex(): boolean {
  return !!(config.gemini.vertexProject && config.gemini.vertexApiKey);
}

/** Vertex AI names Google models with a publisher prefix. */
export function geminiModelId(model: string): string {
  return geminiVertex() && !model.includes('/') ? `google/${model}` : model;
}

/** Google Gemini through its OpenAI-compatible endpoint. */
export function geminiOptions(): OpenAiCompatibleOptions {
  const { vertexProject: project, vertexLocation: loc, vertexApiKey } = config.gemini;
  // Multi-region locations (eu, us) have their own hosts; single regions use the regional host.
  const host = /^(eu|us)$/.test(loc) ? `aiplatform.${loc}.rep.googleapis.com` : `${loc}-aiplatform.googleapis.com`;
  return {
    name: 'gemini',
    baseUrl: geminiVertex()
      ? `https://${host}/v1/projects/${project}/locations/${loc}/endpoints/openapi`
      : 'https://generativelanguage.googleapis.com/v1beta/openai',
    authHeaders: geminiVertex() ? { 'x-goog-api-key': vertexApiKey } : { Authorization: `Bearer ${config.gemini.apiKey}` },
    model: geminiModelId(config.gemini.model),
    // No max_tokens: on Gemini it also counts thinking tokens and would truncate replies.
    extraBody: config.gemini.reasoningEffort ? { reasoning_effort: config.gemini.reasoningEffort } : {},
    openAiOnlyFields: false,
  };
}

/** Chat Completions with `stream: true` (Server-Sent Events) and tool calling. */
export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly log: Logger;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.log = createLogger(`llm:${opts.name}`);
  }

  async *stream(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal, forceTool?: string, options: StreamOptions = {}): AsyncGenerator<LlmEvent> {
    const { opts, log } = this;
    const requestTools = opts.openAiOnlyFields
      ? tools
      : tools.map(({ type, function: { strict: _strict, ...fn } }) => ({ type, function: fn }));
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        ...opts.authHeaders,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        ...(requestTools.length
          ? { tools: requestTools, tool_choice: forceTool && tools.some((t) => t.function.name === forceTool) ? { type: 'function', function: { name: forceTool } } : 'auto' }
          : {}),
        ...(opts.openAiOnlyFields && requestTools.length ? { parallel_tool_calls: false } : {}),
        stream: true,
        ...(options.usage ? { stream_options: { include_usage: true } } : {}),
        // OpenAI reasoning models accept only the default temperature once they actually reason.
        ...(opts.openAiOnlyFields && opts.extraBody?.reasoning_effort && opts.extraBody.reasoning_effort !== 'none' ? {} : { temperature: 0.4 }),
        ...opts.extraBody,
      }),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`${opts.name} HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, ToolCall>();
    let usage: Usage | null = null;
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;

          let chunk: ChatCompletionChunk;
          try {
            chunk = JSON.parse(data) as ChatCompletionChunk;
          } catch {
            log.warn('unparseable SSE line', data.slice(0, 200));
            continue;
          }
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) yield { type: 'text', text: delta.content };

          const base = toolCalls.size;
          for (const [position, tc] of (delta.tool_calls ?? []).entries()) {
            // Some compatible APIs omit `index` and send each call whole in a single chunk.
            const index = tc.index ?? base + position;
            const existing = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            if (tc.extra_content !== undefined) existing.extraContent = tc.extra_content;
            toolCalls.set(index, existing);
          }
        }
      }
    } finally {
      if (signal.aborted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    if (toolCalls.size > 0) {
      const calls = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, c]) => ({ ...c, id: c.id || `call_${Date.now()}_${index}` }));
      yield { type: 'tool_calls', calls };
    }
    if (options.usage && usage) {
      const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_content_token_count ?? 0;
      yield { type: 'usage', promptTokens: usage.prompt_tokens ?? 0, cachedTokens: cached };
    }
  }
}
