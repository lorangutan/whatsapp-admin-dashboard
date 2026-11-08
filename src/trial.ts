// Free-trial and account-blocking rules, shared by login, every API request and the Admin screen.

export interface AccessFields {
  trialFrom: string | null;
  trialUntil: string | null;
  disabled: boolean;
  utcOffsetMinutes: number;
}

/** Today's date (YYYY-MM-DD) on the shop's own calendar. */
export function localToday(utcOffsetMinutes: number, now = new Date()) {
  return new Date(now.getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

const fmt = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Why this account may not use Wamon right now, or null if it may. Trial dates are inclusive. */
export function accessProblem(u: AccessFields, now = new Date()): string | null {
  if (u.disabled) return 'Akun ini dinonaktifkan. Hubungi tim Wamon.';
  const today = localToday(u.utcOffsetMinutes, now);
  if (u.trialFrom && today < u.trialFrom) return `Masa trial baru mulai ${fmt(u.trialFrom)}.`;
  if (u.trialUntil && today > u.trialUntil) {
    return `Masa trial berakhir ${fmt(u.trialUntil)}. Hubungi tim Wamon untuk lanjut berlangganan.`;
  }
  return null;
}

/** Whole days left in the trial including today, or null when there is no end date. */
export function trialDaysLeft(u: Pick<AccessFields, 'trialUntil' | 'utcOffsetMinutes'>, now = new Date()) {
  if (!u.trialUntil) return null;
  const today = localToday(u.utcOffsetMinutes, now);
  return Math.round((Date.parse(`${u.trialUntil}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 1;
}

export const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
