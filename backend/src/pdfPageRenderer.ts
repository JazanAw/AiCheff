// Robuster PDF-Seiten-Renderer für den ALDI-PDF-Vision-Import.
//
// Der bestehende Evidenz-Crop-Pfad (aldiPdfEvidenceImages.ts) rendert über
// pdfjs + node-canvas und ist bei großen Prospekt-PDFs instabil/zu langsam
// ("canvas_render_failed", "Image or Canvas expected", Render-Timeouts). Für den
// Vision-Import brauchen wir aber verlässliche Seitenbilder. Dieses Modul kapselt
// deshalb mehrere externe Renderer und nutzt pdfjs+canvas nur als LETZTEN Fallback:
//
//   1. Poppler  — `pdftoppm` / `pdftocairo`
//   2. MuPDF    — `mutool draw`
//   3. Ghostscript — `gs` / `gswin64c` / `gswin32c`
//   4. pdfjs + node-canvas (letzter Fallback)
//
// Designprinzipien (wie der Rest des ALDI-PDF-Pfads):
//   • EHRLICHE DIAGNOSE statt stillem Scheitern: ist KEIN Renderer verfügbar,
//     liefert {@link renderPdfToPageImages} `status: 'renderer_unavailable'` —
//     kein Hänger, kein Crash.
//   • HARTE TIMEOUTS pro Renderer-Aufruf; ein hängendes Binary blockiert nie.
//   • KEIN OCR, KEIN Web/Publitas. Nur lokales Rendering der hochgeladenen PDF.
//   • Pure Helfer (Detection-Logik, Arg-Builder, PNG-Größe) sind vollständig
//     unit-testbar; die echte Prozess-/FS-Schicht ist injizierbar.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

// ── Renderer-Identität / Präferenz ───────────────────────────────────────────

export type PdfRendererId =
  | 'poppler_pdftoppm'
  | 'poppler_pdftocairo'
  | 'mutool'
  | 'ghostscript'
  | 'pdfjs_canvas';

/** Bevorzugungsreihenfolge: externe Renderer zuerst, pdfjs+canvas zuletzt. */
export const PDF_RENDERER_PREFERENCE: readonly PdfRendererId[] = [
  'poppler_pdftoppm',
  'poppler_pdftocairo',
  'mutool',
  'ghostscript',
  'pdfjs_canvas',
];

/** Kandidaten-Binaries je Renderer (plattformübergreifend). */
const RENDERER_COMMAND_CANDIDATES: Record<Exclude<PdfRendererId, 'pdfjs_canvas'>, string[]> = {
  poppler_pdftoppm: ['pdftoppm'],
  poppler_pdftocairo: ['pdftocairo'],
  mutool: ['mutool'],
  ghostscript: ['gs', 'gswin64c', 'gswin32c'],
};

export interface PdfRendererInfo {
  id: PdfRendererId;
  available: boolean;
  /** Aufgelöstes Binary (extern) bzw. 'pdfjs+canvas'. */
  command: string;
  /** Kurze Versions-/Diagnosezeile (best effort). */
  detail?: string;
}

export interface DetectPdfRenderersResult {
  /** Alle geprüften Renderer (in Präferenzreihenfolge). */
  renderers: PdfRendererInfo[];
  /** Verfügbare Teilmenge (in Präferenzreihenfolge). */
  available: PdfRendererInfo[];
  /** Bester verfügbarer Renderer oder null (→ renderer_unavailable). */
  chosen: PdfRendererInfo | null;
  /** Menschenlesbare Diagnose, welcher Renderer benutzt wird. */
  diagnostic: string;
}

// ── Injizierbare Probes (Tests ohne echte Binaries) ──────────────────────────

export interface PdfRendererProbes {
  /** Existiert/antwortet das Binary? (real: execFile mit Versionsflag). */
  probeCommand: (candidates: string[]) => Promise<{ command: string; detail?: string } | null>;
  /** Ist der pdfjs+canvas-Fallback nutzbar (Module ladbar + nicht deaktiviert)? */
  probeCanvas: () => Promise<{ available: boolean; detail?: string }>;
}

/** Real-Probe: prüft ein Binary über `<cmd> -v`/`--version` mit kurzem Timeout. */
async function realProbeCommand(
  candidates: string[],
): Promise<{ command: string; detail?: string } | null> {
  for (const command of candidates) {
    // mutool/gs nutzen `-v`, poppler-Tools `-v` auf stderr; alle dürfen non-zero
    // exiten — uns interessiert nur, ob das Binary überhaupt startet.
    const detail = await runVersionProbe(command).catch(() => null);
    if (detail !== null) return { command, detail: detail || undefined };
  }
  return null;
}

