import { doctorsFor, priceText, serviceByName } from '../booking/catalog';
import { config } from '../config';
import { addDays, nowInTimezone, weekdayOf } from '../utils/time';
import type { ChatMessage, LlmEvent, LlmProvider, ToolDefinition } from './types';

/** One keyword rule per catalog service; most specific first ("bőrpróba" must not become a generic skin visit). */
const SERVICE_PATTERNS: Array<[RegExp, string]> = [
  [/(gyerek|gyermek|fiam|lányom|kislány|kisfi).*anyajegy|anyajegy.*(gyerek|gyermek)/i, 'Gyermek anyajegyszűrés'],
  [/anyajegy/i, 'Anyajegyszűrés'],
  [/(gyerek|gyermek|fiam|lányom|kislány|kisfi).*bőr|bőr.*(gyerek|gyermek)/i, 'Gyermekbőrgyógyászati vizsgálat és konzultáció'],
  [/epicut|tapasz|allergiatesz/i, 'Allergiavizsgálat epicután teszttel'],
  [/körömgomb/i, 'Lézeres körömgomba-kezelés'],
  [/benőtt/i, 'Benőtt köröm kezelése'],
  [/rosacea/i, 'IPL rosacea-kezelés'],
  [/szemölcs|növedék/i, 'Szemölcs, bőrnövedék eltávolítása'],
  [/bőr.*kontroll|kontroll.*bőr/i, 'Bőrgyógyászati kontrollvizsgálat'],
  [/bőrgyógy|bőr|ekcéma|akné|pikkelysömör/i, 'Bőrgyógyászati vizsgálat és konzultáció'],
  [/rákszűr|citológ/i, 'Nőgyógyászati rákszűrés (citológia, HPV)'],
  [/terhes|várandós/i, 'Terhesgondozási vizsgálat'],
  [/gyermeknőgyógy|gyereknőgyógy/i, 'Gyermeknőgyógyászati vizsgálat'],
  [/nőgyógy/i, 'Nőgyógyászati vizsgálat és konzultáció'],
  [/prosztat/i, 'Prosztataszűrés'],
  [/urológ.*ultrahang|ultrahang.*urológ/i, 'Urológiai vizsgálat ultrahanggal'],
  [/urológ.*kontroll|kontroll.*urológ/i, 'Urológiai kontrollvizsgálat'],
  [/urológ/i, 'Urológiai vizsgálat és konzultáció'],
  [/nemigyógy|std|nemi beteg/i, 'Nemigyógyászati (STD) vizsgálat és konzultáció'],
  [/allerg/i, 'Allergológiai vizsgálat és konzultáció'],
  [/proktológ|aranyér|végbél/i, 'Proktológiai vizsgálat és konzultáció'],
  [/plasztik/i, 'Plasztikai sebészeti konzultáció'],
  [/esztétik|ránc|botox|feltölt/i, 'Orvosesztétikai konzultáció'],
  [/érsebész|visszér|tágult ér/i, 'Érsebészeti vizsgálat és konzultáció'],
  [/sebész/i, 'Sebészeti konzultáció'],
];

const WEEKDAY_PATTERNS: Array<[RegExp, number]> = [
  [/hétfő/i, 1], [/kedd/i, 2], [/szerd/i, 3], [/csütörtök/i, 4], [/péntek/i, 5],
];

const L = 'a-záéíóöőúüű';
const U = 'A-ZÁÉÍÓÖŐÚÜŰ';
const FULL_NAME = `[${U}][${L}]+(?:\\[\\?\\])?(?:\\s+[${U}][${L}]+(?:\\[\\?\\])?)+`;
const NAME_BEFORE_RE = new RegExp(`(${FULL_NAME})\\s+(?:vagyok|a nevem|névre|néven)`);
const NAME_AFTER_RE = new RegExp(`(?:a nevem|nevem|hívnak)\\s*:?\\s*(${FULL_NAME})`, 'i');
const NAME_ONLY_RE = new RegExp(`^\\s*(${FULL_NAME})\\s*\\.?\\s*$`);

interface Slot { kezdes: string; kimondva: string; orvos: string }
interface Found { idopont_id: string; kimondva: string; szolgaltatas: string; orvos: string }

type Decision =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, string> };

