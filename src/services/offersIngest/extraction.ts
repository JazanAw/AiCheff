import { z } from 'zod';
import { appConfig } from '../../config/env';
import { normalizeText } from '../../utils/offers';
import { ollamaChat } from '../ollama';
import { RawOfferCandidate, RawSourceDocument } from './types';

const ollamaOfferSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  storeId: z.string().optional(),
  storeAddress: z.string().optional(),
  storeCity: z.string().optional(),
  storeChain: z.string().optional(),
  category: z.string().optional(),
  price: z.union([z.string(), z.number()]).optional(),
  currency: z.string().optional(),
  unit: z.string().optional(),
  basePrice: z.union([z.string(), z.number()]).optional(),
  baseUnit: z.string().optional(),
  validityStart: z.string().optional(),
  validityEnd: z.string().optional(),
  imageUrl: z.string().optional(),
  sourceUrl: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  sourceScope: z.enum(['national', 'local']).optional(),
  distanceKm: z.number().optional(),
  tags: z.array(z.string()).optional(),
});

const ollamaEnvelopeSchema = z.union([
  z.array(ollamaOfferSchema),
  z.object({ offers: z.array(ollamaOfferSchema) }),
]);

function unwrapJsonFromText(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

export function chunkContent(content: string, chunkSize = appConfig.ingestChunkSize): string[] {
  if (content.length <= chunkSize) {
    return [content];
  }

  const lines = content.split('\n');
  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferLength = 0;

  for (const line of lines) {
    const lineLength = line.length + 1;
    const wouldExceed = bufferLength + lineLength > chunkSize;

    if (wouldExceed && buffer.length > 0) {
      chunks.push(buffer.join('\n'));
      buffer = [];
      bufferLength = 0;
    }

    if (lineLength > chunkSize) {
      chunks.push(line);
      continue;
    }

    buffer.push(line);
    bufferLength += lineLength;
  }

  if (buffer.length > 0) {
    chunks.push(buffer.join('\n'));
  }

  return chunks;
}

function parseHeuristicOffers(chunk: string, source: RawSourceDocument): RawOfferCandidate[] {
  const lines = chunk
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const result: RawOfferCandidate[] = [];

  for (const line of lines) {
    if (!line.startsWith('-') && !line.startsWith('*')) {
      continue;
    }

    const segments = line
      .replace(/^[-*]\s*/, '')
      .split('|')
      .map((entry) => entry.trim());

    if (segments.length < 4) {
      continue;
    }

    const [name, priceToken, categoryToken, validityToken, ...extraSegments] = segments;
    const priceMatch = priceToken.match(
      /(?<price>\d+(?:[.,]\d{1,2})?)\s*(?<currency>EUR|\u20AC)?(?:\/(?<unit>.+))?/i,
    );
    if (!priceMatch?.groups) {
      continue;
    }

    const validityParts = validityToken
      .split('-')
      .map((part) => part.trim())
      .filter(Boolean);
    const extra = extraSegments.join(' | ');

    const basePriceMatch = extra.match(
      /grundpreis\s*(?<basePrice>\d+(?:[.,]\d{1,2})?)\s*(?:EUR|\u20AC)?\/(?<baseUnit>[\w/]+)/i,
    );
    const tagsMatch = extra.match(/tags?\s*(?<tags>.+)$/i);

    result.push({
      name,
      storeId: source.storeId,
      storeAddress: source.storeAddress,
      storeCity: source.storeCity,
      storeChain: source.storeChain,
      category: categoryToken,
      price: priceMatch.groups.price,
      currency: priceMatch.groups.currency?.trim() || 'EUR',
      unit: priceMatch.groups.unit?.trim() || 'Stk',
      basePrice: basePriceMatch?.groups?.basePrice,
      baseUnit: basePriceMatch?.groups?.baseUnit,
      validityStart: validityParts[0],
      validityEnd: validityParts[1],
      sourceUrl: source.sourceUrl,
      region: source.region,
      postalCode: source.postalCode,
      latitude: source.latitude,
      longitude: source.longitude,
      sourceScope: source.sourceScope,
      distanceKm: source.distanceKm,
      tags: tagsMatch?.groups?.tags
        ?.split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    });
  }

  return result;
}

function parseOllamaOffers(rawResponse: string): RawOfferCandidate[] {
  const candidateJson = unwrapJsonFromText(rawResponse);
  const parsed = JSON.parse(candidateJson) as unknown;
  const validation = ollamaEnvelopeSchema.safeParse(parsed);
  if (!validation.success) {
    return [];
  }

  if (Array.isArray(validation.data)) {
    return validation.data;
  }
  return validation.data.offers;
}

function offerKey(offer: RawOfferCandidate): string {
  return [
    normalizeText(offer.name ?? ''),
    normalizeText(offer.storeChain ?? ''),
    offer.validityStart ?? '',
  ].join('|');
}

function mergeCandidates(
  heuristicOffers: RawOfferCandidate[],
  llmOffers: RawOfferCandidate[],
): RawOfferCandidate[] {
  const mergedByKey = new Map<string, RawOfferCandidate>();

  for (const heuristicOffer of heuristicOffers) {
    mergedByKey.set(offerKey(heuristicOffer), heuristicOffer);
  }

  for (const llmOffer of llmOffers) {
    const key = offerKey(llmOffer);
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, llmOffer);
      continue;
    }

    mergedByKey.set(key, {
          ...existing,
          ...llmOffer,
          name: llmOffer.name || existing.name,
          storeId: llmOffer.storeId || existing.storeId,
          storeAddress: llmOffer.storeAddress || existing.storeAddress,
          storeCity: llmOffer.storeCity || existing.storeCity,
          storeChain: llmOffer.storeChain || existing.storeChain,
          sourceUrl: llmOffer.sourceUrl || existing.sourceUrl,
          region: llmOffer.region || existing.region,
          postalCode: llmOffer.postalCode || existing.postalCode,
          latitude: llmOffer.latitude ?? existing.latitude,
          longitude: llmOffer.longitude ?? existing.longitude,
          sourceScope: llmOffer.sourceScope ?? existing.sourceScope,
          distanceKm: llmOffer.distanceKm ?? existing.distanceKm,
          tags:
            llmOffer.tags && llmOffer.tags.length > 0 ? llmOffer.tags : existing.tags,
        });
  }

  return [...mergedByKey.values()];
}

