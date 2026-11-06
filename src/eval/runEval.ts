import fs from 'node:fs';
import path from 'node:path';
import { type Appointment, calendar } from '../booking/calendar';
import { doctorByName, serviceById, serviceByName } from '../booking/catalog';
import { nameScore } from '../booking/nameMatch';
import { config, llmConfigured } from '../config';
import { ConversationAgent, createLlmProvider, llmModelName } from '../llm';
import { RuleBasedProvider } from '../llm/ruleBasedProvider';
import { TOOL_DEFINITIONS, type ToolResult } from '../llm/tools';
import type { ChatMessage, LlmEvent, LlmProvider, StreamOptions, ToolDefinition } from '../llm/types';
import { addDays, nowInTimezone, weekdayOf } from '../utils/time';
import { trustSystemCertificates } from '../utils/systemCa';
import { mentions, validateArguments } from './checks';

type SystemId = 'rules' | 'no-tools' | 'llm-tools';

interface Seed { service: string; doctor: string; weekday: number; time: string; name: string }

interface Expect {
  tools?: string[];
  booking?: { service: string[]; doctor?: string; weekday?: number[]; partOfDay?: 'delelott' | 'delutan'; after?: string; time?: string; notTime?: string; name: string };
  noBooking?: boolean;
  cancelled?: string[];
  kept?: string[];
  say?: string[][];
  notSay?: string[];
}

interface Scenario { id: string; set?: 'core' | 'hard'; category: string; turns: string[]; seed?: Seed[]; expect: Expect }

interface ToolCallRecord { name: string; arguments: string; schemaErrors: string[]; ok: boolean; error?: string }

interface ScenarioResult {
  id: string;
  set: 'core' | 'hard';
  category: string;
  system: SystemId;
  run: number;
  success: boolean;
  failures: string[];
  toolCalls: ToolCallRecord[];
  expectedToolsHit: number;
  expectedToolsTotal: number;
  /** The reply claims a booking or cancellation that no successful tool call backs. */
  hallucinatedConfirmation: boolean;
  llmRequests: number;
  turnMs: number[];
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
  error?: string;
}

const CONFIRM_RE = /(lefoglaltam|rögzítettem|foglalását rögzít|sikeresen lefoglal|le is foglaltam|lemondtam|le is mondtam|töröltem)/i;

/** Counts model requests; the rule-based baseline counts as one "request" per decision too. */
class CountingProvider implements LlmProvider {
  requests = 0;
  constructor(private readonly inner: LlmProvider) {}
  stream(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal, forceTool?: string, options?: StreamOptions): AsyncGenerator<LlmEvent> {
    this.requests++;
    return this.inner.stream(messages, tools, signal, forceTool, options);
  }
}

/** The first date from tomorrow that falls on `weekday` (and is bookable). */
function nextWeekday(weekday: number): string {
  const today = nowInTimezone(config.timezone).date;
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, i);
    if (weekdayOf(d) === weekday) return d;
  }
  throw new Error(`bad weekday ${weekday}`);
}

