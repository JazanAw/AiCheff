import { describe, expect, it } from 'vitest';
import {
  addWeeks,
  getISOWeekNumber,
  getWeekStart,
  isDayPlannable,
  weekRelation,
} from './weekDate';

// Local YYYY-MM-DD — the utils work on local calendar days (matching
// plannerApi.weekStartDate), so assertions must use local components too,
// not toISOString() which is UTC and would shift across timezones.
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('getWeekStart', () => {
  it('returns Monday for any day of the week', () => {
    // 2026-05-28 is a Thursday → Monday is 2026-05-25.
    expect(localYmd(getWeekStart(new Date(2026, 4, 28, 15, 0)))).toBe('2026-05-25');
    // Sunday 2026-05-31 still belongs to the week starting 2026-05-25.
    expect(localYmd(getWeekStart(new Date(2026, 4, 31, 23, 0)))).toBe('2026-05-25');
    // Monday maps to itself.
    expect(localYmd(getWeekStart(new Date(2026, 4, 25, 8, 0)))).toBe('2026-05-25');
  });

  it('zeroes the time component', () => {
    const d = getWeekStart(new Date(2026, 4, 28, 15, 34));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});

describe('addWeeks', () => {
  it('shifts forward and backward without mutating the input', () => {
    const base = new Date(2026, 4, 25, 0, 0);
    expect(localYmd(addWeeks(base, 1))).toBe('2026-06-01');
    expect(localYmd(addWeeks(base, -1))).toBe('2026-05-18');
    expect(localYmd(base)).toBe('2026-05-25'); // unchanged
  });
});

describe('getISOWeekNumber', () => {
  it('computes the ISO week number', () => {
    expect(getISOWeekNumber(new Date('2026-05-28T12:00:00'))).toBe(22);
    // 2025-12-29 (Mon) is ISO week 1 of 2026.
    expect(getISOWeekNumber(new Date('2025-12-29T12:00:00'))).toBe(1);
  });
});

describe('weekRelation', () => {
  const now = new Date('2026-05-28T12:00:00'); // Thursday, week of 2026-05-25
  it('classifies past / current / future weeks by week-start boundary', () => {
    expect(weekRelation(new Date('2026-05-25T00:00:00'), now)).toBe('current');
    expect(weekRelation(new Date('2026-05-31T23:00:00'), now)).toBe('current'); // same week (Sun)
    expect(weekRelation(new Date('2026-05-18T00:00:00'), now)).toBe('past');
    expect(weekRelation(new Date('2026-06-01T00:00:00'), now)).toBe('future');
  });
});

describe('isDayPlannable', () => {
  it('allows every day in a future week', () => {
    for (let d = 0; d < 7; d++) expect(isDayPlannable('future', d, 3)).toBe(true);
  });
  it('blocks every day in a past week', () => {
    for (let d = 0; d < 7; d++) expect(isDayPlannable('past', d, 3)).toBe(false);
  });
  it('allows only today and later in the current week', () => {
    // today = Thursday (dow 3)
    expect(isDayPlannable('current', 2, 3)).toBe(false); // Wed (past)
    expect(isDayPlannable('current', 3, 3)).toBe(true); // today
    expect(isDayPlannable('current', 5, 3)).toBe(true); // Sat (future)
  });
});
