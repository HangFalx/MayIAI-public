export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string, exactly as produced by the model. */
  arguments: string;
  /** Opaque provider data that must be echoed back (Gemini thought signatures). */
  extraContent?: unknown;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
        extra_content?: unknown;
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'usage'; promptTokens: number; cachedTokens: number };

export interface StreamOptions {
  /** Ask for token usage (incl. cached prompt tokens); emitted as a `usage` event at the end. */
  usage?: boolean;
}

/** One streamed completion. Must honour `signal` and throw AbortError when cancelled. */
export interface LlmProvider {
  /** `forceTool`: the model must call this function in this round. */
  stream(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal, forceTool?: string, options?: StreamOptions): AsyncGenerator<LlmEvent>;
}
