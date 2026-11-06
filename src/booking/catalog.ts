/**
 * Simulated catalogue of a fictional private clinic (Belvárosi Magánklinika). Specialties, visit types and
 * price levels are modelled on typical Budapest private clinics; all clinic and doctor names are fictional.
 * Field names follow the Medio clinic management API. Durations and weekly schedules are invented.
 */

export interface Specialization {
  szakterulet_id: number;
  szakterulet: string;
  tipus: 'Felnőtt' | 'Gyermek';
}

export interface Service {
  szolgaltatas_id: number;
  szakterulet_id: number;
  szolgaltatas: string;
  idotartam_perc: number;
  /** Missing when the clinic does not publish a price for it. */
  min_ar?: number;
  max_ar?: number;
  info_text?: string;
  /** Said to the caller after booking; only practical instructions (where, how to prepare). */
  tudnivalo?: string;
  /** Only these doctors perform it (e.g. visits with the head specialist). */
  orvos_ids?: number[];
}

/** Weekday -> working hours [from, to). 0 = Sunday ... 6 = Saturday (Date.getDay); hours may be fractional (8.5 = 8:30). */
export type WeeklySchedule = Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, [number, number]>>;

export interface Doctor {
  orvos_id: number;
  nev: string;
  /** Title as the clinic lists it. */
  titulus: string;
  szakterulet_ids: number[];
  beszelt_nyelvek: string;
  rendelesi_ido: WeeklySchedule;
}

export const INSTITUTION = { intezmeny_id: 1, varos: 'Budapest' };

export const SPECIALIZATIONS: Specialization[] = [
  { szakterulet_id: 101, szakterulet: 'Bőrgyógyászat', tipus: 'Felnőtt' },
  { szakterulet_id: 102, szakterulet: 'Gyermekbőrgyógyászat', tipus: 'Gyermek' },
  { szakterulet_id: 103, szakterulet: 'Nőgyógyászat', tipus: 'Felnőtt' },
  { szakterulet_id: 104, szakterulet: 'Terhesgondozás', tipus: 'Felnőtt' },
  { szakterulet_id: 105, szakterulet: 'Allergológia', tipus: 'Felnőtt' },
  { szakterulet_id: 106, szakterulet: 'STD, nemigyógyászat', tipus: 'Felnőtt' },
  { szakterulet_id: 107, szakterulet: 'Urológia', tipus: 'Felnőtt' },
  { szakterulet_id: 108, szakterulet: 'Proktológia', tipus: 'Felnőtt' },
  { szakterulet_id: 109, szakterulet: 'Sebészet, érsebészet', tipus: 'Felnőtt' },
  { szakterulet_id: 110, szakterulet: 'Plasztikai sebészet', tipus: 'Felnőtt' },
  { szakterulet_id: 111, szakterulet: 'Orvosi esztétika', tipus: 'Felnőtt' },
];

const HEAD_DERMATOLOGISTS = [302, 323];

