/** Fuzzy patient-name matching: speech recognition often gets a letter or two wrong ("Kovách" for "Kovács"). */

function tokens(name: string): string[] {
  return name
    .replace(/\[\?\]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 1 && w !== 'dr');
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const similarity = (a: string, b: string) => 1 - levenshtein(a, b) / Math.max(a.length, b.length);
const average = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** 0..1, word order independent; a surname alone against "surname + first name" scores about 0.75. */
export function nameScore(heard: string, recorded: string): number {
  const q = tokens(heard);
  const c = tokens(recorded);
  if (q.length === 0 || c.length === 0) return 0;
  const heardSide = average(q.map((t) => Math.max(...c.map((u) => similarity(t, u)))));
  const recordedSide = average(c.map((u) => Math.max(...q.map((t) => similarity(t, u)))));
  return (heardSide + recordedSide) / 2;
}

/**
 * Whether every word of `name` was (roughly) said by the caller. Adjacent words are also tried
 * joined, because STT often splits one surname ("Los Anci" for "Losonczi").
 */
export function nameWasSaid(name: string, callerTexts: string[]): boolean {
  const words = callerTexts.flatMap((t) => tokens(t.replace(/\[Rendszer:[^\]]*\]/g, ' ')));
  const pool = [...words, ...words.slice(1).map((w, i) => words[i] + w)];
  const wanted = tokens(name);
  return wanted.length > 0 && wanted.every((t) => pool.some((w) => similarity(t, w) >= 0.6));
}
