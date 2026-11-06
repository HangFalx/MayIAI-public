import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { addDays, formatHungarianDateTime, nowInTimezone, weekdayOf } from '../utils/time';
import { BOOKING_RULES, type Doctor, doctorsFor, type Service, SLOT_MINUTES } from './catalog';
import { nameScore } from './nameMatch';

const log = createLogger('calendar');
const DEFAULT_FILE = path.resolve('data', 'calendar', 'appointments.json');
const SEARCH_DAYS = 28;
const MAX_APPOINTMENTS = 5000;
const ISO_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

export type AppointmentSource = 'asszisztens' | 'teszt';

/** Field names follow the Medio clinic management API, so a real backend could replace this simulator. */
export interface Appointment {
  idopont_id: string;
  orvos_id: number;
  szolgaltatas_id: number;
  /** Naive local time in config.timezone: YYYY-MM-DDTHH:mm */
  kezdes: string;
  veg: string;
  paciens_nev: string;
  forras: AppointmentSource;
  letrehozva: string;
}

export interface Proposal {
  kezdes: string;
  veg: string;
  orvos_id: number;
  orvos_nev: string;
  szolgaltatas_id: number;
  szolgaltatas: string;
  /** "október 8-án, csütörtökön 10 órakor" */
  kimondva: string;
}

export interface ProposalQuery {
  service: Service;
  doctor?: Doctor;
  /** YYYY-MM-DD: only this day and later. */
  fromDate?: string;
  /** YYYY-MM-DD: only this day and earlier. */
  toDate?: string;
  /** Only this day. */
  date?: string;
  partOfDay?: 'delelott' | 'delutan';
  /** HH:MM: on every day, the visit starts no earlier than this. */
  afterTime?: string;
  /** HH:MM: on every day, the visit is over by this. */
  beforeTime?: string;
  count?: number;
}

export type BookResult =
  | { ok: true; appointment: Appointment; kimondva: string; orvos_nev: string; szolgaltatas: string }
  | { ok: false; code: 'invalid' | 'past' | 'closed' | 'taken' | 'full'; hiba: string; javaslatok: Proposal[] };

const pad = (n: number) => String(n).padStart(2, '0');
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fromMin = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const endOf = (kezdes: string, minutes: number) => `${kezdes.slice(0, 10)}T${fromMin(toMin(kezdes.slice(11)) + minutes)}`;

/**
 * Simulated clinic calendar: doctors' weekly schedules from the catalog, 30-minute slot grid,
 * no overlapping visits per doctor. Persisted to a JSON file unless `file` is null (evaluation).
 */
export class ClinicCalendar {
  private appointments: Appointment[] = [];

  constructor(private file: string | null = DEFAULT_FILE) {
    if (!file) return;
    try {
      this.appointments = JSON.parse(fs.readFileSync(file, 'utf-8')) as Appointment[];
    } catch {
      this.appointments = [];
    }
  }

  /** Evaluation: keep everything in memory, starting from `appointments`. */
  useMemory(appointments: Appointment[] = []): void {
    this.file = null;
    this.appointments = structuredClone(appointments);
  }

  list(): Appointment[] {
    return [...this.appointments].sort((a, b) => a.kezdes.localeCompare(b.kezdes) || a.orvos_id - b.orvos_id);
  }

  get(id: string): Appointment | undefined {
    return this.appointments.find((a) => a.idopont_id === id);
  }

  /** The next free slots for a service, earliest first, at most one per start time. */
  proposals(q: ProposalQuery): Proposal[] {
    const count = Math.min(Math.max(q.count ?? 2, 1), 10);
    const eligible = doctorsFor(q.service);
    const doctors = q.doctor && eligible.includes(q.doctor) ? [q.doctor] : eligible;
    const earliest = this.earliestStart();
    const firstDay = [q.date, q.fromDate, earliest.slice(0, 10)].filter(Boolean).sort().at(-1)!;
    const lastDay = q.date ?? q.toDate;
    const minStart = q.afterTime ? toMin(q.afterTime) : 0;
    const maxEnd = q.beforeTime ? toMin(q.beforeTime) : 24 * 60;
    const out: Proposal[] = [];
    for (let i = 0; i < SEARCH_DAYS && out.length < count; i++) {
      const day = addDays(firstDay, i);
      if (lastDay && day > lastDay) break;
      for (let m = 0; m < 24 * 60 && out.length < count; m += SLOT_MINUTES) {
        if (q.partOfDay === 'delelott' && m >= 12 * 60) break;
        if (q.partOfDay === 'delutan' && m < 12 * 60) continue;
        if (m < minStart || m + q.service.idotartam_perc > maxEnd) continue;
        const kezdes = `${day}T${fromMin(m)}`;
        if (kezdes < earliest) continue;
        const doctor = doctors.find((d) => this.isFree(d, kezdes, q.service.idotartam_perc));
        if (doctor) out.push(this.toProposal(doctor, q.service, kezdes));
      }
    }
    return out;
  }

