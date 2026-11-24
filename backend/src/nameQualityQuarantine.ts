// Task P2 — generische Fragment-/Namensqualitäts-Quarantäne.
//
// Manche „Angebote" sind gar kein Produkt, sondern ein isoliertes Eigenschafts-/
// Attributwort, das beim Scrapen/Importieren als eigener Name übrig blieb
// ("kernarm", "kernlos" als REWE-Fragment). Solche Einträge sind WEDER Food noch
// Non-Food, sondern ein NAMENSQUALITÄTS-Problem: sie dürfen nie als echtes
// Angebot persistieren, sollen aber auch nicht als „Non-Food-Review" in derselben
// Liste wie echte Lebensmittel landen.
//
// Diese Regel ist bewusst GENERISCH und strukturell — KEINE Allow-/Blocklist
// einzelner Fragmente wie „kernarm". Erkannt wird der Fall über die Kombination:
//   - sehr kurzer Ein-Wort-Name ohne identitätstragende Mehrwortstruktur,
//   - kein Produktkopf / kein Food-Vokabular (kein starkes Food-Signal),
//   - keine vertrauenswürdige Food-Quellabteilung,
//   - KEIN regelbestätigtes Non-Food (echtes Non-Food ist ein Produkt, kein
//     Fragment — es bleibt confirmed_non_food),
//   - KEIN cache-Konflikt-Food (ein veralteter Non-Food-Cache, dem das eigene
//     foodFlag='food' widerspricht, ist ein Food-Cache-Konflikt, kein Fragment),
//   - aber eine aktive Non-Food-/Schwach-Kategorisierung (der Categorizer konnte
//     den Namen nicht als Food platzieren) — d. h. nichts kann den Namen positiv
//     identifizieren.
//
// Pure (kein IO), trivially unit-testbar.

import type { Offer } from '../../src/types/models';
import { normalizeText } from '../../src/utils/offers';
import { isHardBadOfferName } from './offerNameQuality';
import { isLockedOrManual } from './offerProductIntelligence';
import {
  hasCanonicalNonFoodFlag,
  hasRuleConfirmedNonFoodSignal,
  hasStrongFoodSignal,
  hasStrongFoodSourceSignal,
  hasUntrustworthyCacheNonFood,
} from './offersStrictFoodFilter';

/** Quarantäne-Tag für ein Namensqualitäts-Fragment (getrennt vom harten
 *  `name_fragment`-Tag der Promo-/Packungsfragmente, damit der Report die Klasse
 *  unterscheiden kann). */
export const NAME_QUALITY_TAG = 'name_quality';

/** reviewReason für ein quarantänisiertes Namensqualitäts-Fragment. */
export const NAME_QUALITY_REVIEW_REASON = 'name_quality_fragment';

/** Audit-Reason, der das neutralisierte canonicalCategory eines Namensqualitäts-
 *  Fragments markiert — zusätzlich zu den bestehenden Debug-Reasons, damit
 *  nachvollziehbar bleibt, dass die Non-Food-Optik eine Quarantäne ist. */
export const NAME_QUALITY_QUARANTINE_REASON = 'quarantine:name_quality';

/** Über diesem (großzügigen) Limit ist ein Ein-Wort-Name fast immer ein echtes
 *  Kompositum (Produktname), kein isoliertes Attributwort. */
const MAX_SINGLE_TOKEN_LENGTH = 14;

/** Ab dieser canonicalCategory.confidence gilt eine Klassifikation als
 *  POSITIVE Identifikation (gespiegelt an WEAK_CACHE_NON_FOOD_CONFIDENCE in
 *  offersStrictFoodFilter). Echte Fragmente liegen darunter (sub='unknown',
 *  conf≈0.3 — der Categorizer konnte den Namen nicht platzieren). */
const MIN_IDENTIFIED_CONFIDENCE = 0.6;

/** Identitätstragende Tokens eines Namens (Buchstaben/Ziffern), Bindestrich +
 *  Leerzeichen trennen — damit „l-Dose" als zwei Tokens zerfällt. */
function identityTokens(name: string): string[] {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
}

