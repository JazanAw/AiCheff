import { describe, expect, it } from 'vitest';
import { createScanReportCache } from './scanReportCache';

/** Lässt die Promise-/Microtask-Queue (und ein setImmediate-Tick) durchlaufen,
 *  damit ein im Hintergrund gestarteter Revalidate-Build sicher fertig wird. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('createScanReportCache', () => {
  it('builds once and returns the value', async () => {
    let calls = 0;
    const cache = createScanReportCache<number>();
    const value = await cache.get(() => {
      calls += 1;
      return 42;
    });
    expect(value).toBe(42);
    expect(calls).toBe(1);
  });

  it('serves the cached value within the TTL without rebuilding', async () => {
    let calls = 0;
    let clock = 1000;
    const cache = createScanReportCache<number>({ ttlMs: 3000, now: () => clock });
    const build = () => {
      calls += 1;
      return calls;
    };

    expect(await cache.get(build)).toBe(1);
    clock = 1000 + 2999;
    expect(await cache.get(build)).toBe(1); // still within TTL → cached
    expect(calls).toBe(1);
  });

  it('rebuilds once the TTL has elapsed', async () => {
    let calls = 0;
    let clock = 1000;
    const cache = createScanReportCache<number>({ ttlMs: 3000, now: () => clock });
    const build = () => {
      calls += 1;
      return calls;
    };

    expect(await cache.get(build)).toBe(1);
    clock = 1000 + 3001; // past TTL → stale read kicks off a rebuild …
    expect(await cache.get(build)).toBe(1); // … but serves the previous value at once
    await flushMicrotasks(); // let the background rebuild settle
    expect(calls).toBe(2);
    expect(await cache.get(build)).toBe(2); // the refreshed value is now cached
  });

  it('serves the stale value immediately and revalidates in the background (no blocking rebuild)', async () => {
    // ROOT CAUSE des Burst-Crashes: der alte Cache ließ bei abgelaufenem TTL JEDEN
    // (auch parallele) Aufrufer auf den mehrere Sekunden langen, SYNCHRONEN Build
    // warten. Das blockierte den Event-Loop, sodass /api/health auslief und ein
    // Watchdog den Prozess killte. Stale-while-revalidate liefert sofort den
    // letzten guten Wert und baut höchstens EINMAL im Hintergrund neu.
    let calls = 0;
    let clock = 1000;
    let resolveRebuild: (v: number) => void = () => {};
    const cache = createScanReportCache<number>({ ttlMs: 3000, now: () => clock });
    const build = () => {
      calls += 1;
      if (calls === 1) {
        return 1; // initial build resolves immediately
      }
      return new Promise<number>((resolve) => {
        resolveRebuild = resolve; // the rebuild stays pending → simulates a slow build
      });
    };

    expect(await cache.get(build)).toBe(1);
    expect(calls).toBe(1);

    clock = 1000 + 3001; // stale
    // The stale read returns AT ONCE with the last good value …
    expect(await cache.get(build)).toBe(1);
    // … and the (blocking) rebuild has NOT run in-band — it is only scheduled.
    expect(calls).toBe(1);
    await flushMicrotasks(); // now the deferred background rebuild starts
    expect(calls).toBe(2); // exactly one rebuild was triggered

    // A burst of further stale reads must NOT start more builds and must not wait
    // for the still-pending rebuild.
    expect(await Promise.all([cache.get(build), cache.get(build), cache.get(build)])).toEqual([
      1, 1, 1,
    ]);
    await flushMicrotasks();
    expect(calls).toBe(2);

    resolveRebuild(2);
    await flushMicrotasks();
    expect(await cache.get(build)).toBe(2); // background rebuild updated the cache
  });

  it('keeps serving the last good value when a background revalidate fails (no poison)', async () => {
    let calls = 0;
    let clock = 1000;
    const cache = createScanReportCache<number>({ ttlMs: 3000, now: () => clock });
    const build = () => {
      calls += 1;
      if (calls === 2) {
        return Promise.reject(new Error('rebuild boom'));
      }
      return calls; // 1 then (after the failed rebuild) 3
    };

    expect(await cache.get(build)).toBe(1);
    clock = 1000 + 3001; // stale → triggers the failing background rebuild
    expect(await cache.get(build)).toBe(1); // stale value still served, no throw
    await flushMicrotasks();
    expect(calls).toBe(2);
    // The failed rebuild did not poison the cache: still stale → next read retries.
    expect(await cache.get(build)).toBe(1);
    await flushMicrotasks();
    expect(calls).toBe(3);
  });

  it('coalesces concurrent builds so an expensive build runs only once', async () => {
    let calls = 0;
    const cache = createScanReportCache<string>();
    let resolveBuild: (v: string) => void = () => {};
    const build = () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        resolveBuild = resolve;
      });
    };

    const a = cache.get(build);
    const b = cache.get(build);
    const c = cache.get(build);
    resolveBuild('report');

    expect(await a).toBe('report');
    expect(await b).toBe('report');
    expect(await c).toBe('report');
    expect(calls).toBe(1); // the three concurrent requests shared one build
  });

  it('does not poison the cache when a build throws — the next call retries', async () => {
    let calls = 0;
    const cache = createScanReportCache<number>();
    const build = () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('boom');
      }
      return 7;
    };

    await expect(cache.get(build)).rejects.toThrow('boom');
    // a failed build must not be cached and must not block future builds
    expect(await cache.get(build)).toBe(7);
    expect(calls).toBe(2);
  });

  it('serves the cached report repeatedly within the TTL without rebuilding', async () => {
    // Regression (Live-Stabilitaet): jeder weitere Warm-Read MUSS aus dem Cache
    // kommen und darf NICHT erneut den teuren Build auslösen — sonst friert jeder
    // Aufruf erneut den Event-Loop ein und /api/health läuft aus.
    let calls = 0;
    let clock = 1000;
    const cache = createScanReportCache<{ ok: boolean }>({ ttlMs: 5000, now: () => clock });
    const build = () => {
      calls += 1;
      return { ok: true };
    };

    const first = await cache.get(build);
    for (let i = 0; i < 25; i += 1) {
      clock += 100; // bleibt innerhalb des 5s-TTL
      const again = await cache.get(build);
      expect(again).toBe(first); // identische Referenz → echter Cache-Hit
    }
    expect(calls).toBe(1);
  });

  it('keeps the cached report JSON-serializable across repeated reads', async () => {
    // Der Cache hält EIN Objekt vor, das die Route bei jedem Aufruf erneut
    // serialisiert (response.json). Das wiederholte Serialisieren desselben
    // Objekts muss stabil und fehlerfrei bleiben (kein Zyklus, keine Mutation).
    let clock = 1000;
    const cache = createScanReportCache<{ count: number; examples: string[] }>({
      ttlMs: 5000,
      now: () => clock,
    });
    const build = () => ({ count: 4, examples: ['Spritzring'] });

    const report = await cache.get(build);
    const firstJson = JSON.stringify(report);
    for (let i = 0; i < 5; i += 1) {
      clock += 100;
      const again = await cache.get(build);
      const json = JSON.stringify(again); // darf nie werfen
      expect(json).toBe(firstJson); // identische, unveränderte Serialisierung
    }
  });

  it('coalesces a burst of concurrent + repeated callers into a single build', async () => {
    // Akzeptanz: 6 parallele scan-report-Aufrufe dürfen NUR einen Build starten.
    let calls = 0;
    const cache = createScanReportCache<string>();
    let resolveBuild: (v: string) => void = () => {};
    const build = () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        resolveBuild = resolve;
      });
    };

    const inflight = Array.from({ length: 6 }, () => cache.get(build));
    resolveBuild('report');
    const results = await Promise.all(inflight);

    expect(results).toEqual(Array.from({ length: 6 }, () => 'report'));
    expect(calls).toBe(1);
  });

  it('rebuilds after invalidate()', async () => {
    let calls = 0;
    const cache = createScanReportCache<number>({ ttlMs: 1_000_000, now: () => 0 });
    const build = () => {
      calls += 1;
      return calls;
    };

    expect(await cache.get(build)).toBe(1);
    expect(await cache.get(build)).toBe(1); // cached (huge TTL)
    cache.invalidate();
    expect(await cache.get(build)).toBe(2); // forced rebuild
    expect(calls).toBe(2);
  });

  describe('getEntry — cached JSON payload', () => {
    it('serializes the payload exactly once per build and shares the string across a burst', async () => {
      // Akzeptanz: 6 parallele scan-report-Aufrufe dürfen NUR einen Build UND nur
      // EINE Serialisierung auslösen — die fertige JSON-Response wird vorgehalten
      // statt pro Request erneut JSON.stringify auf demselben großen Objekt.
      let builds = 0;
      let serializes = 0;
      const cache = createScanReportCache<{ n: number }>({
        serialize: (value) => {
          serializes += 1;
          return JSON.stringify(value);
        },
      });
      const build = () => {
        builds += 1;
        return { n: 7 };
      };

      const burst = await Promise.all(
        Array.from({ length: 6 }, () => cache.getEntry(build)),
      );
      expect(builds).toBe(1);
      expect(serializes).toBe(1);
      expect(burst.map((entry) => entry.json)).toEqual(Array.from({ length: 6 }, () => '{"n":7}'));
      // Every caller sees the very same serialized string instance.
      expect(burst.every((entry) => entry.json === burst[0].json)).toBe(true);

      const again = await cache.getEntry(build);
      expect(again.json).toBe(burst[0].json); // warm read reuses the cached string
      expect(serializes).toBe(1); // no re-serialization
    });

    it('exposes both the object and its JSON, kept in sync', async () => {
      const cache = createScanReportCache<{ count: number; examples: string[] }>();
      const entry = await cache.getEntry(() => ({ count: 1, examples: ['Spritzring'] }));
      expect(entry.value).toEqual({ count: 1, examples: ['Spritzring'] });
      expect(JSON.parse(entry.json)).toEqual(entry.value);
    });
  });
});
