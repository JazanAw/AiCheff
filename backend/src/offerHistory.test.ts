import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  aggregateHistoryWeeks,
  aggregateWeekOffers,
  buildHistoryRow,
  canonicalProductKey,
  computeSnapshotId,
  countSnapshotsPerProduct,
  diffSnapshot,
  extractBarcode,
  historyRetentionCutoff,
  isoWeekKey,
  isoWeekToDateRange,
  normalizeOfferScanRunRow,
  normalizeScanType,
  type HistoryRow,
} from './offerHistory';

function makeOffer(overrides: Partial<Offer> & Record<string, unknown> = {}): Offer & Record<string, unknown> {
  return {
    id: 'official_a',
    name: 'Bio Vollmilch 1L',
    normalizedName: 'bio vollmilch 1l',
    storeChain: 'REWE',
    category: 'dairy',
    price: 1.29,
    currency: 'EUR',
    unit: '1L',
    validityStart: '2026-05-27T00:00:00.000Z',
    validityEnd: '2026-06-02T23:59:59.999Z',
    imageUrl: 'https://example.com/milk.png',
    sourceUrl: 'https://example.com/p',
    tags: ['milch'],
    createdAt: '2026-05-27T08:00:00.000Z',
    ...overrides,
  } as Offer & Record<string, unknown>;
}

describe('extractBarcode', () => {
  it('accepts GTIN-8/12/13/14 from string or number fields', () => {
    expect(extractBarcode({ barcode: '4012345678901' })).toBe('4012345678901');
    expect(extractBarcode({ ean: 12345678 })).toBe('12345678');
    expect(extractBarcode({ gtin: '40123456789012' })).toBe('40123456789012');
  });
  it('strips non-digit noise', () => {
    expect(extractBarcode({ barcode: 'GTIN: 4012345-678901' })).toBe('4012345678901');
  });
  it('rejects barcodes outside 8–14 digit range', () => {
    expect(extractBarcode({ barcode: '123' })).toBeNull();
    expect(extractBarcode({ barcode: '123456789012345' })).toBeNull();
    expect(extractBarcode({})).toBeNull();
  });
});

describe('canonicalProductKey', () => {
  it('uses barcode when present (cross-store match)', () => {
    const rewe = canonicalProductKey({ id: 'official_a', name: 'Coca-Cola', barcode: '4012345678901' });
    const lidl = canonicalProductKey({ id: 'official_b', name: 'Coca-Cola 1L', barcode: '4012345678901' });
    expect(rewe).toBe('barcode:4012345678901');
    expect(rewe).toBe(lidl);
  });
  it('falls back to brand+name when no barcode', () => {
    const k = canonicalProductKey({ id: 'x', name: 'Vollmilch 1L', brand: 'Müller' });
    expect(k).toBe('name:mueller+vollmilch 1l');
  });
  it('falls back to name only when neither barcode nor brand', () => {
    expect(canonicalProductKey({ id: 'x', name: 'Bananen lose' })).toBe('name:bananen lose');
  });
  it('does not include storeChain in key (cross-store grouping)', () => {
    const a = canonicalProductKey({ id: 'a', name: 'Bio Milch' });
    const b = canonicalProductKey({ id: 'b', name: 'Bio Milch' });
    expect(a).toBe(b);
  });
  it('handles umlauts via normalizeText', () => {
    expect(canonicalProductKey({ id: 'x', name: 'Müsli mit Nüssen' })).toBe('name:muesli mit nuessen');
  });
  it('uses id-hash fallback when name is empty', () => {
    expect(canonicalProductKey({ id: 'mystery_xyz', name: '' })).toMatch(/^id:[a-f0-9]{12}$/);
  });
});

