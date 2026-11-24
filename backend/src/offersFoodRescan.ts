import { z } from 'zod';
import { appConfig } from '../../src/config/env';
import { ollamaChat } from '../../src/services/ollama';
import { Offer } from '../../src/types/models';
import {
  filterOffersStrictFood,
  isStrictFoodOffer,
  isStrictNonFoodOffer,
} from './offersStrictFoodFilter';

interface FoodDecision {
  id: string;
  isFood?: boolean;
  classification?: 'food' | 'non_food';
}

const foodDecisionSchema = z.object({
  id: z.string(),
  isFood: z.boolean().optional(),
  classification: z.enum(['food', 'non_food']).optional(),
});

const foodDecisionEnvelopeSchema = z.union([
  z.array(foodDecisionSchema),
  z.object({
    items: z.array(foodDecisionSchema),
  }),
]);

export interface AiFoodRescanResult {
  offers: Offer[];
  filteredOffers: Offer[];
  warnings: string[];
  scannedCount: number;
  aiClassifiedCount: number;
  fallbackCount: number;
}

export interface AiFoodRescanProgress {
  total: number;
  processed: number;
  batch: number;
  totalBatches: number;
  message: string;
}

export interface AiFoodRescanOptions {
  tryOllama?: boolean;
  onProgress?: (progress: AiFoodRescanProgress) => void;
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
    /connectex/i.test(message) ||
    /timeout/i.test(message)
  );
}

function normalizeDecision(item: FoodDecision): boolean | null {
  if (typeof item.isFood === 'boolean') {
    return item.isFood;
  }

  if (item.classification === 'food') {
    return true;
  }

  if (item.classification === 'non_food') {
    return false;
  }

  return null;
}

