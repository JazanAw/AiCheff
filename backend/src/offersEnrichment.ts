import { z } from 'zod';
import { appConfig } from '../../src/config/env';
import { ollamaChat } from '../../src/services/ollama';
import {
  SIMPLE_OFFER_CATEGORIES,
  toSimpleOfferCategory,
} from '../../src/utils/offerCategory';
import { Offer } from '../../src/types/models';
import { normalizeText } from '../../src/utils/offers';

interface EnrichmentResult {
  offers: Offer[];
  warnings: string[];
}

export interface EnrichmentProgress {
  total: number;
  processed: number;
  batch: number;
  totalBatches: number;
  message: string;
}

export interface EnrichmentOptions {
  tryOllama?: boolean;
  onProgress?: (progress: EnrichmentProgress) => void;
}

const enrichmentItemSchema = z.object({
  id: z.string(),
  brand: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const enrichmentEnvelopeSchema = z.union([
  z.array(enrichmentItemSchema),
  z.object({
    items: z.array(enrichmentItemSchema),
  }),
]);

const tagRules: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: 'bio', patterns: [/\bbio\b/i, /\borganic\b/i] },
  { tag: 'vegan', patterns: [/\bvegan\b/i, /\btofu\b/i, /\bhaferdrink\b/i, /\bhafer\b/i, /\bsoja/i, /\bkichererb/i, /\blinsen\b/i] },
  { tag: 'vegetarisch', patterns: [/\bvegetarisch\b/i, /\bmilch\b/i, /\bjoghurt\b/i, /\bkaese\b/i, /\beier\b/i, /\bmozzarella\b/i, /\bgouda\b/i] },
  { tag: 'laktosefrei', patterns: [/\blaktosefrei\b/i, /\bhaferdrink\b/i, /\bsojajoghurt\b/i] },
  { tag: 'halal', patterns: [/\bhalal\b/i, /\bkichererb/i, /\blinsen\b/i, /\breis\b/i, /\bhummus\b/i] },
];

function normalizeTag(tag: string): string {
  return normalizeText(tag).replace(/\s+/g, '-');
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))];
}

function inferHeuristicTags(offer: Offer): string[] {
  const source = `${offer.name} ${offer.category} ${offer.tags.join(' ')}`.toLowerCase();
  const tags = [...offer.tags];

  for (const rule of tagRules) {
    if (rule.patterns.some((pattern) => pattern.test(source))) {
      tags.push(rule.tag);
    }
  }

  // Schwein should never be tagged halal.
  if (/\bschwein|pork|bacon\b/i.test(source)) {
    return uniqueTags(tags).filter((tag) => tag !== 'halal');
  }

  return uniqueTags(tags);
}

function defaultBrand(offer: Offer): string {
  return `${offer.storeChain} Eigenmarke`;
}

