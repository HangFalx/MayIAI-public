import { type Appointment, type AppointmentSource, calendar, type Proposal, type ProposalQuery } from '../booking/calendar';
import { DOCTORS, doctorById, doctorByName, doctorsFor, serviceById, serviceByName, SERVICES } from '../booking/catalog';
import { nameScore, nameWasSaid } from '../booking/nameMatch';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { addDays, formatHungarianDateTime, HU_WEEKDAYS, nowInTimezone, weekdayOf } from '../utils/time';
import type { ToolCall, ToolDefinition } from './types';

const log = createLogger('llm:tools');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAY_WORDS: Array<[RegExp, number]> = [
  [/(?<!\p{L})hétfő/u, 1], [/(?<!\p{L})kedd/u, 2], [/(?<!\p{L})szerd/u, 3], [/(?<!\p{L})csütörtök/u, 4],
  [/(?<!\p{L})péntek/u, 5], [/(?<!\p{L})szombat/u, 6], [/(?<!\p{L})vasárnap/u, 0],
];

/**
 * The model sometimes searches the wrong day ("kedden" -> a Monday date). If the caller's latest sentence
 * names a day and the searched date matches none of the named days, returns the error to send back.
 */
function wrongDay(date: string, callerText: string): string | null {
  const t = callerText.replace(/\[Rendszer:[^\]]*\]/g, '').replace(/\[\?\]/g, '').toLowerCase();
  const today = nowInTimezone(config.timezone).date;
  const exact: string[] = [];
  if (/holnapután/.test(t)) exact.push(addDays(today, 2));
  if (/(?<!\p{L})holnap(?!után)/u.test(t)) exact.push(addDays(today, 1));
  const weekdays = WEEKDAY_WORDS.filter(([re]) => re.test(t)).map(([, d]) => d);
  if (exact.length === 0 && weekdays.length === 0) return null;
  if (exact.includes(date) || weekdays.includes(weekdayOf(date))) return null;
  const said = [...exact.map((d) => `${d} (${HU_WEEKDAYS[weekdayOf(d)]})`), ...weekdays.map((d) => HU_WEEKDAYS[d])].join(', ');
  const upcoming = weekdays.flatMap((wd) => Array.from({ length: 14 }, (_, i) => addDays(today, i)).filter((d) => weekdayOf(d) === wd).slice(0, 2));
  return `Rossz nap: a hívó ezt mondta: ${said}, de a keresett dátum ${date} (${HU_WEEKDAYS[weekdayOf(date)]}).` +
    (upcoming.length ? ` A szóba jövő dátumok: ${upcoming.join(', ')}.` : '') + ' Keress újra a helyes dátummal.';
}

/** "9:00" / "09:00" -> "09:00"; anything else -> undefined. */
function hhmm(value: unknown): string | undefined {
  const m = typeof value === 'string' ? /^(\d{1,2}):([0-5]\d)$/.exec(value.trim()) : null;
  return m && Number(m[1]) <= 24 ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined;
}

/** Per-call state shared by the tools. */
export interface ToolContext {
  /** Appointments find_appointment returned in this call; only these may be cancelled. */
  lookedUp?: Set<string>;
  /** How many times slots were offered in this call; repeat offers get a different wording hint. */
  offers?: number;
  /** Slots offered in the latest answer; picking one of them needs no new search. */
  lastOffered?: Proposal[];
  /** The doctor the caller already knows about (named by them or by the assistant). */
  knownDoctorId?: number;
  /** Everything the caller said so far; a name must come from here, never from the model. */
  callerTexts?: string[];
  /** Service of the previous calendar call: follow-up calls that omit it ("and at 16:30?") reuse it. */
  lastServiceId?: number;
}

export interface AppointmentSummary {
  idopont_id: string;
  kezdes: string;
  kimondva: string;
  szolgaltatas: string;
  orvos: string;
  nev: string;
}

