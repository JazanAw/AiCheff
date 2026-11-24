import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Offer } from '../../../src/types/models';
import {
  dedupeDealRows,
  expireDisabledStoreDeals,
  expireStaleDeals,
  offerToDealRow,
  syncDealsToSupabase,
  type DealRow,
} from './supabaseDealsSync';

// ---------------------------------------------------------------------------
// Minimal but faithful Supabase stub for the `deals` table. It MUTATES its
// backing array on upsert/update so a test can assert the post-sync state, and
// it records the size of every `.in('id', [...])` UPDATE so we can prove the
// stale-cleanup chunks (never one giant request → no PostgREST Bad Request).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface Calls {
  /** Size of each `.in('id', [...])` list issued in UPDATE mode. */
  updateChunks: number[];
}

class Builder {
  private filters: ((r: Row) => boolean)[] = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private mode: 'select' | 'upsert' | 'update' | null = null;
  private upsertRows: Row[] = [];
  private updatePatch: Row = {};

  constructor(private deals: Row[], private calls: Calls) {}

  select(): this {
    this.mode = 'select';
    return this;
  }
  gte(col: string, val: unknown): this {
    this.filters.push((r) => String(r[col] ?? '') >= String(val));
    return this;
  }
  in(col: string, vals: unknown[]): this {
    const set = new Set(vals.map(String));
    this.filters.push((r) => set.has(String(r[col])));
    if (this.mode === 'update' && col === 'id') this.calls.updateChunks.push(vals.length);
    return this;
  }
  order(): this {
    return this;
  }
  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  upsert(rows: Row[]): this {
    this.mode = 'upsert';
    this.upsertRows = rows;
    return this;
  }
  update(patch: Row): this {
    this.mode = 'update';
    this.updatePatch = patch;
    return this;
  }

  private exec(): { data: Row[] | null; error: null; count?: number } {
    if (this.mode === 'select') {
      let data = this.deals.filter((r) => this.filters.every((f) => f(r)));
      if (this.rangeFrom != null && this.rangeTo != null) {
        data = data.slice(this.rangeFrom, this.rangeTo + 1);
      }
      return { data: data.map((r) => ({ ...r })), error: null };
    }
    if (this.mode === 'upsert') {
      for (const row of this.upsertRows) {
        const idx = this.deals.findIndex(
          (d) =>
            d.source === row.source && d.source_external_id === row.source_external_id,
        );
        if (idx >= 0) this.deals[idx] = { ...this.deals[idx], ...row };
        else this.deals.push({ id: `gen_${this.deals.length}`, ...row });
      }
      return { data: null, error: null };
    }
    if (this.mode === 'update') {
      let count = 0;
      for (const r of this.deals) {
        if (this.filters.every((f) => f(r))) {
          Object.assign(r, this.updatePatch);
          count += 1;
        }
      }
      return { data: null, error: null, count };
    }
    return { data: null, error: null };
  }

  then<T>(resolve: (v: { data: Row[] | null; error: null; count?: number }) => T): Promise<T> {
    return Promise.resolve(this.exec()).then(resolve);
  }
}

function fakeClient(deals: Row[]): { client: SupabaseClient; deals: Row[]; calls: Calls } {
  const calls: Calls = { updateChunks: [] };
  const client = {
    from(table: string) {
      if (table !== 'deals') throw new Error(`unexpected table ${table}`);
      return new Builder(deals, calls);
    },
  } as unknown as SupabaseClient;
  return { client, deals, calls };
}

const NOW = new Date('2026-06-22T10:00:00.000Z');
const TODAY = '2026-06-22';
const YESTERDAY = '2026-06-21';
const FUTURE = '2026-06-29';

