import { describe, expect, it } from 'vitest';
// Import the RN-free helper module directly (offersApi.ts itself pulls the
// react-native runtime, which the node test env can't transform).
import { resolveBackendAssetUrl } from './backendUrl';

describe('resolveBackendAssetUrl', () => {
  const base = 'http://localhost:8787';

  it('resolves a root-relative REWE image path against the backend base', () => {
    expect(resolveBackendAssetUrl('/rewe-pdf-images/rewe/latest/rewe_browser_x.png', base)).toBe(
      'http://localhost:8787/rewe-pdf-images/rewe/latest/rewe_browser_x.png',
    );
  });

  it('resolves a bare relative path (no leading slash)', () => {
    expect(resolveBackendAssetUrl('rewe-pdf-images/x.png', base)).toBe(
      'http://localhost:8787/rewe-pdf-images/x.png',
    );
  });

  it('leaves absolute http/https URLs untouched', () => {
    expect(resolveBackendAssetUrl('https://cdn.example/p.png', base)).toBe('https://cdn.example/p.png');
    expect(resolveBackendAssetUrl('http://img.rewe.de/p.png', base)).toBe('http://img.rewe.de/p.png');
  });

  it('leaves protocol-relative and data URIs untouched', () => {
    expect(resolveBackendAssetUrl('//cdn.example/p.png', base)).toBe('//cdn.example/p.png');
    expect(resolveBackendAssetUrl('data:image/png;base64,AAAA', base)).toBe('data:image/png;base64,AAAA');
  });

  it('returns undefined for empty / blank / null / undefined', () => {
    expect(resolveBackendAssetUrl('', base)).toBeUndefined();
    expect(resolveBackendAssetUrl('   ', base)).toBeUndefined();
    expect(resolveBackendAssetUrl(undefined, base)).toBeUndefined();
    expect(resolveBackendAssetUrl(null, base)).toBeUndefined();
  });

  it('trims a trailing slash on the base and whitespace on the value', () => {
    expect(resolveBackendAssetUrl('  /rewe-pdf-images/a.png  ', 'http://localhost:8787/')).toBe(
      'http://localhost:8787/rewe-pdf-images/a.png',
    );
  });

  it('works against a LAN backend base (Expo host rewrite case)', () => {
    expect(resolveBackendAssetUrl('/rewe-pdf-images/a.png', 'http://192.168.1.20:8787')).toBe(
      'http://192.168.1.20:8787/rewe-pdf-images/a.png',
    );
  });
});
