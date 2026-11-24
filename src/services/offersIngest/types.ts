import { LocationFilter } from '../../types/models';
import type { SubSourceDiagnostic } from './subSourceDiagnostics';

export interface RawSourceDocument {
  connectorId: string;
  sourceUrl: string;
  sourceLabel: string;
  storeId?: string;
  storeAddress?: string;
  storeCity?: string;
  storeChain?: string;
  region?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  sourceScope?: 'national' | 'local';
  distanceKm?: number;
  contentType: 'text' | 'html' | 'pdf-text';
  content: string;
  fetchedAt: string;
}

export interface RawOfferCandidate {
  id?: string;
  name: string;
  brand?: string;
  storeId?: string;
  storeAddress?: string;
  storeCity?: string;
  storeChain?: string;
  category?: string;
  price?: string | number;
  originalPrice?: string | number;
  currency?: string;
  unit?: string;
  basePrice?: string | number;
  baseUnit?: string;
  validityStart?: string;
  validityEnd?: string;
  imageUrl?: string;
  sourceUrl?: string;
  region?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  sourceScope?: 'national' | 'local';
  distanceKm?: number;
  tags?: string[];
  // Roh-Quellsignale (Task 2): die ungekürzten Originalwerte aus der Quelle,
  // BEVOR `category` auf das einfache Set kollabiert wird. Sie helfen der
  // KI/Klassifikation (z. B. internationale Lebensmittel) und ersetzen NICHT
  // die bestehenden Mobile/Admin-Felder.
  sourceCategoryRaw?: string;
  sourceDepartmentRaw?: string;
  sourceTagsRaw?: string[];
  sourceContextRaw?: string;
  /** Stabile Subquellen-/Prospekt-Id (Task P5), aus der das Angebot stammt. */
  sourceId?: string;
}

/**
 * Per-Store-Fortschrittsereignis (Phase 1). Lässt einen Connector melden, welcher
 * Store gerade startet/endet/timeoutet, damit ein blockierender Store sofort im
 * Admin-Status sichtbar ist — statt eines eingefrorenen „Quellen werden
 * geladen...". Bewusst neutral & klein.
 */
export interface StoreFetchProgressEvent {
  /** Shop, der gerade gefetcht wird. */
  storeChain: string;
  /** Parser/Quelle des Shops (Diagnostik). */
  parser?: string;
  /** 1-basierte Position im aktuellen Scrape. */
  index: number;
  /** Gesamtzahl Shops im aktuellen Scrape. */
  total: number;
  /** Lebenszyklus-Phase des Store-Fetches. */
  phase: 'start' | 'success' | 'failure' | 'timeout';
  /** Dauer in ms (bei success/failure/timeout). */
  durationMs?: number;
  /** Anzahl Angebote (bei success). */
  offerCount?: number;
}

/**
 * Laufzeit-Kontext für Connectoren: Abbruchsignal + Per-Store-Fortschritt.
 * Optional & rückwärtskompatibel — bestehende Connectoren dürfen ihn ignorieren.
 */
export interface SourceConnectorRuntime {
  /** Abbruchsignal (Scan-Cancel/Pause). Bricht der Scan ab, stoppt der Connector
   *  nach dem aktuellen Store und behandelt ihn NICHT als Store-Timeout/Fehler. */
  signal?: AbortSignal;
  /** Per-Store-Fortschritt (start/success/failure/timeout). */
  onStoreProgress?: (event: StoreFetchProgressEvent) => void;
}

export interface SourceConnector {
  id: string;
  displayName: string;
  fetchRawContent(locationFilter: LocationFilter): Promise<RawSourceDocument[]>;
  getLastWarnings?(): string[];
  /** Strukturierte Subquellen-/Prospekt-Diagnosen des letzten Laufs (Task P5). */
  getLastSubSourceDiagnostics?(): SubSourceDiagnostic[];
  fetchRawOffers?(
    locationFilter: LocationFilter,
    tryOllama?: boolean,
    runtime?: SourceConnectorRuntime,
  ): Promise<RawOfferCandidate[]>;
}

export interface IngestPipelineOptions {
  locationFilter: LocationFilter;
  tryOllama: boolean;
  onProgress?: (message: string, total?: number, completed?: number) => void;
  /** Abbruchsignal, an die Connectoren durchgereicht (Scan-Cancel/Pause). */
  signal?: AbortSignal;
}

export interface IngestPipelineResult {
  offers: RawOfferCandidate[];
  warnings: string[];
  /** Strukturierte Subquellen-/Prospekt-Diagnosen aller Connectoren (Task P5). */
  subSourceDiagnostics: SubSourceDiagnostic[];
}
