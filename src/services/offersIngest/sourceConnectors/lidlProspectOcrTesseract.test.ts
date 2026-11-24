import { afterEach, describe, expect, it, vi } from 'vitest';

// Belegt den behobenen Root Cause: tesseract.js v7 liefert per Default NUR `text`;
// die Wortdaten liegen NICHT top-level unter `data.words`, sondern (bei `blocks:true`)
// in `data.blocks[].paragraphs[].lines[].words[]` bzw. via `data.tsv`. Getestet wird,
// dass `recognizeLidlImage` v7 korrekt mit dem Output-Schalter anspricht, EINEN
// geteilten Lauf pro Bild fährt und die strukturierten Daten robust zu Wortboxen
// mappt (blocks → words → tsv). Die tesseract.js-Runtime wird gemockt — KEIN echter
// OCR-Lauf, KEIN Produkt-/Markenwissen.

const recognizeMock = vi.fn();
const terminateMock = vi.fn(async () => undefined);
const createWorkerMock = vi.fn(async () => ({ recognize: recognizeMock, terminate: terminateMock }));

vi.mock('tesseract.js', () => ({ createWorker: () => createWorkerMock() }));

import {
  createDefaultLidlOcrPair,
  defaultLidlOcrImage,
  extractOcrWordBoxes,
} from './lidlProspectOcr';
import { fakePngBytes } from './lidlProspect.fixture';

afterEach(() => {
  vi.clearAllMocks();
});

