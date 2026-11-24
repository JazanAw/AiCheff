// Internationale-Lebensmittel-Zusatzklassifikation (Task 6).
//
// Dies ist eine ZUSATZstruktur — sie ersetzt NICHT die Hauptkategorie. Sie läuft
// nur für echte Lebensmittel (Non-Food wird sauber übersprungen) und beantwortet
// die Frage "ist das ein internationales Lebensmittel, und aus welcher Küche?".
//
// Klare Fälle werden regelbasiert + hochpräzise erkannt (Ayran/Sucuk/Tahini/…);
// mehrdeutige Fälle bekommen `needsReview=true` statt falscher Sicherheit. Für die
// unsicheren Fälle steht eine Qwen3-Strukturausgabe bereit (JSON-Schema,
// temperature 0, think false — genau wie der bestehende offers_categorizer), die
// per Dependency-Injection eingehängt werden kann, ohne den Hot-Path zu ändern.

import type { Offer } from '../../src/types/models';
import { normalizeText } from '../../src/utils/offers';
import { hasHardNonFoodSignal } from './offersStrictFoodFilter';

export type CuisineRegion =
  | 'turkish'
  | 'arabic'
  | 'asian'
  | 'indian'
  | 'latin'
  | 'balkan'
  | 'italian'
  | 'other'
  | 'unknown';

export const CUISINE_REGIONS: readonly CuisineRegion[] = [
  'turkish',
  'arabic',
  'asian',
  'indian',
  'latin',
  'balkan',
  'italian',
  'other',
  'unknown',
];

export interface InternationalFoodClassification {
  isInternational: boolean;
  cuisineRegion: CuisineRegion;
  /** 0..1 — high for unambiguous rule hits, low for ambiguous ones. */
  confidence: number;
  reasons: string[];
  /** True when the signal is ambiguous/conflicting — a human or Qwen3 should
   *  confirm, instead of the rule asserting false certainty. */
  needsReview: boolean;
}

interface CuisineKeyword {
  /** Already-normalized token (matches the output of {@link normalizeText}). */
  token: string;
  region: CuisineRegion;
  /** strong = unambiguous (confident, no review); weak = ambiguous (needsReview). */
  strong: boolean;
}

function kw(token: string, region: CuisineRegion, strong = true): CuisineKeyword {
  return { token, region, strong };
}