export const SERVICES: Service[] = [
  // Bőrgyógyászat
  { szolgaltatas_id: 2001, szakterulet_id: 101, szolgaltatas: 'Bőrgyógyászati vizsgálat és konzultáció', idotartam_perc: 30, min_ar: 37000, max_ar: 37000 },
  { szolgaltatas_id: 2002, szakterulet_id: 101, szolgaltatas: 'Vezető szakorvosi bőrgyógyászati vizsgálat', idotartam_perc: 30, min_ar: 40000, max_ar: 40000,
    orvos_ids: HEAD_DERMATOLOGISTS },
  { szolgaltatas_id: 2003, szakterulet_id: 101, szolgaltatas: 'Bőrgyógyászati kontrollvizsgálat', idotartam_perc: 30, min_ar: 25000, max_ar: 25000,
    info_text: 'Kontrollvizsgálat az előző vizsgálatot követő egy hónapon belül.' },
  { szolgaltatas_id: 2004, szakterulet_id: 101, szolgaltatas: 'Anyajegyszűrés', idotartam_perc: 30, min_ar: 37000, max_ar: 40000,
    info_text: 'Kézi dermatoszkóppal; vezető szakorvosnál (Dr. Kertész, Dr. Rácz, Dr. Csonka) 40 000 Ft.' },
  { szolgaltatas_id: 2005, szakterulet_id: 101, szolgaltatas: 'Szemölcs, bőrnövedék eltávolítása', idotartam_perc: 30, min_ar: 39000, max_ar: 94000,
    info_text: 'Az ár a mérettől és a darabszámtól függ, tartalmazza a konzultációt és az érzéstelenítést.' },
  { szolgaltatas_id: 2006, szakterulet_id: 101, szolgaltatas: 'Benőtt köröm kezelése', idotartam_perc: 60, min_ar: 59000, max_ar: 120000 },
  { szolgaltatas_id: 2007, szakterulet_id: 101, szolgaltatas: 'Lézeres körömgomba-kezelés', idotartam_perc: 30, min_ar: 29000, max_ar: 42000,
    info_text: 'Az ár egy alkalomra vonatkozik, legalább öt alkalom javasolt.' },
  { szolgaltatas_id: 2008, szakterulet_id: 101, szolgaltatas: 'IPL rosacea-kezelés', idotartam_perc: 30, min_ar: 43000, max_ar: 121000,
    orvos_ids: [323, 307, 313] },
  // Gyermekbőrgyógyászat
  { szolgaltatas_id: 2101, szakterulet_id: 102, szolgaltatas: 'Gyermekbőrgyógyászati vizsgálat és konzultáció', idotartam_perc: 30, min_ar: 37000, max_ar: 37000,
    info_text: 'Testvérkedvezmény: 30% a második gyermek vizsgálatára.' },
  { szolgaltatas_id: 2102, szakterulet_id: 102, szolgaltatas: 'Gyermekbőrgyógyászati kontrollvizsgálat', idotartam_perc: 30, min_ar: 25000, max_ar: 25000 },
  { szolgaltatas_id: 2103, szakterulet_id: 102, szolgaltatas: 'Gyermek anyajegyszűrés', idotartam_perc: 30, min_ar: 37000, max_ar: 37000 },
  // Nőgyógyászat, terhesgondozás (no published price: told at the visit)
  { szolgaltatas_id: 2201, szakterulet_id: 103, szolgaltatas: 'Nőgyógyászati vizsgálat és konzultáció', idotartam_perc: 30 },
  { szolgaltatas_id: 2202, szakterulet_id: 103, szolgaltatas: 'Nőgyógyászati rákszűrés (citológia, HPV)', idotartam_perc: 30 },
  { szolgaltatas_id: 2203, szakterulet_id: 103, szolgaltatas: 'Gyermeknőgyógyászati vizsgálat', idotartam_perc: 30, orvos_ids: [317] },
  { szolgaltatas_id: 2301, szakterulet_id: 104, szolgaltatas: 'Terhesgondozási vizsgálat', idotartam_perc: 30 },
  // Allergológia
  { szolgaltatas_id: 2401, szakterulet_id: 105, szolgaltatas: 'Allergológiai vizsgálat és konzultáció', idotartam_perc: 30, min_ar: 40000, max_ar: 40000 },
  { szolgaltatas_id: 2402, szakterulet_id: 105, szolgaltatas: 'Allergiavizsgálat epicután teszttel', idotartam_perc: 30, min_ar: 60000, max_ar: 60000,
    info_text: 'A teszt 33 anyagra történik, a tapaszok a hátra kerülnek, az eredmény egy hét múlva van meg. A budai telephelyünkön végezzük.',
    tudnivalo: 'A vizsgálat a budai rendelőben lesz, a Fenyő utca 12. alatt; az eredmény egy hét múlva van meg.' },
  // STD, nemigyógyászat
  { szolgaltatas_id: 2501, szakterulet_id: 106, szolgaltatas: 'Nemigyógyászati (STD) vizsgálat és konzultáció', idotartam_perc: 30, min_ar: 37000, max_ar: 37000,
    info_text: 'A laborvizsgálatok díja a konzultáción felül fizetendő.' },
  { szolgaltatas_id: 2502, szakterulet_id: 106, szolgaltatas: 'Vezető szakorvosi nemigyógyászati vizsgálat', idotartam_perc: 30, min_ar: 40000, max_ar: 40000,
    orvos_ids: HEAD_DERMATOLOGISTS },
  { szolgaltatas_id: 2503, szakterulet_id: 106, szolgaltatas: 'Nemi szervi szemölcs, növedék eltávolítása', idotartam_perc: 30, min_ar: 39000, max_ar: 94000 },
  // Urológia
  { szolgaltatas_id: 2601, szakterulet_id: 107, szolgaltatas: 'Urológiai vizsgálat és konzultáció', idotartam_perc: 30, min_ar: 37000, max_ar: 37000,
    info_text: 'Felnőtteknek és gyermekeknek is.' },
  { szolgaltatas_id: 2602, szakterulet_id: 107, szolgaltatas: 'Urológiai vizsgálat ultrahanggal', idotartam_perc: 30, min_ar: 45000, max_ar: 45000 },
  { szolgaltatas_id: 2603, szakterulet_id: 107, szolgaltatas: 'Urológiai kontrollvizsgálat', idotartam_perc: 30, min_ar: 25000, max_ar: 25000 },
  { szolgaltatas_id: 2604, szakterulet_id: 107, szolgaltatas: 'Prosztataszűrés', idotartam_perc: 60, min_ar: 57000, max_ar: 57000,
    info_text: 'Ultrahang, szakorvosi konzultáció és PSA labor.' },
  // Proktológia, sebészet, plasztikai sebészet, orvosi esztétika (no published price)
  { szolgaltatas_id: 2701, szakterulet_id: 108, szolgaltatas: 'Proktológiai vizsgálat és konzultáció', idotartam_perc: 30 },
  { szolgaltatas_id: 2801, szakterulet_id: 109, szolgaltatas: 'Érsebészeti vizsgálat és konzultáció', idotartam_perc: 30, orvos_ids: [319] },
  { szolgaltatas_id: 2802, szakterulet_id: 109, szolgaltatas: 'Sebészeti konzultáció', idotartam_perc: 30,
    info_text: 'Például anyajegyek, növedékek eltávolítása, kézsebészet.' },
  { szolgaltatas_id: 2901, szakterulet_id: 110, szolgaltatas: 'Plasztikai sebészeti konzultáció', idotartam_perc: 30 },
  { szolgaltatas_id: 3001, szakterulet_id: 111, szolgaltatas: 'Orvosesztétikai konzultáció', idotartam_perc: 30,
    info_text: 'Például ráncfeltöltés, ajakfeltöltés, bioszálak, HIFU, mezoterápia.' },
];

