import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import type { SnapshotBuckets } from './offerAiRescanScope';
import {
  isStoreExcluded,
  isoWeekLabel,
  parseExcludedStores,
  parseTimeToMinutes,
  parseWeekdayIndex,
  partitionExcludedFromBuckets,
  resolveWeeklyScanProfile,
  shouldRunWeeklyScanNow,
} from './weeklyAutoScan';

function offer(id: string, storeChain: string): Offer {
  return {
    id,
    name: `Produkt ${id}`,
    normalizedName: `produkt ${id}`,
    storeChain,
    category: 'other',
    price: 1,
    currency: 'EUR',
    unit: '1 St',
    validityStart: '2026-06-01T00:00:00.000Z',
    validityEnd: '2026-06-07T23:59:59.999Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

describe('parseExcludedStores', () => {
  it('defaults to REWE + nahkauf when empty', () => {
    expect(parseExcludedStores('')).toEqual(['rewe', 'nahkauf']);
    expect(parseExcludedStores(undefined)).toEqual(['rewe', 'nahkauf']);
  });
  it('parses + lowercases + dedupes a csv', () => {
    expect(parseExcludedStores('REWE, nahkauf ,REWE,Edeka')).toEqual(['rewe', 'nahkauf', 'edeka']);
  });
});

describe('isStoreExcluded', () => {
  it('is case-insensitive', () => {
    expect(isStoreExcluded('REWE', ['rewe', 'nahkauf'])).toBe(true);
    expect(isStoreExcluded('Lidl', ['rewe', 'nahkauf'])).toBe(false);
    expect(isStoreExcluded(undefined, ['rewe'])).toBe(false);
  });
});

describe('partitionExcludedFromBuckets — keeps REWE, replaces the rest', () => {
  it('retains excluded-store offers per bucket and counts replaced', () => {
    const buckets: SnapshotBuckets = {
      current: [offer('a', 'REWE'), offer('b', 'Lidl')],
      next: [offer('c', 'nahkauf'), offer('d', 'ALDI SUED')],
      filtered: [offer('e', 'REWE'), offer('f', 'Kaufland')],
    };
    const { retained, retainedCount, replacedCount } = partitionExcludedFromBuckets(
      buckets,
      ['rewe', 'nahkauf'],
    );
    expect(retained.current.map((o) => o.id)).toEqual(['a']);
    expect(retained.next.map((o) => o.id)).toEqual(['c']);
    expect(retained.filtered.map((o) => o.id)).toEqual(['e']);
    expect(retainedCount).toBe(3);
    expect(replacedCount).toBe(3);
  });
});

describe('resolveWeeklyScanProfile', () => {
  const central = {
    forceAll: true,
    centralTimeoutMs: 90000,
    centralBatchSize: 6,
    centralMaxFailures: 3,
    weeklyTimeoutMs: 120000,
    weeklyBatchSize: 8,
    allowCpu: false,
  };

  it('high_quality uses the longer timeout, bigger batch, and requires GPU', () => {
    const p = resolveWeeklyScanProfile({ aiMode: 'high_quality', ...central });
    expect(p.aiMode).toBe('high_quality');
    expect(p.ollamaTimeoutMs).toBe(120000);
    expect(p.ollamaBatchSize).toBe(8);
    expect(p.maxConsecutiveFailures).toBe(3);
    expect(p.requireGpu).toBe(true);
    expect(p.forceAll).toBe(true);
  });

  it('never drops below a user-raised central timeout', () => {
    const p = resolveWeeklyScanProfile({ aiMode: 'high_quality', ...central, centralTimeoutMs: 150000 });
    expect(p.ollamaTimeoutMs).toBe(150000);
  });

  it('allowCpu=true relaxes the GPU requirement', () => {
    const p = resolveWeeklyScanProfile({ aiMode: 'high_quality', ...central, allowCpu: true });
    expect(p.requireGpu).toBe(false);
  });

  it('standard mode uses central values and no GPU requirement', () => {
    const p = resolveWeeklyScanProfile({ aiMode: 'standard', ...central });
    expect(p.aiMode).toBe('standard');
    expect(p.ollamaTimeoutMs).toBe(90000);
    expect(p.ollamaBatchSize).toBe(6);
    expect(p.requireGpu).toBe(false);
  });
});

describe('parseWeekdayIndex / parseTimeToMinutes', () => {
  it('maps EN/DE weekday names to 0..6 (Sun..Sat)', () => {
    expect(parseWeekdayIndex('MONDAY')).toBe(1);
    expect(parseWeekdayIndex('montag')).toBe(1);
    expect(parseWeekdayIndex('Sun')).toBe(0);
    expect(parseWeekdayIndex('nope')).toBeNull();
  });
  it('parses HH:MM to minutes', () => {
    expect(parseTimeToMinutes('06:00')).toBe(360);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
    expect(parseTimeToMinutes('24:00')).toBeNull();
    expect(parseTimeToMinutes('bad')).toBeNull();
  });
});

describe('shouldRunWeeklyScanNow', () => {
  // 2026-06-01 is a Monday.
  const monday0700 = new Date('2026-06-01T07:00:00');
  const base = { enabled: true, day: 'MONDAY', time: '06:00', lastTriggeredIso: null, running: false };

  it('fires on the right weekday after the configured time, once per day', () => {
    expect(shouldRunWeeklyScanNow({ now: monday0700, ...base })).toBe(true);
  });
  it('does not fire before the configured time', () => {
    expect(shouldRunWeeklyScanNow({ now: new Date('2026-06-01T05:30:00'), ...base })).toBe(false);
  });
  it('does not fire on the wrong weekday', () => {
    expect(shouldRunWeeklyScanNow({ now: new Date('2026-06-02T07:00:00'), ...base })).toBe(false);
  });
  it('does not fire twice on the same calendar day', () => {
    expect(
      shouldRunWeeklyScanNow({ now: monday0700, ...base, lastTriggeredIso: '2026-06-01T06:01:00' }),
    ).toBe(false);
  });
  it('does not fire when disabled or already running', () => {
    expect(shouldRunWeeklyScanNow({ now: monday0700, ...base, enabled: false })).toBe(false);
    expect(shouldRunWeeklyScanNow({ now: monday0700, ...base, running: true })).toBe(false);
  });
});

describe('isoWeekLabel', () => {
  it('produces a YYYY-Www label', () => {
    expect(isoWeekLabel(new Date('2026-06-01T12:00:00Z'))).toMatch(/^2026-W\d{2}$/);
  });
});
