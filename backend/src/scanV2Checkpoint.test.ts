import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Offer } from '../../src/types/models';
import {
  CheckpointCorruptError,
  SCAN_V2_CHECKPOINT_VERSION,
  checkpointDisposition,
  clearCheckpoint,
  pendingItems,
  readCheckpoint,
  resolveCheckpointScope,
  summarizeCheckpoint,
  summarizePausedMessage,
  writeCheckpointAtomic,
  type ScanV2Checkpoint,
} from './scanV2Checkpoint';
import { scopeFromStores } from './scanV2Scope';

function makeOffer(overrides: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: 'o1',
    name: 'Bio Milch',
    normalizedName: 'bio milch',
    storeChain: 'Aldi',
    category: 'dairy',
    price: 1.29,
    currency: 'EUR',
    unit: '1l',
    validityStart: '2026-05-26T00:00:00.000Z',
    validityEnd: '2026-06-01T23:59:59.999Z',
    imageUrl: 'https://example.com/milk.png',
    sourceUrl: 'https://example.com/offer',
    tags: [],
    createdAt: '2026-05-26T08:00:00.000Z',
    ...overrides,
  } as Offer;
}

function baseCheckpoint(overrides: Partial<ScanV2Checkpoint> = {}): ScanV2Checkpoint {
  return {
    version: SCAN_V2_CHECKPOINT_VERSION,
    mode: 'phase1_phase2',
    phase: 'phase2_food_analysis',
    startedAt: '2026-06-07T10:00:00.000Z',
    pausedAt: '2026-06-07T10:30:00.000Z',
    total: 2164,
    processed: 1768,
    phase1: null,
    phase2: null,
    diagnostics: {},
    ...overrides,
  };
}

