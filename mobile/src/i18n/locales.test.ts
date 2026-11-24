import { describe, expect, it } from 'vitest';

import de from './locales/de';
import en from './locales/en';
import es from './locales/es';
import itLocale from './locales/it';
import pl from './locales/pl';
import tr from './locales/tr';

// de is the source of truth (also fallbackLng in i18n/index.ts). Every other
// locale must expose exactly the same set of leaf key paths — no missing keys
// (would silently fall back to German) and no extra/orphan keys.
function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return flattenKeys(value, path);
  });
}

const deKeys = flattenKeys(de).sort();

const locales: Record<string, unknown> = { en, es, it: itLocale, pl, tr };

describe('i18n locale key parity', () => {
  for (const [name, locale] of Object.entries(locales)) {
    const localeKeys = flattenKeys(locale).sort();

    it(`${name} has no missing keys vs de`, () => {
      const missing = deKeys.filter((k) => !localeKeys.includes(k));
      expect(missing).toEqual([]);
    });

    it(`${name} has no extra keys vs de`, () => {
      const extra = localeKeys.filter((k) => !deKeys.includes(k));
      expect(extra).toEqual([]);
    });
  }
});
