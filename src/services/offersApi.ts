import { appConfig } from '../config/env';
import { LocationFilter, Offer } from '../types/models';

interface OffersApiResponse {
  offers: Offer[];
  updatedAt: string | null;
  warnings: string[];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveBackendBaseUrl(): string {
  const configured = trimTrailingSlash(appConfig.backendBaseUrl);

  if (typeof window === 'undefined') {
    return configured;
  }

  try {
    const url = new URL(configured);
    const isLocalHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const pageHost = window.location.hostname;
    const pageIsLocalHost = pageHost === 'localhost' || pageHost === '127.0.0.1';

    if (isLocalHost && pageHost && !pageIsLocalHost) {
      const backendPort = url.port || '8787';
      return `${url.protocol}//${pageHost}:${backendPort}`;
    }

    return configured;
  } catch {
    return configured;
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 25000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseOffersResponse(payload: unknown): OffersApiResponse {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { offers?: unknown }).offers)
  ) {
    throw new Error('Backend-Antwort hat kein gueltiges Angebotsformat.');
  }

  const typed = payload as OffersApiResponse;
  return {
    offers: typed.offers,
    updatedAt: typed.updatedAt ?? null,
    warnings: Array.isArray(typed.warnings) ? typed.warnings : [],
  };
}

function backendUrl(path: string): string {
  const baseUrl = resolveBackendBaseUrl();
  return `${baseUrl}${path}`;
}

export async function fetchOffersFromBackend(): Promise<OffersApiResponse> {
  const response = await fetchWithTimeout(backendUrl('/api/offers'));
  if (!response.ok) {
    throw new Error(`Backend-Fehler (${response.status}) beim Laden der Angebote.`);
  }

  const payload = (await response.json()) as unknown;
  return parseOffersResponse(payload);
}

export async function refreshOffersFromBackend(
  locationFilter: LocationFilter,
  tryOllama = true,
): Promise<OffersApiResponse> {
  const response = await fetchWithTimeout(backendUrl('/api/offers/refresh'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locationFilter,
      tryOllama,
    }),
  });

  if (!response.ok) {
    let message = `Backend-Fehler (${response.status}) beim Aktualisieren.`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // Keep fallback message.
    }
    throw new Error(message);
  }

  const payload = (await response.json()) as unknown;
  return parseOffersResponse(payload);
}
