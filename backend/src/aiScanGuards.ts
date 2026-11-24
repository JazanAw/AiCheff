// Pure, testable guards for the KI offer scan. Kept out of server.ts so they
// can be unit-tested without booting Express / the snapshot.

export interface AllStoresGuardInput {
  /** Number of store chains the request scoped to (0 = whole snapshot). */
  storeChainsCount: number;
  /** How many offers the run would actually process. */
  sourceOfferCount: number;
  /** Explicit caller override to run the whole snapshot anyway. */
  forceAll: boolean;
  /** Ceiling above which a store-less run must be confirmed. */
  maxOffers: number;
}

export type AllStoresGuardResult =
  | { ok: true }
  | { ok: false; status: number; error: string; requiresForceAll: true };

/**
 * Protects against the "Alles neu + KI" foot-gun: a store-less run over the
 * whole snapshot (2000+ offers) with a local 14B model is far too large for one
 * click and was the run that ground for hours. When no store scope is given and
 * the offer count exceeds `maxOffers`, the caller must either pick stores or
 * pass `forceAll=true`. A scoped run (storeChainsCount > 0) is always allowed.
 */
export function evaluateAllStoresGuard(
  input: AllStoresGuardInput,
): AllStoresGuardResult {
  const { storeChainsCount, sourceOfferCount, forceAll, maxOffers } = input;
  if (storeChainsCount > 0) return { ok: true };
  if (forceAll) return { ok: true };
  if (sourceOfferCount <= maxOffers) return { ok: true };
  return {
    ok: false,
    status: 409,
    requiresForceAll: true,
    error:
      `Zu viele Angebote für einen KI-Lauf über alle Stores ` +
      `(${sourceOfferCount} > ${maxOffers}). Bitte einen oder mehrere Stores ` +
      `auswählen — oder den Lauf bewusst mit forceAll=true bestätigen.`,
  };
}

export interface ZeroAiInput {
  tryOllama: boolean;
  scannedCount: number;
  aiClassifiedCount: number;
}

/**
 * Data-integrity guard: a KI run with `tryOllama=true` that scanned offers but
 * produced ZERO KI classifications is treated as a failure, never a success —
 * it means Ollama did nothing and the result is a pure rule-based fallback that
 * must not silently overwrite a good snapshot.
 */
export function isZeroAiClassificationFailure(input: ZeroAiInput): boolean {
  return (
    input.tryOllama === true &&
    input.scannedCount > 0 &&
    input.aiClassifiedCount === 0
  );
}