const summarize = (a: Appointment): AppointmentSummary => ({
  idopont_id: a.idopont_id,
  kezdes: a.kezdes,
  kimondva: formatHungarianDateTime(a.kezdes),
  szolgaltatas: serviceById(a.szolgaltatas_id)?.szolgaltatas ?? '',
  orvos: doctorById(a.orvos_id)?.nev ?? '',
  nev: a.paciens_nev,
});

const serviceEnum = SERVICES.map((s) => s.szolgaltatas);
const doctorEnum = DOCTORS.map((d) => d.nev);

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'find_free_slots',
      description:
        'A rendelő naptárából lekéri a két legközelebbi szabad időpontot. Mindig ezt hívd meg, mielőtt időpontot ajánlasz; ' +
        'időpontot soha ne találj ki. Ha az ügyfél napot, napszakot, időszakot vagy időkorlátot mondott, add meg szűrőként. ' +
        'Ha konkrét órát kért („csütörtökön tízkor”), add meg a time mezőt: ha az szabad, csak azt az egyet kapod vissza. ' +
        'Példák: „csütörtökön 3 után” → date + after_time 15:00; „10 előtt végezni szeretnék” → before_time 10:00; ' +
        '„3 és 5 között” → after_time 15:00, before_time 17:00; „jövő hét keddtől péntekig” → from_date + to_date; ' +
        '„csütörtökön tíz órára” → date + time 10:00.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', enum: serviceEnum, description: 'A kért vizsgálat. Ha az ügyfél csak orvost nevezett meg, hagyd el: az orvos alap vizsgálata lesz.' },
          doctor: { type: 'string', enum: doctorEnum, description: 'Csak ha az ügyfél konkrét orvost kért.' },
          any_doctor: { type: 'boolean', description: 'true, ha az ügyfélnek más orvos is jó (pl. „más nem rendel?”, „mindegy, ki”): ilyenkor minden orvosnál keres, a doctor mezőt figyelmen kívül hagyja.' },
          date: { type: 'string', description: 'Csak ezen a napon keressen (ÉÉÉÉ-HH-NN), ha az ügyfél konkrét napot kért.' },
          from_date: { type: 'string', description: 'Ettől a naptól keressen (ÉÉÉÉ-HH-NN), pl. „jövő héttől”.' },
          to_date: { type: 'string', description: 'Eddig a napig keressen, ezt a napot is beleértve (ÉÉÉÉ-HH-NN), pl. „péntekig”.' },
          part_of_day: { type: 'string', enum: ['delelott', 'delutan'], description: 'Ha az ügyfél délelőttet vagy délutánt kért (délután = dél után, 12 órától). Ilyenkor ezt add meg, ne after_time-ot.' },
          after_time: { type: 'string', description: 'Csak ha konkrét órát mondott: a vizsgálat legkorábban ekkor kezdődjön, minden napon (ÓÓ:PP, 24 órás), pl. „4 után” → 16:00.' },
          before_time: { type: 'string', description: 'A vizsgálat legkésőbb ekkorra érjen véget, minden napon (ÓÓ:PP, 24 órás), pl. „10 előtt” → 10:00.' },
          time: { type: 'string', description: 'Az ügyfél által kért pontos kezdés (ÓÓ:PP, 24 órás), pl. „tízkor” → 10:00. Lehetőleg date-tel együtt.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description:
        'Időpont lefoglalása a rendelő naptárában. Csak a find_free_slots által adott időpontok egyikére hívd meg, ' +
        'miután az ügyfél választott és megadta a teljes nevét. Ha sikertelen, a válaszban kapott javaslatokat ajánld fel.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', enum: serviceEnum, description: 'A kért vizsgálat.' },
          datetime: { type: 'string', description: 'A választott időpont kezdete: ÉÉÉÉ-HH-NNTÓÓ:PP, pontosan ahogy a find_free_slots adta.' },
          doctor: { type: 'string', enum: doctorEnum, description: 'A választott időponthoz tartozó orvos.' },
          name: { type: 'string', description: 'Az ügyfél teljes neve, ahogy bemutatkozott.' },
        },
        required: ['service', 'datetime', 'name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_appointment',
      description:
        'Az ügyfél meglévő (jövőbeli) foglalásának megkeresése név és lehetőleg nap alapján, lemondás vagy áthelyezés előtt. ' +
        'A név nem kell, hogy betűre egyezzen, a beszédfelismerés hibáit a keresés kezeli.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A név, ahogy az ügyfél mondta.' },
          date: { type: 'string', description: 'A foglalás napja (ÉÉÉÉ-HH-NN), ha az ügyfél megmondta.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description:
        'Foglalás lemondása. Csak a find_appointment által visszaadott foglalásra hívd meg, és csak miután az ügyfél ' +
        'kifejezetten megerősítette, hogy azt a foglalást szeretné lemondani.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'string', description: 'A foglalás idopont_id mezője a find_appointment válaszából.' },
        },
        required: ['appointment_id'],
        additionalProperties: false,
      },
    },
  },
];

