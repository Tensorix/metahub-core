// Date helpers shared by the calendar and timeline views. All dates are handled
// as *local* calendar days (no time component): date property values are stored
// as "YYYY-MM-DD" strings (produced by <input type="date">), so we parse/format
// in local time to avoid timezone drift around midnight.

const MS_DAY = 86_400_000;

/** Parse a "YYYY-MM-DD" (optionally with time) value into a local midnight Date.
 *  Returns null for empty / unparseable values. */
export function parseDate(v: unknown): Date | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Format a Date as "YYYY-MM-DD" in local time. */
export function toISO(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** A new Date n days after d (n may be negative). Time is normalized to midnight. */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** True when a and b fall on the same calendar day. */
export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function startOfMonth(y: number, m: number): Date {
  return new Date(y, m, 1);
}
export function endOfMonth(y: number, m: number): Date {
  return new Date(y, m + 1, 0);
}

/** Whole calendar days from a to b (b - a), rounded; same day → 0. */
export function daysBetween(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / MS_DAY);
}

/** Today at local midnight. */
export function today(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/** Monday-of-the-week for d (Monday = start of week). */
export function startOfWeekMon(d: Date): Date {
  const dow = (d.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  return addDays(d, -dow);
}

/** A grid of weeks (each 7 days, Monday-first) that fully covers month (y, m).
 *  Always returns whole weeks; length is 5 or 6 rows. */
export function monthMatrix(y: number, m: number): Date[][] {
  const first = startOfWeekMon(startOfMonth(y, m));
  const last = endOfMonth(y, m);
  const weeks: Date[][] = [];
  let cur = first;
  while (cur <= last || weeks.length === 0 || cur.getDay() !== 1) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) week.push(addDays(cur, i));
    weeks.push(week);
    cur = addDays(cur, 7);
    if (weeks.length >= 6) break;
  }
  return weeks;
}