describe('computeSnapshotId', () => {
  const FIXED = new Date('2026-05-27T09:14:30.000Z');
  it('is stable: same offer set + same minute → same id', () => {
    const a = computeSnapshotId([{ id: 'a' }, { id: 'b' }], FIXED);
    const b = computeSnapshotId([{ id: 'b' }, { id: 'a' }], FIXED);
    expect(a).toBe(b);
  });
  it('changes when the offer set changes', () => {
    const a = computeSnapshotId([{ id: 'a' }], FIXED);
    const b = computeSnapshotId([{ id: 'a' }, { id: 'b' }], FIXED);
    expect(a).not.toBe(b);
  });
  it('embeds a minute-precision UTC timestamp', () => {
    const id = computeSnapshotId([{ id: 'a' }], FIXED);
    expect(id.startsWith('2026-05-27T09:14:00Z-')).toBe(true);
  });
});

describe('buildHistoryRow', () => {
  const SNAPSHOT = 'snap-1';
  const NOW = new Date('2026-05-27T09:14:30.000Z');

  it('maps the core fields from an Offer', () => {
    const row = buildHistoryRow(makeOffer(), SNAPSHOT, NOW);
    expect(row.snapshot_id).toBe(SNAPSHOT);
    expect(row.source).toBe('official');
    // Store-scoped to mirror `deals.source_external_id` (REWE + nahkauf sharing
    // a connector id must not collide on the snapshot unique key).
    expect(row.source_external_id).toBe('rewe::official_a');
    expect(row.store_name).toBe('REWE');
    expect(row.product_name).toBe('Bio Vollmilch 1L');
    expect(row.price).toBe(1.29);
    expect(row.canonical_product_key).toMatch(/^name:bio vollmilch 1l$/);
    expect(row.valid_from).toBe('2026-05-27');
    expect(row.valid_until).toBe('2026-06-02');
    expect(row.observed_at).toBe('2026-05-27T09:14:30.000Z');
  });

  it('does NOT include raw OCR / connector dumps', () => {
    // payload is intentionally trimmed; description-style strings should
    // never appear in the serialized row.
    const row = buildHistoryRow(makeOffer({
      // these are fields that the OCR connectors sometimes set
      description: 'A huge OCR dump that we do not want in the DB',
      rawHtml: '<html>' + 'x'.repeat(5000) + '</html>',
    }), SNAPSHOT, NOW);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('A huge OCR dump');
    expect(serialized).not.toContain('rawHtml');
    expect(serialized.length).toBeLessThan(2000);
  });

  it('maps sourceScope=national/local to is_national bool', () => {
    expect(buildHistoryRow(makeOffer({ sourceScope: 'national' }), SNAPSHOT, NOW).is_national).toBe(true);
    expect(buildHistoryRow(makeOffer({ sourceScope: 'local' }), SNAPSHOT, NOW).is_national).toBe(false);
    expect(buildHistoryRow(makeOffer({ sourceScope: undefined }), SNAPSHOT, NOW).is_national).toBeNull();
  });

  it('honors `source` from the offer-id prefix (no leak of marktguru)', () => {
    expect(buildHistoryRow(makeOffer({ id: 'local_xyz' }), SNAPSHOT, NOW).source).toBe('local_ocr');
    expect(buildHistoryRow(makeOffer({ id: 'rewe_browser_x' }), SNAPSHOT, NOW).source).toBe('manual_rewe_import');
    expect(buildHistoryRow(makeOffer({ id: 'random_x' }), SNAPSHOT, NOW).source).toBe('manual');
  });
});

