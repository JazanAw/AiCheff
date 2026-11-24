import { describe, it, expect } from 'vitest';

import {
  detectPdfRenderers,
  renderPdfToPageImages,
  buildPdftoppmArgs,
  buildPdftocairoArgs,
  buildMutoolArgs,
  buildGhostscriptArgs,
  readPngSize,
  comparePageFileNames,
  pdfDataUrlToBytes,
  type PdfRendererProbes,
  type DetectPdfRenderersResult,
  type RenderPdfDeps,
} from './pdfPageRenderer';

// Ein minimaler, gültiger PNG-Header (Signatur + IHDR mit Breite/Höhe).
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR-Länge
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const VALID_PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0xLjQK';

describe('detectPdfRenderers', () => {
  it('kein Renderer verfügbar → chosen null (renderer_unavailable)', async () => {
    const probes: PdfRendererProbes = {
      probeCommand: async () => null,
      probeCanvas: async () => ({ available: false, detail: 'deaktiviert' }),
    };
    const result = await detectPdfRenderers(probes);
    expect(result.chosen).toBeNull();
    expect(result.available).toHaveLength(0);
    expect(result.diagnostic).toMatch(/[Kk]ein PDF-Renderer/);
  });

  it('poppler vorhanden → wird als bester Renderer gewählt', async () => {
    const probes: PdfRendererProbes = {
      probeCommand: async (candidates) =>
        candidates.includes('pdftoppm') ? { command: 'pdftoppm', detail: 'pdftoppm 24.x' } : null,
      probeCanvas: async () => ({ available: true }),
    };
    const result = await detectPdfRenderers(probes);
    expect(result.chosen?.id).toBe('poppler_pdftoppm');
    expect(result.diagnostic).toMatch(/poppler_pdftoppm/);
  });

  it('nur pdfjs+canvas verfügbar → es ist der LETZTE Fallback (nicht bevorzugt)', async () => {
    const probes: PdfRendererProbes = {
      probeCommand: async () => null,
      probeCanvas: async () => ({ available: true, detail: 'pdfjs+canvas' }),
    };
    const result = await detectPdfRenderers(probes);
    expect(result.chosen?.id).toBe('pdfjs_canvas');
    expect(result.available.map((r) => r.id)).toEqual(['pdfjs_canvas']);
  });
});

describe('Arg-Builder (pure)', () => {
  const base = { inputPdfPath: '/in.pdf', outputPrefix: '/out/page', dpi: 150, firstPage: 1, lastPage: 8 };
  it('pdftoppm: -png -r DPI -f -l input prefix', () => {
    expect(buildPdftoppmArgs(base)).toEqual(['-png', '-r', '150', '-f', '1', '-l', '8', '/in.pdf', '/out/page']);
  });
  it('pdftocairo: -png …', () => {
    expect(buildPdftocairoArgs(base)[0]).toBe('-png');
  });
  it('mutool: draw -o prefix-%d.png', () => {
    expect(buildMutoolArgs(base)).toContain('-o');
    expect(buildMutoolArgs(base)).toContain('/out/page-%d.png');
    expect(buildMutoolArgs(base)).toContain('1-8');
  });
  it('ghostscript: png16m + First/LastPage', () => {
    const args = buildGhostscriptArgs(base);
    expect(args).toContain('-sDEVICE=png16m');
    expect(args).toContain('-dFirstPage=1');
    expect(args).toContain('-dLastPage=8');
    expect(args).toContain('-sOutputFile=/out/page-%d.png');
  });
});

describe('readPngSize / comparePageFileNames (pure)', () => {
  it('liest Breite/Höhe aus dem IHDR', () => {
    expect(readPngSize(pngHeader(1240, 1754))).toEqual({ width: 1240, height: 1754 });
  });
  it('Nicht-PNG → null', () => {
    expect(readPngSize(Buffer.from('not a png at all here padding'))).toBeNull();
  });
  it('sortiert Seiten numerisch (page-2 vor page-10)', () => {
    expect(['page-10.png', 'page-2.png', 'page-1.png'].sort(comparePageFileNames)).toEqual([
      'page-1.png', 'page-2.png', 'page-10.png',
    ]);
  });
});

