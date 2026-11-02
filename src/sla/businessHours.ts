/** Opening windows per weekday (0 = Sunday … 6 = Saturday) as local wall-clock "HH:MM". */
export type BusinessHours = Partial<Record<number, Array<[string, string]>>>;

export interface ShopClock {
  /** Indonesia has no DST, so a fixed offset is exact: WIB 420, WITA 480, WIT 540. */
  utcOffsetMinutes: number;
  hours: BusinessHours;
}

export const MINUTE = 60_000;
const DAY = 1440 * MINUTE;

function toMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Milliseconds between start and end that fall inside opening hours.
 * A chat that arrives at 22:00 and is answered at 08:05 next morning costs 5 minutes, not 10 hours.
 */
export function businessMs(start: Date, end: Date, clock: ShopClock): number {
  const offset = clock.utcOffsetMinutes * MINUTE;
  // Shift into local wall-clock time so UTC date math lines up with local days.
  const a = start.getTime() + offset;
  const b = end.getTime() + offset;
  let total = 0;
  for (let day = Math.floor(a / DAY) * DAY; day < b; day += DAY) {
    for (const [open, close] of clock.hours[new Date(day).getUTCDay()] ?? []) {
      const s = Math.max(a, day + toMinutes(open) * MINUTE);
      const e = Math.min(b, day + toMinutes(close) * MINUTE);
      if (e > s) total += e - s;
    }
  }
  return total;
}

/** UTC instant of local midnight for the day containing `at`. */
export function localDayStart(at: Date, clock: ShopClock): Date {
  const offset = clock.utcOffsetMinutes * MINUTE;
  return new Date(Math.floor((at.getTime() + offset) / DAY) * DAY - offset);
}

/** A Date whose UTC fields read as the shop's local wall-clock time; format it with timeZone 'UTC'. */
export function toLocalWallClock(at: Date, clock: ShopClock): Date {
  return new Date(at.getTime() + clock.utcOffsetMinutes * MINUTE);
}