/** Fictional doctors; the weekly schedules are invented for the simulation. */
export const DOCTORS: Doctor[] = [
  { orvos_id: 301, nev: 'Dr. Vámos Ildikó', titulus: 'orvosigazgató, vezető orvosesztétikai bőrgyógyász', szakterulet_ids: [111, 101],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 2: [10, 16], 4: [10, 16] } },
  { orvos_id: 302, nev: 'Dr. Kertész Bernadett', titulus: 'vezető bőrgyógyász, nemigyógyász, allergológus', szakterulet_ids: [101, 105, 106],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 1: [8, 14], 3: [12, 18] } },
  { orvos_id: 303, nev: 'Dr. Halász Csaba', titulus: 'plasztikai sebész', szakterulet_ids: [110],
    beszelt_nyelvek: 'HU', rendelesi_ido: { 3: [14, 19] } },
  { orvos_id: 304, nev: 'Dr. Antal Mária', titulus: 'szülész-nőgyógyász', szakterulet_ids: [103, 104, 106],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 1: [14, 20], 4: [8, 13] } },
  { orvos_id: 305, nev: 'Dr. Erdős Bálint', titulus: 'szülész-nőgyógyász, Ph.D', szakterulet_ids: [103, 104, 106],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 2: [14, 20] } },
  { orvos_id: 307, nev: 'Dr. Csonka Zsuzsa', titulus: 'bőrgyógyász, esztétikai bőrgyógyász', szakterulet_ids: [101, 111],
    beszelt_nyelvek: 'HU', rendelesi_ido: { 2: [8, 14], 5: [8, 14] } },
  { orvos_id: 308, nev: 'Dr. Dévai P. Balázs', titulus: 'sebész, plasztikai sebész', szakterulet_ids: [109, 110],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 5: [12, 18] } },
  { orvos_id: 309, nev: 'Dr. Bárány-Ódor Ivett', titulus: 'gyermek- és felnőtt bőrgyógyász, nemigyógyász', szakterulet_ids: [101, 102, 106],
    beszelt_nyelvek: 'HU', rendelesi_ido: { 1: [12, 18], 4: [12, 18] } },
  { orvos_id: 310, nev: 'Dr. Fazekas Melinda', titulus: 'bőr- és nemigyógyász, esztétikai bőrgyógyász, Ph.D', szakterulet_ids: [101, 106, 111],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 3: [8, 13] } },
  { orvos_id: 311, nev: 'Dr. Hegedűs Balázs', titulus: 'szülész-nőgyógyász, Ph.D', szakterulet_ids: [103, 104, 106],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 3: [8, 14] } },
  { orvos_id: 313, nev: 'Dr. Kardos Martina', titulus: 'bőr- és nemigyógyász, esztétikai bőrgyógyász', szakterulet_ids: [101, 106, 111],
    beszelt_nyelvek: 'HU', rendelesi_ido: { 2: [14, 20], 5: [14, 20] } },
  { orvos_id: 314, nev: 'Dr. Keller Tünde', titulus: 'bőr- és nemigyógyász', szakterulet_ids: [101, 106],
    beszelt_nyelvek: 'HU,DE', rendelesi_ido: { 4: [14, 20] } },
  { orvos_id: 315, nev: 'Dr. Kozma Erzsébet', titulus: 'szülész-nőgyógyász', szakterulet_ids: [103, 104],
    beszelt_nyelvek: 'HU', rendelesi_ido: { 2: [8, 13], 5: [8, 13] } },
  { orvos_id: 317, nev: 'Dr. Medve Márta', titulus: 'gyermeknőgyógyász, szülész-nőgyógyász', szakterulet_ids: [103, 106],
    beszelt_nyelvek: 'HU', rendelesi_ido: { 4: [14, 19] } },
  { orvos_id: 318, nev: 'Dr. Nádor Judit', titulus: 'bőrgyógyász, gyermekbőrgyógyász, gyermekgyógyász', szakterulet_ids: [101, 102],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 2: [8, 13], 3: [8, 13] } },
  { orvos_id: 319, nev: 'Dr. Szirmai Péter', titulus: 'sebész, érsebész, proktológus, Ph.D', szakterulet_ids: [109, 108],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 1: [14, 20], 3: [14, 20] } },
  { orvos_id: 320, nev: 'Dr. Orbán Henrik', titulus: 'kézsebész', szakterulet_ids: [109],
    beszelt_nyelvek: 'HU', rendelesi_ido: { 4: [8, 12] } },
  { orvos_id: 321, nev: 'Dr. Somogyi Margit', titulus: 'szülész-nőgyógyász-sebész, Ph.D', szakterulet_ids: [103],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 1: [8, 13] } },
  { orvos_id: 322, nev: 'Dr. Szűcs Bálint', titulus: 'urológus', szakterulet_ids: [107],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 2: [12, 18], 4: [12, 18] } },
  { orvos_id: 323, nev: 'Dr. Rácz Veronika', titulus: 'bőr- és nemigyógyász, esztétikai bőrgyógyász', szakterulet_ids: [101, 106, 111],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 1: [8, 14], 4: [8, 14] } },
  { orvos_id: 324, nev: 'Dr. Tamási Dóra', titulus: 'bőr- és nemigyógyász, esztétikai bőrgyógyász', szakterulet_ids: [101, 106, 111],
    beszelt_nyelvek: 'HU', rendelesi_ido: { 3: [14, 20], 5: [8, 12] } },
  { orvos_id: 325, nev: 'Dr. Sárközi Richárd', titulus: 'esztétikát végző orvos, aneszteziológus', szakterulet_ids: [111],
    beszelt_nyelvek: 'HU,EN', rendelesi_ido: { 1: [14, 20] } },
];

