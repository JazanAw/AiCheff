// Pure, testable helpers for the weekly auto-scan ("Vollgas") mode.
//
// The weekly auto-scan scrapes every connected source EXCEPT the excluded
// stores (REWE/nahkauf — they 403/captcha and stay file-import only), then runs
// the KI categorizer in a high-quality profile. These helpers stay free of IO so
// server.ts can keep the heavy lifting (scrape, python pipeline, snapshot).

import type { SnapshotBuckets } from './offerAiRescanScope';

export type WeeklyScanPhase =
  | 'idle'
  | 'preflight'
  | 'scrape'
  | 'filter'
  | 'ai'
  | 'history'
  | 'done'
  | 'error'
  | 'cancelled';

export interface WeeklyScanProfileInput {
  aiMode: string;
  forceAll: boolean;
  centralTimeoutMs: number;
  centralBatchSize: number;
  centralMaxFailures: number;
  weeklyTimeoutMs: number;
  weeklyBatchSize: number;
  allowCpu: boolean;
}

export interface WeeklyScanProfile {
  aiMode: 'high_quality' | 'standard';
  forceAll: boolean;
  ollamaTimeoutMs: number;
  ollamaBatchSize: number;
  maxConsecutiveFailures: number;
  /** Whether a GPU preflight should hard-block on missing/insufficient VRAM. */
  requireGpu: boolean;
}

/**
 * Parse the WEEKLY_SCAN_EXCLUDED_STORES csv into a clean lowercase list.
 * Empty input falls back to the safe default (REWE + nahkauf).
 */
export function parseExcludedStores(
  raw: string | undefined,
  fallback: readonly string[] = ['rewe', 'nahkauf'],
): string[] {
  const parts = String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const source = parts.length > 0 ? parts : fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of source) {
    const norm = entry.trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/** Whether a store chain is in the excluded set (case-insensitive). */
export function isStoreExcluded(
  storeChain: string | undefined,
  excluded: readonly string[],
): boolean {
  const chain = String(storeChain ?? '').trim().toLowerCase();
  if (!chain) return false;
  return excluded.includes(chain);
}

export interface ExcludedPartition {
  /** Excluded-store offers from the current snapshot, kept per bucket. These are
   *  the manually-imported REWE/nahkauf offers that must survive the scan. */
  retained: SnapshotBuckets;
  /** How many non-excluded offers will be replaced by the fresh scrape. */
  replacedCount: number;
  /** How many excluded offers are preserved. */
  retainedCount: number;
}

/**
 * Split the current snapshot buckets into the excluded-store offers to KEEP and
 * count the non-excluded offers that the fresh scrape will replace. This is what
 * preserves REWE/nahkauf (file-imported) while every other store is refreshed.
 */
export function partitionExcludedFromBuckets(
  buckets: SnapshotBuckets,
  excluded: readonly string[],
): ExcludedPartition {
  const retained: SnapshotBuckets = { current: [], next: [], filtered: [] };
  let replacedCount = 0;
  let retainedCount = 0;

  const sort = (offers: readonly { storeChain?: string }[], bucket: keyof SnapshotBuckets): void => {
    for (const offer of offers) {
      if (isStoreExcluded(offer.storeChain, excluded)) {
        retained[bucket].push(offer as SnapshotBuckets['current'][number]);
        retainedCount += 1;
      } else {
        replacedCount += 1;
      }
    }
  };

  sort(buckets.current, 'current');
  sort(buckets.next, 'next');
  sort(buckets.filtered, 'filtered');

  return { retained, replacedCount, retainedCount };
}

/**
 * Resolve the effective AI profile for the weekly scan. high_quality uses the
 * longer weekly timeout (≥120 s) and a slightly larger batch, and requires a
 * GPU unless CPU is explicitly allowed. Fail-fast stays at the central value.
 */
export function resolveWeeklyScanProfile(input: WeeklyScanProfileInput): WeeklyScanProfile {
  const highQuality = String(input.aiMode).trim().toLowerCase() === 'high_quality';
  if (!highQuality) {
    return {
      aiMode: 'standard',
      forceAll: input.forceAll,
      ollamaTimeoutMs: input.centralTimeoutMs,
      ollamaBatchSize: input.centralBatchSize,
      maxConsecutiveFailures: input.centralMaxFailures,
      requireGpu: false,
    };
  }
  return {
    aiMode: 'high_quality',
    forceAll: input.forceAll,
    // At least the weekly timeout, but never below a user-raised central value.
    ollamaTimeoutMs: Math.max(input.weeklyTimeoutMs, input.centralTimeoutMs),
    ollamaBatchSize: Math.max(input.weeklyBatchSize, input.centralBatchSize),
    maxConsecutiveFailures: input.centralMaxFailures,
    requireGpu: !input.allowCpu,
  };
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0, sunday: 0, so: 0, sonntag: 0,
  mon: 1, monday: 1, mo: 1, montag: 1,
  tue: 2, tuesday: 2, di: 2, dienstag: 2,
  wed: 3, wednesday: 3, mi: 3, mittwoch: 3,
  thu: 4, thursday: 4, do: 4, donnerstag: 4,
  fri: 5, friday: 5, fr: 5, freitag: 5,
  sat: 6, saturday: 6, sa: 6, samstag: 6,
};

/** Map a configured day name (EN/DE/abbrev) to 0..6 (Sun..Sat), or null. */
export function parseWeekdayIndex(day: string | undefined): number | null {
  const key = String(day ?? '').trim().toLowerCase();
  return key in WEEKDAY_INDEX ? WEEKDAY_INDEX[key] : null;
}

/** Parse "HH:MM" into minutes-since-midnight, or null when malformed. */
export function parseTimeToMinutes(time: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface WeeklyScheduleInput {
  now: Date;
  enabled: boolean;
  day: string;
  time: string;
  /** ISO timestamp of the last auto-trigger, or null if never. */
  lastTriggeredIso: string | null;
  /** True if a run is currently active (never double-trigger). */
  running: boolean;
}

/**
 * Decide whether the in-process scheduler should fire now. Fires when: enabled,
 * not already running, today matches the configured weekday, the time has passed
 * the configured HH:MM, and we have not already triggered today. A polling tick
 * (e.g. every minute) calls this; the calendar-day guard prevents re-triggering.
 */
export function shouldRunWeeklyScanNow(input: WeeklyScheduleInput): boolean {
  if (!input.enabled || input.running) return false;
  const targetDay = parseWeekdayIndex(input.day);
  const targetMinutes = parseTimeToMinutes(input.time);
  if (targetDay === null || targetMinutes === null) return false;

  const now = input.now;
  if (now.getDay() !== targetDay) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (nowMinutes < targetMinutes) return false;

  if (input.lastTriggeredIso) {
    const last = new Date(input.lastTriggeredIso);
    if (
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate()
    ) {
      return false; // already triggered today
    }
  }
  return true;
}

/** ISO-week label like "2026-W23" for the current date (for scan-run display). */
export function isoWeekLabel(date: Date): string {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