/** A pre-existing active deal row already in the `deals` table. */
function existingDeal(overrides: Partial<Row> & { source_external_id: string }): Row {
  return {
    id: `db_${overrides.source_external_id}`,
    source: 'official',
    store_name: 'PENNY',
    valid_from: TODAY,
    valid_to: FUTURE, // still inside its window → active
    is_verified: false,
    ...overrides,
  };
}

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'official_x',
    name: 'Tomaten',
    normalizedName: 'tomaten',
    storeChain: 'PENNY',
    category: 'Obst & Gemüse',
    price: 1.99,
    currency: 'EUR',
    unit: 'kg',
    validityStart: '',
    validityEnd: '',
    sourceUrl: '',
    tags: [],
    createdAt: NOW.toISOString(),
    ...overrides,
  } as Offer;
}

function syncedRow(store: string, externalId: string): Pick<DealRow, 'store_name' | 'source_external_id'> {
  return { store_name: store, source_external_id: externalId };
}

describe('expireStaleDeals', () => {
  it('expires active deals whose id is no longer in the snapshot (PENNY stale)', async () => {
    const deals: Row[] = [
      existingDeal({ source_external_id: 'official_old_1' }),
      existingDeal({ source_external_id: 'official_old_2' }),
      existingDeal({ source_external_id: 'official_keep' }),
    ];
    const { client, calls } = fakeClient(deals);

    const result = await expireStaleDeals(
      client,
      [syncedRow('PENNY', 'official_keep')],
      NOW,
    );

    expect(result.staleExpired).toBe(2);
    expect(result.staleByStore).toEqual({ PENNY: 2 });
    expect(result.errors).toEqual([]);
    // Old ones collapsed to yesterday (no longer active), the kept one untouched.
    const byId = new Map(deals.map((d) => [d.source_external_id, d]));
    expect(byId.get('official_old_1')?.valid_to).toBe(YESTERDAY);
    expect(byId.get('official_old_1')?.valid_from).toBe(YESTERDAY);
    expect(byId.get('official_keep')?.valid_to).toBe(FUTURE);
    // One update call for the 2 stale ids.
    expect(calls.updateChunks).toEqual([2]);
  });

  it('keeps current AND future snapshot deals active', async () => {
    const deals: Row[] = [
      existingDeal({ source_external_id: 'official_cur', valid_to: TODAY }),
      existingDeal({ source_external_id: 'official_fut', valid_from: FUTURE, valid_to: '2026-07-05' }),
    ];
    const { client } = fakeClient(deals);

    const result = await expireStaleDeals(
      client,
      [syncedRow('PENNY', 'official_cur'), syncedRow('PENNY', 'official_fut')],
      NOW,
    );

    expect(result.staleExpired).toBe(0);
    expect(deals.find((d) => d.source_external_id === 'official_fut')?.valid_to).toBe('2026-07-05');
  });

  it('never touches deals of a store that is not in this snapshot', async () => {
    const deals: Row[] = [
      existingDeal({ source_external_id: 'rewe_old', store_name: 'REWE' }),
      existingDeal({ source_external_id: 'official_old', store_name: 'PENNY' }),
    ];
    const { client } = fakeClient(deals);

    // Snapshot only carries PENNY → REWE must stay untouched.
    const result = await expireStaleDeals(client, [syncedRow('PENNY', 'something_else')], NOW);

    expect(result.staleByStore).toEqual({ PENNY: 1 });
    expect(deals.find((d) => d.source_external_id === 'rewe_old')?.valid_to).toBe(FUTURE);
  });

  it('never touches admin-verified deals', async () => {
    const deals: Row[] = [
      existingDeal({ source_external_id: 'official_admin', is_verified: true }),
      existingDeal({ source_external_id: 'official_normal' }),
    ];
    const { client } = fakeClient(deals);

    const result = await expireStaleDeals(client, [syncedRow('PENNY', 'kept')], NOW);

    expect(result.staleExpired).toBe(1); // only the normal one
    expect(deals.find((d) => d.source_external_id === 'official_admin')?.valid_to).toBe(FUTURE);
  });

  it('chunks a large stale set so no single request is over-long', async () => {
    const deals: Row[] = Array.from({ length: 250 }, (_, i) =>
      existingDeal({ source_external_id: `official_old_${i}` }),
    );
    const { client, calls } = fakeClient(deals);

    const result = await expireStaleDeals(client, [syncedRow('PENNY', 'kept')], NOW);

    expect(result.staleExpired).toBe(250);
    // 100 + 100 + 50 — every request well under any URL-length limit.
    expect(calls.updateChunks).toEqual([100, 100, 50]);
    expect(calls.updateChunks.every((n) => n <= 100)).toBe(true);
  });
});

