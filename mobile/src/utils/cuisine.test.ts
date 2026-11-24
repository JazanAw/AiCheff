import { describe, expect, it } from 'vitest';

import {
  CUISINE_FALLBACK,
  CUISINE_FILTER_CANDIDATES,
  CUISINE_SLUGS,
  getCuisineLabel,
  getCuisineLabelFromRaw,
  normalizeCuisine,
} from './cuisine';

describe('normalizeCuisine', () => {
  it('maps the German seed values used in recipes_seed.v1.de.json to slugs', () => {
    expect(normalizeCuisine('deutsch')).toBe('german');
    expect(normalizeCuisine('italienisch')).toBe('italian');
    expect(normalizeCuisine('asiatisch')).toBe('asian');
    expect(normalizeCuisine('indisch')).toBe('indian');
    expect(normalizeCuisine('orientalisch')).toBe('oriental');
    expect(normalizeCuisine('mediterran')).toBe('mediterranean');
    expect(normalizeCuisine('französisch')).toBe('french');
    expect(normalizeCuisine('griechisch')).toBe('greek');
    expect(normalizeCuisine('international')).toBe('international');
  });

  it('accepts the canonical slug itself (idempotent)', () => {
    for (const slug of CUISINE_SLUGS) {
      expect(normalizeCuisine(slug)).toBe(slug);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeCuisine('  Italienisch ')).toBe('italian');
    expect(normalizeCuisine('TÜRKISCH')).toBe('turkish');
    expect(normalizeCuisine('Japanese')).toBe('japanese');
  });

  it('maps English country synonyms', () => {
    expect(normalizeCuisine('Italy')).toBe('italian');
    expect(normalizeCuisine('japan')).toBe('japanese');
    expect(normalizeCuisine('mexico')).toBe('mexican');
  });

  it('falls back to international for empty / null / unknown', () => {
    expect(normalizeCuisine(null)).toBe(CUISINE_FALLBACK);
    expect(normalizeCuisine(undefined)).toBe(CUISINE_FALLBACK);
    expect(normalizeCuisine('')).toBe(CUISINE_FALLBACK);
    expect(normalizeCuisine('   ')).toBe(CUISINE_FALLBACK);
    expect(normalizeCuisine('klingonisch')).toBe('international');
    expect(CUISINE_FALLBACK).toBe('international');
  });
});

describe('cuisine labels', () => {
  // Fake i18n: echoes the key so we can assert the right key is requested.
  const t = (key: string) => key;

  it('builds the i18n key per slug', () => {
    expect(getCuisineLabel('german', t)).toBe('cheffity.cuisine.german');
    expect(getCuisineLabel('japanese', t)).toBe('cheffity.cuisine.japanese');
  });

  it('normalizes raw values before resolving the label', () => {
    expect(getCuisineLabelFromRaw('deutsch', t)).toBe('cheffity.cuisine.german');
    expect(getCuisineLabelFromRaw('unbekannt', t)).toBe('cheffity.cuisine.international');
  });
});

describe('filter candidates', () => {
  it('only references real slugs', () => {
    for (const slug of CUISINE_FILTER_CANDIDATES) {
      expect(CUISINE_SLUGS).toContain(slug);
    }
  });
});
