export type OfferWeekBucket = 'current' | 'next' | 'other';
export type OfferWeekMode = 'overlap' | 'starts';

const weekClassifierShiftMs = 12 * 60 * 60 * 1000;
const weekDurationMs = 7 * 24 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

function weekWindowFromTimestamp(anchorMs: number): { startMs: number; endMs: number } {
  const date = new Date(anchorMs);
  const utcDate = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayOfWeek = utcDate.getUTCDay();
  const diffToMonday = (dayOfWeek + 6) % 7;

  const weekStart = new Date(utcDate);
  weekStart.setUTCDate(utcDate.getUTCDate() - diffToMonday);
  weekStart.setUTCHours(0, 0, 0, 0);

  return {
    startMs: weekStart.valueOf(),
    endMs: weekStart.valueOf() + weekDurationMs - 1,
  };
}

function isSundayRolloverDay(now: Date): boolean {
  // UTC to stay consistent with weekWindowFromTimestamp (which does all of its
  // week math in UTC). Using the local getDay() made the result depend on the
  // runner/server timezone.
  return now.getUTCDay() === 0;
}

export function classifyOfferWeekRange(
  startMs: number,
  endMs: number,
  now = new Date(),
  mode: OfferWeekMode = 'overlap',
  maxValidityDays = 21,
): OfferWeekBucket {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 'other';
  }

  const durationMs = endMs - startMs;
  const maxValidityMs = Math.max(1, maxValidityDays) * dayMs;
  if (durationMs > maxValidityMs) {
    return 'other';
  }

  const adjustedStartMs = startMs + weekClassifierShiftMs;
  const adjustedEndMs = endMs + weekClassifierShiftMs;
  // The +12h shift is applied ONLY to the OFFER range (above) to absorb
  // midnight/timezone boundaries of validity dates. It must NOT be applied to
  // `now` as well: on a Sunday afternoon `now + 12h` already rolls into Monday,
  // pushing `currentWeek` to the next calendar week — and then the Sunday
  // rollover below shifts it AGAIN (double shift), which dropped Monday offers
  // into 'other'. Anchor the current week on the unshifted `now`.
  const currentWeek = weekWindowFromTimestamp(now.valueOf());
  const calendarNextWeek = {
    startMs: currentWeek.startMs + weekDurationMs,
    endMs: currentWeek.endMs + weekDurationMs,
  };
  const followingWeek = {
    startMs: calendarNextWeek.startMs + weekDurationMs,
    endMs: calendarNextWeek.endMs + weekDurationMs,
  };
  const sundayRollover = isSundayRolloverDay(now);
  const activeWeek = sundayRollover ? calendarNextWeek : currentWeek;
  const nextWeek = sundayRollover ? followingWeek : calendarNextWeek;

  const overlapsCurrent =
    adjustedStartMs <= activeWeek.endMs &&
    adjustedEndMs >= activeWeek.startMs;
  const overlapsNext =
    adjustedStartMs <= nextWeek.endMs &&
    adjustedEndMs >= nextWeek.startMs;

  const startsCurrent =
    adjustedStartMs >= activeWeek.startMs &&
    adjustedStartMs <= activeWeek.endMs;
  const startsNext =
    adjustedStartMs >= nextWeek.startMs &&
    adjustedStartMs <= nextWeek.endMs;

  if (sundayRollover) {
    if (startsCurrent || (overlapsCurrent && durationMs > weekDurationMs)) {
      return 'current';
    }
    if (startsNext || (overlapsNext && durationMs > weekDurationMs)) {
      return 'next';
    }
    return 'other';
  }

  if (mode === 'starts') {
    if (startsNext) {
      return 'next';
    }
    if (startsCurrent) {
      return 'current';
    }
    return 'other';
  }

  if (overlapsCurrent && overlapsNext) {
    // Keep regular week offers in current bucket, but move true multi-week ranges to next bucket.
    return durationMs > weekDurationMs ? 'next' : 'current';
  }

  if (overlapsNext) {
    return 'next';
  }
  if (overlapsCurrent) {
    return 'current';
  }
  return 'other';
}
