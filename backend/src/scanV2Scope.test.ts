import { describe, expect, it } from 'vitest';
import {
  allStoresScope,
  deriveScopeFromOffers,
  describeScope,
  isChainInScope,
  normalizeChainKey,
  normalizeScope,
  scopeFromStores,
} from './scanV2Scope';

// Angebots-Scan 2.0 — explizites Scope-Modell. Diese Tests sichern die
// Kern-Eigenschaften ab, von denen das scope-aware Gate + Resume abhängen.

describe('normalizeChainKey', () => {
  it('foldet Groß-/Kleinschreibung und Umlaute auf einen kanonischen Key', () => {
    expect(normalizeChainKey('REWE')).toBe('rewe');
    expect(normalizeChainKey('  rewe ')).toBe('rewe');
    expect(normalizeChainKey('ALDI SÜD')).toBe('aldi sued');
    expect(normalizeChainKey('Aldi  Süd')).toBe('aldi sued');
    expect(normalizeChainKey('aldi sued')).toBe('aldi sued');
  });
});

describe('Scope-Konstruktion', () => {
  it('all_stores ist explizit getypt und enthält jeden Shop', () => {
    const scope = allStoresScope();
    expect(scope.type).toBe('all_stores');
    expect(isChainInScope(scope, 'rewe')).toBe(true);
    expect(isChainInScope(scope, 'irgendwas')).toBe(true);
  });

  it('expliziter Scope bleibt explizit und normalisiert/dedupliziert seine Shops', () => {
    const scope = scopeFromStores(['REWE', 'rewe', ' Rewe ', 'Lidl']);
    expect(scope.type).toBe('stores');
    expect(scope.stores).toEqual(['rewe', 'lidl']);
    expect(isChainInScope(scope, 'REWE')).toBe(true);
    expect(isChainInScope(scope, 'nahkauf')).toBe(false);
  });

  it('ein leerer expliziter Scope bedeutet „kein Shop", NICHT „alle Shops"', () => {
    const scope = scopeFromStores([]);
    expect(scope.type).toBe('stores');
    expect(scope.stores).toEqual([]);
    expect(isChainInScope(scope, 'rewe')).toBe(false);
  });

  it('leitet den Scope aus den tatsächlich vorhandenen Angeboten ab', () => {
    const scope = deriveScopeFromOffers([
      { storeChain: 'REWE' },
      { storeChain: 'rewe' },
      { storeChain: '' },
      { storeChain: undefined },
    ]);
    expect(scope.stores).toEqual(['rewe']);
  });

  it('Case-/Alias-Normalisierung: rewe, REWE und kanonische Form ergeben denselben Scope', () => {
    const a = scopeFromStores(['rewe']);
    const b = scopeFromStores(['REWE']);
    const c = deriveScopeFromOffers([{ storeChain: 'Rewe' }]);
    expect(a.stores).toEqual(b.stores);
    expect(b.stores).toEqual(c.stores);
  });
});

describe('normalizeScope (defensive Deserialisierung)', () => {
  it('übernimmt einen expliziten Store-Scope verlustfrei', () => {
    expect(normalizeScope({ type: 'stores', stores: ['REWE', 'Lidl'] }).stores).toEqual([
      'rewe',
      'lidl',
    ]);
  });

  it('ein malformter Store-Scope wird ein LEERER Store-Scope, nicht all_stores', () => {
    const scope = normalizeScope({ type: 'stores', stores: 'kaputt' });
    expect(scope.type).toBe('stores');
    expect(scope.stores).toEqual([]);
  });

  it('unbekannte/leere Werte degradieren zu all_stores nur bei explizitem Typ', () => {
    expect(normalizeScope({ type: 'all_stores' }).type).toBe('all_stores');
    expect(normalizeScope(null).type).toBe('all_stores');
    expect(normalizeScope(undefined).type).toBe('all_stores');
  });
});

describe('describeScope', () => {
  it('liefert eine kompakte, lesbare Beschreibung', () => {
    expect(describeScope(allStoresScope())).toContain('all_stores');
    expect(describeScope(scopeFromStores(['REWE']))).toContain('rewe');
    expect(describeScope(scopeFromStores([]))).toContain('kein Shop');
  });
});