const brief = (p: Proposal) => ({ kezdes: p.kezdes, kimondva: p.kimondva, orvos: p.orvos_nev });

const REOFFER_STYLES = [
  '„Akkor tudok ajánlani … Valamelyik jó lenne?”',
  '„Más időpontot is találtam: … Ez megfelelne?”',
  '„Mit szólna ehhez: …?”',
  '„Van még szabad hely … Ezek közül melyiket választaná?”',
  '„Esetleg … jó lenne?”',
];

/** From the second offer on, nudges the model away from repeating its earlier sentence word for word. */
function varyOffer(ctx: ToolContext, note: string): string {
  const n = ctx.offers ?? 0;
  ctx.offers = n + 1;
  if (n === 0) return note;
  return `${note} Ez már nem az első ajánlat: ne ismételd a korábbi mondataidat, fogalmazz másképp, például így: ${REOFFER_STYLES[(n - 1) % REOFFER_STYLES.length]}`;
}

/** The doctor is named once per call; only a different doctor's slots get a name again. */
function doctorNote(ctx: ToolContext, slots: Proposal[]): string {
  const ids = new Set(slots.map((s) => s.orvos_id));
  const sameDay = slots.length > 1 && slots.every((s) => s.kezdes.slice(0, 10) === slots[0].kezdes.slice(0, 10));
  const day = sameDay ? ' A napot csak egyszer mondd.' : '';
  if (ids.size > 1) {
    ctx.knownDoctorId = undefined;
    return ` Az időpontok különböző orvosokhoz tartoznak, mindegyiknél mondd ki az orvos nevét.${day}`;
  }
  const known = ctx.knownDoctorId === slots[0].orvos_id;
  ctx.knownDoctorId = slots[0].orvos_id;
  if (known) return ` Az orvos (${slots[0].orvos_nev}) ugyanaz, akiről már szó volt: a nevét most ne mondd ki.${day}`;
  return slots.length > 1
    ? ` Mindkét időpont ${slots[0].orvos_nev} rendelésén van: a nevét egyszer mondd ki.${day}`
    : ` Mondd ki az orvos nevét (${slots[0].orvos_nev}).`;
}

export type ToolResult = Record<string, unknown>;