describe('pdfDataUrlToBytes', () => {
  it('akzeptiert nur application/pdf-DataURLs', () => {
    expect(() => pdfDataUrlToBytes('data:image/png;base64,AAAA')).toThrow();
    expect(pdfDataUrlToBytes(VALID_PDF_DATA_URL).byteLength).toBeGreaterThan(0);
  });
});

describe('renderPdfToPageImages — fail-soft Orchestrierung', () => {
  const detection = (chosen: DetectPdfRenderersResult['chosen']): DetectPdfRenderersResult => ({
    renderers: [],
    available: chosen ? [chosen] : [],
    chosen,
    diagnostic: chosen ? `PDF-Renderer: ${chosen.id}` : 'Kein PDF-Renderer verfügbar.',
  });

  it('kein Renderer → status renderer_unavailable, kein Throw', async () => {
    const deps: RenderPdfDeps = {
      detect: async () => detection(null),
      exec: async () => undefined,
      writeTempPdf: async () => '/tmp/x.pdf',
      collectPngs: async () => [],
      cleanupTempPdf: async () => undefined,
    };
    const r = await renderPdfToPageImages({ pdfDataUrl: VALID_PDF_DATA_URL, outputDir: '/out' }, deps);
    expect(r.status).toBe('renderer_unavailable');
    expect(r.pages).toHaveLength(0);
  });

  it('nur pdfjs_canvas → renderer_unavailable (externer Renderer nötig)', async () => {
    const deps: RenderPdfDeps = {
      detect: async () => detection({ id: 'pdfjs_canvas', available: true, command: 'pdfjs+canvas' }),
      exec: async () => undefined,
      writeTempPdf: async () => '/tmp/x.pdf',
      collectPngs: async () => [],
      cleanupTempPdf: async () => undefined,
    };
    const r = await renderPdfToPageImages({ pdfDataUrl: VALID_PDF_DATA_URL, outputDir: '/out' }, deps);
    expect(r.status).toBe('renderer_unavailable');
    expect(r.renderer).toBe('pdfjs_canvas');
  });

  it('poppler ok → status ok mit Seiten', async () => {
    let cleaned = false;
    const deps: RenderPdfDeps = {
      detect: async () => detection({ id: 'poppler_pdftoppm', available: true, command: 'pdftoppm' }),
      exec: async () => undefined,
      writeTempPdf: async () => '/tmp/x.pdf',
      collectPngs: async () => [
        { filePath: '/out/page-1.png', width: 1000, height: 1400 },
        { filePath: '/out/page-2.png', width: 1000, height: 1400 },
      ],
      cleanupTempPdf: async () => {
        cleaned = true;
      },
    };
    const r = await renderPdfToPageImages({ pdfDataUrl: VALID_PDF_DATA_URL, outputDir: '/out', pageLimit: 8 }, deps);
    expect(r.status).toBe('ok');
    expect(r.renderer).toBe('poppler_pdftoppm');
    expect(r.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(cleaned).toBe(true);
  });

  it('Renderer wirft → status failed mit Warnung, kein Throw', async () => {
    const deps: RenderPdfDeps = {
      detect: async () => detection({ id: 'mutool', available: true, command: 'mutool' }),
      exec: async () => {
        throw new Error('spawn ENOENT mutool');
      },
      writeTempPdf: async () => '/tmp/x.pdf',
      collectPngs: async () => [],
      cleanupTempPdf: async () => undefined,
    };
    const r = await renderPdfToPageImages({ pdfDataUrl: VALID_PDF_DATA_URL, outputDir: '/out' }, deps);
    expect(r.status).toBe('failed');
    expect(r.warning).toMatch(/mutool/);
  });
});