  book(req: { service: Service; kezdes: string; doctor?: Doctor; name: string; source: AppointmentSource }): BookResult {
    const fail = (code: Extract<BookResult, { ok: false }>['code'], hiba: string, from?: string): BookResult => ({
      ok: false,
      code,
      hiba,
      javaslatok: this.proposals({ service: req.service, doctor: req.doctor, fromDate: from }),
    });
    const name = req.name.replace(/\[\?\]/g, '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 100) return fail('invalid', 'Hiányzó vagy érvénytelen név.');
    if (!ISO_RE.test(req.kezdes)) return fail('invalid', 'Érvénytelen időpont, ÉÉÉÉ-HH-NNTÓÓ:PP formátum szükséges.');
    if (toMin(req.kezdes.slice(11)) % SLOT_MINUTES !== 0) return fail('invalid', 'Csak egész vagy fél órás kezdés foglalható.', req.kezdes.slice(0, 10));
    if (req.kezdes < this.earliestStart()) return fail('past', 'Ez az időpont már elmúlt vagy túl közeli.');
    if (this.appointments.length >= MAX_APPOINTMENTS) return fail('full', 'A naptár megtelt.');

    const minutes = req.service.idotartam_perc;
    const doctors = req.doctor ? [req.doctor] : doctorsFor(req.service);
    if (req.doctor && !doctorsFor(req.service).includes(req.doctor)) {
      return fail('invalid', `${req.doctor.nev} nem végez ilyen vizsgálatot.`, req.kezdes.slice(0, 10));
    }
    if (!doctors.some((d) => this.works(d, req.kezdes, minutes))) {
      return fail('closed', 'Ebben az időpontban nincs rendelés ehhez a vizsgálathoz.', req.kezdes.slice(0, 10));
    }
    const doctor = doctors.find((d) => this.isFree(d, req.kezdes, minutes));
    if (!doctor) return fail('taken', 'Ez az időpont már foglalt.', req.kezdes.slice(0, 10));

    const appointment: Appointment = {
      idopont_id: `I${crypto.randomBytes(5).toString('hex')}`,
      orvos_id: doctor.orvos_id,
      szolgaltatas_id: req.service.szolgaltatas_id,
      kezdes: req.kezdes,
      veg: endOf(req.kezdes, minutes),
      paciens_nev: name,
      forras: req.source,
      letrehozva: new Date().toISOString(),
    };
    this.appointments.push(appointment);
    this.save();
    log.info(`booked ${req.service.szolgaltatas} with ${doctor.nev} at ${req.kezdes}`);
    return { ok: true, appointment, kimondva: formatHungarianDateTime(req.kezdes), orvos_nev: doctor.nev, szolgaltatas: req.service.szolgaltatas };
  }

  cancel(id: string): boolean {
    const before = this.appointments.length;
    this.appointments = this.appointments.filter((a) => a.idopont_id !== id);
    if (this.appointments.length === before) return false;
    this.save();
    log.info(`cancelled ${id}`);
    return true;
  }

  /** Upcoming appointments booked under a name close to `name`, best match first. */
  findByName(name: string, date?: string, limit = 3): Array<{ appointment: Appointment; egyezes: number }> {
    const now = nowInTimezone(config.timezone);
    const from = `${now.date}T${now.time.slice(0, 5)}`;
    const threshold = date ? 0.7 : 0.8;
    return this.appointments
      .filter((a) => a.kezdes >= from && (!date || a.kezdes.startsWith(date)))
      .map((a) => ({ appointment: a, egyezes: Math.round(nameScore(name, a.paciens_nev) * 100) / 100 }))
      .filter((m) => m.egyezes >= threshold)
      .sort((x, y) => y.egyezes - x.egyezes || x.appointment.kezdes.localeCompare(y.appointment.kezdes))
      .slice(0, limit);
  }

  /** Now + lead time, rounded up to the slot grid. */
  earliestStart(): string {
    const now = nowInTimezone(config.timezone);
    const total = Math.ceil((toMin(now.time) + BOOKING_RULES.leadMinutes) / SLOT_MINUTES) * SLOT_MINUTES;
    const dayOffset = Math.floor(total / (24 * 60));
    return `${addDays(now.date, dayOffset)}T${fromMin(total % (24 * 60))}`;
  }

  private toProposal(doctor: Doctor, service: Service, kezdes: string): Proposal {
    return {
      kezdes,
      veg: endOf(kezdes, service.idotartam_perc),
      orvos_id: doctor.orvos_id,
      orvos_nev: doctor.nev,
      szolgaltatas_id: service.szolgaltatas_id,
      szolgaltatas: service.szolgaltatas,
      kimondva: formatHungarianDateTime(kezdes),
    };
  }

  private works(doctor: Doctor, kezdes: string, minutes: number): boolean {
    if (BOOKING_RULES.holidays.includes(kezdes.slice(0, 10))) return false;
    const hours = doctor.rendelesi_ido[weekdayOf(kezdes.slice(0, 10)) as 0];
    if (!hours) return false;
    const start = toMin(kezdes.slice(11));
    return start >= hours[0] * 60 && start + minutes <= hours[1] * 60;
  }

  private isFree(doctor: Doctor, kezdes: string, minutes: number): boolean {
    if (!this.works(doctor, kezdes, minutes)) return false;
    const end = endOf(kezdes, minutes);
    return !this.appointments.some((a) => a.orvos_id === doctor.orvos_id && a.kezdes < end && kezdes < a.veg);
  }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.appointments), 'utf-8');
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}

export const calendar = new ClinicCalendar();