describe('diffSnapshot', () => {
  function row(overrides: Partial<HistoryRow>): HistoryRow {
    return {
      snapshot_id: 's1',
      observed_at: '2026-05-27T09:14:30.000Z',
      source: 'official',
      source_external_id: 'a',
      canonical_product_key: 'name:milch',
      barcode: null,
      store_name: 'REWE',
      product_name: 'Milch',
      brand: null,
      category: null,
      image_url: null,
      price: 1.29,
      original_price: null,
      savings_percent: null,
      currency: 'EUR',
      valid_from: '2026-05-27',
      valid_until: '2026-06-02',
      is_national: null,
      raw_payload: null,
      ...overrides,
    };
  }

  it('classifies new vs seen-again vs changed vs expired', () => {
    const previous = new Map<string, HistoryRow>([
      ['official:a', row({ source_external_id: 'a', price: 1.29 })],
      ['official:b', row({ source_external_id: 'b', price: 2.49 })],
      ['official:c', row({ source_external_id: 'c', price: 0.99 })],
    ]);
    const current = [
      row({ source_external_id: 'a', price: 1.29 }),         // unchanged
      row({ source_external_id: 'b', price: 1.99 }),         // changed (price)
      row({ source_external_id: 'd', price: 3.49 }),         // new
      // c missing → expired
    ];
    const diff = diffSnapshot(current, previous);
    expect(diff.seenAgainOfferIds).toEqual(['a']);
    expect(diff.changedOfferIds).toEqual(['b']);
    expect(diff.newOfferIds).toEqual(['d']);
    expect(diff.expiredOfferIds).toEqual(['c']);
  });

  it('treats valid_until change as "changed"', () => {
    const previous = new Map([['official:a', row({ source_external_id: 'a', valid_until: '2026-06-02' })]]);
    const current = [row({ source_external_id: 'a', valid_until: '2026-06-09' })];
    expect(diffSnapshot(current, previous).changedOfferIds).toEqual(['a']);
  });

  it('treats original_price change as "changed"', () => {
    const previous = new Map([['official:a', row({ source_external_id: 'a', original_price: 2.99 })]]);
    const current = [row({ source_external_id: 'a', original_price: 1.99 })];
    expect(diffSnapshot(current, previous).changedOfferIds).toEqual(['a']);
  });

  it('returns empty arrays on empty inputs (no division-by-zero etc)', () => {
    const diff = diffSnapshot([], new Map());
    expect(diff).toEqual({
      newOfferIds: [], seenAgainOfferIds: [], changedOfferIds: [], expiredOfferIds: [],
    });
  });
});

describe('historyRetentionCutoff', () => {
  it('returns a 12-month-ago UTC ISO timestamp by default', () => {
    const now = new Date('2026-05-27T09:14:30.000Z');
    const cutoff = historyRetentionCutoff(now);
    expect(cutoff).toBe('2025-05-27T09:14:30.000Z');
  });
  it('respects a custom months window', () => {
    const now = new Date('2026-05-27T09:14:30.000Z');
    expect(historyRetentionCutoff(now, 1)).toBe('2026-04-27T09:14:30.000Z');
    expect(historyRetentionCutoff(now, 24)).toBe('2024-05-27T09:14:30.000Z');
  });
});

describe('isoWeekKey', () => {
  it('returns ISO week 22 / 2026 for 2026-05-28 (Thursday)', () => {
    const k = isoWeekKey('2026-05-28T12:00:00Z');
    expect(k).toEqual({
      isoYear: 2026,
      isoWeek: 22,
      weekStartDate: '2026-05-25',
    });
  });

  it('handles the cross-year edge: 2025-12-29 (Mon) is ISO 2026 W01', () => {
    const k = isoWeekKey('2025-12-29T00:00:00Z');
    expect(k).toEqual({
      isoYear: 2026,
      isoWeek: 1,
      weekStartDate: '2025-12-29',
    });
  });

  it('handles 2026-01-04 (Sunday) as ISO 2026 W01 (week start still 2025-12-29)', () => {
    const k = isoWeekKey('2026-01-04T23:59:59Z');
    expect(k).toEqual({
      isoYear: 2026,
      isoWeek: 1,
      weekStartDate: '2025-12-29',
    });
  });

  it('handles 2026-01-05 (Monday) as ISO 2026 W02', () => {
    const k = isoWeekKey('2026-01-05T00:00:00Z');
    expect(k).toEqual({
      isoYear: 2026,
      isoWeek: 2,
      weekStartDate: '2026-01-05',
    });
  });

  it('accepts a Date and a number (epoch ms) just like a string', () => {
    const t = '2026-05-28T12:00:00Z';
    const fromString = isoWeekKey(t);
    expect(isoWeekKey(new Date(t))).toEqual(fromString);
    expect(isoWeekKey(new Date(t).getTime())).toEqual(fromString);
  });

  it('throws on an unparseable input rather than silently returning week 1', () => {
    expect(() => isoWeekKey('not-a-date')).toThrow(/invalid date/i);
  });
});

