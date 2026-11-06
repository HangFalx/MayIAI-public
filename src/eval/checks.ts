import type { ToolDefinition } from '../llm/types';

/** Lowercase, without spaces, dots and hyphens: "37 000 Ft" -> "37000ft", "harminchét-ezer" -> "harminchétezer". */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s.\-\u00a0\u202f,]/g, '');
}

const ONES = ['', 'egy', 'kettő', 'három', 'négy', 'öt', 'hat', 'hét', 'nyolc', 'kilenc'];
const TENS = ['', 'tíz', 'húsz', 'harminc', 'negyven', 'ötven', 'hatvan', 'hetven', 'nyolcvan', 'kilencven'];
const TENS_PREFIX = ['', 'tizen', 'huszon', 'harminc', 'negyven', 'ötven', 'hatvan', 'hetven', 'nyolcvan', 'kilencven'];

function below1000(n: number, final: boolean): string {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  const one = (d: number) => (d === 2 && !final ? 'két' : ONES[d]);
  const hundreds = h === 0 ? '' : `${h === 1 ? '' : h === 2 ? 'két' : ONES[h]}száz`;
  const tens = o === 0 ? TENS[t] : TENS_PREFIX[t];
  return hundreds + tens + one(o);
}

/** Hungarian number words, as a TTS-friendly reply would say a price: 37000 -> "harminchétezer". */
export function hungarianNumber(n: number): string {
  if (n < 1000) return below1000(n, true);
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  return `${thousands === 1 ? '' : below1000(thousands, false)}ezer${rest ? below1000(rest, true) : ''}`;
}

/** The ways a reply may contain an expected fact; numbers also in words and in "37 ezer" form. */
export function variants(expected: string): string[] {
  if (!/^\d+$/.test(expected)) return [normalize(expected)];
  const n = Number(expected);
  const out = [expected, hungarianNumber(n)];
  if (n >= 1000 && n % 1000 === 0) out.push(`${n / 1000}ezer`);
  return out;
}

export function mentions(reply: string, alternatives: string[]): boolean {
  const text = normalize(reply);
  return alternatives.some((a) => variants(a).some((v) => text.includes(v)));
}

interface JsonSchema {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Validates tool arguments against the subset of JSON Schema our tool definitions use. Returns the problems found. */
export function validateArguments(tools: ToolDefinition[], name: string, rawArgs: string): string[] {
  const tool = tools.find((t) => t.function.name === name);
  if (!tool) return [`unknown tool ${name}`];
  let args: unknown;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return ['arguments are not valid JSON'];
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return ['arguments are not an object'];
  const schema = tool.function.parameters as JsonSchema;
  const values = args as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (values[key] === undefined || values[key] === '') problems.push(`missing ${key}`);
  }
  for (const [key, value] of Object.entries(values)) {
    const prop = schema.properties?.[key];
    if (!prop) {
      if (schema.additionalProperties === false) problems.push(`unexpected ${key}`);
      continue;
    }
    if (prop.type && typeof value !== prop.type) problems.push(`${key} is not ${prop.type}`);
    if (prop.enum && !prop.enum.includes(value)) problems.push(`${key} not in enum`);
  }
  return problems;
}