describe('dedupeDealRows (store-scoped keys)', () => {
  it('keeps REWE and nahkauf with the SAME connector id as two separate rows', () => {
    // The structural fix: store-scoped source_external_id means the shared
    // connector id no longer collides cross-store — both stores survive.
    const rewe = offerToDealRow(
      makeOffer({ id: 'official_shared', storeChain: 'REWE' }),
      {},
      'current',
      NOW,
    );
    const nahkauf = offerToDealRow(
      makeOffer({ id: 'official_shared', storeChain: 'nahkauf' }),
      {},
      'current',
      NOW,
    );
    const unique = offerToDealRow(
      makeOffer({ id: 'official_unique', storeChain: 'nahkauf' }),
      {},
      'current',
      NOW,
    );

    // The two scoped keys are distinct and carry the original id as a suffix.
    expect(rewe.source_external_id).toBe('rewe::official_shared');
    expect(nahkauf.source_external_id).toBe('nahkauf::official_shared');

    const result = dedupeDealRows([rewe, nahkauf, unique]);

    expect(result.rows).toHaveLength(3); // nothing collapsed cross-store
    expect(result.collisions).toBe(0);
    expect(result.collisionSamples).toEqual([]);
  });

  it('still collapses a genuine in-store duplicate (same store, same id)', () => {
    const a = offerToDealRow(makeOffer({ id: 'official_dup', storeChain: 'REWE' }), {}, 'current', NOW);
    const b = offerToDealRow(makeOffer({ id: 'official_dup', storeChain: 'REWE' }), {}, 'current', NOW);

    const result = dedupeDealRows([a, b]);

    expect(result.rows).toHaveLength(1); // real duplicate collapsed
    expect(result.collisions).toBe(1);
    expect(result.collisionSamples[0]).toContain('official:rewe::official_dup');
    expect(result.collisionSamples[0]).toContain('REWE');
  });
});