describe('countSnapshotsPerProduct', () => {
  it('counts distinct snapshots per (canonical_product_key, store_name)', () => {
    const rows = [
      { snapshot_id: 'S1', canonical_product_key: 'k:milk', store_name: 'REWE' },
      { snapshot_id: 'S2', canonical_product_key: 'k:milk', store_name: 'REWE' },
      { snapshot_id: 'S3', canonical_product_key: 'k:milk', store_name: 'REWE' },
      { snapshot_id: 'S1', canonical_product_key: 'k:milk', store_name: 'Lidl' },
    ];
    const out = countSnapshotsPerProduct(rows);
    const milkRewe = out.find((r) => r.store_name === 'REWE');
    const milkLidl = out.find((r) => r.store_name === 'Lidl');
    expect(milkRewe?.snapshotCount).toBe(3);
    expect(milkLidl?.snapshotCount).toBe(1);
  });

  it('does NOT double-count when the same snapshot has duplicate rows for the same key', () => {
    // The exact bug described in the production push report: two offers in
    // ONE snapshot normalise to the same canonical key.
    const rows = [
      { snapshot_id: 'S1', canonical_product_key: 'k:tomato', store_name: 'REWE' },
      { snapshot_id: 'S1', canonical_product_key: 'k:tomato', store_name: 'REWE' },
    ];
    const out = countSnapshotsPerProduct(rows);
    expect(out).toHaveLength(1);
    expect(out[0].snapshotCount).toBe(1);
    expect(out[0].rowCount).toBe(2);
  });

  it('exposes the raw rowCount separately so the in-snapshot duplicate is still visible', () => {
    const rows = [
      { snapshot_id: 'S1', canonical_product_key: 'k:milk', store_name: 'REWE' },
      { snapshot_id: 'S1', canonical_product_key: 'k:milk', store_name: 'REWE' },
      { snapshot_id: 'S2', canonical_product_key: 'k:milk', store_name: 'REWE' },
    ];
    const out = countSnapshotsPerProduct(rows);
    expect(out[0].snapshotCount).toBe(2);
    expect(out[0].rowCount).toBe(3);
  });

  it('skips malformed rows (missing key, store, or snapshot)', () => {
    const rows = [
      { snapshot_id: '', canonical_product_key: 'k:milk', store_name: 'REWE' },
      { snapshot_id: 'S1', canonical_product_key: '', store_name: 'REWE' },
      { snapshot_id: 'S1', canonical_product_key: 'k:milk', store_name: '' },
      { snapshot_id: 'S1', canonical_product_key: 'k:milk', store_name: 'REWE' },
    ];
    const out = countSnapshotsPerProduct(rows);
    expect(out).toHaveLength(1);
    expect(out[0].snapshotCount).toBe(1);
  });

  it('sorts most-repeated first (snapshotCount → rowCount → key)', () => {
    const rows = [
      { snapshot_id: 'S1', canonical_product_key: 'k:a', store_name: 'X' },
      { snapshot_id: 'S2', canonical_product_key: 'k:a', store_name: 'X' },
      { snapshot_id: 'S1', canonical_product_key: 'k:b', store_name: 'X' },
      { snapshot_id: 'S2', canonical_product_key: 'k:b', store_name: 'X' },
      { snapshot_id: 'S3', canonical_product_key: 'k:b', store_name: 'X' },
    ];
    const out = countSnapshotsPerProduct(rows);
    expect(out.map((o) => o.canonical_product_key)).toEqual(['k:b', 'k:a']);
  });

  it('returns an empty array for empty input', () => {
    expect(countSnapshotsPerProduct([])).toEqual([]);
  });
});