export async function extractOffersFromChunk(
  chunk: string,
  source: RawSourceDocument,
  tryOllama: boolean,
): Promise<RawOfferCandidate[]> {
  const heuristicOffers = parseHeuristicOffers(chunk, source);

  if (tryOllama) {
    try {
      const prompt = `
Extrahiere Lebensmittelangebote aus folgendem Text.
Antwortformat: valid JSON only.
Schema:
{
  "offers": [
    {
      "id": "optional string",
      "name": "string",
      "storeChain": "string",
      "category": "string",
      "price": "number|string",
      "currency": "EUR",
      "unit": "string",
      "basePrice": "optional number|string",
      "baseUnit": "optional string",
      "validityStart": "string date",
      "validityEnd": "string date",
      "imageUrl": "optional string",
      "sourceUrl": "optional string",
      "region": "optional string",
      "postalCode": "optional string",
      "latitude": "optional number",
      "longitude": "optional number",
      "tags": ["optional", "array", "of", "strings"]
    }
  ]
}

Text:
${chunk}
      `.trim();

      const llmResponse = await ollamaChat(
        [
          {
            role: 'system',
            content:
              'Du bist ein präziser Informationsextraktor. Gib ausschließlich valides JSON zurück.',
          },
          { role: 'user', content: prompt },
        ],
        { retries: 1, temperature: 0 },
      );

      const parsed = parseOllamaOffers(llmResponse);
      if (parsed.length > 0) {
        const llmOffers = parsed.map((offer) => ({
          ...offer,
          sourceUrl: offer.sourceUrl ?? source.sourceUrl,
          region: offer.region ?? source.region,
          postalCode: offer.postalCode ?? source.postalCode,
          latitude: offer.latitude ?? source.latitude,
          longitude: offer.longitude ?? source.longitude,
          storeId: offer.storeId ?? source.storeId,
          storeAddress: offer.storeAddress ?? source.storeAddress,
          storeCity: offer.storeCity ?? source.storeCity,
          sourceScope: offer.sourceScope ?? source.sourceScope,
          distanceKm: offer.distanceKm ?? source.distanceKm,
          storeChain: offer.storeChain ?? source.storeChain,
        }));

        return mergeCandidates(heuristicOffers, llmOffers);
      }
    } catch {
      // Fallback parser below.
    }
  }

  return heuristicOffers;
}