let tmpDir: string;
let cpPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanv2-cp-'));
  cpPath = path.join(tmpDir, 'nested', 'scan-v2-checkpoint.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('writeCheckpointAtomic + readCheckpoint', () => {
  it('round-trips a checkpoint through disk (creating the dir)', async () => {
    const cp = baseCheckpoint();
    await writeCheckpointAtomic(cpPath, cp);
    const read = await readCheckpoint(cpPath);
    expect(read).toEqual(cp);
  });

  it('leaves no .tmp sibling behind after a successful write', async () => {
    await writeCheckpointAtomic(cpPath, baseCheckpoint());
    const siblings = await fs.readdir(path.dirname(cpPath));
    expect(siblings.filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('returns null when no checkpoint file exists', async () => {
    expect(await readCheckpoint(cpPath)).toBeNull();
  });

  it('throws CheckpointCorruptError on invalid JSON (and does not return a partial object)', async () => {
    await fs.mkdir(path.dirname(cpPath), { recursive: true });
    await fs.writeFile(cpPath, '{ this is not valid json', 'utf8');
    await expect(readCheckpoint(cpPath)).rejects.toBeInstanceOf(CheckpointCorruptError);
  });

  it('throws CheckpointCorruptError on a version mismatch', async () => {
    await fs.mkdir(path.dirname(cpPath), { recursive: true });
    await fs.writeFile(
      cpPath,
      JSON.stringify({ ...baseCheckpoint(), version: 999 }),
      'utf8',
    );
    await expect(readCheckpoint(cpPath)).rejects.toBeInstanceOf(CheckpointCorruptError);
  });

  it('throws CheckpointCorruptError when required fields are missing', async () => {
    await fs.mkdir(path.dirname(cpPath), { recursive: true });
    await fs.writeFile(cpPath, JSON.stringify({ version: SCAN_V2_CHECKPOINT_VERSION }), 'utf8');
    await expect(readCheckpoint(cpPath)).rejects.toBeInstanceOf(CheckpointCorruptError);
  });
});

describe('clearCheckpoint', () => {
  it('removes the checkpoint file and is a no-op when absent', async () => {
    await writeCheckpointAtomic(cpPath, baseCheckpoint());
    await clearCheckpoint(cpPath);
    expect(await readCheckpoint(cpPath)).toBeNull();
    // second clear must not throw
    await expect(clearCheckpoint(cpPath)).resolves.toBeUndefined();
  });
});

describe('phase 1 checkpoint persistence', () => {
  it('round-trips raw scraped offers + processed index', async () => {
    const raw = [makeOffer({ id: 'a' }), makeOffer({ id: 'b' }), makeOffer({ id: 'c' })];
    const cp = baseCheckpoint({
      phase: 'phase1_scraping',
      phase1: {
        rawOffers: raw,
        processedIndex: 2,
        categorizedFood: [makeOffer({ id: 'a' })],
        categorizedNonFood: [],
        preservedExcluded: { current: [], next: [], filtered: [] },
        offerScopes: {},
        scrapeWarnings: ['w1'],
      },
      phase2: null,
    });
    await writeCheckpointAtomic(cpPath, cp);
    const read = await readCheckpoint(cpPath);
    expect(read?.phase1?.processedIndex).toBe(2);
    expect(read?.phase1?.rawOffers.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('phase 2 checkpoint persistence', () => {
  it('round-trips representatives, partial analysed results and preserved REWE/nahkauf offers', async () => {
    const reps = [makeOffer({ id: 'r1' }), makeOffer({ id: 'r2' }), makeOffer({ id: 'r3' })];
    const reweOffer = makeOffer({ id: 'rewe-1', storeChain: 'REWE', tags: ['browser-import'] });
    const cp = baseCheckpoint({
      phase: 'phase2_food_analysis',
      phase1: null,
      phase2: {
        representatives: reps,
        followers: [],
        baseFood: [reweOffer],
        skippedNonFood: [],
        imageById: { r1: { imageStatus: 'ok', brokenImage: false } },
        processedIndex: 1,
        analyzedFood: [makeOffer({ id: 'r1', category: 'dairy' })],
        analyzedFiltered: [],
        candidatesCount: 3,
        reusedFromBase: 0,
        skippedLockedCount: 0,
        aiClassifiedCount: 1,
        fallbackCount: 0,
        model: 'qwen3:14b',
      },
    });
    await writeCheckpointAtomic(cpPath, cp);
    const read = await readCheckpoint(cpPath);
    expect(read?.phase2?.processedIndex).toBe(1);
    expect(read?.phase2?.representatives).toHaveLength(3);
    expect(read?.phase2?.analyzedFood.map((o) => o.id)).toEqual(['r1']);
    // The manually imported REWE offer must survive the round-trip so resume keeps it.
    expect(read?.phase2?.baseFood.map((o) => o.id)).toContain('rewe-1');
    expect(read?.phase2?.baseFood[0].storeChain).toBe('REWE');
  });
});

describe('resume Phase 2 acceptance scenario', () => {
  it('only the not-yet-analysed representatives are re-sent to the model (no duplicate Qwen work)', async () => {
    const reps = [
      makeOffer({ id: 'r1' }),
      makeOffer({ id: 'r2' }),
      makeOffer({ id: 'r3' }),
      makeOffer({ id: 'r4' }),
    ];
    const reweOffer = makeOffer({ id: 'rewe-1', storeChain: 'REWE', tags: ['browser-import'] });
    const cp = baseCheckpoint({
      phase: 'phase2_food_analysis',
      total: 4,
      processed: 2,
      phase2: {
        representatives: reps,
        followers: [],
        baseFood: [reweOffer], // manual REWE import lives here → must survive resume
        skippedNonFood: [],
        imageById: {},
        processedIndex: 2, // r1, r2 already analysed
        analyzedFood: [makeOffer({ id: 'r1' }), makeOffer({ id: 'r2' })],
        analyzedFiltered: [],
        candidatesCount: 4,
        reusedFromBase: 0,
        skippedLockedCount: 0,
        aiClassifiedCount: 2,
        fallbackCount: 0,
        model: 'qwen3:14b',
      },
    });
    await writeCheckpointAtomic(cpPath, cp);
    const read = await readCheckpoint(cpPath);
    const phase2 = read!.phase2!;

    const stillToSend = pendingItems(phase2.representatives, phase2.processedIndex);
    expect(stillToSend.map((o) => o.id)).toEqual(['r3', 'r4']);
    // The already-analysed reps are NOT in the queue → never re-sent to Qwen.
    expect(stillToSend.map((o) => o.id)).not.toContain('r1');
    expect(stillToSend.map((o) => o.id)).not.toContain('r2');
    // The manually imported REWE offer is preserved for the finalize merge.
    expect(phase2.baseFood.some((o) => o.storeChain === 'REWE')).toBe(true);
  });
});

describe('vollständiger Phase-2-Checkpoint (1731/1731) — Finalisierung ohne Modell-Arbeit (Task P4)', () => {
  it('processed === total → keine offenen Repräsentanten → pendingItems leer (keine erneute Analyse)', async () => {
    const reps = Array.from({ length: 5 }, (_, i) => makeOffer({ id: `r${i}` }));
    const cp = baseCheckpoint({
      phase: 'phase2_food_analysis',
      total: reps.length,
      processed: reps.length, // wie der Live-Checkpoint: 1731/1731
      phase2: {
        representatives: reps,
        followers: [],
        baseFood: [makeOffer({ id: 'rewe-1', storeChain: 'REWE', tags: ['browser-import'] })],
        skippedNonFood: [],
        imageById: {},
        processedIndex: reps.length, // vollständig analysiert
        analyzedFood: reps.map((r) => makeOffer({ id: r.id, category: 'dairy' })),
        analyzedFiltered: [],
        candidatesCount: reps.length,
        reusedFromBase: 0,
        skippedLockedCount: 0,
        aiClassifiedCount: reps.length,
        fallbackCount: 0,
        model: 'qwen3:14b',
      },
    });
    await writeCheckpointAtomic(cpPath, cp);
    const read = await readCheckpoint(cpPath);
    const p2 = read!.phase2!;

    // 1) + 2) Nichts mehr an das Modell → direkt zur Reassembly/Finalisierung.
    expect(pendingItems(p2.representatives, p2.processedIndex)).toEqual([]);

    // 3) Keine Duplikate im Finalize-Universum (baseFood + analysiert + Follower).
    const universe = [...p2.baseFood, ...p2.analyzedFood, ...p2.analyzedFiltered, ...p2.followers];
    const ids = universe.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);

    // 4) Kein Verlust des manuellen REWE-Imports über den Resume.
    expect(p2.baseFood.some((o) => o.storeChain === 'REWE')).toBe(true);
  });
});

describe('resolveCheckpointScope — Resume behält den Scope, alte Checkpoints migrieren defensiv', () => {
  it('7) Pause/Resume: ein persistierter Scope wird unverändert übernommen (keine Erweiterung)', () => {
    const cp = baseCheckpoint({ scope: scopeFromStores(['REWE']) });
    const scope = resolveCheckpointScope(cp);
    expect(scope).toEqual({ type: 'stores', stores: ['rewe'] });
  });

  it('8a) alter Phase-1-inklusiver Checkpoint ohne Scope → all_stores', () => {
    const cp = baseCheckpoint({ mode: 'phase1_phase2', scope: undefined });
    expect(resolveCheckpointScope(cp)).toEqual({ type: 'all_stores', stores: [] });
  });

  it('8b) alter Phase-2-only-Checkpoint ohne Scope → Scope aus den getragenen Angeboten', () => {
    const cp = baseCheckpoint({
      mode: 'phase2',
      scope: undefined,
      phase2: {
        representatives: [makeOffer({ id: 'r1', storeChain: 'REWE' })],
        followers: [],
        baseFood: [makeOffer({ id: 'rewe-1', storeChain: 'REWE', tags: ['browser-import'] })],
        skippedNonFood: [],
        imageById: {},
        processedIndex: 0,
        analyzedFood: [],
        analyzedFiltered: [],
        candidatesCount: 1,
        reusedFromBase: 0,
        skippedLockedCount: 0,
        aiClassifiedCount: 0,
        fallbackCount: 0,
        model: 'qwen3:14b',
      },
    });
    expect(resolveCheckpointScope(cp)).toEqual({ type: 'stores', stores: ['rewe'] });
  });

  it('8c) wirklich unklarer alter Checkpoint → kontrollierter Fehler statt riskantem Widen', () => {
    const cp = baseCheckpoint({ mode: 'phase2', scope: undefined, phase1: null, phase2: null });
    const result = resolveCheckpointScope(cp);
    expect('error' in result).toBe(true);
  });
});

describe('pendingItems', () => {
  it('returns only items after the processed index (resume does not re-process)', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(pendingItems(items, 2)).toEqual(['c', 'd']);
  });

  it('returns everything when nothing was processed', () => {
    expect(pendingItems(['a', 'b'], 0)).toEqual(['a', 'b']);
  });

  it('returns nothing when all items were processed', () => {
    expect(pendingItems(['a', 'b'], 2)).toEqual([]);
  });

  it('clamps an out-of-range / negative index instead of throwing', () => {
    expect(pendingItems(['a', 'b'], 99)).toEqual([]);
    expect(pendingItems(['a', 'b'], -3)).toEqual(['a', 'b']);
  });
});

describe('checkpointDisposition', () => {
  it('keeps the checkpoint on pause but clears it on cancel/done', () => {
    expect(checkpointDisposition('paused')).toBe('keep');
    expect(checkpointDisposition('cancelled')).toBe('clear');
    expect(checkpointDisposition('done')).toBe('clear');
    expect(checkpointDisposition('error')).toBe('keep');
  });
});

describe('summarize helpers', () => {
  it('summarizePausedMessage renders processed/total', () => {
    expect(summarizePausedMessage({ processed: 1768, total: 2164 })).toBe(
      'Angebots-Scan 2.0 pausiert bei 1768/2164',
    );
  });

  it('summarizeCheckpoint extracts lightweight meta without the offer arrays', () => {
    const meta = summarizeCheckpoint(baseCheckpoint());
    expect(meta).toEqual({
      version: SCAN_V2_CHECKPOINT_VERSION,
      mode: 'phase1_phase2',
      phase: 'phase2_food_analysis',
      startedAt: '2026-06-07T10:00:00.000Z',
      pausedAt: '2026-06-07T10:30:00.000Z',
      total: 2164,
      processed: 1768,
    });
  });
});
