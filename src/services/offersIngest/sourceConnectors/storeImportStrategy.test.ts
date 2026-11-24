import { describe, expect, it } from 'vitest';
import {
  resolveStoreImportStrategy,
  STORE_IMPORT_STRATEGIES,
  type ImportStrategy,
} from './storeImportStrategy';

describe('resolveStoreImportStrategy', () => {
  it('treats REWE as browser_required with a pdf_fallback (never fetch-only)', () => {
    const rewe = resolveStoreImportStrategy('REWE');
    expect(rewe.strategy).toBe<ImportStrategy>('browser_required');
    expect(rewe.fallbackStrategies).toContain('pdf_fallback');
    expect(rewe.automated).toBe(false);
  });

  it('treats nahkauf as an automated Storyblok api_endpoint with a pdf_fallback', () => {
    const nahkauf = resolveStoreImportStrategy('nahkauf');
    expect(nahkauf.strategy).toBe<ImportStrategy>('api_endpoint');
    expect(nahkauf.fallbackStrategies).toContain('pdf_fallback');
    expect(nahkauf.automated).toBe(true);
  });

  it('maps the SSR/embedded-json stores correctly', () => {
    expect(resolveStoreImportStrategy('Kaufland').strategy).toBe('embedded_json');
    expect(resolveStoreImportStrategy('ALDI NORD').strategy).toBe('embedded_json');
  });

  it('maps the api-endpoint stores correctly', () => {
    expect(resolveStoreImportStrategy('PENNY').strategy).toBe('api_endpoint');
    expect(resolveStoreImportStrategy('HIT').strategy).toBe('api_endpoint');
  });

  it('maps the direct-html stores correctly', () => {
    expect(resolveStoreImportStrategy('ALDI SUED').strategy).toBe('direct_html');
    expect(resolveStoreImportStrategy('NORMA').strategy).toBe('direct_html');
    expect(resolveStoreImportStrategy('Netto').strategy).toBe('direct_html');
    // EDEKA: serverseitig gerendertes HTML (Template "edeka_neu"), kein
    // __NEXT_DATA__ mehr.
    expect(resolveStoreImportStrategy('EDEKA').strategy).toBe('direct_html');
  });

  it('resolves case-insensitively and trims whitespace', () => {
    expect(resolveStoreImportStrategy('  rewe  ').strategy).toBe('browser_required');
    expect(resolveStoreImportStrategy('ReWe').strategy).toBe('browser_required');
  });

  it('defaults an unknown store to blocked_or_unverified (never claims a working path)', () => {
    const unknown = resolveStoreImportStrategy('Unbekannter Markt 123');
    expect(unknown.strategy).toBe<ImportStrategy>('blocked_or_unverified');
    expect(unknown.automated).toBe(false);
  });

  it('exposes a normalized-keyed table for direct lookups', () => {
    expect(STORE_IMPORT_STRATEGIES.rewe.strategy).toBe('browser_required');
    expect(STORE_IMPORT_STRATEGIES.kaufland.strategy).toBe('embedded_json');
  });
});
