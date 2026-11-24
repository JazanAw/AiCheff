// Inhaltliche Angebots-Deduplizierung (Task P3) — getrennt von der id-Dedupe.
//
// Ein Angebot kann mehrfach mit VERSCHIEDENEN ids im Snapshot landen (zwei
// Scrape-Durchläufe, zwei Quell-Slugs, ein Browser-Reimport) — der „Auslese"-Fall:
// dasselbe Wochenangebot taucht mehrfach auf. Diese reine Dedupe fasst NUR
// Einträge mit identischem normalisiertem Angebots-Fingerprint zusammen
// (Shop, Name, Preis, Gültigkeit, relevante Quelle, Einheit). UNTERSCHIEDLICHE
// echte Wochenangebote — z. B. dieselbe Marke mit anderer Gültigkeit oder anderem
// Preis — bleiben bewusst getrennt: der Fingerprint enthält Gültigkeit + Preis.
//
// Pure (kein IO, keine Mutation), idempotent. Bewusst KEINE Produkt-/Marken-
// Sonderregel — die Dedupe ist rein strukturell über die Angebotsfelder.

import type { Offer } from '../../src/types/models';
import { normalizeText } from '../../src/utils/offers';

/** Relevante Quelle eines Angebots (Quellabteilung bzw. -kategorie), normalisiert. */
function sourcePart(offer: Offer): string {
  const o = offer as Offer & { sourceCategoryRaw?: unknown; sourceDepartmentRaw?: unknown };
  return normalizeText(`${String(o.sourceCategoryRaw ?? '')} ${String(o.sourceDepartmentRaw ?? '')}`);
}

function pricePart(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '';
}

/**
 * Normalisierter Angebots-Fingerprint aus den entscheidungsrelevanten
 * Identitätsfeldern: Shop, Name, Preis, Gültigkeitsfenster, Einheit und relevante
 * Quelle. Zwei Einträge mit demselben Fingerprint sind dasselbe Wochenangebot;
 * jede Abweichung (anderer Preis, andere Gültigkeit) erzeugt einen anderen
 * Fingerprint und bleibt ein eigenständiges Angebot.
 */
export function offerContentFingerprint(offer: Offer): string {
  return [
    `chain:${normalizeText(offer.storeChain ?? '')}`,
    `name:${normalizeText(offer.name ?? '')}`,
    `price:${pricePart(offer.price as number | null | undefined)}`,
    `vs:${normalizeText(String(offer.validityStart ?? ''))}`,
    `ve:${normalizeText(String(offer.validityEnd ?? ''))}`,
    `unit:${normalizeText(String((offer as Offer & { unit?: unknown }).unit ?? ''))}`,
    `src:${sourcePart(offer)}`,
  ].join('|');
}

export interface ContentDedupeResult<T extends Offer> {
  offers: T[];
  /** Anzahl entfernter inhaltlicher Duplikate (verschiedene id, gleicher Fingerprint). */
  removedCount: number;
  /** Bis zu 8 distinct Namen der zusammengeführten Angebote. */
  removedExamples: string[];
}

/**
 * Dedupliziert eine Angebotsliste über den {@link offerContentFingerprint}: das
 * ERSTE Vorkommen je Fingerprint gewinnt, weitere mit gleichem Fingerprint werden
 * entfernt. Einträge mit identischer id gelten ohnehin als dasselbe Angebot (sie
 * teilen den Fingerprint). Idempotent: ein zweiter Lauf entfernt nichts mehr.
 */
export function dedupeOffersByContent<T extends Offer>(offers: readonly T[]): ContentDedupeResult<T> {
  const seen = new Set<string>();
  const kept: T[] = [];
  const removedNames: string[] = [];
  for (const offer of offers) {
    const fingerprint = offerContentFingerprint(offer);
    if (seen.has(fingerprint)) {
      removedNames.push(offer.name);
      continue;
    }
    seen.add(fingerprint);
    kept.push(offer);
  }
  return {
    offers: kept,
    removedCount: removedNames.length,
    removedExamples: [...new Set(removedNames)].slice(0, 8),
  };
}