describe('syncDealsToSupabase — stale-cleanup integration', () => {
  it('PENNY regression: old active deals expire, new ones stay current', async () => {
    // Table already holds 3 old PENNY deals from a previous ID generation.
    const deals: Row[] = [
      existingDeal({ source: 'official', source_external_id: 'official_pold_1' }),
      existingDeal({ source: 'official', source_external_id: 'official_pold_2' }),
      existingDeal({ source: 'official', source_external_id: 'official_pold_3' }),
    ];
    const { client } = fakeClient(deals);

    // Snapshot carries 3 NEW PENNY offers with different ids.
    const offers: Offer[] = [
      makeOffer({ id: 'official_pnew_1', storeChain: 'PENNY' }),
      makeOffer({ id: 'official_pnew_2', storeChain: 'PENNY' }),
      makeOffer({ id: 'official_pnew_3', storeChain: 'PENNY' }),
    ];

    const result = await syncDealsToSupabase(offers, {}, { now: NOW, client });

    expect(result.upserted).toBe(3);
    expect(result.staleExpired).toBe(3);
    expect(result.staleByStore).toEqual({ PENNY: 3 });

    // Cheffity-current for PENNY = exactly the 3 new ids (store-scoped).
    const currentPenny = deals.filter(
      (d) => d.store_name === 'PENNY' && String(d.valid_to) >= TODAY && String(d.valid_from) <= TODAY,
    );
    expect(currentPenny).toHaveLength(3);
    expect(currentPenny.map((d) => d.source_external_id).sort()).toEqual([
      'penny::official_pnew_1',
      'penny::official_pnew_2',
      'penny::official_pnew_3',
    ]);
  });

  it('mixed snapshot: migrated-from-next items become current, nextWeek stays future', async () => {
    // The Kaufland/ALDI drift: items moved into snapshot.offers (current bucket)
    // but still carrying a future validityStart, plus a genuine nextWeek item.
    const deals: Row[] = [];
    const { client } = fakeClient(deals);

    const offers: Offer[] = [
      // current bucket, future validityStart → must clamp to today.
      makeOffer({ id: 'official_mig_1', storeChain: 'Kaufland', validityStart: '2026-06-29', validityEnd: '2026-07-05' }),
      makeOffer({ id: 'official_mig_2', storeChain: 'ALDI NORD', validityStart: '2026-06-29' }),
      // current bucket, no validityStart → today (not forced).
      makeOffer({ id: 'official_cur', storeChain: 'Kaufland' }),
      // genuine nextWeek item with a real future start → stays future.
      makeOffer({ id: 'official_next_1', storeChain: 'Kaufland', validityStart: '2026-06-29', validityEnd: '2026-07-05' }),
      // nextWeek without a start → forced future fallback.
      makeOffer({ id: 'official_next_2', storeChain: 'ALDI NORD' }),
    ];
    const nextWeekOfferIds = new Set(['official_next_1', 'official_next_2']);

    const result = await syncDealsToSupabase(offers, {}, { now: NOW, client, nextWeekOfferIds });

    expect(result.upserted).toBe(5);
    // Diagnostics prove the bucket-dominant rule fired.
    expect(result.currentBucketForcedTodayCount).toBe(2); // mig_1 + mig_2
    expect(result.futureBucketForcedTomorrowCount).toBe(1); // next_2 (no start)

    const byId = new Map(deals.map((d) => [d.source_external_id, d]));
    // Migrated-from-next current items now read as current (keys are store-scoped).
    expect(byId.get('kaufland::official_mig_1')?.valid_from).toBe(TODAY);
    expect(byId.get('kaufland::official_mig_1')?.valid_to).toBe('2026-07-05'); // real end kept
    expect(byId.get('aldi_nord::official_mig_2')?.valid_from).toBe(TODAY);
    expect(byId.get('kaufland::official_cur')?.valid_from).toBe(TODAY);
    // nextWeek items stay strictly future.
    expect(String(byId.get('kaufland::official_next_1')?.valid_from) > TODAY).toBe(true);
    expect(String(byId.get('aldi_nord::official_next_2')?.valid_from) > TODAY).toBe(true);

    // Current bucket exactly = the 3 current offers, future = the 2 nextWeek.
    const current = deals.filter(
      (d) => String(d.valid_from) <= TODAY && String(d.valid_to) >= TODAY,
    );
    const future = deals.filter((d) => String(d.valid_from) > TODAY);
    expect(current.map((d) => d.source_external_id).sort()).toEqual([
      'aldi_nord::official_mig_2',
      'kaufland::official_cur',
      'kaufland::official_mig_1',
    ]);
    expect(future.map((d) => d.source_external_id).sort()).toEqual([
      'aldi_nord::official_next_2',
      'kaufland::official_next_1',
    ]);
  });

  it('REWE + nahkauf with the SAME connector id both stay current after sync', async () => {
    // The exact production symptom: nahkauf and REWE emit the same official_*
    // id. Pre-store-scoping they collided on (source, source_external_id) and
    // nahkauf "vanished". Now both must be upserted and stay current.
    const deals: Row[] = [];
    const { client } = fakeClient(deals);

    const offers: Offer[] = [
      makeOffer({ id: 'official_coq5xx', storeChain: 'REWE', name: 'REWE Tomaten' }),
      makeOffer({ id: 'official_coq5xx', storeChain: 'nahkauf', name: 'nahkauf Tomaten' }),
    ];

    const result = await syncDealsToSupabase(offers, {}, { now: NOW, client });

    // Two distinct rows written, no cross-store collision dropped.
    expect(result.upserted).toBe(2);
    expect(result.collisions).toBe(0);
    expect(deals).toHaveLength(2);

    const byStore = new Map(deals.map((d) => [d.store_name, d]));
    expect(byStore.get('REWE')?.source_external_id).toBe('rewe::official_coq5xx');
    expect(byStore.get('nahkauf')?.source_external_id).toBe('nahkauf::official_coq5xx');
    // Both current (valid_from <= today <= valid_to).
    for (const store of ['REWE', 'nahkauf']) {
      const row = byStore.get(store)!;
      expect(String(row.valid_from) <= TODAY).toBe(true);
      expect(String(row.valid_to) >= TODAY).toBe(true);
    }
  });

  it('store-aware stale-cleanup: re-syncing REWE does not expire nahkauf with the same id', async () => {
    // nahkauf::id and rewe::id are already active. A new snapshot carries only
    // REWE (id unchanged). Store-scoped cleanup must touch neither — REWE's id
    // is still present and nahkauf is not even in this snapshot's store set.
    const deals: Row[] = [
      existingDeal({ store_name: 'REWE', source_external_id: 'rewe::official_shared' }),
      existingDeal({ store_name: 'nahkauf', source_external_id: 'nahkauf::official_shared' }),
    ];
    const { client } = fakeClient(deals);

    const offers: Offer[] = [
      makeOffer({ id: 'official_shared', storeChain: 'REWE' }),
    ];

    const result = await syncDealsToSupabase(offers, {}, { now: NOW, client });

    expect(result.staleExpired).toBe(0);
    const nahkauf = deals.find((d) => d.store_name === 'nahkauf');
    expect(nahkauf?.valid_to).toBe(FUTURE); // untouched, still active
  });

  it('does NOT expire anything when the upsert wrote nothing', async () => {
    const deals: Row[] = [existingDeal({ source_external_id: 'official_old' })];
    const { client } = fakeClient(deals);

    // Empty snapshot → upserted 0 → stale-cleanup must be a no-op.
    const result = await syncDealsToSupabase([], {}, { now: NOW, client });

    expect(result.upserted).toBe(0);
    expect(result.staleExpired).toBe(0);
    expect(deals[0].valid_to).toBe(FUTURE); // untouched
  });
});