export async function executeToolCall(call: ToolCall, ctx: ToolContext = {}, source: AppointmentSource = 'asszisztens'): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
  } catch {
    return { siker: false, hiba: 'A függvény argumentumai nem érvényes JSON-t alkotnak.' };
  }
  log.info(call.name, args);

  if (call.name === 'find_appointment') {
    const name = String(args.name ?? '').trim();
    if (!name) return { talalatok: [], hiba: 'Hiányzik a név.' };
    if (DOCTORS.some((d) => nameScore(name, d.nev) >= 0.85)) {
      return {
        talalatok: [],
        hiba: 'Ez a rendelő egyik orvosának a neve, nem az ügyfélé.',
        megjegyzes: 'Ha az ügyfél most választott a felajánlott időpontok közül, nem kell foglalást keresni: kérd el a saját teljes nevét a foglaláshoz.',
      };
    }
    if (ctx.callerTexts && !nameWasSaid(name, ctx.callerTexts)) {
      return { talalatok: [], hiba: 'Ezt a nevet az ügyfél nem mondta.', megjegyzes: 'Nevet soha ne találj ki: kérd el az ügyfél teljes nevét.' };
    }
    const date = typeof args.date === 'string' && DATE_RE.test(args.date) ? args.date : undefined;
    const found = calendar.findByName(name, date);
    if (found.length === 0) {
      return {
        talalatok: [],
        hiba: `Nem találtam ilyen nevű jövőbeli foglalást${date ? ' ezen a napon' : ''}.`,
        megjegyzes: 'Kérd meg az ügyfelet, hogy betűzze a nevét, vagy pontosítsa a napot, aztán keress újra.',
      };
    }
    ctx.lookedUp ??= new Set();
    for (const m of found) ctx.lookedUp.add(m.appointment.idopont_id);
    return {
      talalatok: found.map((m) => ({ ...summarize(m.appointment), egyezes: m.egyezes })),
      megjegyzes:
        'Mondd el, milyen foglalást találtál (vizsgálat, nap, idő, orvos), és kérdezd meg, ezt szeretné-e lemondani. ' +
        'Ha a talált név eltér attól, amit hallottál, a talált nevet is mondd ki. Több találatnál kérdezd meg, melyikről van szó.',
    };
  }

  if (call.name === 'cancel_appointment') {
    const id = String(args.appointment_id ?? '');
    if (!ctx.lookedUp?.has(id)) return { siker: false, hiba: 'Előbb keresd meg a foglalást a find_appointment függvénnyel.' };
    const appointment = calendar.get(id);
    if (!appointment || !calendar.cancel(id)) return { siker: false, hiba: 'Ez a foglalás már nem létezik.' };
    const summary = summarize(appointment);
    return { siker: true, lemondva: summary, megjegyzes: 'Erősítsd meg, hogy a foglalást lemondtad (vizsgálat, nap, idő).' };
  }

  const doctor = args.doctor && args.any_doctor !== true ? doctorByName(String(args.doctor)) : undefined;
  if (args.doctor && args.any_doctor !== true && !doctor) return { siker: false, hiba: `Ismeretlen orvos. Választható: ${doctorEnum.join(', ')}.` };
  // No service given: the previous one if this doctor does it, otherwise the doctor's basic consultation.
  const previous = serviceById(ctx.lastServiceId ?? -1);
  const service = serviceByName(String(args.service ?? '')) ?? (args.service ? undefined
    : previous && (!doctor || doctorsFor(previous).includes(doctor)) ? previous
    : doctor ? SERVICES.find((s) => s.szakterulet_id === doctor.szakterulet_ids[0] && doctorsFor(s).includes(doctor)) : undefined);
  if (!service) {
    return { siker: false, hiba: args.service ? 'Ismeretlen vizsgálat. Csak a listában szereplő vizsgálatnevek egyikét add meg pontosan.' : 'Hiányzik a vizsgálat: kérdezd meg, milyen panasszal vagy melyik szakterületre szeretne időpontot.' };
  }
  ctx.lastServiceId = service.szolgaltatas_id;

  if (call.name === 'find_free_slots') {
    // The caller named this doctor: they know who it is.
    if (doctor && doctorsFor(service).includes(doctor)) ctx.knownDoctorId = doctor.orvos_id;
    const date = typeof args.date === 'string' && DATE_RE.test(args.date) ? args.date : undefined;
    const fromDate = typeof args.from_date === 'string' && DATE_RE.test(args.from_date) ? args.from_date : undefined;
    const toDate = typeof args.to_date === 'string' && DATE_RE.test(args.to_date) ? args.to_date : undefined;
    let partOfDay: ProposalQuery['partOfDay'] = args.part_of_day === 'delelott' || args.part_of_day === 'delutan' ? args.part_of_day : undefined;
    const singleDay = date ?? (fromDate && fromDate === toDate ? fromDate : undefined);
    const latest = (ctx.callerTexts?.[ctx.callerTexts.length - 1] ?? '').toLowerCase();
    const dayError = singleDay && latest ? wrongDay(singleDay, latest) : null;
    if (dayError) {
      log.warn(`find_free_slots: ${dayError}`);
      return { talalatok: [], hiba: dayError };
    }
    let afterTime = hhmm(args.after_time);
    let beforeTime = hhmm(args.before_time);
    // "Délután" means from noon; the model tends to turn it into "after 14:00" and miss the early afternoon.
    const bothParts = /délután/.test(latest) && /délelőtt/.test(latest);
    if (!bothParts && /délután(?!\s+(nem|sem)\b)/.test(latest) && !/(?<!dél)után/.test(latest.replace(/délután/g, ''))) {
      partOfDay = 'delutan';
      if (afterTime && afterTime >= '12:00') afterTime = undefined;
    } else if (!bothParts && /délelőtt(?!\s+(nem|sem)\b)/.test(latest) && !/előtt/.test(latest.replace(/délelőtt/g, ''))) {
      partOfDay = 'delelott';
      if (beforeTime && beforeTime <= '12:00') beforeTime = undefined;
    }
    if (afterTime && beforeTime && afterTime >= beforeTime) {
      return { talalatok: [], hiba: `Érvénytelen időablak: ${afterTime} után és ${beforeTime} előtt. Kérdezz rá újra az ügyfélnél.` };
    }
    const timeFilter: Pick<ProposalQuery, 'partOfDay' | 'afterTime' | 'beforeTime'> = { partOfDay, afterTime, beforeTime };

    const exact = hhmm(args.time);
    if (exact) {
      const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      const endMin = minutes(exact) + service.idotartam_perc;
      const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      const hit = endMin <= 24 * 60
        ? calendar.proposals({ service, doctor, date, fromDate, toDate, afterTime: exact, beforeTime: end, count: 1 })
        : [];
      if (hit.length) {
        const picked = ctx.lastOffered?.some((p) => p.kezdes === hit[0].kezdes);
        const nameGiven = ctx.callerTexts?.some((t) => /\b(vagyok|a nevem|nevem|hívnak)\b/i.test(t)) ?? true;
        return {
          talalatok: hit.map(brief),
          megjegyzes: 'A kért időpont szabad, és az ügyfél már ezt kérte: ne kérdezz rá újra, ne ajánlj másikat. ' +
            'Ha még nincs meg a teljes neve, kérd el; ha megvan, foglald le azonnal a book_appointment függvénnyel.' +
            doctorNote(ctx, hit),
          // The caller just picked one of the offered slots and has not given a name yet: no need for another model round.
          ...(picked && !nameGiven ? { kimondando: 'Rendben, köszönöm. Elkérhetem a teljes nevét?' } : {}),
        };
      }
      // Not free: the two slots closest to the requested time on that day, otherwise the next free ones.
      const target = minutes(exact);
      const sameDay = date ? calendar.proposals({ service, doctor, date, count: 10 }) : [];
      const nearest = sameDay
        .sort((a, b) => Math.abs(minutes(a.kezdes.slice(11)) - target) - Math.abs(minutes(b.kezdes.slice(11)) - target))
        .slice(0, 2)
        .sort((a, b) => a.kezdes.localeCompare(b.kezdes));
      const alternatives = nearest.length ? nearest : calendar.proposals({ service, doctor, fromDate: date ?? fromDate });
      if (alternatives.length === 0) return { talalatok: [], hiba: 'A kért időpont nem szabad, és a következő négy hétben sincs szabad időpont erre a vizsgálatra.' };
      ctx.lastOffered = alternatives;
      return {
        talalatok: alternatives.map(brief),
        megjegyzes: varyOffer(ctx, `A kért időpont (${exact}) nem szabad. Mondd el röviden, és ezt a két, hozzá legközelebbi időpontot ajánld fel helyette.${doctorNote(ctx, alternatives)}`),
      };
    }

    let found = calendar.proposals({ service, doctor, date, fromDate, toDate, ...timeFilter });
    let note = 'Pontosan ezeket az időpontokat ajánld fel.';
    if (doctor && !doctorsFor(service).includes(doctor)) {
      note = `${doctor.nev} nem végez ilyen vizsgálatot, csak: ${doctorsFor(service).map((d) => d.nev).join(', ')}. ` +
        'Mondd el, és ezt a két időpontot ajánld fel helyette.';
    }
    if (found.length === 0 && singleDay && (afterTime || beforeTime || partOfDay)) {
      // Nothing in the window that day: the same day's slots nearest to the window come before other days.
      const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      const from = minutes(afterTime ?? (partOfDay === 'delutan' ? '12:00' : '00:00'));
      const to = minutes(beforeTime ?? (partOfDay === 'delelott' ? '12:00' : '24:00'));
      const gap = (p: Proposal) => { const m = minutes(p.kezdes.slice(11, 16)); return m < from ? from - m : m > to ? m - to : 0; };
      found = calendar.proposals({ service, doctor, date: singleDay, count: 20 })
        .sort((a, b) => gap(a) - gap(b)).slice(0, 2).sort((a, b) => a.kezdes.localeCompare(b.kezdes));
      note = 'Ezen a napon a kért időszakban nincs szabad hely; ezek a hozzá legközelebbi időpontok ugyanazon a napon. Mondd el, és ajánld fel őket.';
    }
    if (found.length === 0 && date) {
      found = calendar.proposals({ service, doctor, fromDate: date, ...timeFilter });
      note = 'A kért napon nincs szabad időpont. Mondd el, és ezt a két legközelebbi időpontot ajánld fel helyette.';
    }
    if (found.length === 0 && (date || toDate || afterTime || beforeTime || partOfDay)) {
      found = calendar.proposals({ service, doctor, fromDate: date ?? fromDate });
      note = 'A kért időszakban nincs szabad időpont. Mondd el, és kérdezd meg, megfelel-e helyette ez a két legközelebbi időpont.';
    }
    if (found.length === 0) return { talalatok: [], hiba: 'A következő négy hétben nincs szabad időpont erre a vizsgálatra.' };
    ctx.lastOffered = found;
    return { talalatok: found.map(brief), megjegyzes: varyOffer(ctx, note + doctorNote(ctx, found)) };
  }

  if (call.name === 'book_appointment') {
    const name = String(args.name ?? '');
    if (DOCTORS.some((d) => nameScore(name, d.nev) >= 0.85)) {
      log.warn(`rejected booking under a doctor's name: ${name}`);
      return { siker: false, hiba: 'Ez a rendelő egyik orvosának a neve, nem az ügyfélé.', megjegyzes: 'Az ügyfél az orvost nevezte meg, nem magát. Kérd el az ügyfél saját teljes nevét.' };
    }
    if (ctx.callerTexts && !nameWasSaid(name, ctx.callerTexts)) {
      log.warn(`rejected booking name the caller never said: ${name}`);
      return { siker: false, hiba: 'Ezt a nevet az ügyfél nem mondta.', megjegyzes: 'Nevet soha ne találj ki: kérd el az ügyfél teljes nevét, és azzal foglalj.' };
    }
    const result = calendar.book({ service, doctor, kezdes: String(args.datetime ?? ''), name, source });
    if (!result.ok) {
      return { siker: false, hiba: result.hiba, javaslatok: result.javaslatok.map(brief), megjegyzes: 'Mondd el az okát, és ezeket a javaslatokat ajánld fel.' };
    }
    return {
      siker: true,
      idopont_id: result.appointment.idopont_id,
      kimondva: result.kimondva,
      orvos: result.orvos_nev,
      szolgaltatas: result.szolgaltatas,
      nev: result.appointment.paciens_nev,
      ...(service.tudnivalo ? { tudnivalo: service.tudnivalo } : {}),
      ...(ctx.knownDoctorId === result.appointment.orvos_id
        ? { megjegyzes: 'Az orvos nevét az ügyfél már tudja, a visszaigazolásban ne ismételd meg.' }
        : {}),
    };
  }

  log.warn(`unknown tool ${call.name}`);
  return { siker: false, hiba: `Ismeretlen függvény: ${call.name}` };
}