// High-precision dictionary. STRONG entries are products/terms that are
// unambiguously a given cuisine in a German supermarket; WEAK entries are common
// but ambiguous (could be a German staple) and therefore route to needsReview.
// Deliberately NO bare "pizza"/"pasta"/"mozzarella"/"espresso"/"pesto" — those
// are everyday German-shelf items, not an international-food signal.
const CUISINE_KEYWORDS: CuisineKeyword[] = [
  // ── Türkisch ──────────────────────────────────────────────────────────────
  kw('ayran', 'turkish'),
  kw('sucuk', 'turkish'),
  kw('simit', 'turkish'),
  kw('boerek', 'turkish'),
  kw('lahmacun', 'turkish'),
  kw('pide', 'turkish'),
  kw('doener', 'turkish'),
  kw('koefte', 'turkish'),
  kw('manti', 'turkish'),
  kw('beyaz peynir', 'turkish'),
  kw('kasar', 'turkish'),
  kw('tuerkisch', 'turkish'),
  kw('tuerkische', 'turkish'),
  // ── Arabisch / Levante ──────────────────────────────────────────────────────
  kw('tahini', 'arabic'),
  kw('tahin', 'arabic'),
  kw('hummus', 'arabic'),
  kw('hommus', 'arabic'),
  kw('falafel', 'arabic'),
  kw('halloumi', 'arabic'),
  kw('zaatar', 'arabic'),
  kw('za atar', 'arabic'),
  kw('harissa', 'arabic'),
  kw('labneh', 'arabic'),
  kw('baba ganoush', 'arabic'),
  kw('arabisch', 'arabic'),
  kw('arabische', 'arabic'),
  // ── Asiatisch (Ost-/Südostasien) ────────────────────────────────────────────
  kw('sojasauce', 'asian'),
  kw('soja sauce', 'asian'),
  kw('soja sosse', 'asian'),
  kw('soy sauce', 'asian'),
  kw('sriracha', 'asian'),
  kw('kimchi', 'asian'),
  kw('miso', 'asian'),
  kw('sushi', 'asian'),
  kw('ramen', 'asian'),
  kw('udon', 'asian'),
  kw('soba', 'asian'),
  kw('nori', 'asian'),
  kw('wasabi', 'asian'),
  kw('teriyaki', 'asian'),
  kw('hoisin', 'asian'),
  kw('mirin', 'asian'),
  kw('dashi', 'asian'),
  kw('gochujang', 'asian'),
  kw('sambal oelek', 'asian'),
  kw('fischsauce', 'asian'),
  kw('fish sauce', 'asian'),
  kw('jasminreis', 'asian'),
  kw('glasnudeln', 'asian'),
  kw('pad thai', 'asian'),
  kw('asiatisch', 'asian'),
  kw('asiatische', 'asian'),
  kw('thai', 'asian'),
  kw('chinesisch', 'asian'),
  kw('japanisch', 'asian'),
  kw('koreanisch', 'asian'),
  kw('vietnamesisch', 'asian'),
  // ── Indisch ─────────────────────────────────────────────────────────────────
  kw('basmati', 'indian'),
  kw('naan', 'indian'),
  kw('paneer', 'indian'),
  kw('garam masala', 'indian'),
  kw('tandoori', 'indian'),
  kw('tikka', 'indian'),
  kw('chapati', 'indian'),
  kw('dhal', 'indian'),
  kw('ghee', 'indian'),
  kw('papadam', 'indian'),
  kw('biryani', 'indian'),
  kw('indisch', 'indian'),
  kw('indische', 'indian'),
  // ── Lateinamerikanisch / mexikanisch ─────────────────────────────────────────
  kw('taco', 'latin'),
  kw('tacos', 'latin'),
  kw('burrito', 'latin'),
  kw('guacamole', 'latin'),
  kw('jalapeno', 'latin'),
  kw('jalapenos', 'latin'),
  kw('nacho', 'latin'),
  kw('nachos', 'latin'),
  kw('enchilada', 'latin'),
  kw('fajita', 'latin'),
  kw('quesadilla', 'latin'),
  kw('chili con carne', 'latin'),
  kw('mexikanisch', 'latin'),
  kw('mexikanische', 'latin'),
  // ── Balkan ────────────────────────────────────────────────────────────────
  kw('ajvar', 'balkan'),
  kw('cevapcici', 'balkan'),
  kw('cevapi', 'balkan'),
  kw('pljeskavica', 'balkan'),
  kw('sarma', 'balkan'),
  kw('rakija', 'balkan'),
  kw('balkan', 'balkan'),
  // ── Italienisch (hochpräzise; KEIN bare pizza/pasta/mozzarella) ──────────────
  kw('antipasti', 'italian'),
  kw('prosciutto', 'italian'),
  kw('ciabatta', 'italian'),
  kw('focaccia', 'italian'),
  kw('gnocchi', 'italian'),
  kw('risotto', 'italian'),
  kw('tiramisu', 'italian'),
  kw('mortadella', 'italian'),
  kw('parmigiano', 'italian'),
  kw('pecorino', 'italian'),
  kw('mozzarella di bufala', 'italian'),
  // ── Sonstige eindeutige Küchen ───────────────────────────────────────────────
  kw('gyros', 'other'),
  kw('tzatziki', 'other'),
  // ── WEAK / mehrdeutig → needsReview ──────────────────────────────────────────
  kw('tortilla', 'latin', false),
  kw('tortillas', 'latin', false),
  kw('wrap', 'latin', false),
  kw('wraps', 'latin', false),
  kw('couscous', 'arabic', false),
  kw('bulgur', 'arabic', false),
  kw('kokosmilch', 'asian', false),
  kw('pita', 'other', false),
  kw('feta', 'other', false),
  kw('curry', 'unknown', false),
];