describe('expireDisabledStoreDeals (Policy-deaktivierte Shops)', () => {
  it('läuft alte aktive ALDI/Lidl-Deals ab (valid_to=gestern), lässt andere Shops in Ruhe', async () => {
    const deals: Row[] = [
      existingDeal({ store_name: 'ALDI SÜD', source_external_id: 'aldi_sued::official_a' }),
      existingDeal({ store_name: 'ALDI NORD', source_external_id: 'aldi_nord::official_b' }),
      existingDeal({ store_name: 'Lidl', source_external_id: 'lidl::official_c' }),
      existingDeal({ store_name: 'REWE', source_external_id: 'rewe::official_keep' }),
      existingDeal({ store_name: 'Kaufland', source_external_id: 'kaufland::official_keep' }),
    ];
    const { client, calls } = fakeClient(deals);

    const result = await expireDisabledStoreDeals(client, ['ALDI SÜD', 'ALDI NORD', 'Lidl'], NOW);

    expect(result.staleExpired).toBe(3);
    expect(result.errors).toEqual([]);
    const byId = new Map(deals.map((d) => [d.source_external_id, d]));
    expect(byId.get('aldi_sued::official_a')?.valid_to).toBe(YESTERDAY);
    expect(byId.get('aldi_nord::official_b')?.valid_to).toBe(YESTERDAY);
    expect(byId.get('lidl::official_c')?.valid_to).toBe(YESTERDAY);
    // Weiterlaufende Shops bleiben aktiv.
    expect(byId.get('rewe::official_keep')?.valid_to).toBe(FUTURE);
    expect(byId.get('kaufland::official_keep')?.valid_to).toBe(FUTURE);
    expect(calls.updateChunks.every((n) => n <= 100)).toBe(true);
  });

  it('matcht Umlaut-Varianten des store_name (ALDI SUED vs ALDI SÜD)', async () => {
    const deals: Row[] = [
      existingDeal({ store_name: 'ALDI SUED', source_external_id: 'aldi_sued::x' }),
    ];
    const { client } = fakeClient(deals);
    const result = await expireDisabledStoreDeals(client, ['ALDI SÜD'], NOW);
    expect(result.staleExpired).toBe(1);
    expect(deals[0].valid_to).toBe(YESTERDAY);
  });

  it('respektiert verified/admin-Deals (werden nie abgelaufen, nie gelöscht)', async () => {
    const deals: Row[] = [
      existingDeal({ store_name: 'Lidl', source_external_id: 'lidl::admin', is_verified: true }),
      existingDeal({ store_name: 'Lidl', source_external_id: 'lidl::normal' }),
    ];
    const { client } = fakeClient(deals);
    const result = await expireDisabledStoreDeals(client, ['Lidl'], NOW);
    expect(result.staleExpired).toBe(1);
    expect(deals.find((d) => d.source_external_id === 'lidl::admin')?.valid_to).toBe(FUTURE);
    expect(deals.find((d) => d.source_external_id === 'lidl::normal')?.valid_to).toBe(YESTERDAY);
    // Keine Zeile gelöscht.
    expect(deals).toHaveLength(2);
  });

  it('läuft aktive EDEKA-Deals ab (valid_to=gestern), respektiert verified/admin, matcht Schreibweisen', async () => {
    const deals: Row[] = [
      existingDeal({ store_name: 'EDEKA', source_external_id: 'edeka::official_a' }),
      existingDeal({ store_name: 'Edeka', source_external_id: 'edeka::official_b' }),
      existingDeal({ store_name: 'EDEKA', source_external_id: 'edeka::admin', is_verified: true }),
      existingDeal({ store_name: 'REWE', source_external_id: 'rewe::official_keep' }),
    ];
    const { client } = fakeClient(deals);

    const result = await expireDisabledStoreDeals(client, ['EDEKA'], NOW);

    expect(result.staleExpired).toBe(2);
    expect(result.errors).toEqual([]);
    const byId = new Map(deals.map((d) => [d.source_external_id, d]));
    // Aktive EDEKA-Deals laufen ab (nicht gelöscht).
    expect(byId.get('edeka::official_a')?.valid_to).toBe(YESTERDAY);
    expect(byId.get('edeka::official_b')?.valid_to).toBe(YESTERDAY);
    // Verified/Admin-Deal bleibt unangetastet.
    expect(byId.get('edeka::admin')?.valid_to).toBe(FUTURE);
    // Weiterlaufender Shop bleibt aktiv.
    expect(byId.get('rewe::official_keep')?.valid_to).toBe(FUTURE);
    // Keine Zeile gelöscht.
    expect(deals).toHaveLength(4);
  });

  it('syncDealsToSupabase: deaktivierte Shops (inkl. EDEKA) werden beim Sync abgelaufen', async () => {
    const deals: Row[] = [
      existingDeal({ store_name: 'Lidl', source_external_id: 'lidl::official_stale' }),
      existingDeal({ store_name: 'EDEKA', source_external_id: 'edeka::official_stale' }),
      existingDeal({ store_name: 'PENNY', source_external_id: 'official_pold' }),
    ];
    const { client } = fakeClient(deals);
    const offers: Offer[] = [makeOffer({ id: 'official_pnew', storeChain: 'PENNY' })];

    const result = await syncDealsToSupabase(offers, {}, {
      now: NOW,
      client,
      disabledStores: ['ALDI SÜD', 'ALDI NORD', 'Lidl', 'EDEKA'],
    });

    expect(result.disabledExpired).toBe(2);
    expect(result.disabledByStore).toEqual({ Lidl: 1, EDEKA: 1 });
    expect(deals.find((d) => d.source_external_id === 'lidl::official_stale')?.valid_to).toBe(YESTERDAY);
    expect(deals.find((d) => d.source_external_id === 'edeka::official_stale')?.valid_to).toBe(YESTERDAY);
  });
});
