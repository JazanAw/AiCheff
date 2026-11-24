import { describe, expect, it } from 'vitest';
import {
  evaluateAllStoresGuard,
  isZeroAiClassificationFailure,
} from './aiScanGuards';

describe('evaluateAllStoresGuard', () => {
  it('allows a scoped run (store chains selected) regardless of size', () => {
    const r = evaluateAllStoresGuard({
      storeChainsCount: 1,
      sourceOfferCount: 5000,
      forceAll: false,
      maxOffers: 500,
    });
    expect(r.ok).toBe(true);
  });

  it('allows a store-less run under the ceiling', () => {
    const r = evaluateAllStoresGuard({
      storeChainsCount: 0,
      sourceOfferCount: 400,
      forceAll: false,
      maxOffers: 500,
    });
    expect(r.ok).toBe(true);
  });

  it('blocks a store-less run above the ceiling without forceAll (409)', () => {
    const r = evaluateAllStoresGuard({
      storeChainsCount: 0,
      sourceOfferCount: 2236,
      forceAll: false,
      maxOffers: 500,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.requiresForceAll).toBe(true);
      expect(r.error).toMatch(/forceAll/);
      expect(r.error).toMatch(/2236/);
    }
  });

  it('allows a large store-less run when forceAll is set', () => {
    const r = evaluateAllStoresGuard({
      storeChainsCount: 0,
      sourceOfferCount: 2236,
      forceAll: true,
      maxOffers: 500,
    });
    expect(r.ok).toBe(true);
  });

  it('treats exactly the ceiling as allowed (boundary)', () => {
    expect(
      evaluateAllStoresGuard({
        storeChainsCount: 0,
        sourceOfferCount: 500,
        forceAll: false,
        maxOffers: 500,
      }).ok,
    ).toBe(true);
  });
});

describe('isZeroAiClassificationFailure', () => {
  it('is a failure when KI is on, offers were scanned, but 0 were KI-classified', () => {
    expect(
      isZeroAiClassificationFailure({ tryOllama: true, scannedCount: 1200, aiClassifiedCount: 0 }),
    ).toBe(true);
  });

  it('is NOT a failure when KI produced at least one classification', () => {
    expect(
      isZeroAiClassificationFailure({ tryOllama: true, scannedCount: 1200, aiClassifiedCount: 5 }),
    ).toBe(false);
  });

  it('is NOT a failure for a rule-based run (tryOllama=false)', () => {
    expect(
      isZeroAiClassificationFailure({ tryOllama: false, scannedCount: 1200, aiClassifiedCount: 0 }),
    ).toBe(false);
  });

  it('is NOT a failure when nothing was scanned (empty snapshot)', () => {
    expect(
      isZeroAiClassificationFailure({ tryOllama: true, scannedCount: 0, aiClassifiedCount: 0 }),
    ).toBe(false);
  });
});