function runVersionProbe(command: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(command, ['-v'], { timeout: 2500, windowsHide: true }, (error, stdout, stderr) => {
      // ENOENT → Binary fehlt. Jede andere Antwort (auch non-zero) zählt als "da".
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(error);
        return;
      }
      const out = `${stdout || ''}${stderr || ''}`.split(/\r?\n/)[0]?.trim() ?? '';
      resolve(out.slice(0, 80));
    });
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(error);
      else resolve('');
    });
  });
}

/** Real-Probe: kann der pdfjs+canvas-Fallback überhaupt geladen werden? */
async function realProbeCanvas(): Promise<{ available: boolean; detail?: string }> {
  // Bewusst opt-OUT-bar: pdfjs+canvas ist der bekannt instabile Pfad und soll nur
  // benutzt werden, wenn ausdrücklich erlaubt UND die Module vorhanden sind.
  if (process.env.ALDI_PDF_VISION_ALLOW_CANVAS_FALLBACK === '0') {
    return { available: false, detail: 'pdfjs+canvas per ALDI_PDF_VISION_ALLOW_CANVAS_FALLBACK=0 deaktiviert' };
  }
  try {
    await import('pdfjs-dist/legacy/build/pdf.mjs');
    await import('canvas');
    return { available: true, detail: 'pdfjs+canvas (letzter Fallback)' };
  } catch (error) {
    return { available: false, detail: errMessage(error) };
  }
}

export const realPdfRendererProbes: PdfRendererProbes = {
  probeCommand: realProbeCommand,
  probeCanvas: realProbeCanvas,
};

/**
 * Ermittelt verfügbare PDF-Renderer in Präferenzreihenfolge. Externe Binaries
 * werden über die injizierten Probes geprüft; pdfjs+canvas ist der letzte
 * Fallback. Gibt es nichts, ist `chosen === null` (→ renderer_unavailable).
 */
export async function detectPdfRenderers(
  probes: PdfRendererProbes = realPdfRendererProbes,
): Promise<DetectPdfRenderersResult> {
  const renderers: PdfRendererInfo[] = [];
  for (const id of PDF_RENDERER_PREFERENCE) {
    if (id === 'pdfjs_canvas') {
      const canvas = await probes.probeCanvas();
      renderers.push({ id, available: canvas.available, command: 'pdfjs+canvas', detail: canvas.detail });
      continue;
    }
    const hit = await probes.probeCommand(RENDERER_COMMAND_CANDIDATES[id]);
    renderers.push({
      id,
      available: hit !== null,
      command: hit?.command ?? RENDERER_COMMAND_CANDIDATES[id][0],
      detail: hit?.detail,
    });
  }
  const available = renderers.filter((r) => r.available);
  const chosen = available[0] ?? null;
  const diagnostic = chosen
    ? `PDF-Renderer: ${chosen.id} (${chosen.command})${chosen.detail ? ` — ${chosen.detail}` : ''}`
    : 'Kein PDF-Renderer verfügbar (poppler/mupdf/ghostscript/pdfjs+canvas fehlen).';
  return { renderers, available, chosen, diagnostic };
}

// ── Pure Arg-Builder je Renderer ─────────────────────────────────────────────

export interface PageRenderArgsInput {
  inputPdfPath: string;
  /** Ziel-Präfix OHNE Endung, z. B. ".../page". Renderer hängen -N.png an. */
  outputPrefix: string;
  /** Auflösung in DPI (Default 150). */
  dpi: number;
  /** 1-basierte erste Seite. */
  firstPage: number;
  /** 1-basierte letzte Seite. */
  lastPage: number;
}

/** Poppler `pdftoppm`: `-png -r DPI -f F -l L input prefix` → prefix-1.png … */
export function buildPdftoppmArgs(input: PageRenderArgsInput): string[] {
  return [
    '-png',
    '-r', String(input.dpi),
    '-f', String(input.firstPage),
    '-l', String(input.lastPage),
    input.inputPdfPath,
    input.outputPrefix,
  ];
}

/** Poppler `pdftocairo`: wie pdftoppm, aber explizit `-png`. */
export function buildPdftocairoArgs(input: PageRenderArgsInput): string[] {
  return [
    '-png',
    '-r', String(input.dpi),
    '-f', String(input.firstPage),
    '-l', String(input.lastPage),
    input.inputPdfPath,
    input.outputPrefix,
  ];
}