describe('normalizeScanType', () => {
  it('passes through every known value', () => {
    expect(normalizeScanType('manual_sync')).toBe('manual_sync');
    expect(normalizeScanType('one_click_ai')).toBe('one_click_ai');
    expect(normalizeScanType('auto_sync')).toBe('auto_sync');
    expect(normalizeScanType('test')).toBe('test');
    expect(normalizeScanType('unknown')).toBe('unknown');
  });

  it('falls back to "unknown" for anything outside the allowed set', () => {
    // Mirrors the DB CHECK constraint: anything else would be rejected.
    expect(normalizeScanType('MANUAL_SYNC')).toBe('unknown');
    expect(normalizeScanType('cron')).toBe('unknown');
    expect(normalizeScanType('')).toBe('unknown');
    expect(normalizeScanType(undefined)).toBe('unknown');
    expect(normalizeScanType(null)).toBe('unknown');
    expect(normalizeScanType(42)).toBe('unknown');
  });
});

describe('normalizeOfferScanRunRow', () => {
  // Helper to build a "full" row with sane defaults — tests then override
  // just the field they care about, keeping each case readable.
  const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'run-abc',
    snapshot_id: '2026-05-28T10:00:00Z-deadbeef',
    scan_type: 'manual_sync',
    status: 'completed',
    iso_year: 2026,
    iso_week: 22,
    week_start_date: '2026-05-25',
    week_end_date: '2026-05-31',
    started_at: '2026-05-28T10:00:00.000Z',
    completed_at: '2026-05-28T10:00:05.000Z',
    offers_count: 891,
    history_written_count: 891,
    expired_count: 0,
    error_count: 0,
    error_message: null,
    ...overrides,
  });

  it('camel-cases every field 1:1 from a well-formed row', () => {
    expect(normalizeOfferScanRunRow(row())).toEqual({
      id: 'run-abc',
      snapshotId: '2026-05-28T10:00:00Z-deadbeef',
      scanType: 'manual_sync',
      status: 'completed',
      isoYear: 2026,
      isoWeek: 22,
      weekStartDate: '2026-05-25',
      weekEndDate: '2026-05-31',
      startedAt: '2026-05-28T10:00:00.000Z',
      completedAt: '2026-05-28T10:00:05.000Z',
      offersCount: 891,
      historyWrittenCount: 891,
      expiredCount: 0,
      errorCount: 0,
      errorMessage: null,
    });
  });

  it('returns null when id or snapshot_id are missing — junk rows are dropped', () => {
    expect(normalizeOfferScanRunRow(row({ id: '' }))).toBeNull();
    expect(normalizeOfferScanRunRow(row({ snapshot_id: '' }))).toBeNull();
  });

  it('coerces an unknown scan_type to "unknown"', () => {
    const out = normalizeOfferScanRunRow(row({ scan_type: 'cron' }));
    expect(out?.scanType).toBe('unknown');
  });

  it('coerces an unknown status to "failed" — never surface raw junk', () => {
    const out = normalizeOfferScanRunRow(row({ status: 'pending' }));
    expect(out?.status).toBe('failed');
  });

  it('passes through `started` status (active run, not yet completed)', () => {
    const out = normalizeOfferScanRunRow(row({ status: 'started', completed_at: null }));
    expect(out?.status).toBe('started');
    expect(out?.completedAt).toBeNull();
  });

  it('passes the error_message through when status=failed', () => {
    const out = normalizeOfferScanRunRow(
      row({ status: 'failed', error_message: 'Connector REWE timed out' }),
    );
    expect(out?.status).toBe('failed');
    expect(out?.errorMessage).toBe('Connector REWE timed out');
  });
});

