// GPU preflight for the high-quality weekly auto-scan.
//
// A 14B model that silently spills onto the CPU runs 10-50× slower and was part
// of the 4-hour failure (qwen3:14b only 20/41 layers on the GPU). In the
// high-quality / full-power mode we therefore check that an NVIDIA GPU is
// present and the model will actually live on it, and otherwise abort cleanly
// with a clear message instead of accepting hours of CPU offload.
//
// IMPORTANT — the "loaded model" case: the Ollama smoke-test that runs just
// before this preflight LOADS the target model into VRAM. Measuring free VRAM
// afterwards is misleading: the free number is low *because the model we want is
// already resident*. So when we know the configured model is fully on the GPU
// (all layers offloaded, per Ollama's load log / /api/ps), we accept the run
// even with little free VRAM. We only fall back to the free-VRAM threshold when
// no model is loaded yet (or its residency is unknown).
//
// `runNvidiaSmi` is injectable so the whole flow is unit-testable without a GPU.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GpuInfo {
  name: string;
  totalMb: number;
  freeMb: number;
}

/**
 * Residency of the configured model in Ollama, as observed right after the
 * smoke-test loaded it. Layer counts (from Ollama's "offloaded X/Y layers to
 * GPU" log line) are authoritative; the /api/ps byte sizes are a fallback when
 * the log is unavailable (e.g. Ollama started externally).
 */
export interface LoadedModelGpuStatus {
  /** The configured model is currently resident in Ollama. */
  loaded: boolean;
  /** Layers placed on the GPU (e.g. 41). Undefined when unknown. */
  gpuLayers?: number;
  /** Total layers of the model (e.g. 41). Undefined when unknown. */
  totalLayers?: number;
  /** Bytes resident in VRAM, from /api/ps. Undefined when unknown. */
  sizeVramBytes?: number;
  /** Total model bytes, from /api/ps. Undefined when unknown. */
  sizeBytes?: number;
}

export interface GpuPreflightConfig {
  /** Minimum free VRAM (MB) for the model to fit on-GPU. Default ~9 GB for a
   *  qwen3:14b Q4_K_M plus a modest context. Only consulted when no model is
   *  loaded yet. */
  requiredFreeMb?: number;
  modelLabel?: string;
  /** Residency of the configured model (after the smoke-test loaded it). When
   *  the model is fully on the GPU, a low free-VRAM reading is expected and not
   *  a failure. */
  loadedModel?: LoadedModelGpuStatus | null;
  /** Injectable nvidia-smi runner. Resolves the raw csv text, or rejects when
   *  nvidia-smi is absent / no NVIDIA GPU. Defaults to the real binary. */
  runNvidiaSmi?: () => Promise<string>;
}

export type GpuPreflightResult =
  | {
      ok: true;
      gpuPresent: boolean;
      /** Present when nvidia-smi could be read; may be absent when the pass is
       *  based purely on Ollama reporting the model fully GPU-resident. */
      gpu?: GpuInfo;
      /** Non-null when free VRAM is tight but above the hard minimum. */
      warning: string | null;
      /** True when the pass is because the configured model is already fully
       *  GPU-resident (free VRAM is low *because of* that model). */
      loadedFull?: boolean;
      /** Human-readable status, e.g. "GPU OK: qwen3:14b ist geladen (41/41 …)". */
      message?: string;
    }
  | {
      ok: false;
      gpuPresent: boolean;
      reason: 'no_gpu' | 'insufficient_vram' | 'cpu_offload' | 'unknown';
      message: string;
      gpu?: GpuInfo;
    };

const DEFAULT_REQUIRED_FREE_MB = 9000;
const BYTES_PER_GIB = 1024 * 1024 * 1024;

async function defaultRunNvidiaSmi(): Promise<string> {
  const { stdout } = await execFileAsync(
    'nvidia-smi',
    ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
    { timeout: 8000, windowsHide: true },
  );
  return stdout;
}

/** Parse nvidia-smi csv ("name, total, free" per line) into GpuInfo rows. */
export function parseNvidiaSmiCsv(csv: string): GpuInfo[] {
  const rows: GpuInfo[] = [];
  for (const line of String(csv ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',').map((p) => p.trim());
    if (parts.length < 3) continue;
    const name = parts[0];
    const totalMb = Number(parts[1]);
    const freeMb = Number(parts[2]);
    if (!Number.isFinite(totalMb) || !Number.isFinite(freeMb)) continue;
    rows.push({ name, totalMb, freeMb });
  }
  return rows;
}

export interface LoadedModelEvaluation {
  /** Every layer / essentially all bytes are on the GPU. */
  fullyOnGpu: boolean;
  /** The model is loaded but spilled partly onto the CPU. */
  partialCpuOffload: boolean;
  /** "41/41" when layer counts are known, else null. */
  layerLabel: string | null;
}

/**
 * Decide whether a loaded model is fully on the GPU or partially offloaded.
 * Layer counts (from Ollama's load log) are authoritative when present; the
 * /api/ps byte residency is used as a fallback (>=95 % in VRAM counts as full,
 * to tolerate minor KV-cache rounding). A loaded model with no residency detail
 * yields neither — the caller then falls back to the free-VRAM threshold.
 */