/** MuPDF `mutool draw -o prefix-%d.png -r DPI input F-L`. */
export function buildMutoolArgs(input: PageRenderArgsInput): string[] {
  return [
    'draw',
    '-o', `${input.outputPrefix}-%d.png`,
    '-r', String(input.dpi),
    input.inputPdfPath,
    `${input.firstPage}-${input.lastPage}`,
  ];
}

/** Ghostscript: png16m-Device, `prefix-%d.png`, First/LastPage. */
export function buildGhostscriptArgs(input: PageRenderArgsInput): string[] {
  return [
    '-q',
    '-dNOPAUSE',
    '-dBATCH',
    '-sDEVICE=png16m',
    `-r${input.dpi}`,
    `-dFirstPage=${input.firstPage}`,
    `-dLastPage=${input.lastPage}`,
    `-sOutputFile=${input.outputPrefix}-%d.png`,
    input.inputPdfPath,
  ];
}

function buildArgsFor(id: PdfRendererId, input: PageRenderArgsInput): string[] {
  switch (id) {
    case 'poppler_pdftoppm':
      return buildPdftoppmArgs(input);
    case 'poppler_pdftocairo':
      return buildPdftocairoArgs(input);
    case 'mutool':
      return buildMutoolArgs(input);
    case 'ghostscript':
      return buildGhostscriptArgs(input);
    case 'pdfjs_canvas':
      return [];
  }
}

// ── Pure: PNG-Größe aus den ersten Bytes lesen (kein Bild-Decode) ─────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Liest Breite/Höhe aus dem IHDR-Chunk eines PNG-Buffers. Null, wenn kein PNG. */
export function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // IHDR ist immer der erste Chunk: Länge(4) + "IHDR"(4) + Breite(4) + Höhe(4) …
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

// ── Data-URL → Bytes ─────────────────────────────────────────────────────────

