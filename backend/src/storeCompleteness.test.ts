import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { buildStoreExpectations, computeStoreCompleteness, DEFAULT_STORE_EXPECTATIONS } from './storeCompleteness';

const now = new Date('2026-06-03T13:00:00.000Z');
const CURRENT = { validityStart: '2026-06-01T00:00:00.000Z', validityEnd: '2026-06-07T23:59:59.000Z' };
const UPCOMING = { validityStart: '2026-06-08T00:00:00.000Z', validityEnd: '2026-06-14T23:59:59.000Z' };

let seq = 0;
function offer(storeChain: string, when: typeof CURRENT): Offer {
  seq += 1;
  return {
    id: `o_${seq}`,
    name: `Artikel ${seq}`,
    normalizedName: `artikel ${seq}`,
    storeChain,
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: when.validityStart,
    validityEnd: when.validityEnd,
    sourceUrl: 'https://example.org',
    tags: [],
    createdAt: '2026-06-03T00:00:00.000Z',
  };
}

function rowFor(report: ReturnType<typeof computeStoreCompleteness>, chain: string) {
  const row = report.stores.find((s) => s.storeChain === chain);
  if (!row) throw new Error(`no row for ${chain}`);
  return row;
}

describe('computeStoreCompleteness', () => {
  it('scores Kaufland against the official current food count', () => {
    const report = computeStoreCompleteness({
      offers: [offer('Kaufland', CURRENT), offer('Kaufland', CURRENT)],
      nextWeekOffers: [offer('Kaufland', UPCOMING)],
      filteredOffers: [offer('Kaufland', CURRENT)],
      officialCounts: { kaufland: 2 },
      now,
    });
    const k = rowFor(report, 'Kaufland');
    expect(k.currentImported).toBe(2);
    expect(k.upcomingImported).toBe(1);
    expect(k.filteredCount).toBe(1);
    expect(k.officialCount).toBe(2);
    expect(k.completenessScore).toBe(1);
    expect(k.status).toBe('healthy');
  });

  it('flags Kaufland as warn/critical when far below the official count', () => {
    const report = computeStoreCompleteness({
      offers: [offer('Kaufland', CURRENT)], // imported 1 of 4 official
      nextWeekOffers: [],
      filteredOffers: [],
      officialCounts: { kaufland: 4 },
      now,
    });
    const k = rowFor(report, 'Kaufland');
    expect(k.completenessScore).toBe(0.25);
    expect(k.status).toBe('critical');
  });

  it('marks EDEKA as national_only (nur nationale Angebote), never healthy', () => {
    // EDEKA ist direkt lesbar, zeigt aber ohne Marktauswahl nur nationale
    // Angebote — ein glaubhafter Import (≥ 5) ist ehrlich "warn", nie healthy.
    const report = computeStoreCompleteness({
      offers: Array.from({ length: 6 }, () => offer('EDEKA', CURRENT)),
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const e = rowFor(report, 'EDEKA');
    expect(e.coverage).toBe('national_only');
    expect(e.status).toBe('warn');
    expect(e.status).not.toBe('healthy');
    expect(e.reasons.join(' ')).toMatch(/national/i);
  });

  it('Lidl (structured_only): Kollaps bleibt critical, funktionierender Teilimport ist warn — NIE healthy', () => {
    // Die Quelle liefert strukturiert nur einen Teil des Wochensortiments
    // (Frische nur als Prospektbilder). Ein 1-Angebot-Import bleibt critical;
    // ein funktionierender Teilimport (18 Food) wird ehrlich "warn" — niemals
    // healthy, egal wie gut der strukturierte Teil laeuft.
    const collapsed = computeStoreCompleteness({
      offers: [offer('Lidl', CURRENT)],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(rowFor(collapsed, 'Lidl').status).toBe('critical');

    const partial = computeStoreCompleteness({
      offers: Array.from({ length: 18 }, () => offer('Lidl', CURRENT)),
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const l = rowFor(partial, 'Lidl');
    expect(l.status).toBe('warn');
    expect(l.reasons.join(' ')).toMatch(/Teilimport/);

    // Auch ein numerisch "voller" Import bleibt warn — structured_only kann
    // per Definition nicht das volle Sortiment sein.
    const big = computeStoreCompleteness({
      offers: Array.from({ length: 80 }, () => offer('Lidl', CURRENT)),
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(rowFor(big, 'Lidl').status).toBe('warn');
  });

  it('schuetzt die Lidl-Erwartung: expectedMin bleibt das VOLLE Wochensortiment (>= 60)', () => {
    // Akzeptanzkriterium: expectedMin darf nicht kuenstlich gesenkt werden,
    // damit ein Teilimport als full healthy erscheint.
    expect(DEFAULT_STORE_EXPECTATIONS.lidl.expectedMin).toBeGreaterThanOrEqual(60);
    expect(DEFAULT_STORE_EXPECTATIONS.lidl.coverage).toBe('structured_only');
  });

  it('treats a well-stocked store with no expectation as healthy', () => {
    const report = computeStoreCompleteness({
      offers: Array.from({ length: 120 }, () => offer('PENNY', CURRENT)),
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(rowFor(report, 'PENNY').status).toBe('healthy');
  });

  it('current=0 mit kommenden Angeboten: ehrliche Quellen-Diagnose statt "Scraper defekt"', () => {
    // Der Import funktioniert nachweislich (167 kommende Angebote geparst) —
    // die Quelle liefert nur (noch) keine aktuelle Kampagne. Das ist ein
    // Quellzustand, kein Scraper-Defekt: warn statt critical, mit Erklärung.
    const report = computeStoreCompleteness({
      offers: [],
      nextWeekOffers: Array.from({ length: 167 }, () => offer('PENNY', UPCOMING)),
      filteredOffers: [],
      now,
    });
    const p = rowFor(report, 'PENNY');
    expect(p.currentImported).toBe(0);
    expect(p.upcomingImported).toBe(167);
    expect(p.status).toBe('warn');
    expect(p.reasons.join(' ')).not.toMatch(/Scraper vermutlich defekt/);
    expect(p.reasons.join(' ')).toMatch(/kommende/i);
  });

  it('current=0 ohne brauchbare kommende Angebote bleibt critical (Scraper defekt)', () => {
    const report = computeStoreCompleteness({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [offer('PENNY', CURRENT)],
      now,
    });
    const p = rowFor(report, 'PENNY');
    expect(p.status).toBe('critical');
    expect(p.reasons.join(' ')).toMatch(/Scraper vermutlich defekt/);
  });

  it('only counts offers active today as currentImported (validityStart in the future = upcoming)', () => {
    const report = computeStoreCompleteness({
      // both put in the "live" bucket, but one only starts next week
      offers: [offer('NORMA', CURRENT), offer('NORMA', UPCOMING)],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const n = rowFor(report, 'NORMA');
    expect(n.currentImported).toBe(1);
    expect(n.upcomingImported).toBe(1);
  });
});

describe('nahkauf — national_only ohne Markt-ID, full mit Markt-ID', () => {
  it('haelt nahkauf ohne Markt-ID auf warn (nie healthy), trotz erreichtem expectedMin', () => {
    const report = computeStoreCompleteness({
      offers: Array.from({ length: 38 }, () => offer('nahkauf', CURRENT)),
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const row = rowFor(report, 'nahkauf');
    expect(row.status).toBe('warn');
    expect(row.reasons.join(' ')).toMatch(/lokale Marktangebote nicht verifiziert/);
  });

  it('buildStoreExpectations: Markt-ID schaltet nahkauf auf volle Abdeckung', () => {
    const without = buildStoreExpectations({});
    expect(without.nahkauf.coverage).toBe('national_only');
    expect(without.nahkauf.localVerificationTag).toBeUndefined();

    const withMarket = buildStoreExpectations({ nahkaufMarketId: '320593' });
    expect(withMarket.nahkauf.coverage).toBe('full');
    expect(withMarket.nahkauf.note).toContain('320593');
    // Der Anspruch "full" muss im Snapshot belegt werden: lokale Angebote
    // tragen das Connector-Tag, das hier als Verifikationsanker hinterlegt ist.
    expect(withMarket.nahkauf.localVerificationTag).toBe('nahkauf-local');
    // Andere Stores bleiben unveraendert (Lidl-Teilimport etc.).
    expect(withMarket.lidl.coverage).toBe('structured_only');
  });

  it('mit Markt-ID-Expectations kann nahkauf healthy werden, wenn lokale Angebote importiert wurden', () => {
    const offers = Array.from({ length: 38 }, () => offer('nahkauf', CURRENT));
    offers[0] = { ...offers[0], tags: ['nahkauf-storyblok', 'nahkauf-local'] };
    const report = computeStoreCompleteness({
      offers,
      nextWeekOffers: [],
      filteredOffers: [],
      expectations: buildStoreExpectations({ nahkaufMarketId: '320593' }),
      now,
    });
    const row = rowFor(report, 'nahkauf');
    expect(row.status).toBe('healthy');
    expect(row.coverage).toBe('full');
  });

  it('mit Markt-ID, aber ohne lokale Angebote im Snapshot: ehrlich national_only + warn statt false-positive full', () => {
    const report = computeStoreCompleteness({
      offers: Array.from({ length: 38 }, () => offer('nahkauf', CURRENT)), // nur nationale, kein nahkauf-local-Tag
      nextWeekOffers: [],
      filteredOffers: [],
      expectations: buildStoreExpectations({ nahkaufMarketId: '320593' }),
      now,
    });
    const row = rowFor(report, 'nahkauf');
    expect(row.coverage).toBe('national_only');
    expect(row.status).toBe('warn');
    expect(row.reasons.join(' ')).toMatch(/Markt-ID/);
  });

  it('EDEKA ist national_only und nie full', () => {
    const report = computeStoreCompleteness({
      offers: [offer('EDEKA', CURRENT), offer('EDEKA', CURRENT), offer('EDEKA', CURRENT)],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const row = rowFor(report, 'EDEKA');
    expect(row.coverage).toBe('national_only');
    expect(row.coverage).not.toBe('full');
  });

  it('national_only mit nur kommenden Angeboten (Wochenende) ist warn, nicht critical', () => {
    // EDEKA liefert kurz vor dem Wochenwechsel nur die nächste Aktionswoche:
    // 0 aktuelle, aber viele kommende — der Import funktioniert nachweislich.
    const report = computeStoreCompleteness({
      offers: [],
      nextWeekOffers: [
        offer('EDEKA', UPCOMING),
        offer('EDEKA', UPCOMING),
        offer('EDEKA', UPCOMING),
        offer('EDEKA', UPCOMING),
        offer('EDEKA', UPCOMING),
        offer('EDEKA', UPCOMING),
      ],
      filteredOffers: [],
      now,
    });
    const row = rowFor(report, 'EDEKA');
    expect(row.status).toBe('warn');
    expect(row.reasons.join(' ')).toMatch(/nächste Aktionswoche/);
  });
});