describe('recognizeLidlImage — tesseract.js-v7-Output-Schalter + geteilter Lauf', () => {
  it('ruft worker.recognize mit Output { text, blocks, tsv } auf (kein zweiter Lauf, ein geteilter Lauf je Bild)', async () => {
    recognizeMock.mockResolvedValue({ data: { text: 'Bananen', blocks: [], tsv: '' } });
    const pair = createDefaultLidlOcrPair();
    // ocrImage UND ocrLayout für DASSELBE Bild → memoisiert auf EINEN recognize-Lauf.
    await pair.ocrImage(fakePngBytes(), 'https://cdn/p1.jpg');
    await pair.ocrLayout(fakePngBytes(), 'https://cdn/p1.jpg');
    expect(recognizeMock).toHaveBeenCalledTimes(1);
    const [, options, output] = recognizeMock.mock.calls[0];
    expect(options).toEqual({});
    expect(output).toEqual({ text: true, blocks: true, tsv: true });
    expect(terminateMock).toHaveBeenCalledTimes(1);
  });

  it('liefert weiterhin den OCR-Text (defaultLidlOcrImage)', async () => {
    recognizeMock.mockResolvedValue({ data: { text: 'Rispentomaten\n1,99', blocks: [] } });
    expect(await defaultLidlOcrImage(fakePngBytes())).toBe('Rispentomaten\n1,99');
  });

  it('mappt die v7 blocks-Hierarchie zu Layout-Wörtern in DENSELBEN Bildkoordinaten (wordBoxSource=blocks)', async () => {
    recognizeMock.mockResolvedValue({
      data: {
        text: 'Rispentomaten 1,99',
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  {
                    words: [
                      { text: 'Rispentomaten', bbox: { x0: 10, y0: 20, x1: 210, y1: 60 }, confidence: 90 },
                      { text: '1,99', bbox: { x0: 12, y0: 80, x1: 90, y1: 180 }, confidence: 88 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const page = await createDefaultLidlOcrPair().ocrLayout(fakePngBytes(), 'https://cdn/p2.jpg');
    expect(page).not.toBeNull();
    expect(page!.words.map((w) => w.text)).toEqual(['Rispentomaten', '1,99']);
    // x=x0, y=y0, w=x1-x0, h=y1-y0 — keine Skalierung, keine Verschiebung.
    expect(page!.words[0].bbox).toEqual({ x: 10, y: 20, w: 200, h: 40 });
    expect(page!.structuredOutputRequested).toBe(true);
    expect(page!.wordBoxSource).toBe('blocks');
    expect(page!.blocksPresent).toBe(true);
    expect(page!.blockWordCount).toBe(2);
    expect(page!.sourceWordCount).toBe(2);
  });

  it('trägt die Struktur-Diagnose auch ohne Wörter (leere Seite statt null) — kein stilles noWordBoxesFromOcr', async () => {
    // v6-/Mock-artige Antwort: Output-Schalter ignoriert → weder blocks/tsv noch words.
    recognizeMock.mockResolvedValue({ data: { text: 'Prospekt der Woche' } });
    const page = await createDefaultLidlOcrPair().ocrLayout(fakePngBytes(), 'https://cdn/p3.jpg');
    expect(page).not.toBeNull();
    expect(page!.words).toHaveLength(0);
    expect(page!.structuredOutputRequested).toBe(true);
    expect(page!.blocksPresent).toBe(false);
    expect(page!.tsvPresent).toBe(false);
    expect(page!.wordBoxSource).toBe('none');
  });
});

describe('extractOcrWordBoxes — robustes Mapping blocks → words → tsv', () => {
  it('bevorzugt blocks und verwirft leere/ungültige Block-Wörter', () => {
    const ex = extractOcrWordBoxes({
      text: 't',
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                {
                  words: [
                    { text: '   ', bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } }, // leerer Text → verworfen
                    { text: 'Kaese', bbox: { x0: 1, y0: 2, x1: 3, y1: 4 }, confidence: 80 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(ex.wordBoxSource).toBe('blocks');
    expect(ex.blocksPresent).toBe(true);
    expect(ex.blockWordCount).toBe(1);
    expect(ex.words.map((w) => w.text)).toEqual(['Kaese']);
  });

  it('Legacy top-level data.words als Fallback, wenn blocks fehlen (wordBoxSource=topLevelWords)', () => {
    const ex = extractOcrWordBoxes({
      text: 't',
      words: [{ text: 'Apfel', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }],
    });
    expect(ex.wordBoxSource).toBe('topLevelWords');
    expect(ex.blocksPresent).toBe(false);
    expect(ex.words).toHaveLength(1);
  });

  it('TSV-Fallback geparst (nur Wort-Ebene), ungültige Zeilen verworfen (wordBoxSource=tsv)', () => {
    const tsv = [
      'level\tpage\tblock\tpar\tline\tword\tleft\ttop\twidth\theight\tconf\ttext', // Header → kein level 5
      '1\t1\t0\t0\t0\t0\t0\t0\t1000\t1400\t-1\t', // level 1 (Seite), kein Wort → verworfen
      '5\t1\t1\t1\t1\t1\t10\t20\t30\t40\t95\tBananen', // gültiges Wort
      '5\t1\t1\t1\t1\t2\t50\t20\t10\t40\t90\t   ', // leerer Text → verworfen
      'kaputt\tzeile', // < 12 Spalten → verworfen
    ].join('\n');
    const ex = extractOcrWordBoxes({ text: 't', tsv });
    expect(ex.wordBoxSource).toBe('tsv');
    expect(ex.tsvPresent).toBe(true);
    expect(ex.tsvWordCount).toBe(1);
    expect(ex.words[0]).toMatchObject({
      text: 'Bananen',
      bbox: { x0: 10, y0: 20, x1: 40, y1: 60 },
      confidence: 95,
    });
  });

  it('blocks gewinnen vor top-level words und tsv (Reihenfolge)', () => {
    const ex = extractOcrWordBoxes({
      text: 't',
      blocks: [{ paragraphs: [{ lines: [{ words: [{ text: 'Brot', bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } }] }] }] }],
      words: [{ text: 'Wurst', bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } }],
      tsv: '5\t1\t1\t1\t1\t1\t0\t0\t5\t5\t90\tMilch',
    });
    expect(ex.wordBoxSource).toBe('blocks');
    expect(ex.words.map((w) => w.text)).toEqual(['Brot']);
    // Die Nebenquellen werden trotzdem ehrlich diagnostisch gezählt.
    expect(ex.tsvWordCount).toBe(1);
  });

  it('keine strukturierte Ausgabe → wordBoxSource=none, leere Wortliste', () => {
    const ex = extractOcrWordBoxes({ text: 'nur text' });
    expect(ex.wordBoxSource).toBe('none');
    expect(ex.words).toHaveLength(0);
    expect(ex.blocksPresent).toBe(false);
    expect(ex.tsvPresent).toBe(false);
  });
});