function seedAppointments(seeds: Seed[] = []): Appointment[] {
  return seeds.map((s, i) => {
    const service = serviceByName(s.service);
    const doctor = doctorByName(s.doctor);
    if (!service || !doctor) throw new Error(`unknown seed service/doctor: ${s.service} / ${s.doctor}`);
    const kezdes = `${nextWeekday(s.weekday)}T${s.time}`;
    const endMin = Number(s.time.slice(0, 2)) * 60 + Number(s.time.slice(3)) + service.idotartam_perc;
    const veg = `${kezdes.slice(0, 11)}${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
    return {
      idopont_id: `Iseed${i}`,
      orvos_id: doctor.orvos_id,
      szolgaltatas_id: service.szolgaltatas_id,
      kezdes,
      veg,
      paciens_nev: s.name,
      forras: 'teszt',
      letrehozva: new Date().toISOString(),
    };
  });
}

function checkOutcome(s: Scenario, seeds: Appointment[], replies: string, calls: ToolCallRecord[]): string[] {
  const failures: string[] = [];
  const e = s.expect;
  const after = calendar.list();
  const created = after.filter((a) => a.forras === 'asszisztens');
  const seedGone = (name: string) => {
    const seed = seeds.find((a) => a.paciens_nev === name);
    return seed !== undefined && !after.some((a) => a.idopont_id === seed.idopont_id);
  };

  if (e.booking) {
    const b = e.booking;
    if (created.length !== 1) failures.push(`expected 1 new booking, found ${created.length}`);
    const a = created[0];
    if (a) {
      const service = serviceById(a.szolgaltatas_id)?.szolgaltatas ?? '';
      const time = a.kezdes.slice(11, 16);
      if (!b.service.includes(service)) failures.push(`service: ${service}`);
      if (b.doctor && doctorByName(b.doctor)?.orvos_id !== a.orvos_id) failures.push('doctor mismatch');
      if (b.weekday && !b.weekday.includes(weekdayOf(a.kezdes.slice(0, 10)))) failures.push(`weekday: ${weekdayOf(a.kezdes.slice(0, 10))}`);
      if (b.partOfDay === 'delelott' && time >= '12:00') failures.push(`not morning: ${time}`);
      if (b.partOfDay === 'delutan' && time < '12:00') failures.push(`not afternoon: ${time}`);
      if (b.after && time < b.after) failures.push(`before ${b.after}: ${time}`);
      if (b.time && time !== b.time) failures.push(`time: ${time}`);
      if (b.notTime && time === b.notTime) failures.push(`booked the taken time ${time}`);
      if (nameScore(a.paciens_nev, b.name) < 0.8) failures.push(`name: ${a.paciens_nev}`);
    }
  }
  if (e.noBooking && created.length > 0) failures.push(`unexpected booking (${created.length})`);
  for (const name of e.cancelled ?? []) if (!seedGone(name)) failures.push(`not cancelled: ${name}`);
  for (const name of e.kept ?? []) if (seedGone(name)) failures.push(`wrongly cancelled: ${name}`);
  for (const group of e.say ?? []) if (!mentions(replies, group)) failures.push(`missing: ${group.join(' | ')}`);
  for (const pattern of e.notSay ?? []) if (new RegExp(pattern, 'i').test(replies)) failures.push(`should not say /${pattern}/`);
  const called = new Set(calls.map((c) => c.name));
  for (const tool of e.tools ?? []) if (!called.has(tool)) failures.push(`tool not called: ${tool}`);
  return failures;
}

async function runScenario(s: Scenario, system: SystemId, run: number): Promise<ScenarioResult> {
  const seeds = seedAppointments(s.seed);
  calendar.useMemory(seeds);
  const provider = new CountingProvider(system === 'rules' ? new RuleBasedProvider() : createLlmProvider());
  const tools = system === 'no-tools' ? [] : TOOL_DEFINITIONS;
  const agent = new ConversationAgent(provider, { tools });
  agent.addAssistantMessage(config.greeting);

  const calls: ToolCallRecord[] = [];
  const transcript: ScenarioResult['transcript'] = [];
  const turnMs: number[] = [];
  let error: string | undefined;
  let replies = '';

  for (const turn of s.turns) {
    transcript.push({ role: 'user', text: turn });
    const started = Date.now();
    let reply = '';
    try {
      const hooks = {
        onToolResult: (call: { name: string; arguments: string }, result: ToolResult) => {
          const failed = result.siker === false || typeof result.hiba === 'string';
          calls.push({
            name: call.name,
            arguments: call.arguments,
            schemaErrors: validateArguments(TOOL_DEFINITIONS, call.name, call.arguments),
            ok: !failed,
            ...(failed ? { error: String(result.hiba ?? 'failed') } : {}),
          });
        },
      };
      for await (const token of agent.respond(turn, AbortSignal.timeout(60000), hooks)) reply += token;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      transcript.push({ role: 'assistant', text: `[error] ${error}` });
      break;
    }
    turnMs.push(Date.now() - started);
    transcript.push({ role: 'assistant', text: reply });
    replies += ` ${reply}`;
  }

  const failures = error ? [`error: ${error}`] : checkOutcome(s, seeds, replies, calls);
  const backed = calls.some((c) => c.ok && (c.name === 'book_appointment' || c.name === 'cancel_appointment'));
  const expected = s.expect.tools ?? [];
  return {
    id: s.id,
    set: s.set ?? 'core',
    category: s.category,
    system,
    run,
    success: failures.length === 0,
    failures,
    toolCalls: calls,
    expectedToolsHit: expected.filter((t) => calls.some((c) => c.name === t)).length,
    expectedToolsTotal: expected.length,
    hallucinatedConfirmation: CONFIRM_RE.test(replies) && !backed,
    llmRequests: provider.requests,
    turnMs,
    transcript,
    ...(error ? { error } : {}),
  };
}

const pct = (n: number, d: number) => (d === 0 ? '–' : `${((100 * n) / d).toFixed(1)}%`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function summarize(results: ScenarioResult[], systems: SystemId[], categories: string[]) {
  return systems.map((system) => {
    const rs = results.filter((r) => r.system === system);
    const calls = rs.flatMap((r) => r.toolCalls);
    const byCategory = Object.fromEntries(categories.map((c) => {
      const cr = rs.filter((r) => r.category === c);
      return [c, { success: cr.filter((r) => r.success).length, total: cr.length }];
    }));
    const runs = [...new Set(rs.map((r) => r.run))];
    const perRun = runs.map((run) => {
      const rr = rs.filter((r) => r.run === run);
      return rr.filter((r) => r.success).length / rr.length;
    });
    return {
      system,
      scenarios: rs.length,
      success: rs.filter((r) => r.success).length,
      successRatePerRun: perRun,
      byCategory,
      toolCalls: calls.length,
      schemaValidCalls: calls.filter((c) => c.schemaErrors.length === 0).length,
      successfulCalls: calls.filter((c) => c.ok).length,
      expectedToolsHit: rs.reduce((a, r) => a + r.expectedToolsHit, 0),
      expectedToolsTotal: rs.reduce((a, r) => a + r.expectedToolsTotal, 0),
      hallucinatedConfirmations: rs.filter((r) => r.hallucinatedConfirmation).length,
      errors: rs.filter((r) => r.error).length,
      meanTurnMs: Math.round(mean(rs.flatMap((r) => r.turnMs))),
      meanLlmRequestsPerTurn: Number(mean(rs.map((r) => r.llmRequests / Math.max(1, r.turnMs.length))).toFixed(2)),
    };
  });
}

function markdown(summary: ReturnType<typeof summarize>, categories: string[], title: string): string {
  const names: Record<SystemId, string> = { rules: 'B0 rule-based', 'no-tools': 'B1 LLM without tools', 'llm-tools': 'LLM + tool calling' };
  const lines = [
    `## ${title}`,
    '',
    `| System | Task success | ${categories.join(' | ')} | Expected tools called | Schema-valid calls | Successful calls | Hallucinated confirmations | Mean turn latency | LLM requests / turn |`,
    `|---|---|${categories.map(() => '---').join('|')}|---|---|---|---|---|---|`,
  ];
  for (const s of summary) {
    const cats = categories.map((c) => `${s.byCategory[c].success}/${s.byCategory[c].total}`);
    lines.push(`| ${names[s.system as SystemId]} | ${pct(s.success, s.scenarios)} (${s.success}/${s.scenarios}) | ${cats.join(' | ')} | ${pct(s.expectedToolsHit, s.expectedToolsTotal)} | ${pct(s.schemaValidCalls, s.toolCalls)} | ${pct(s.successfulCalls, s.toolCalls)} | ${s.hallucinatedConfirmations} | ${s.meanTurnMs} ms | ${s.meanLlmRequestsPerTurn} |`);
  }
  return lines.join('\n') + '\n';
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  trustSystemCertificates();
  process.env.LOG_LEVEL ??= 'warn';
  const systems = (arg('systems') ?? 'rules,no-tools,llm-tools').split(',') as SystemId[];
  const runs = Number(arg('runs') ?? 1);
  const only = arg('only');
  if (systems.some((s) => s !== 'rules') && !llmConfigured()) throw new Error('Set GEMINI_API_KEY or OPENAI_API_KEY in .env, or run with --systems rules');

  const all = JSON.parse(fs.readFileSync(path.resolve('eval', 'scenarios.json'), 'utf-8')) as Scenario[];
  const scenarios = only ? all.filter((s) => s.id.startsWith(only)) : all;
  const results: ScenarioResult[] = [];

  for (const system of systems) {
    // The rule-based baseline is deterministic: one run is enough.
    const n = system === 'rules' ? 1 : runs;
    for (let run = 1; run <= n; run++) {
      for (const s of scenarios) {
        const r = await runScenario(s, system, run);
        results.push(r);
        console.log(`${system.padEnd(9)} run ${run} ${s.id.padEnd(11)} ${r.success ? 'OK  ' : 'FAIL'} ${r.failures.join('; ')}`);
      }
    }
  }

  const model = llmModelName();
  const sets: Array<{ title: string; filter: (r: ScenarioResult) => boolean }> = [
    { title: 'Core set', filter: (r) => r.set === 'core' },
    { title: 'Hard set (paraphrases, number words, implicit intents)', filter: (r) => r.set === 'hard' },
    { title: 'All scenarios', filter: () => true },
  ];
  const summaries = sets
    .map((s) => ({ title: s.title, results: results.filter(s.filter) }))
    .filter((s) => s.results.length > 0)
    .map((s) => {
      const cats = [...new Set(s.results.map((r) => r.category))];
      return { title: s.title, categories: cats, summary: summarize(s.results, systems, cats) };
    });
  const report = [
    '# Evaluation results',
    '',
    `LLM: ${config.llmProvider} / ${model}, runs per LLM system: ${runs}, date: ${new Date().toISOString().slice(0, 10)}`,
    '',
    ...summaries.map((s) => markdown(s.summary, s.categories, s.title)),
  ].join('\n');
  const outDir = path.resolve('results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ model, date: new Date().toISOString(), summaries, results }, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.md'), report);
  console.log('\n' + report);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