function isModelNotFoundError(message: string): boolean {
  return (
    /model\s+['"`]?.+['"`]?\s+not\s+found/i.test(message) ||
    /modell?\s+['"`]?.+['"`]?\s+nicht\s+gefunden/i.test(message)
  );
}

function isOllamaUnavailableError(message: string): boolean {
  return (
    /nicht erreichbar/i.test(message) ||
    /connection refused/i.test(message) ||
    /ecconnrefused/i.test(message) ||
    /connectex/i.test(message)
  );
}

function parseJsonEnvelope(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) {
    return JSON.parse(trimmed);
  }

  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  return JSON.parse(cleaned);
}

async function enrichBatchWithOllama(batch: Offer[]): Promise<Map<string, z.infer<typeof enrichmentItemSchema>>> {
  const compact = batch.map((offer) => ({
    id: offer.id,
    name: offer.name,
    storeChain: offer.storeChain,
    category: offer.category,
    unit: offer.unit,
    tags: offer.tags,
  }));

  const prompt = `
Analysiere Lebensmittelangebote.
Ziel: bessere Einordnung von Marke, Kategorie und Ernährungs-Tags.
Nutze verfügbare Information aus Namen/Kategorie/Einheit und bekannte typische Inhaltsstoffe.
Antwort nur als valides JSON.
Schema:
{
  "items": [
    {
      "id": "string",
      "brand": "optional string",
      "category": "optional string",
      "tags": ["optional tags wie bio, vegan, vegetarisch, halal, laktosefrei"]
    }
  ]
}

Erlaubte Kategorien:
${SIMPLE_OFFER_CATEGORIES.join(', ')}

Eingabe:
${JSON.stringify(compact)}
  `.trim();

  const responseText = await ollamaChat(
    [
      {
        role: 'system',
        content:
          'Du bist ein strukturierter Klassifikator für Lebensmittelangebote. Gib nur JSON zurück.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    {
      retries: 1,
      temperature: 0,
    },
  );

  const parsed = parseJsonEnvelope(responseText);
  const validation = enrichmentEnvelopeSchema.safeParse(parsed);
  if (!validation.success) {
    return new Map();
  }

  const items = Array.isArray(validation.data)
    ? validation.data
    : validation.data.items;

  const byId = new Map<string, z.infer<typeof enrichmentItemSchema>>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return byId;
}

export async function enrichOffersWithOllama(
  offers: Offer[],
  options: boolean | EnrichmentOptions,
): Promise<EnrichmentResult> {
  const tryOllama =
    typeof options === 'boolean' ? options : options.tryOllama ?? true;
  const onProgress =
    typeof options === 'boolean' ? undefined : options.onProgress;

  const warnings: string[] = [];
  const enrichedOffers = offers.map((offer) => ({
    ...offer,
    brand: offer.brand || defaultBrand(offer),
    category: toSimpleOfferCategory(
      offer.category,
      `${offer.name} ${offer.brand ?? ''} ${(offer.tags ?? []).join(' ')}`,
    ),
    tags: inferHeuristicTags(offer),
  }));

  onProgress?.({
    total: enrichedOffers.length,
    processed: 0,
    batch: 0,
    totalBatches:
      enrichedOffers.length > 0 ? Math.ceil(enrichedOffers.length / 24) : 0,
    message: 'Kategorie-Enrichment vorbereitet.',
  });

  if (!tryOllama || enrichedOffers.length === 0) {
    onProgress?.({
      total: enrichedOffers.length,
      processed: enrichedOffers.length,
      batch: enrichedOffers.length > 0 ? 1 : 0,
      totalBatches: enrichedOffers.length > 0 ? 1 : 0,
      message:
        enrichedOffers.length > 0
          ? 'Kategorie-Enrichment ohne Ollama abgeschlossen.'
          : 'Keine Angebote fuer Kategorie-Enrichment.',
    });
    return { offers: enrichedOffers, warnings };
  }

  // Conservative, env-driven batch (default 6) keeps each Ollama call short
  // enough to fit the timeout on a 12 GB GPU. Previously a hard-coded 24.
  const batchSize = appConfig.ollamaBatchSize;
  const totalBatches = Math.max(1, Math.ceil(enrichedOffers.length / batchSize));
  const byId = new Map<string, z.infer<typeof enrichmentItemSchema>>();
  let transientFailures = 0;
  const transientWarningLimit = 3;
  // Fail-fast: abort the whole enrichment once Ollama fails this many times in a
  // row, instead of grinding through every remaining batch against a dead model.
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = appConfig.ollamaMaxConsecutiveFailures;
  let processed = 0;

  for (let cursor = 0; cursor < enrichedOffers.length; cursor += batchSize) {
    const batch = enrichedOffers.slice(cursor, cursor + batchSize);
    const batchNumber = Math.floor(cursor / batchSize) + 1;

    onProgress?.({
      total: enrichedOffers.length,
      processed,
      batch: batchNumber,
      totalBatches,
      message: `Kategorie-Enrichment Batch ${batchNumber}/${totalBatches}.`,
    });

    try {
      const batchResult = await enrichBatchWithOllama(batch);
      for (const [id, item] of batchResult.entries()) {
        byId.set(id, item);
      }
      consecutiveFailures = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unbekannter Fehler';

      if (isModelNotFoundError(message)) {
        break;
      }

      if (isOllamaUnavailableError(message)) {
        break;
      }

      transientFailures += 1;
      consecutiveFailures += 1;
      if (transientFailures <= transientWarningLimit) {
        warnings.push(
          `Ollama-Enrichment Batch ${Math.floor(cursor / batchSize) + 1} fehlgeschlagen: ${message}`,
        );
      } else if (transientFailures === transientWarningLimit + 1) {
        warnings.push('Weitere Ollama-Enrichment-Fehler werden unterdrueckt.');
      }
      // Fail-fast: a model that errors N times in a row will keep erroring —
      // stop the enrichment instead of timing out on every remaining batch.
      if (consecutiveFailures >= maxConsecutiveFailures) {
        warnings.push(
          `Kategorie-Enrichment abgebrochen: ${consecutiveFailures} Ollama-Fehler in Folge.`,
        );
        break;
      }
    }

    processed += batch.length;
    onProgress?.({
      total: enrichedOffers.length,
      processed,
      batch: batchNumber,
      totalBatches,
      message: `Kategorie-Enrichment Fortschritt ${processed}/${enrichedOffers.length}.`,
    });
  }

  const finalOffers = enrichedOffers.map((offer) => {
    const enrichment = byId.get(offer.id);
    if (!enrichment) {
      return offer;
    }

    const mergedTags = uniqueTags([
      ...offer.tags,
      ...(enrichment.tags ?? []),
    ]);

    return {
      ...offer,
      brand: enrichment.brand?.trim() || offer.brand,
      category: toSimpleOfferCategory(
        enrichment.category?.trim() || offer.category,
        `${offer.name} ${offer.brand ?? ''} ${mergedTags.join(' ')}`,
      ),
      tags: mergedTags,
    };
  });

  return {
    offers: finalOffers,
    warnings,
  };
}
