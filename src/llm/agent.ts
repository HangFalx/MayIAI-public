import { createLogger } from '../utils/logger';
import { buildSystemPrompt } from './systemPrompt';
import { executeToolCall, TOOL_DEFINITIONS, type ToolContext, type ToolResult } from './tools';
import type { ChatMessage, LlmProvider, ToolCall, ToolDefinition } from './types';

const log = createLogger('llm:agent');
const MAX_TOOL_ROUNDS = 4;

export interface RespondHooks {
  onToolCall?: (calls: ToolCall[]) => void;
  onToolResult?: (call: ToolCall, result: ToolResult) => void;
}

export interface AgentOptions {
  /** Tools offered to the model; an empty list gives the prompt-only baseline. */
  tools?: ToolDefinition[];
  systemPrompt?: string;
}

/**
 * Owns the conversation history of one call and runs the
 * LLM stream -> tool call -> tool result -> LLM stream loop.
 */
export class ConversationAgent {
  readonly messages: ChatMessage[];
  private readonly tools: ToolDefinition[];
  private readonly toolContext: ToolContext = {};

  constructor(private readonly provider: LlmProvider, options: AgentOptions = {}) {
    this.tools = options.tools ?? TOOL_DEFINITIONS;
    const prompt = options.systemPrompt ?? buildSystemPrompt({ tools: this.tools.length > 0 });
    this.messages = [{ role: 'system', content: prompt }];
  }

  addAssistantMessage(text: string): void {
    this.messages.push({ role: 'assistant', content: text });
  }

  /** Yields assistant text deltas. Throws AbortError when `signal` fires (barge-in). */
  async *respond(userText: string, signal: AbortSignal, hooks: RespondHooks = {}): AsyncGenerator<string> {
    this.messages.push({ role: 'user', content: userText });
    let retriedEmpty = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let text = '';
      let toolCalls: ToolCall[] = [];
      try {
        for await (const event of this.provider.stream(this.messages, this.tools, signal)) {
          if (event.type === 'text') {
            text += event.text;
            yield event.text;
          } else if (event.type === 'tool_calls') {
            toolCalls = event.calls;
          }
        }
      } finally {
        // Keep what was already spoken, so the model knows where it was interrupted.
        if (signal.aborted && text.trim()) this.messages.push({ role: 'assistant', content: `${text.trim()} …` });
      }
      signal.throwIfAborted();

      if (toolCalls.length === 0) {
        // An empty reply would leave the caller in silence: ask once more.
        if (!text.trim() && !retriedEmpty) {
          retriedEmpty = true;
          log.warn(`empty reply in round ${round}, retrying`);
          round--;
          continue;
        }
        this.messages.push({ role: 'assistant', content: text });
        return;
      }
      hooks.onToolCall?.(toolCalls);

      this.messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
          ...(c.extraContent !== undefined ? { extra_content: c.extraContent } : {}),
        })),
      });
      // Every tool call needs its result in the history, otherwise the next request is rejected.
      const direct: string[] = [];
      for (const call of toolCalls) {
        this.toolContext.callerTexts = this.messages.flatMap((m) => (m.role === 'user' ? [m.content] : []));
        const result = await executeToolCall(call, this.toolContext);
        log.info(`tool ${call.name} ->`, result);
        hooks.onToolResult?.(call, result);
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        if (typeof result.kimondando === 'string') direct.push(result.kimondando);
      }
      signal.throwIfAborted();
      // A tool that already knows the exact next sentence saves a whole model round.
      if (direct.length === toolCalls.length) {
        const say = direct.join(' ');
        yield say;
        this.messages.push({ role: 'assistant', content: say });
        return;
      }
    }
    log.warn('max tool rounds reached');
  }
}