describe('scan-run week anchoring (semantics check)', () => {
  // The runtime uses `isoWeekKey(startedAt)` to derive iso_year / iso_week /
  // week_start_date when starting a run. Two scans on the same day land in
  // the same week; a scan crossing the Mon/Sun boundary moves to a new week.
  // These are the contract tests for that derivation.

  it('two scans in the same week share iso_year + iso_week', () => {
    const a = isoWeekKey('2026-05-26T10:00:00Z'); // Tue
    const b = isoWeekKey('2026-05-31T22:00:00Z'); // Sun
    expect(a.isoYear).toBe(b.isoYear);
    expect(a.isoWeek).toBe(b.isoWeek);
    expect(a.weekStartDate).toBe(b.weekStartDate);
  });

  it('the first scan of a new week gets a new iso_week and a new week_start_date', () => {
    const sunday = isoWeekKey('2026-05-31T22:00:00Z'); // KW 22
    const monday = isoWeekKey('2026-06-01T00:00:01Z'); // KW 23
    expect(monday.isoWeek).toBe(sunday.isoWeek + 1);
    expect(monday.weekStartDate).not.toBe(sunday.weekStartDate);
  });

  it('snapshotId is deterministic — re-running the same set gives the same id (no duplicate run)', () => {
    // Pins the idempotency property the DB UNIQUE(snapshot_id) relies on.
    const offers = [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }];
    const at = new Date('2026-05-28T10:00:00Z');
    expect(computeSnapshotId(offers, at)).toBe(computeSnapshotId(offers, at));
  });

  it('snapshotId differs between two scans even in the same week (different minute)', () => {
    const offers = [{ id: 'o1' }, { id: 'o2' }];
    const a = computeSnapshotId(offers, new Date('2026-05-28T10:00:00Z'));
    const b = computeSnapshotId(offers, new Date('2026-05-28T11:00:00Z'));
    expect(a).not.toBe(b);
  });
});

describe('isoWeekToDateRange', () => {
  it('returns the Monday/Sunday span for KW 22 / 2026', () => {
    const r = isoWeekToDateRange(2026, 22);
    expect(r.weekStartDate).toBe('2026-05-25'); // Monday
    expect(r.weekEndDate).toBe('2026-05-31'); // Sunday
    expect(r.startIso).toBe('2026-05-25T00:00:00.000Z');
    expect(r.endExclusiveIso).toBe('2026-06-01T00:00:00.000Z'); // next Monday
  });

  it('is the exact inverse of isoWeekKey at the week boundaries', () => {
    const r = isoWeekToDateRange(2026, 22);
    // Monday 00:00 and Sunday 23:59 of the range must map back to KW 22.
    expect(isoWeekKey(r.startIso).isoWeek).toBe(22);
    const lastSecond = isoWeekKey('2026-05-31T23:59:59.000Z');
    expect(lastSecond.isoYear).toBe(2026);
    expect(lastSecond.isoWeek).toBe(22);
    // The exclusive upper bound already belongs to KW 23.
    expect(isoWeekKey(r.endExclusiveIso).isoWeek).toBe(23);
  });

  it('handles the cross-year edge: KW 1 / 2026 starts 2025-12-29 (Mon)', () => {
    const r = isoWeekToDateRange(2026, 1);
    expect(r.weekStartDate).toBe('2025-12-29');
    expect(r.weekEndDate).toBe('2026-01-04');
  });

  it('Monday is always a Monday and Sunday always a Sunday (UTC)', () => {
    for (const week of [1, 10, 22, 53]) {
      const r = isoWeekToDateRange(2026, week);
      const mon = new Date(r.startIso);
      const sun = new Date(r.weekEndDate + 'T00:00:00.000Z');
      expect(mon.getUTCDay()).toBe(1); // Monday
      expect(sun.getUTCDay()).toBe(0); // Sunday
    }
  });

  it('rejects an out-of-range week', () => {
    expect(() => isoWeekToDateRange(2026, 0)).toThrow(/invalid/i);
    expect(() => isoWeekToDateRange(2026, 54)).toThrow(/invalid/i);
  });
});

