// Pure date helpers for the weekly planner's calendar navigation.
//
// Monday is the week start (matches plannerApi.weekStartDate + the DB's
// weekly_plan_entries.week_start_date). Everything works on LOCAL calendar
// days for the UI; the ISO `YYYY-MM-DD` string handed to the API is produced
// by plannerApi.weekStartDate(date), so there is exactly one place that maps a
// Date → DB key and these helpers never duplicate that.

export type WeekRelation = 'past' | 'current' | 'future';

/** Monday 00:00 (local) of the week containing `date`. */
export function getWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const isoDow = (d.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  d.setDate(d.getDate() - isoDow);
  return d;
}

/** `date` shifted by `n` weeks (n may be negative). Does not mutate input. */
export function addWeeks(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n * 7);
  return d;
}

/**
 * ISO-8601 week number (1–53). Identical algorithm to the one the planner
 * header used before — kept here so KW numbers stay stable.
 */
export function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Is the week containing `weekDate` in the past, the current week, or the
 * future — relative to `now`. Compared on week-start boundaries so any day of
 * the same week counts as 'current'.
 */
export function weekRelation(weekDate: Date, now: Date = new Date()): WeekRelation {
  const a = getWeekStart(weekDate).getTime();
  const b = getWeekStart(now).getTime();
  if (a < b) return 'past';
  if (a > b) return 'future';
  return 'current';
}

/**
 * Whether a given day slot may still be planned/edited:
 *   - future week → every day is plannable
 *   - past week   → nothing is plannable
 *   - current week → only today and later (dayOfWeek >= todayDow)
 * `dayOfWeek` / `todayDow` are 0=Mon … 6=Sun. Pure.
 */
export function isDayPlannable(
  relation: WeekRelation,
  dayOfWeek: number,
  todayDow: number,
): boolean {
  if (relation === 'future') return true;
  if (relation === 'past') return false;
  return dayOfWeek >= todayDow;
}