/**
 * True, wenn der Name ein generisches Namensqualitäts-Fragment ist (Task P2):
 * entweder ein HARTER Schlecht-Name (Promo-/Packungs-/Beschreibungs-Fragment über
 * {@link isHardBadOfferName}) ODER ein einzelnes, NICHT identifizierbares Kurzwort
 * (der „kernarm"-Fall). Die zweite Klasse verlangt einen aktiven Non-Food-/Schwach-
 * Kategorisierungs-Beleg, schließt aber echtes Non-Food (regelbestätigt) und einen
 * Food-Cache-Konflikt (untrustworthy cache mit foodFlag='food') bewusst aus —
 * diese sind ein Produkt bzw. ein Food-Review-Fall, kein Namensfragment.
 *
 * Bewusst OHNE Produkt-/Fragment-Allowlist. Legitime kurze Food-Namen
 * (Obst/Gemüse/Getränke, Marke + Kontext, klare Food-Abteilung) tragen ein
 * starkes Food-Signal und werden NIE quarantänisiert.
 */
export function isNameQualityFragment(offer: Offer): boolean {
  // Harte Promo-/Packungs-/Descriptor-Fragmente ("extra", "Original", "Tiefpreis",
  // "l-Dose") tragen NIE eine Produktidentität — unabhängig davon, ob ein Cache-Hit
  // sie zufällig zu einer Marke aufgelöst hat. Vor allem anderen prüfen, damit ein
  // hoch-konfidenter Cache-Treffer einen harten Schrottnamen nicht „rettet".
  if (isHardBadOfferName(offer.name)) {
    return true;
  }
  // Bereits persistiertes Fragment trägt das Quarantäne-Tag. Das Tag wird NICHT
  // mehr blind vertraut (ein früherer Pass stempelte name_quality auch auf echte
  // Ein-Wort-PRODUKTE wie „Gewichte"/„Pfannen") — es wird re-validiert: ein
  // POSITIV identifiziertes Produkt (hohe Confidence + konkrete Sub-Kategorie) ist
  // kein Namensmüll, ein schwach/nicht identifizierter Name (kernarm, conf 0.3,
  // sub='unknown') bleibt Fragment, auch nachdem die Non-Food-Optik neutralisiert
  // wurde (isNonFood=false).
  if (hasNameQualityTag(offer)) {
    return !isConfidentlyCategorized(offer);
  }
  const tokens = identityTokens(offer.name);
  if (tokens.length !== 1 || tokens[0].length > MAX_SINGLE_TOKEN_LENGTH) {
    return false;
  }
  if (hasStrongFoodSignal(offer) || hasStrongFoodSourceSignal(offer)) {
    return false; // ein echter Produktkopf / Food-Abteilung ⇒ kein Fragment
  }
  if (hasRuleConfirmedNonFoodSignal(offer)) {
    return false; // echtes Non-Food-Produkt ⇒ bleibt confirmed_non_food
  }
  if (hasUntrustworthyCacheNonFood(offer)) {
    return false; // Food-Cache-Konflikt (Spritzring) ⇒ Cache-Konflikt-Review
  }
  // Ein CONFIDENT identifizierter Ein-Wort-Name ist ein echtes Produkt/Artikel
  // (Food ODER Non-Food), kein Schrottname — auch wenn der Categorizer ihn nach
  // Non-Food legte. „Gewichte"/„Fitnessbänder" (conf 0.8, sub „Küche & Geräte")
  // sind echte Produkte; „kernarm"/„Buch"/„Kiezmische" (conf 0.3, sub „unknown")
  // konnte der Categorizer NICHT platzieren ⇒ Fragment.
  if (isConfidentlyCategorized(offer)) {
    return false;
  }
  // Nichts identifiziert den Namen positiv; der Categorizer hat ihn (schwach)
  // als Non-Food markiert ⇒ reines Namensqualitäts-Fragment.
  return hasCanonicalNonFoodFlag(offer);
}

/**
 * True, wenn die Klassifikation des Categorizers den (Ein-Wort-)Namen POSITIV
 * identifiziert hat: hohe Confidence ({@link MIN_IDENTIFIED_CONFIDENCE}) UND eine
 * konkrete (nicht-„unknown") Sub-Kategorie. Das trennt ein echtes Ein-Wort-Produkt
 * („Pfannen" → Küche & Geräte, conf 0.9) von einem Namensfragment, das der
 * Categorizer NICHT platzieren konnte („kernarm" → unknown, conf 0.3). Bewusst
 * richtungsagnostisch (Food wie Non-Food) und ohne Produkt-/Marken-Liste. Liest
 * confidence/sub auch nach der Quarantäne-Neutralisierung (beide bleiben erhalten).
 */
