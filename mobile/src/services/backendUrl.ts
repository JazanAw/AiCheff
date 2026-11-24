// RN-free backend URL helpers, kept in their own module so they are unit-testable
// in the node test env without pulling the react-native / expo-constants runtime
// that the rest of offersApi.ts imports.

export function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Resolve a backend asset URL (imageUrl / sourceUrl) against the backend base.
 *
 * Manual REWE PDF/Screenshot imports and both scan versions (1.0 + 2.0) can emit
 * RELATIVE paths like "/rewe-pdf-images/rewe/latest/x.png" — the backend serves
 * those under "<backendBase>/rewe-pdf-images/…". Mobile must turn them into
 * absolute URLs or the <Image> never loads. Absolute http/https (and protocol-
 * relative / data / blob) URLs pass through untouched; empty/blank/null values
 * degrade to undefined so the UI shows its placeholder instead of a broken tile.
 */
export function resolveBackendAssetUrl(
  raw: string | undefined | null,
  baseUrl: string,
): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return undefined;
  }
  // Already absolute (http/https or protocol-relative) or an inline data/blob
  // URI → never rewrite.
  if (/^(?:https?:)?\/\//i.test(value) || /^(?:data|blob):/i.test(value)) {
    return value;
  }
  const base = trimTrailingSlash(baseUrl);
  if (!base) {
    return value;
  }
  const suffix = value.startsWith('/') ? value : `/${value}`;
  return `${base}${suffix}`;
}
