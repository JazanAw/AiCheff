import { appConfig } from '../../config/env';
import { Offer } from '../../types/models';
import { chunkContent, extractOffersFromChunk } from './extraction';
import { normalizeOffers } from './normalize';
import { FixtureSourceConnector } from './sourceConnectors/fixtureConnector';
import { OfficialSupermarketSourceConnector } from './sourceConnectors/officialSupermarketConnector';
import {
  IngestPipelineOptions,
  IngestPipelineResult,
  RawOfferCandidate,
  RawSourceDocument,
  SourceConnector,
  SourceConnectorRuntime,
  StoreFetchProgressEvent,
} from './types';
import type { SubSourceDiagnostic } from './subSourceDiagnostics';

interface PreparedChunk {
  id: string;
  source: RawSourceDocument;
  content: string;
}

function buildDefaultConnectors(): SourceConnector[] {
  if (appConfig.useFixtureOffers) {
    return [new FixtureSourceConnector()];
  }
  return [new OfficialSupermarketSourceConnector()];
}

export async function runOffersIngestPipeline(
  options: IngestPipelineOptions,
  connectors: SourceConnector[] = buildDefaultConnectors(),
): Promise<{ offers: Offer[]; warnings: string[]; subSourceDiagnostics: SubSourceDiagnostic[] }> {
  const warnings: string[] = [];
  const report = (message: string, total?: number, completed?: number): void => {
    options.onProgress?.(message, total, completed);
  };

  // Per-Store-Fortschritt → menschenlesbare Statusmeldung. So zeigt der Admin
  // „Lidl 6/11 wird geladen..." statt des eingefrorenen „Quellen werden geladen...",
  // wenn ein einzelner Shop hängt/lange braucht.
  const formatStoreProgress = (event: StoreFetchProgressEvent): string => {
    const position = `${event.index}/${event.total}`;
    switch (event.phase) {
      case 'success':
        return `${event.storeChain} ${position} geladen (${event.offerCount ?? 0}).`;
      case 'timeout':
        return `${event.storeChain} ${position}: Zeitüberschreitung – weiter mit nächstem Shop...`;
      case 'failure':
        return `${event.storeChain} ${position}: Fehler – weiter mit nächstem Shop...`;
      case 'start':
      default:
        return `${event.storeChain} ${position} wird geladen...`;
    }
  };
  const runtime: SourceConnectorRuntime = {
    signal: options.signal,
    onStoreProgress: (event) => report(formatStoreProgress(event)),
  };

  report('Quellen werden geladen...');
  const connectorResults = await Promise.all(
    connectors.map(async (connector) => {
      let rawDocuments: RawSourceDocument[] = [];
      let directOffers: RawOfferCandidate[] = [];

      try {
        rawDocuments = await connector.fetchRawContent(options.locationFilter);
      } catch (error) {
        warnings.push(
          `${connector.displayName} (fetchRawContent): ${
            error instanceof Error ? error.message : 'Unbekannter Fehler'
          }`,
        );
      }

      if (connector.fetchRawOffers) {
        try {
          directOffers = await connector.fetchRawOffers(
            options.locationFilter,
            options.tryOllama,
            runtime,
          );
        } catch (error) {
          warnings.push(
            `${connector.displayName} (fetchRawOffers): ${
              error instanceof Error ? error.message : 'Unbekannter Fehler'
            }`,
          );
        }
      }

      const connectorWarnings = connector.getLastWarnings?.() ?? [];
      for (const warning of connectorWarnings) {
        warnings.push(`${connector.displayName}: ${warning}`);
      }

      const connectorDiagnostics = connector.getLastSubSourceDiagnostics?.() ?? [];

      return {
        rawDocuments,
        directOffers,
        connectorDiagnostics,
      };
    }),
  );
  const subSourceDiagnostics: SubSourceDiagnostic[] = connectorResults.flatMap(
    (entry) => entry.connectorDiagnostics,
  );

  const rawDocuments = connectorResults.flatMap((entry) => entry.rawDocuments);
  const extractedCandidates: RawOfferCandidate[] = connectorResults.flatMap(
    (entry) => entry.directOffers,
  );

  if (extractedCandidates.length > 0) {
    report(
      `Direkte Angebotsquellen geladen (${extractedCandidates.length}).`,
      extractedCandidates.length,
      extractedCandidates.length,
    );
  }

  report('Dokumente werden gechunkt...');
  const preparedChunks: PreparedChunk[] = rawDocuments.flatMap((document, documentIndex) =>
    chunkContent(document.content).map((content, chunkIndex) => ({
      id: `${document.connectorId}_${documentIndex}_${chunkIndex}`,
      source: document,
      content,
    })),
  );

  const totalChunks = preparedChunks.length;

  for (let index = 0; index < preparedChunks.length; index += 1) {
    const chunk = preparedChunks[index];
    report(
      `Angebote extrahieren (${index + 1}/${totalChunks})...`,
      totalChunks,
      index + 1,
    );

    try {
      const chunkOffers = await extractOffersFromChunk(
        chunk.content,
        chunk.source,
        options.tryOllama,
      );
      extractedCandidates.push(...chunkOffers);
    } catch (error) {
      warnings.push(
        `Chunk ${chunk.id}: ${
          error instanceof Error ? error.message : 'Unbekannter Fehler'
        }`,
      );
    }
  }

  report('Angebote normalisieren...');
  const normalizedOffers = normalizeOffers(extractedCandidates);
  report('Angebote gespeichert.', normalizedOffers.length, normalizedOffers.length);

  return {
    offers: normalizedOffers,
    warnings,
    subSourceDiagnostics,
  };
}

export type { IngestPipelineResult };