function parse(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const findService = (text: string) => SERVICE_PATTERNS.find(([re]) => re.test(text))?.[1];

/** "4 után" -> after 16:00, "10 előtt" -> before 10:00. Hours below 8 mean afternoon. */
function timeLimits(text: string): Record<string, string> {
  const at = (h: string) => `${String(Number(h) < 8 ? Number(h) + 12 : Number(h)).padStart(2, '0')}:00`;
  const after = /(\d{1,2})\s*(?:ór[aá]\w*)?\s*után/i.exec(text);
  const before = /(\d{1,2})\s*(?:ór[aá]\w*)?\s*előtt/i.exec(text);
  const exact = /(\d{1,2})\s*(?:órára|órakor|-kor|-ra|-re)/i.exec(text);
  return {
    ...(after ? { after_time: at(after[1]) } : {}),
    ...(before ? { before_time: at(before[1]) } : {}),
    ...(exact && !after && !before ? { time: at(exact[1]) } : {}),
  };
}

/** The next date (from tomorrow) that falls on a weekday named in the text. */
function namedDate(text: string): string | undefined {
  const wd = WEEKDAY_PATTERNS.find(([re]) => re.test(text))?.[1];
  if (wd === undefined) return undefined;
  const today = nowInTimezone(config.timezone).date;
  for (let i = 1; i <= 7; i++) if (weekdayOf(addDays(today, i)) === wd) return addDays(today, i);
  return undefined;
}

/**
 * Baseline B0: a keyword and regex dialogue manager in place of the LLM. It emits the same event
 * stream as the real provider (text or tool calls), so it runs on the same tools and calendar.
 */
export class RuleBasedProvider implements LlmProvider {
  private callSeq = 0;

  async *stream(messages: ChatMessage[], _tools: ToolDefinition[], _signal: AbortSignal): AsyncGenerator<LlmEvent> {
    const decision = this.decide(messages);
    if (decision.kind === 'tool') {
      yield { type: 'tool_calls', calls: [{ id: `call_rule_${++this.callSeq}`, name: decision.name, arguments: JSON.stringify(decision.args) }] };
      return;
    }
    yield { type: 'text', text: decision.text };
  }

  private decide(messages: ChatMessage[]): Decision {
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') return { kind: 'text', text: this.afterTool(parse(last.content)) };

    const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.content as string);
    const lastUser = userTexts[userTexts.length - 1] ?? '';
    const all = userTexts.join(' ');
    const toolResults = messages.filter((m) => m.role === 'tool').map((m) => parse(m.content as string));

    if (/viszonthall|szép napot|ennyi lett volna/i.test(lastUser)) return { kind: 'text', text: 'Köszönöm a hívását, viszonthallásra!' };
    if (toolResults.some((r) => r.siker === true)) return { kind: 'text', text: 'Rendben. Miben segíthetek még?' };

    if (/lemond|le\s+(\p{L}+\s+)?mond|töröl|áthelyez|átten|módosít/iu.test(all)) return this.cancellation(messages, all, lastUser, toolResults);

    const service = findService(all);
    const s = service ? serviceByName(service) : undefined;
    const info = s?.info_text ? ` ${s.info_text}` : '';
    if (/mennyi|kerül|(?<!\p{L})ár(a|at|ak)?(?!\p{L})|költség/iu.test(lastUser)) {
      return { kind: 'text', text: s ? `${s.szolgaltatas}: ${priceText(s)}.${info}` : 'Sajnos erről nincs információm.' };
    }
    if (/(?<!\p{L})(ki|kihez|melyik orvos)(?!\p{L})/iu.test(lastUser) && !/szeretnék|kérnék|foglal/i.test(lastUser)) {
      return { kind: 'text', text: s ? `Ezt a vizsgálatot ${doctorsFor(s).map((d) => d.nev).join(', ')} végzi.${info}` : 'Sajnos erről nincs információm.' };
    }
    if (/(?<!\p{L})hol(?!\p{L})|tartalmaz|kedvezmény|tudnivaló/iu.test(lastUser)) {
      return { kind: 'text', text: s?.info_text ?? 'Sajnos erről nincs információm.' };
    }
    if (!service) return { kind: 'text', text: 'Melyik vizsgálatra szeretne időpontot?' };

    const offerIndex = messages.findLastIndex((m) => m.role === 'tool' && ((parse(m.content as string).talalatok ?? parse(m.content as string).javaslatok) as Slot[] | undefined)?.length);
    if (offerIndex < 0) {
      const partOfDay = /délelőtt/i.test(all) ? 'delelott' : /délután/i.test(all) ? 'delutan' : undefined;
      const date = namedDate(all);
      const doctor = /dr\.?\s+([A-ZÁÉÍÓÖŐÚÜŰ][\p{L}-]+\s+[A-ZÁÉÍÓÖŐÚÜŰ][\p{L}]+)/u.exec(all)?.[1];
      return {
        kind: 'tool',
        name: 'find_free_slots',
        args: { service, ...(date ? { date } : {}), ...(partOfDay ? { part_of_day: partOfDay } : {}), ...timeLimits(all), ...(doctor ? { doctor: `Dr. ${doctor.replace(/(hoz|hez|höz)$/, '')}` } : {}) },
      };
    }
    const r = parse(messages[offerIndex].content as string);
    const offer = (r.talalatok ?? r.javaslatok) as Slot[];
    const afterOffer = messages.slice(offerIndex + 1).filter((m) => m.role === 'user').map((m) => m.content as string);
    const chosen = this.pick(offer, afterOffer);
    if (!chosen) return { kind: 'text', text: `Melyik felelne meg: ${offer.map((s) => s.kimondva).join(', vagy ')}?` };
    const name = this.findName(messages);
    if (!name) return { kind: 'text', text: 'Milyen névre rögzíthetem a foglalást?' };
    return { kind: 'tool', name: 'book_appointment', args: { service, datetime: chosen.kezdes, doctor: chosen.orvos, name } };
  }

  private cancellation(messages: ChatMessage[], all: string, lastUser: string, results: Record<string, unknown>[]): Decision {
    if (/áthelyez|átten|módosít/i.test(all)) return { kind: 'text', text: 'Időpont áthelyezésében sajnos nem tudok segíteni, kérem, hívja a recepciót.' };
    const found = [...results].reverse().find((r) => Array.isArray(r.talalatok) && r.talalatok.length)?.talalatok as Found[] | undefined;
    if (found) {
      if (/mégsem|ne mondja|megtartom|(?<!\p{L})nem(?!\p{L})/iu.test(lastUser)) return { kind: 'text', text: 'Rendben, a foglalását megtartottam.' };
      if (/igen|mondja le|azt|kérem/i.test(lastUser)) return { kind: 'tool', name: 'cancel_appointment', args: { appointment_id: found[0].idopont_id } };
      return { kind: 'text', text: 'Ezt a foglalást szeretné lemondani?' };
    }
    const name = this.findName(messages);
    if (!name) return { kind: 'text', text: 'Kérem, mondja meg a teljes nevét.' };
    const date = namedDate(all);
    return { kind: 'tool', name: 'find_appointment', args: { name, ...(date ? { date } : {}) } };
  }

  /** "az első" / "a második" / "a tízórás" -> one of the offered slots. */
  private pick(offer: Slot[], replies: string[]): Slot | undefined {
    for (const reply of replies) {
      if (/első|korábbi/i.test(reply)) return offer[0];
      if (/második|másik|későbbi/i.test(reply) && offer[1]) return offer[1];
      const hour = /(\d{1,2})(?:[:.](\d{2}))?\s*(?:óra|-kor|kor)/i.exec(reply);
      if (hour) {
        const h = Number(hour[1]);
        const hit = offer.find((s) => [h, h + 12].includes(Number(s.kezdes.slice(11, 13))));
        if (hit) return hit;
      }
      if (/^(igen|jó|rendben|megfelel|mehet)/i.test(reply.trim()) && offer.length === 1) return offer[0];
    }
    return undefined;
  }

  private findName(messages: ChatMessage[]): string | undefined {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      const text = m.content;
      const askedName = messages.slice(0, i).reverse().find((p) => p.role === 'assistant')?.content?.includes('név');
      const name = NAME_BEFORE_RE.exec(text)?.[1] ?? NAME_AFTER_RE.exec(text)?.[1] ?? (askedName ? NAME_ONLY_RE.exec(text)?.[1] : undefined);
      if (name) return name.replace(/\[\?\]/g, '');
    }
    return undefined;
  }

  private afterTool(r: Record<string, unknown>): string {
    if (r.lemondva) return 'A foglalását lemondtam.';
    if (r.siker === true) return `Rendben, ${String(r.nev)} névre lefoglaltam: ${String(r.szolgaltatas)}, ${String(r.kimondva)}, ${String(r.orvos)}.`;
    const talalatok = r.talalatok as Array<Slot & Partial<Found>> | undefined;
    if (talalatok?.length && talalatok[0].idopont_id) {
      const f = talalatok[0];
      return `Ezt a foglalást találtam: ${f.szolgaltatas}, ${f.kimondva}, ${f.orvos}. Ezt szeretné lemondani?`;
    }
    const offer = (talalatok ?? r.javaslatok) as Slot[] | undefined;
    if (offer?.length) return `A legközelebbi szabad időpontok: ${offer.map((s) => `${s.kimondva} ${s.orvos} rendelésén`).join(', vagy ')}. Melyik felelne meg?`;
    return `Sajnos ${String(r.hiba ?? 'nem sikerült.')}`;
  }
}
