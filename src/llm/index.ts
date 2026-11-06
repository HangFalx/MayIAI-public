import { config } from '../config';
import { geminiOptions, OpenAiCompatibleProvider, openAiOptions } from './openaiProvider';
import type { LlmProvider } from './types';

export function createLlmProvider(): LlmProvider {
  return new OpenAiCompatibleProvider(config.llmProvider === 'gemini' ? geminiOptions() : openAiOptions());
}

export function llmModelName(): string {
  return config.llmProvider === 'gemini' ? config.gemini.model : config.openai.model;
}

export { ConversationAgent } from './agent';
