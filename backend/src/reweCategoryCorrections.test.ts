import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  computeFinalCategoryCorrections,
  type FinalCategoryOffer,
  type ReweImportReportData,
} from './reweBrowserImport';
import { buildScanReport } from './scanReport';

// Task P2 — die REWE-„Kategorie-Korrekturen" im Report müssen aus dem FINALEN,
// persistierten Offer-Zustand kommen, nicht aus einem Import-Zwischenstand.
// Live-Repro 2026-06-16: der Report zeigte Iglo Tiefkühl → Trockenware und
// Trollinger Alkohol → Snacks/Süßes, obwohl die echten Offers Tiefkühl bzw.
// Alkohol blieben. Produktnamen sind reine Reproduktions-Fixtures.

function finalOffer(
  name: string,
  category: string,
  sourceCategoryRaw: string,
): FinalCategoryOffer {
  return { name, category, sourceCategoryRaw };
}

describe('computeFinalCategoryCorrections — Diagnose aus dem finalen Zustand', () => {
  it('Iglo Tiefkühl bleibt Tiefkühl → KEINE irreführende Korrektur', () => {
    const corrections = computeFinalCategoryCorrections([
      finalOffer('Iglo Tagliatelle Pilzpfanne', 'Tiefkühl', 'Tiefkühl'),
      finalOffer('Iglo Pasta Carbonara', 'Tiefkühl', 'Tiefkühl'),
    ]);
    expect(corrections).toEqual([]);
  });

  it('Trollinger bleibt Alkohol → keine Snacks/Süßes-Korrektur', () => {
    const corrections = computeFinalCategoryCorrections([
      finalOffer('Süss & Fruchtig oder Trollinger Qualitätswein', 'Alkohol', 'Wein, Sekt & Spirituosen'),
    ]);
    expect(corrections).toEqual([]);
  });

  it('ein echter korrigierter Fall zeigt die korrekte Richtung (Roh-Quelle → final)', () => {
    // Eine Süßware, die unter einer (mis-carried) Tiefkühl-Sektionsüberschrift
    // importiert wurde, aber final korrekt Snacks/Süßes ist.
    const corrections = computeFinalCategoryCorrections([
      finalOffer('Nimm 2 Lachgummi', 'Snacks/Süßes', 'Tiefkühl'),
    ]);
    expect(corrections).toEqual([
      { name: 'Nimm 2 Lachgummi', from: 'Tiefkühl', to: 'Snacks/Süßes' },
    ]);
  });

  it('ohne Roh-Quellüberschrift oder ohne Netto-Änderung entsteht keine Korrektur', () => {
    expect(
      computeFinalCategoryCorrections([
        finalOffer('Ohne Heading', 'Tiefkühl', ''),
        finalOffer('Heading Sonstiges', 'Tiefkühl', 'Irgendwas Unbekanntes'),
      ]),
    ).toEqual([]);
  });
});

// ── Realer Report-Pfad: stale Import-Korrekturen werden verworfen ────────────

const NOW = new Date('2026-06-16T12:00:00.000Z');
const CURRENT = { validityStart: '2026-06-14T00:00:00.000Z', validityEnd: '2026-06-21T23:59:59.000Z' };

let seq = 0;
function reweOffer(name: string, category: string, sourceCategoryRaw: string): Offer {
  seq += 1;
  return {
    id: `rewe_${seq}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category,
    price: 2.49,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: CURRENT.validityStart,
    validityEnd: CURRENT.validityEnd,
    sourceUrl: 'https://rewe.de',
    tags: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    sourceCategoryRaw,
  } as Offer;
}

function reweImportWithStaleCorrections(): ReweImportReportData {
  return {
    rawCount: 3,
    normalizedCount: 3,
    reviewCount: 0,
    skippedCount: 0,
    skippedFragments: [],
    suspiciousPrices: [],
    duplicateCandidates: [],
    // STALE/irreführende Import-Zwischenstands-Korrekturen aus dem Live-Repro.
    categoryCorrections: [
      { name: 'Iglo Tagliatelle Pilzpfanne', from: 'Tiefkühl', to: 'Trockenware' },
      { name: 'Iglo Pasta Carbonara', from: 'Tiefkühl', to: 'Trockenware' },
      { name: 'Süss & Fruchtig oder Trollinger Qualitätswein', from: 'Alkohol', to: 'Snacks/Süßes' },
    ],
  };
}

describe('buildScanReport — REWE categoryCorrections aus dem finalen Snapshot', () => {
  it('verwirft stale Zwischenstands-Korrekturen und zeigt nur echte finale Korrekturen', () => {
    const report = buildScanReport({
      offers: [
        reweOffer('Iglo Tagliatelle Pilzpfanne', 'Tiefkühl', 'Tiefkühl'),
        reweOffer('Iglo Pasta Carbonara', 'Tiefkühl', 'Tiefkühl'),
        reweOffer('Süss & Fruchtig oder Trollinger Qualitätswein', 'Alkohol', 'Wein, Sekt & Spirituosen'),
        // Eine echte finale Korrektur (heading Tiefkühl, final Snacks/Süßes).
        reweOffer('Nimm 2 Lachgummi', 'Snacks/Süßes', 'Tiefkühl'),
      ],
      nextWeekOffers: [],
      filteredOffers: [],
      officialCounts: {},
      reweImport: reweImportWithStaleCorrections(),
      reweImportMethod: 'browser',
      now: NOW,
    });

    const corrections = report.reweImport?.categoryCorrections ?? [];
    // Iglo + Trollinger erscheinen NICHT mehr (kein Netto-Wechsel im finalen Zustand).
    expect(corrections.find((c) => c.name.startsWith('Iglo'))).toBeUndefined();
    expect(corrections.find((c) => c.name.includes('Trollinger'))).toBeUndefined();
    // Nur die echte finale Korrektur bleibt, mit korrekter Richtung.
    expect(corrections).toEqual([
      { name: 'Nimm 2 Lachgummi', from: 'Tiefkühl', to: 'Snacks/Süßes' },
    ]);
  });
});