async function classifyBatchWithOllama(batch: Offer[]): Promise<Map<string, boolean>> {
  const compact = batch.map((offer) => ({
    id: offer.id,
    name: offer.name,
    brand: offer.brand ?? '',
    category: offer.category,
    unit: offer.unit,
    tags: offer.tags,
    storeChain: offer.storeChain,
  }));

  const prompt = `
Du klassifizierst Supermarkt-Angebote.
Gib fuer jedes Angebot zurueck, ob es ein Lebensmittel fuer Menschen ist.
Haustierfutter, Motoroel, Kosmetik, Haushaltsartikel, Technik und Werkzeug sind KEINE Lebensmittel.
Bei Unsicherheit entscheide konservativ: isFood=false.

Antwort nur als valides JSON.
Schema:
{
  "items": [
    {
      "id": "string",
      "isFood": true
    }
  ]
}

Eingabe:
${JSON.stringify(compact)}
  `.trim();

  const responseText = await ollamaChat(
    [
      {
        role: 'system',
        content:
          'Du bist ein praeziser Lebensmittel-Klassifikator. Gib nur valides JSON zurueck.',
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
  const validation = foodDecisionEnvelopeSchema.safeParse(parsed);
  if (!validation.success) {
    return new Map();
  }

  const items = Array.isArray(validation.data)
    ? validation.data
    : validation.data.items;

  const byId = new Map<string, boolean>();
  for (const item of items) {
    const normalized = normalizeDecision(item);
    if (normalized === null) {
      continue;
    }
    byId.set(item.id, normalized);
  }

  return byId;
}

export async function rescanOffersWithAiFoodClassifier(
  offers: Offer[],
  options: boolean | AiFoodRescanOptions = true,
): Promise<AiFoodRescanResult> {
  const tryOllama =
    typeof options === 'boolean'
      ? options
      : options.tryOllama ?? true;
  const onProgress =
    typeof options === 'boolean'
      ? undefined
      : options.onProgress;

  if (offers.length === 0) {
    onProgress?.({
      total: 0,
      processed: 0,
      batch: 0,
      totalBatches: 0,
      message: 'Keine Angebote zum Scannen.',
    });
    return {
      offers: [],
      filteredOffers: [],
      warnings: [],
      scannedCount: 0,
      aiClassifiedCount: 0,
      fallbackCount: 0,
    };
  }

  if (!tryOllama) {
    const strict = filterOffersStrictFood(offers);
    onProgress?.({
      total: offers.length,
      processed: 0,
      batch: 0,
      totalBatches: 1,
      message: 'Regelbasierter Lebensmittel-Scan gestartet.',
    });
    onProgress?.({
      total: offers.length,
      processed: offers.length,
      batch: 1,
      totalBatches: 1,
      message: 'Regelbasierter Lebensmittel-Scan abgeschlossen.',
    });
    return {
      offers: strict.offers,
      filteredOffers: strict.removedOffers,
      warnings: ['KI-Rescan ohne Ollama: regelbasierte Klassifizierung verwendet.'],
      scannedCount: offers.length,
      aiClassifiedCount: 0,
      fallbackCount: offers.length,
    };
  }

  const warnings: string[] = [];
  const kept: Offer[] = [];
  const removed: Offer[] = [];
  const aiCandidates: Offer[] = [];
  // Conservative, env-driven batch (default 6) instead of a hard-coded 24, so
  // each Ollama call stays inside the timeout on a 12 GB GPU.
  const batchSize = appConfig.ollamaBatchSize;
  let strictKeptCount = 0;
  let hardNonFoodVetoCount = 0;
  // Fail-fast guard: abort after this many consecutive Ollama batch failures.
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = appConfig.ollamaMaxConsecutiveFailures;

  for (const offer of offers) {
    if (isStrictFoodOffer(offer)) {
      kept.push(offer);
      strictKeptCount += 1;
      continue;
    }
    aiCandidates.push(offer);
  }

  let processedCount = strictKeptCount;
  const totalBatches = Math.max(1, Math.ceil(aiCandidates.length / batchSize));
  let aiClassifiedCount = 0;
  let fallbackCount = 0;

  onProgress?.({
    total: offers.length,
    processed: processedCount,
    batch: 0,
    totalBatches,
    message: `Regel-Filter vorab: ${processedCount}/${offers.length} als Lebensmittel erkannt.`,
  });

  if (aiCandidates.length === 0) {
    onProgress?.({
      total: offers.length,
      processed: offers.length,
      batch: 0,
      totalBatches: 0,
      message: 'Alle Angebote wurden durch Regel-Filter als Lebensmittel erkannt.',
    });
    return {
      offers: kept,
      filteredOffers: removed,
      warnings,
      scannedCount: offers.length,
      aiClassifiedCount: 0,
      fallbackCount: 0,
    };
  }

  for (let cursor = 0; cursor < aiCandidates.length; cursor += batchSize) {
    const batch = aiCandidates.slice(cursor, cursor + batchSize);
    const batchNumber = Math.floor(cursor / batchSize) + 1;
    let batchDecisions = new Map<string, boolean>();

    onProgress?.({
      total: offers.length,
      processed: processedCount,
      batch: batchNumber,
      totalBatches,
      message: `KI klassifiziert Batch ${batchNumber}/${totalBatches}.`,
    });

    try {
      batchDecisions = await classifyBatchWithOllama(batch);
      aiClassifiedCount += batchDecisions.size;
      consecutiveFailures = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unbekannter Fehler';

      if (isModelNotFoundError(message)) {
        throw new Error(
          `KI-Rescan gestoppt: Modell nicht gefunden. Installiere das konfigurierte Modell oder passe VITE_OLLAMA_MODEL an. (${message})`,
        );
      }

      if (isOllamaUnavailableError(message)) {
        throw new Error(
          `KI-Rescan gestoppt: Ollama ist nicht erreichbar. Starte Ollama und versuche es erneut. (${message})`,
        );
      }

      consecutiveFailures += 1;
      // Fail-fast: repeated 500s/transport errors mean Ollama is effectively
      // dead — stop instead of falling back through thousands of offers.
      if (consecutiveFailures >= maxConsecutiveFailures) {
        throw new Error(
          `KI-Rescan abgebrochen: ${consecutiveFailures} Ollama-Fehler in Folge (zuletzt: ${message}).`,
        );
      }

      warnings.push(
        `KI-Rescan Batch ${batchNumber} fehlgeschlagen, Fallback aktiv: ${message}`,
      );
    }

    for (const offer of batch) {
      const decision = batchDecisions.get(offer.id);
      if (typeof decision === 'boolean') {
        if (decision) {
          if (isStrictNonFoodOffer(offer)) {
            removed.push(offer);
            hardNonFoodVetoCount += 1;
          } else {
            kept.push(offer);
          }
        } else {
          removed.push(offer);
        }
        continue;
      }

      fallbackCount += 1;
      removed.push(offer);
    }

    processedCount += batch.length;
    onProgress?.({
      total: offers.length,
      processed: processedCount,
      batch: batchNumber,
      totalBatches,
      message: `KI-Rescan Fortschritt ${processedCount}/${offers.length}.`,
    });
  }

  if (fallbackCount > 0) {
    warnings.push(
      `${fallbackCount} Angebote wurden ohne KI-Entscheidung mit Regel-Filter einsortiert.`,
    );
  }
  if (hardNonFoodVetoCount > 0) {
    warnings.push(
      `${hardNonFoodVetoCount} KI-Treffer wurden durch den harten Nicht-Lebensmittel-Filter geblockt.`,
    );
  }

  return {
    offers: kept,
    filteredOffers: removed,
    warnings,
    scannedCount: offers.length,
    aiClassifiedCount,
    fallbackCount,
  };
}
