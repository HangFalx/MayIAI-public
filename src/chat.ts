import readline from 'node:readline/promises';
import { config, llmConfigured } from './config';
import { ConversationAgent, createLlmProvider } from './llm';
import { RuleBasedProvider } from './llm/ruleBasedProvider';
import { trustSystemCertificates } from './utils/systemCa';

/**
 * Text-only conversation with the assistant (no telephony, STT or TTS).
 *   npm run chat                  LLM + tools (the full assistant)
 *   npm run chat -- --no-tools    baseline B1: same LLM and prompt, no calendar tools
 *   npm run chat -- --rules       baseline B0: rule-based dialogue manager
 */
async function main(): Promise<void> {
  trustSystemCertificates();
  const rules = process.argv.includes('--rules');
  if (!rules && !llmConfigured()) throw new Error('Set GEMINI_API_KEY or OPENAI_API_KEY in .env (or use --rules).');
  const agent = new ConversationAgent(rules ? new RuleBasedProvider() : createLlmProvider(), {
    ...(process.argv.includes('--no-tools') ? { tools: [] } : {}),
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Asszisztens: ${config.greeting}`);
  agent.addAssistantMessage(config.greeting);
  for (;;) {
    const text = (await rl.question('Ön: ')).trim();
    if (!text || text === '/exit') break;
    process.stdout.write('Asszisztens: ');
    const hooks = {
      onToolCall: (calls: Array<{ name: string; arguments: string }>) =>
        console.log(`\n  [tool] ${calls.map((c) => `${c.name}(${c.arguments})`).join(', ')}`),
    };
    for await (const token of agent.respond(text, new AbortController().signal, hooks)) process.stdout.write(token);
    process.stdout.write('\n');
  }
  rl.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