/** Booking constraints: minimum lead time before a visit, closed days (YYYY-MM-DD). */
export const BOOKING_RULES = { leadMinutes: 60, holidays: [] as string[] };

/** Slot grid: every booking starts on a :00 or :30 boundary. */
export const SLOT_MINUTES = 30;

export const serviceById = (id: number) => SERVICES.find((s) => s.szolgaltatas_id === id);
export const doctorById = (id: number) => DOCTORS.find((d) => d.orvos_id === id);
export const specializationById = (id: number) => SPECIALIZATIONS.find((s) => s.szakterulet_id === id);

export function serviceByName(name: string): Service | undefined {
  const key = name.trim().toLowerCase();
  return SERVICES.find((s) => s.szolgaltatas.toLowerCase() === key);
}

export function doctorByName(name: string): Doctor | undefined {
  const key = name.replace(/^dr\.?\s*/i, '').trim().toLowerCase();
  return DOCTORS.find((d) => d.nev.replace(/^dr\.?\s*/i, '').toLowerCase() === key);
}

export function doctorsFor(service: Service): Doctor[] {
  return DOCTORS.filter((d) =>
    service.orvos_ids ? service.orvos_ids.includes(d.orvos_id) : d.szakterulet_ids.includes(service.szakterulet_id));
}

export function priceText(s: Service): string {
  if (s.min_ar === undefined || s.max_ar === undefined) return 'az ár a vizsgálaton derül ki';
  const fmt = (n: number) => n.toLocaleString('hu-HU') + ' Ft';
  return s.min_ar === s.max_ar ? fmt(s.min_ar) : `${fmt(s.min_ar)}–${fmt(s.max_ar)}`;
}

/** Prompt-ready summary of specialties, services (duration, price) and doctors. */
export function catalogSummary(): string {
  return SPECIALIZATIONS.map((sp) => {
    const services = SERVICES.filter((s) => s.szakterulet_id === sp.szakterulet_id)
      .map((s) => {
        const only = s.orvos_ids ? ', csak: ' + s.orvos_ids.map((id) => doctorById(id)?.nev).join(', ') : '';
        const info = s.info_text ? ' ' + s.info_text : '';
        return `${s.szolgaltatas} (${s.idotartam_perc} perc, ${priceText(s)}${only}).${info}`;
      })
      .join(' | ');
    const doctors = DOCTORS.filter((d) => d.szakterulet_ids.includes(sp.szakterulet_id)).map((d) => d.nev).join(', ');
    return `- ${sp.szakterulet}: ${services}. Orvos: ${doctors}.`;
  }).join('\n');
}