function isConfidentlyCategorized(offer: Offer): boolean {
  const cc = (offer as Offer & {
    canonicalCategory?: { confidence?: unknown; sub?: unknown };
  }).canonicalCategory;
  if (!cc || typeof cc !== 'object') {
    return false;
  }
  const confidence = Number(cc.confidence);
  if (!Number.isFinite(confidence) || confidence < MIN_IDENTIFIED_CONFIDENCE) {
    return false;
  }
  const sub = normalizeText(String(cc.sub ?? ''));
  return sub.length > 0 && sub !== 'unknown';
}

/** True, wenn das Angebot das Namensqualitäts-Quarantäne-Tag trägt. */
function hasNameQualityTag(offer: Offer): boolean {
  return (offer.tags ?? []).some((tag) => normalizeText(tag) === NAME_QUALITY_TAG);
}

/**
 * True, wenn die persistierten Felder eines Fragments bereits vollständig
 * normalisiert sind (Tag gesetzt, reviewReason enthält das Fragment-Token, und das
 * canonicalCategory täuscht kein Non-Food mehr vor). Dient der Idempotenz: ein
 * bereits normalisiertes Angebot wird nicht erneut „repariert" und nicht doppelt
 * gezählt.
 */
export function isNameQualityNormalized(offer: Offer): boolean {
  if (!hasNameQualityTag(offer)) {
    return false;
  }
  const reviewReason = String((offer as Offer & { reviewReason?: unknown }).reviewReason ?? '');
  const hasReason = reviewReason
    .split(',')
    .map((part) => part.trim())
    .includes(NAME_QUALITY_REVIEW_REASON);
  if (!hasReason) {
    return false;
  }
  const cc = (offer as Offer & {
    canonicalCategory?: { isNonFood?: unknown; main?: unknown };
  }).canonicalCategory;
  if (cc && typeof cc === 'object') {
    if (cc.isNonFood === true || normalizeText(String(cc.main ?? '')) === 'non food') {
      return false;
    }
  }
  return true;
}

/** Hängt einen reviewReason-Token an die bestehende (komma-separierte) Liste an,
 *  ohne zu duplizieren — bestehende Gründe (z. B. unknown_sub,low_confidence)
 *  bleiben erhalten. */
function appendReviewReason(existing: unknown, reason: string): string {
  const parts = String(existing ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.includes(reason)) {
    parts.push(reason);
  }
  return parts.join(',');
}

/** Neutralisiert ein Non-Food vortäuschendes canonicalCategory: isNonFood=false,
 *  `main` geleert (nie zurück nach „Non-Food" gemappt), bestehende Debug-Reasons
 *  bleiben erhalten und werden um den Quarantäne-Reason ergänzt. Idempotent. */
function neutralizeNonFoodCanonical(canonical: unknown): Record<string, unknown> {
  const base =
    canonical && typeof canonical === 'object'
      ? { ...(canonical as Record<string, unknown>) }
      : {};
  const priorReasons = Array.isArray(base.reasons)
    ? (base.reasons as unknown[]).filter((reason): reason is string => typeof reason === 'string')
    : [];
  const reasons = priorReasons.includes(NAME_QUALITY_QUARANTINE_REASON)
    ? priorReasons
    : [...priorReasons, NAME_QUALITY_QUARANTINE_REASON];
  return {
    ...base,
    isNonFood: false,
    main: undefined,
    reasons,
  };
}

/**
 * Zentrale, idempotente Normalisierung eines Namensqualitäts-Fragments für die
 * PERSISTIERUNG. Der „kernarm"-Fall blieb im Snapshot als scheinbares Non-Food
 * liegen (canonicalCategory.isNonFood, main='Non-Food', generischer reviewReason),
 * obwohl der Report ihn korrekt als name_quality erkannte. Diese Funktion bringt
 * die persistierten Felder mit der Klassifikation in Einklang:
 *   - tags enthält name_quality (+ reviewNeeded-Marker), dedupliziert
 *   - reviewNeeded = true
 *   - reviewReason enthält name_quality_fragment (bestehende Gründe bleiben)
 *   - foodFlag neutralisiert (unsure) — weder Food noch Non-Food
 *   - canonicalCategory.isNonFood = false, main geleert (nicht „Non-Food")
 *   - canonicalCategory.reasons um quarantine:name_quality ergänzt (Debug bleibt)
 *
 * Bewusst KEINE Produkt-/Marken-Liste — der Aufrufer entscheidet über
 * {@link isNameQualityFragment}, ob ein Angebot ein Fragment ist. Editorial
 * gesperrte / manuell entschiedene Angebote werden NIE überschrieben
 * (Bewegungs-/Hand-Guard). Preis/Gültigkeit/Store/Bild bleiben unberührt.
 */