function buildHaystack(offer: Offer): string {
  const o = offer as Offer & Record<string, unknown>;
  const parts = [
    offer.name,
    offer.brand,
    offer.category,
    o.sourceCategoryRaw,
    o.sourceDepartmentRaw,
    o.sourceContextRaw,
    Array.isArray(offer.tags) ? offer.tags.join(' ') : '',
    Array.isArray(o.sourceTagsRaw) ? (o.sourceTagsRaw as string[]).join(' ') : '',
  ];
  return normalizeText(parts.filter(Boolean).join(' '));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenMatches(haystack: string, token: string): boolean {
  if (token.includes(' ')) {
    return haystack.includes(token);
  }
  // Short single words use a word boundary so "wok"/"dal"/"naan" never match
  // inside a longer unrelated word; longer tokens are specific enough as substrings.
  if (token.length <= 4) {
    return new RegExp(`(^|[\\s-])${escapeRegExp(token)}($|[\\s-])`).test(haystack);
  }
  return haystack.includes(token);
}

const NOT_INTERNATIONAL: InternationalFoodClassification = {
  isInternational: false,
  cuisineRegion: 'unknown',
  confidence: 0.9,
  reasons: ['rule:no_international_signal'],
  needsReview: false,
};

/**
 * Rule-based international-food classification (synchronous, pure, fast). Only
 * runs for real food — a hard non-food signal returns a clean skip. Unambiguous
 * keyword hits are confident (no review); ambiguous-only hits or conflicting
 * regions are returned with `needsReview=true` so Qwen3/a human can confirm.
 */
export function classifyInternationalFood(offer: Offer): InternationalFoodClassification {
  // Zusatzklassifikation läuft NUR für echte Lebensmittel.
  if (hasHardNonFoodSignal(offer)) {
    return {
      isInternational: false,
      cuisineRegion: 'unknown',
      confidence: 1,
      reasons: ['skipped:nonfood'],
      needsReview: false,
    };
  }

  const haystack = buildHaystack(offer);
  const strongHits: CuisineKeyword[] = [];
  const weakHits: CuisineKeyword[] = [];
  for (const entry of CUISINE_KEYWORDS) {
    if (!tokenMatches(haystack, entry.token)) continue;
    (entry.strong ? strongHits : weakHits).push(entry);
  }

  if (strongHits.length > 0) {
    const distinctRegions = [...new Set(strongHits.map((hit) => hit.region))];
    const region = strongHits[0].region;
    const conflict = distinctRegions.length > 1;
    return {
      isInternational: true,
      cuisineRegion: conflict ? region : region,
      confidence: conflict ? 0.6 : 0.9,
      reasons: conflict
        ? [
            `rule:keyword:${strongHits.map((hit) => hit.token).join('+')}`,
            `conflict:regions:${distinctRegions.join('+')}`,
          ]
        : [`rule:keyword:${strongHits[0].token}`, `region:${region}`],
      needsReview: conflict,
    };
  }

  if (weakHits.length > 0) {
    const region = weakHits[0].region;
    return {
      isInternational: true,
      cuisineRegion: region,
      confidence: 0.45,
      reasons: [`rule:ambiguous:${weakHits.map((hit) => hit.token).join('+')}`],
      needsReview: true,
    };
  }

  return { ...NOT_INTERNATIONAL };
}

// ───────────────────────────────────────────────────────────────────────────
// Qwen3 structured-output scaffold (für die unsicheren Fälle)
// ───────────────────────────────────────────────────────────────────────────

/** JSON Schema for Ollama Structured Outputs — constrains `cuisineRegion` to the
 *  allowed enum so a local model can only return a VALID region. */
export const INTERNATIONAL_FOOD_SCHEMA = {
  type: 'object',
  properties: {
    isInternational: { type: 'boolean' },
    cuisineRegion: { type: 'string', enum: [...CUISINE_REGIONS] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasons: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    needsReview: { type: 'boolean' },
  },
  required: ['isInternational', 'cuisineRegion', 'confidence', 'needsReview'],
  additionalProperties: false,
} as const;

export interface InternationalFoodLlmRequest {
  model: string;
  stream: false;
  format: typeof INTERNATIONAL_FOOD_SCHEMA;
  think: false;
  keep_alive: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  options: { temperature: number; num_predict: number };
}

/**
 * Build the Ollama `/api/chat` request for the international-food classification,
 * mirroring the existing offers_categorizer settings: JSON-Schema structured
 * output, `temperature: 0`, `think: false`. Pure (returns the payload), so it is
 * unit-testable and the actual transport can be injected.
 */
export function buildInternationalFoodLlmRequest(
  offer: Offer,
  model: string,
): InternationalFoodLlmRequest {
  const o = offer as Offer & Record<string, unknown>;
  const system =
    'You decide whether a German supermarket FOOD product is an international/ethnic ' +
    'food and from which cuisine region. Return ONLY JSON matching the schema. ' +
    "cuisineRegion MUST be from the enum. If a normal German staple (milk, butter, " +
    "plain pizza, cola, gouda, bananas), set isInternational=false and cuisineRegion='unknown'. " +
    'If genuinely unsure, set needsReview=true and a low confidence. No prose, no thinking.';
  const user = JSON.stringify(
    {
      name: offer.name,
      brand: offer.brand ?? null,
      category: offer.category ?? null,
      source_category: o.sourceCategoryRaw ?? null,
      source_department: o.sourceDepartmentRaw ?? null,
      context: o.sourceContextRaw ?? null,
    },
    null,
    0,
  );
  return {
    model,
    stream: false,
    format: INTERNATIONAL_FOOD_SCHEMA,
    think: false,
    keep_alive: '10m',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    options: { temperature: 0, num_predict: 200 },
  };
}

/** Validate + normalize a model response into a classification, or null when the
 *  payload is malformed / the region is out of the enum (never trust free text). */
export function parseInternationalFoodLlmResponse(
  payload: unknown,
): InternationalFoodClassification | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const region = String(p.cuisineRegion ?? '').trim() as CuisineRegion;
  if (!CUISINE_REGIONS.includes(region)) return null;
  const confidenceRaw = Number(p.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.5;
  const reasons = Array.isArray(p.reasons)
    ? p.reasons.map((r) => String(r).trim()).filter(Boolean)
    : [];
  return {
    isInternational: p.isInternational === true,
    cuisineRegion: region,
    confidence,
    reasons: reasons.length > 0 ? reasons : ['llm'],
    needsReview: p.needsReview === true,
  };
}

/** A pluggable LLM classifier (e.g. an Ollama/Qwen3 call). */
export type InternationalFoodLlm = (
  offer: Offer,
) => Promise<InternationalFoodClassification | null>;

export interface ClassifyWithLlmOptions {
  llm?: InternationalFoodLlm;
}

/**
 * Rule-first classification that ONLY escalates the ambiguous (`needsReview`)
 * cases to the injected Qwen3 LLM. Confident rule results never call the model
 * (keeps the hot path cheap); when no LLM is injected the honest rule result
 * (incl. its `needsReview`) is returned unchanged — never false certainty.
 */
export async function classifyInternationalFoodWithLlm(
  offer: Offer,
  options: ClassifyWithLlmOptions = {},
): Promise<InternationalFoodClassification> {
  const rule = classifyInternationalFood(offer);
  if (!rule.needsReview || !options.llm) {
    return rule;
  }
  try {
    const llmResult = await options.llm(offer);
    return llmResult ?? rule;
  } catch {
    return rule; // a model hiccup must never lose the honest rule result
  }
}

/** Minimal fetch shape so the Ollama transport can be injected in tests. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OllamaInternationalFoodOptions {
  host: string;
  model: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Factory for a production {@link InternationalFoodLlm} backed by Ollama/Qwen3
 * structured outputs. Wiring this into Phase 2 for the `needsReview` offers is
 * the documented integration point; it stays out of the synchronous hot path so
 * a slow/missing model can never degrade the rule-based default.
 */
export function createOllamaInternationalFoodLlm(
  options: OllamaInternationalFoodOptions,
): InternationalFoodLlm {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  return async (offer: Offer) => {
    if (!fetchImpl) return null;
    const request = buildInternationalFoodLlmRequest(offer, options.model);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
    try {
      const response = await fetchImpl(`${options.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const envelope = JSON.parse(await response.text()) as {
        message?: { content?: unknown };
        response?: unknown;
      };
      const content = String(envelope.message?.content ?? envelope.response ?? '');
      try {
        return parseInternationalFoodLlmResponse(JSON.parse(content));
      } catch {
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        return parseInternationalFoodLlmResponse(JSON.parse(content.slice(start, end + 1)));
      }
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