describe('aggregateHistoryWeeks', () => {
  it('groups observations per ISO week and counts distinct snapshots/offers/stores', () => {
    const rows = [
      // KW 22: two snapshots (= two scans), 2 offers, 2 stores
      { observed_at: '2026-05-25T08:00:00Z', snapshot_id: 'S1', store_name: 'REWE', source: 'official', source_external_id: 'o1' },
      { observed_at: '2026-05-25T08:00:00Z', snapshot_id: 'S1', store_name: 'Lidl', source: 'official', source_external_id: 'o2' },
      { observed_at: '2026-05-27T09:00:00Z', snapshot_id: 'S2', store_name: 'REWE', source: 'official', source_external_id: 'o1' },
      // KW 23: one snapshot, 1 offer, 1 store
      { observed_at: '2026-06-01T08:00:00Z', snapshot_id: 'S3', store_name: 'Aldi', source: 'official', source_external_id: 'o9' },
    ];
    const out = aggregateHistoryWeeks(rows);
    expect(out).toHaveLength(2);
    // Newest week first.
    expect(out[0].isoWeek).toBe(23);
    expect(out[1].isoWeek).toBe(22);
    const kw22 = out[1];
    expect(kw22.snapshotCount).toBe(2); // S1, S2 — two scans in the same week
    expect(kw22.offerCount).toBe(2); // o1 (seen twice) + o2 → distinct = 2
    expect(kw22.storeCount).toBe(2); // REWE, Lidl
    expect(kw22.weekStartDate).toBe('2026-05-25');
    expect(kw22.weekEndDate).toBe('2026-05-31');
    expect(kw22.latestObservedAt).toBe('2026-05-27T09:00:00Z');
  });

  it('counts multiple scans in the same week distinctly', () => {
    const rows = [
      { observed_at: '2026-05-25T08:00:00Z', snapshot_id: 'A', store_name: 'REWE', source: 'official', source_external_id: 'o1' },
      { observed_at: '2026-05-26T08:00:00Z', snapshot_id: 'B', store_name: 'REWE', source: 'official', source_external_id: 'o1' },
      { observed_at: '2026-05-27T08:00:00Z', snapshot_id: 'C', store_name: 'REWE', source: 'official', source_external_id: 'o1' },
    ];
    const out = aggregateHistoryWeeks(rows);
    expect(out).toHaveLength(1);
    expect(out[0].snapshotCount).toBe(3); // three scans
    expect(out[0].offerCount).toBe(1); // same offer each time
  });

  it('skips rows with unparseable or missing observed_at', () => {
    const rows = [
      { observed_at: '', snapshot_id: 'S1', store_name: 'REWE', source_external_id: 'o1' },
      { observed_at: 'not-a-date', snapshot_id: 'S2', store_name: 'REWE', source_external_id: 'o2' },
      { observed_at: '2026-05-25T08:00:00Z', snapshot_id: 'S3', store_name: 'REWE', source_external_id: 'o3' },
    ];
    const out = aggregateHistoryWeeks(rows);
    expect(out).toHaveLength(1);
    expect(out[0].snapshotCount).toBe(1);
  });
});