export function pdfDataUrlToBytes(pdfDataUrl: string): Uint8Array {
  const match = pdfDataUrl.match(/^data:application\/pdf;base64,(.+)$/i);
  if (!match) throw new Error('PDF muss als application/pdf (data-URL) übergeben werden.');
  return new Uint8Array(Buffer.from(match[1], 'base64'));
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Render-Orchestrierung (injizierbare Prozess-/FS-Schicht) ─────────────────

export interface RenderedPdfPage {
  /** 1-basierte Seitenzahl im PDF. */
  pageNumber: number;
  /** Absoluter Pfad des erzeugten PNG. */
  filePath: string;
  /** Pixelbreite des Seitenbilds. */
  width: number;
  /** Pixelhöhe des Seitenbilds. */
  height: number;
}

export type PdfRenderStatus = 'ok' | 'renderer_unavailable' | 'failed';

export interface RenderPdfResult {
  status: PdfRenderStatus;
  renderer: PdfRendererId | null;
  pages: RenderedPdfPage[];
  diagnostic: string;
  warning?: string;
}

export interface RenderPdfInput {
  pdfDataUrl: string;
  /** Ausgabeverzeichnis für page-*.png (wird angelegt). */
  outputDir: string;
  /** Maximale Anzahl gerenderter Seiten (Default 8). */
  pageLimit?: number;
  dpi?: number;
  /** Hartes Limit für den Renderer-Aufruf (Default 60000 ms). */
  renderTimeoutMs?: number;
}

export interface RenderPdfDeps {
  detect: () => Promise<DetectPdfRenderersResult>;
  /** Führt das Renderer-Binary aus (real: execFile mit Timeout). */
  exec: (command: string, args: string[], timeoutMs: number) => Promise<void>;
  /** Schreibt die PDF-Bytes in eine temporäre Datei, gibt deren Pfad zurück. */
  writeTempPdf: (bytes: Uint8Array) => Promise<string>;
  /** Liest die im outputDir erzeugten PNGs zurück (Pfad + Größe). */
  collectPngs: (outputDir: string) => Promise<Array<{ filePath: string; width: number; height: number }>>;
  /** Räumt die temporäre PDF-Datei weg (best effort). */
  cleanupTempPdf: (filePath: string) => Promise<void>;
}

/**
 * Rendert die ersten `pageLimit` Seiten der PDF in PNGs. Fail-soft:
 *   • Kein Renderer verfügbar → `status: 'renderer_unavailable'` (kein Throw).
 *   • Renderer-Aufruf wirft/timeoutet → `status: 'failed'` mit Warnung.
 * Wirft NIE für erwartbare Fehler.
 */
export async function renderPdfToPageImages(
  input: RenderPdfInput,
  deps: RenderPdfDeps = defaultRenderPdfDeps,
): Promise<RenderPdfResult> {
  const pageLimit = Math.max(1, input.pageLimit ?? 8);
  const dpi = Math.max(72, input.dpi ?? 150);
  const renderTimeoutMs = Math.max(1000, input.renderTimeoutMs ?? 60000);

  const detection = await deps.detect();
  if (!detection.chosen) {
    return {
      status: 'renderer_unavailable',
      renderer: null,
      pages: [],
      diagnostic: detection.diagnostic,
    };
  }
  const chosen = detection.chosen;

  // Der pdfjs+canvas-Fallback hat keinen CLI-Renderpfad hier — das ist der
  // bewusst NICHT bevorzugte Weg. Wenn er der einzige verfügbare „Renderer" ist,
  // melden wir das ehrlich als renderer_unavailable für den CLI-Pfad.
  if (chosen.id === 'pdfjs_canvas') {
    return {
      status: 'renderer_unavailable',
      renderer: 'pdfjs_canvas',
      pages: [],
      diagnostic:
        'Nur pdfjs+canvas verfügbar — für den Vision-Import wird ein externer ' +
        'Renderer (poppler/mupdf/ghostscript) benötigt. Bitte z. B. poppler-utils installieren.',
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = pdfDataUrlToBytes(input.pdfDataUrl);
  } catch (error) {
    return { status: 'failed', renderer: chosen.id, pages: [], diagnostic: detection.diagnostic, warning: errMessage(error) };
  }

  let tempPdf: string | null = null;
  try {
    await fs.mkdir(input.outputDir, { recursive: true }).catch(() => undefined);
    tempPdf = await deps.writeTempPdf(bytes);
    const args = buildArgsFor(chosen.id, {
      inputPdfPath: tempPdf,
      outputPrefix: path.join(input.outputDir, 'page'),
      dpi,
      firstPage: 1,
      lastPage: pageLimit,
    });
    await deps.exec(chosen.command, args, renderTimeoutMs);
    const pngs = await deps.collectPngs(input.outputDir);
    const pages: RenderedPdfPage[] = pngs
      .slice(0, pageLimit)
      .map((png, index) => ({ pageNumber: index + 1, filePath: png.filePath, width: png.width, height: png.height }));
    if (pages.length === 0) {
      return {
        status: 'failed',
        renderer: chosen.id,
        pages: [],
        diagnostic: detection.diagnostic,
        warning: `Renderer ${chosen.id} erzeugte keine Seitenbilder.`,
      };
    }
    return { status: 'ok', renderer: chosen.id, pages, diagnostic: detection.diagnostic };
  } catch (error) {
    return {
      status: 'failed',
      renderer: chosen.id,
      pages: [],
      diagnostic: detection.diagnostic,
      warning: `Renderer ${chosen.id} fehlgeschlagen: ${errMessage(error)}`,
    };
  } finally {
    if (tempPdf) await deps.cleanupTempPdf(tempPdf).catch(() => undefined);
  }
}

// ── Reale Default-Deps (Prozess + FS) ────────────────────────────────────────

function execFileWithTimeout(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
    child.on('error', reject);
  });
}

async function writeTempPdf(bytes: Uint8Array): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aldi-vision-'));
  const file = path.join(dir, `${randomUUID()}.pdf`);
  await fs.writeFile(file, bytes);
  return file;
}

async function collectPngs(
  outputDir: string,
): Promise<Array<{ filePath: string; width: number; height: number }>> {
  const names = await fs.readdir(outputDir).catch(() => [] as string[]);
  const pngNames = names.filter((n) => n.toLowerCase().endsWith('.png')).sort(comparePageFileNames);
  const out: Array<{ filePath: string; width: number; height: number }> = [];
  for (const name of pngNames) {
    const filePath = path.join(outputDir, name);
    try {
      const buf = await fs.readFile(filePath);
      const size = readPngSize(buf);
      if (size) out.push({ filePath, width: size.width, height: size.height });
    } catch {
      /* eine kaputte Datei überspringen */
    }
  }
  return out;
}

/** Sortiert page-2.png vor page-10.png (numerisch, nicht lexikografisch). */
export function comparePageFileNames(a: string, b: string): number {
  const na = Number(a.match(/(\d+)/)?.[1] ?? 0);
  const nb = Number(b.match(/(\d+)/)?.[1] ?? 0);
  return na - nb;
}

async function cleanupTempPdf(filePath: string): Promise<void> {
  await fs.rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => undefined);
}

export const defaultRenderPdfDeps: RenderPdfDeps = {
  detect: () => detectPdfRenderers(),
  exec: execFileWithTimeout,
  writeTempPdf,
  collectPngs,
  cleanupTempPdf,
};