export function evaluateLoadedModel(status: LoadedModelGpuStatus): LoadedModelEvaluation {
  const none: LoadedModelEvaluation = {
    fullyOnGpu: false,
    partialCpuOffload: false,
    layerLabel: null,
  };
  if (!status.loaded) return none;

  const { gpuLayers, totalLayers, sizeVramBytes, sizeBytes } = status;

  if (
    typeof gpuLayers === 'number' &&
    typeof totalLayers === 'number' &&
    Number.isFinite(gpuLayers) &&
    Number.isFinite(totalLayers) &&
    totalLayers > 0 &&
    gpuLayers >= 0
  ) {
    return {
      fullyOnGpu: gpuLayers >= totalLayers,
      partialCpuOffload: gpuLayers < totalLayers,
      layerLabel: `${gpuLayers}/${totalLayers}`,
    };
  }

  if (
    typeof sizeVramBytes === 'number' &&
    typeof sizeBytes === 'number' &&
    Number.isFinite(sizeVramBytes) &&
    Number.isFinite(sizeBytes) &&
    sizeBytes > 0
  ) {
    const fully = sizeVramBytes > 0 && sizeVramBytes >= sizeBytes * 0.95;
    return {
      fullyOnGpu: fully,
      partialCpuOffload: sizeVramBytes > 0 && !fully,
      layerLabel: null,
    };
  }

  return none;
}

function gib(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  return `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`;
}

/**
 * Run the GPU preflight. Picks the GPU with the most free VRAM for reporting.
 *
 * Decision order:
 *   1. If the configured model is already loaded and PARTIALLY on the CPU →
 *      fail (`cpu_offload`): a 14B on CPU is unusably slow.
 *   2. If the configured model is already FULLY on the GPU → pass, regardless of
 *      how little VRAM is free (the model itself holds it).
 *   3. Otherwise (no model loaded / residency unknown) → require an NVIDIA GPU
 *      with enough free VRAM (`insufficient_vram` / `no_gpu` / `unknown`).
 */
export async function runGpuPreflight(
  config: GpuPreflightConfig = {},
): Promise<GpuPreflightResult> {
  const requiredFreeMb = config.requiredFreeMb ?? DEFAULT_REQUIRED_FREE_MB;
  const modelLabel = config.modelLabel ?? 'das Modell';
  const runner = config.runNvidiaSmi ?? defaultRunNvidiaSmi;

  // Read the GPU state best-effort: it is informational when a model is already
  // loaded, and decisive only on the no-model path below.
  let best: GpuInfo | undefined;
  let smiUnavailable = false;
  let smiUnparseable = false;
  try {
    const gpus = parseNvidiaSmiCsv(await runner());
    if (gpus.length === 0) smiUnparseable = true;
    else best = gpus.reduce((a, b) => (b.freeMb > a.freeMb ? b : a));
  } catch {
    smiUnavailable = true;
  }

  // 1) + 2) — the configured model is (or was just) loaded.
  const loaded = config.loadedModel ? evaluateLoadedModel(config.loadedModel) : null;

  if (loaded?.partialCpuOffload) {
    const detail =
      loaded.layerLabel !== null
        ? `${loaded.layerLabel} Layer auf GPU`
        : `nur ${gib(config.loadedModel?.sizeVramBytes) ?? '?'} von ` +
          `${gib(config.loadedModel?.sizeBytes) ?? '?'} im VRAM`;
    return {
      ok: false,
      gpuPresent: Boolean(best),
      reason: 'cpu_offload',
      gpu: best,
      message:
        `${modelLabel} laeuft nur teilweise auf der GPU (${detail}) — der Rest wird ` +
        `auf die CPU ausgelagert (10-50× langsamer). Lauf abgebrochen. GPU-Speicher ` +
        `freigeben (andere Apps/Modelle schliessen) oder WEEKLY_SCAN_ALLOW_CPU=true setzen.`,
    };
  }

  if (loaded?.fullyOnGpu) {
    const detail =
      loaded.layerLabel !== null
        ? `${loaded.layerLabel} Layer auf GPU`
        : `vollstaendig im VRAM${gib(config.loadedModel?.sizeVramBytes) ? `, ${gib(config.loadedModel?.sizeVramBytes)}` : ''}`;
    return {
      ok: true,
      gpuPresent: true,
      gpu: best,
      warning: null,
      loadedFull: true,
      message: `GPU OK: ${modelLabel} ist geladen (${detail}).`,
    };
  }

  // 3) — no model loaded yet (or residency unknown): gate on free VRAM.
  if (smiUnavailable) {
    return {
      ok: false,
      gpuPresent: false,
      reason: 'no_gpu',
      message:
        'Keine NVIDIA-GPU erkannt (nvidia-smi nicht verfügbar). Full-Power-Modus ' +
        'würde auf CPU laufen — Lauf abgebrochen. Setze WEEKLY_SCAN_ALLOW_CPU=true, ' +
        'um trotzdem fortzufahren.',
    };
  }

  if (smiUnparseable || !best) {
    return {
      ok: false,
      gpuPresent: false,
      reason: 'unknown',
      message: 'nvidia-smi lieferte keine lesbaren GPU-Daten — VRAM nicht prüfbar.',
    };
  }

  if (best.freeMb < requiredFreeMb) {
    return {
      ok: false,
      gpuPresent: true,
      reason: 'insufficient_vram',
      gpu: best,
      message:
        `Zu wenig freier GPU-Speicher für ${modelLabel}: ` +
        `${best.freeMb} MB frei von ${best.totalMb} MB (${best.name}), ` +
        `benötigt ~${requiredFreeMb} MB. ${modelLabel} würde teilweise auf die CPU ` +
        `ausgelagert — Lauf abgebrochen. GPU-Speicher freigeben (andere Apps/Modelle ` +
        `schließen) oder WEEKLY_SCAN_ALLOW_CPU=true setzen.`,
    };
  }

  // Tight but acceptable: warn within ~1.5 GB of the minimum.
  const warning =
    best.freeMb < requiredFreeMb + 1500
      ? `GPU-Speicher knapp: ${best.freeMb} MB frei (${best.name}). Lauf startet, ` +
        `kann aber langsamer sein.`
      : null;

  return { ok: true, gpuPresent: true, gpu: best, warning };
}
