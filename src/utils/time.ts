export interface LocalNow {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
  /** YYYY-MM-DDTHH:mm (naive local time in the configured timezone) */
  iso: string;
}

export const HU_WEEKDAYS = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];
/** Temporal ("on Monday") forms: hétfőn, kedden ... */
export const HU_WEEKDAYS_ON = ['vasárnap', 'hétfőn', 'kedden', 'szerdán', 'csütörtökön', 'pénteken', 'szombaton'];
export const HU_MONTHS = [
  'január', 'február', 'március', 'április', 'május', 'június',
  'július', 'augusztus', 'szeptember', 'október', 'november', 'december',
];

export function nowInTimezone(timeZone: string): LocalNow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  return { date, time, iso: `${date}T${time}` };
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Hungarian date suffix: 1-jén, 2-án, 12-én, 20-án ... (elsején, másodikán, tizenkettedikén, huszadikán). */
export function dayWithSuffix(day: number): string {
  if (day === 1) return '1-jén';
  if (day === 2) return '2-án';
  const byLastDigit: Record<number, string> = { 1: 'én', 2: 'én', 3: 'án', 4: 'én', 5: 'én', 6: 'án', 7: 'én', 8: 'án', 9: 'én' };
  const last = day % 10;
  const suffix = last === 0 ? (day === 10 ? 'én' : 'án') : byLastDigit[last];
  return `${day}-${suffix}`;
}

/** "2026-09-28T15:00" -> "szeptember 28-án, hétfőn 15 órakor" */
export function formatHungarianDateTime(isoLocal: string): string {
  const [date, time] = isoLocal.split('T');
  const [, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const clock = mm === 0 ? `${hh} órakor` : `${hh} óra ${mm} perckor`;
  return `${HU_MONTHS[m - 1]} ${dayWithSuffix(d)}, ${HU_WEEKDAYS_ON[weekdayOf(date)]} ${clock}`;
}