describe('aggregateWeekOffers', () => {
  it('groups by product × store and computes min/avg/max price', () => {
    const rows = [
      { snapshot_id: 'S1', observed_at: '2026-05-25T08:00:00Z', canonical_product_key: 'name:milch', store_name: 'REWE', product_name: 'Bio Milch', brand: 'REWE Bio', category: 'dairy', image_url: 'https://x/a.png', price: 1.0, original_price: 1.5, savings_percent: 33, valid_until: '2026-05-31' },
      { snapshot_id: 'S2', observed_at: '2026-05-27T08:00:00Z', canonical_product_key: 'name:milch', store_name: 'REWE', product_name: 'Bio Milch', brand: 'REWE Bio', category: 'dairy', image_url: 'https://x/a.png', price: 2.0, original_price: 2.2, savings_percent: 9, valid_until: '2026-06-02' },
      { snapshot_id: 'S3', observed_at: '2026-05-26T08:00:00Z', canonical_product_key: 'name:milch', store_name: 'REWE', product_name: 'Bio Milch', brand: 'REWE Bio', category: 'dairy', image_url: 'https://x/a.png', price: 3.0, valid_until: '2026-05-30' },
      // Same product, different store → separate group.
      { snapshot_id: 'S1', observed_at: '2026-05-25T08:00:00Z', canonical_product_key: 'name:milch', store_name: 'Lidl', product_name: 'Bio Milch', price: 0.99, valid_until: '2026-05-31' },
    ];
    const out = aggregateWeekOffers(rows);
    expect(out).toHaveLength(2);
    const rewe = out.find((g) => g.store === 'REWE');
    expect(rewe).toBeDefined();
    if (!rewe) return;
    expect(rewe.minPrice).toBe(1.0);
    expect(rewe.maxPrice).toBe(3.0);
    expect(rewe.avgPrice).toBe(2.0); // (1+2+3)/3
    expect(rewe.snapshotCount).toBe(3);
    expect(rewe.rowCount).toBe(3);
    expect(rewe.priceChanged).toBe(true);
    expect(rewe.firstObserved).toBe('2026-05-25T08:00:00Z');
    expect(rewe.lastObserved).toBe('2026-05-27T08:00:00Z');
    // Furthest validity wins.
    expect(rewe.validUntil).toBe('2026-06-02');
    // Display fields from the most-recent observation (S2 @ 05-27).
    expect(rewe.name).toBe('Bio Milch');
    expect(rewe.originalPrice).toBe(2.2);
    expect(rewe.savingsPercent).toBe(9);
  });

  it('marks priceChanged false when the price never moves across scans', () => {
    const rows = [
      { snapshot_id: 'S1', observed_at: '2026-05-25T08:00:00Z', canonical_product_key: 'k', store_name: 'REWE', product_name: 'X', price: 2.49 },
      { snapshot_id: 'S2', observed_at: '2026-05-26T08:00:00Z', canonical_product_key: 'k', store_name: 'REWE', product_name: 'X', price: 2.49 },
    ];
    const out = aggregateWeekOffers(rows);
    expect(out).toHaveLength(1);
    expect(out[0].snapshotCount).toBe(2);
    expect(out[0].priceChanged).toBe(false);
    expect(out[0].minPrice).toBe(2.49);
    expect(out[0].maxPrice).toBe(2.49);
    expect(out[0].avgPrice).toBe(2.49);
  });

  it('sorts most-observed groups first and skips rows without key/store', () => {
    const rows = [
      { snapshot_id: 'S1', observed_at: '2026-05-25T08:00:00Z', canonical_product_key: 'a', store_name: 'REWE', product_name: 'A', price: 1 },
      { snapshot_id: 'S1', observed_at: '2026-05-25T08:00:00Z', canonical_product_key: 'b', store_name: 'REWE', product_name: 'B', price: 1 },
      { snapshot_id: 'S2', observed_at: '2026-05-26T08:00:00Z', canonical_product_key: 'b', store_name: 'REWE', product_name: 'B', price: 1 },
      // dropped: no canonical key / no store
      { snapshot_id: 'S3', observed_at: '2026-05-27T08:00:00Z', canonical_product_key: '', store_name: 'REWE', product_name: 'junk', price: 1 },
      { snapshot_id: 'S3', observed_at: '2026-05-27T08:00:00Z', canonical_product_key: 'c', store_name: '', product_name: 'junk', price: 1 },
    ];
    const out = aggregateWeekOffers(rows);
    expect(out).toHaveLength(2);
    expect(out[0].canonicalProductKey).toBe('b'); // 2 snapshots > 1
    expect(out[1].canonicalProductKey).toBe('a');
  });
});