export function markNameQualityFragment<T extends Offer>(offer: T): T {
  if (isLockedOrManual(offer)) {
    return offer;
  }
  const o = offer as T & {
    foodFlag?: unknown;
    reviewNeeded?: unknown;
    reviewReason?: unknown;
    canonicalCategory?: unknown;
  };
  return {
    ...o,
    tags: [...new Set([...(offer.tags ?? []), NAME_QUALITY_TAG, 'reviewNeeded'])],
    reviewNeeded: true,
    reviewReason: appendReviewReason(o.reviewReason, NAME_QUALITY_REVIEW_REASON),
    foodFlag: 'unsure',
    canonicalCategory: neutralizeNonFoodCanonical(o.canonicalCategory),
  } as T;
}

/** Entfernt einen reviewReason-Token aus der komma-separierten Liste (bestehende
 *  Gründe wie unknown_sub/low_confidence bleiben erhalten). */
function stripReviewReason(existing: unknown, reason: string): string {
  return String(existing ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== reason)
    .join(',');
}

/** Macht die Quarantäne-Neutralisierung eines canonicalCategory rückgängig: stellt
 *  die (vor markNameQualityFragment garantiert vorhandene) Non-Food-Optik wieder
 *  her und entfernt den Quarantäne-Reason. Idempotent; übrige Felder/Reasons
 *  bleiben unberührt. */
function restoreNonFoodCanonical(canonical: unknown): unknown {
  if (!canonical || typeof canonical !== 'object') {
    return canonical;
  }
  const base = { ...(canonical as Record<string, unknown>) };
  const reasons = Array.isArray(base.reasons)
    ? (base.reasons as unknown[]).filter(
        (reason): reason is string =>
          typeof reason === 'string' && reason !== NAME_QUALITY_QUARANTINE_REASON,
      )
    : base.reasons;
  return { ...base, isNonFood: true, main: 'Non-Food', reasons };
}

/**
 * Idempotente DENORMALISIERUNG eines FALSCH persistierten Namensqualitäts-Tags
 * (Gegenstück zu {@link markNameQualityFragment}). Ein früherer Pass stempelte
 * `name_quality` auch auf echte Ein-Wort-PRODUKTE (z. B. „Gewichte"/„Pfannen"/
 * Gartenpflanzen), weil der alte Fast-Path jeden vom Categorizer (schwach) als
 * Non-Food markierten Kurznamen als Fragment behandelte. Diese Funktion entfernt
 * das Tag + den name_quality_fragment-reviewReason + den quarantine-Reason und
 * stellt das Non-Food-Verdikt wieder her — aber NUR bei einem confident
 * identifizierten Produkt. Ein echtes Fragment ({@link isNameQualityFragment},
 * z. B. „kernarm") und ein editorial gesperrtes Angebot bleiben unangetastet.
 * Bewusst KEINE Produkt-/Marken-Liste — die Entscheidung kommt allein aus der
 * strukturellen Re-Validierung. Preis/Gültigkeit/Store/Bild bleiben unberührt.
 */
export function repairNonFragmentNameQuality<T extends Offer>(offer: T): T {
  if (!hasNameQualityTag(offer)) {
    return offer; // nichts falsch persistiert
  }
  if (isLockedOrManual(offer)) {
    return offer; // menschliche Entscheidung nie überschreiben
  }
  if (isNameQualityFragment(offer)) {
    return offer; // echtes Fragment (kernarm) bleibt quarantänisiert
  }
  const o = offer as T & { reviewReason?: unknown; canonicalCategory?: unknown };
  return {
    ...o,
    tags: (offer.tags ?? []).filter((tag) => normalizeText(tag) !== NAME_QUALITY_TAG),
    reviewReason: stripReviewReason(o.reviewReason, NAME_QUALITY_REVIEW_REASON),
    canonicalCategory: restoreNonFoodCanonical(o.canonicalCategory),
  } as T;
}
