import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appConfig } from '../../src/config/env';
import {
  categoryFromTrustedSourceDepartment,
  mapCanonicalToSimpleCategory,
  repairSimpleOfferCategory,
  simpleToCanonicalMain,
  toSimpleOfferCategory,
} from '../../src/utils/offerCategory';
import type { Offer } from '../../src/types/models';
import {
  hasHardNonFoodSignal,
  hasStrongFoodSourceSignal,
  hasStrongNonFoodSignal,
} from './offersStrictFoodFilter';

interface CanonicalCategoryPayload {
  main?: string;
  sub?: string;
  isNonFood?: boolean;
  confidence?: number;
  reasons?: string[];
}

interface CategorizedOffer extends Offer {
  canonicalCategory?: CanonicalCategoryPayload;
  foodFlag?: string;
  foodReasons?: unknown;
  nonfoodReasons?: unknown;
  offerAvailability?: unknown;
}

interface CategorizedOffersFile {
  offers?: unknown;
}

interface ReviewNeededFile {
  offers?: unknown;
}

export interface OffersCategorizerProgress {
  total: number;
  processed: number;
  batch: number;
  totalBatches: number;
  message: string;
}

export interface OffersCategorizerResult {
  offers: Offer[];
  filteredOffers: Offer[];
  warnings: string[];
  scannedCount: number;
  aiClassifiedCount: number;
  fallbackCount: number;
  reviewNeededCount: number;
  /** Items that timed out at the model (Ollama alive) and were skipped. */
  timedOutCount: number;
  /** Of those, how many became reviewNeeded with reason `ai_timeout`. */
  reviewNeededFromTimeout: number;
  /** Items corrected + flagged reviewNeeded due to a keyword↔category conflict. */
  conflictRejected: number;
  /** Title of the last item that timed out (for the admin status). */
  lastTimedOutOfferName: string | null;
  /** Last transport-level Ollama error string (for the admin status). */
  lastOllamaError: string | null;
}

export interface RunOffersCategorizerOptions {
  tryOllama: boolean;
  mode?: 'overlap' | 'starts';
  engine?: 'offers_categorizer' | 'aichef_offers';
  asOfDate?: string;
  onProgress?: (progress: OffersCategorizerProgress) => void;
  /** Cooperative cancellation. When aborted, the running Python child is killed,
   *  the temp run dir is cleaned up, and the call rejects with
   *  `PipelineCancelledError` — so callers never apply a half/cancelled run. */
  signal?: AbortSignal;
  /** Per-run override for the Ollama timeout (ms). Used by the weekly auto-scan
   *  high-quality profile (120 s) instead of the central OLLAMA_TIMEOUT_MS. */
  ollamaTimeoutMs?: number;
  /** Extra attempts for a single timed-out item before skipping it (0 = none). */
  ollamaRetries?: number;
  /** Override the Ollama model for this run (e.g. for qwen3 vs llama3.1
   *  comparison). Falls back to the env-configured model. */
  model?: string;
}

/** Thrown when a categorizer run is cancelled via the AbortSignal. Distinct
 *  from a pipeline failure so callers can report "Vom Nutzer abgebrochen"
 *  instead of an error, and so they never overwrite the snapshot. */
export class PipelineCancelledError extends Error {
  public constructor(message = 'KI-Lauf vom Nutzer abgebrochen.') {
    super(message);
    this.name = 'PipelineCancelledError';
  }
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the run was killed because the AbortSignal fired. */
  cancelled: boolean;
}

const progressPrefix = '__AICHEF_PROGRESS__';

function berlinDateIso(value = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(value);
}

function resolveProjectRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), '..', '..');
}

/** Central Ollama per-request timeout in whole seconds for the Python CLI,
 *  derived from the single OLLAMA_TIMEOUT_MS/SECONDS env config (or a per-run
 *  override, e.g. the weekly high-quality profile). Floored at 3 s. */
function ollamaTimeoutSeconds(overrideMs?: number): number {
  const ms = overrideMs && overrideMs > 0 ? overrideMs : appConfig.ollamaTimeoutMs;
  return Math.max(3, Math.round(ms / 1000));
}

function trimValue(value: string | undefined | null, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

/**
 * Reads an on/off env flag. Default is the Cheffity product default — the deals
 * detail screen needs nutrition/diet/halal data, so these enrich by default.
 * Set CHEFFITY_OFFERS_NUTRITION/_DIET/_HALAL to "off"/"0"/"false" to disable
 * (e.g. for a faster scan when OpenFoodFacts/BLS lookups slow a run down).
 */
function envFlagOnOff(name: string, fallbackOn: boolean): 'on' | 'off' {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallbackOn ? 'on' : 'off';
  if (['off', '0', 'false', 'no'].includes(raw)) return 'off';
  if (['on', '1', 'true', 'yes'].includes(raw)) return 'on';
  return fallbackOn ? 'on' : 'off';
}

function isNonFoodOffer(offer: CategorizedOffer): boolean {
  if (typeof offer.foodFlag === 'string') {
    return offer.foodFlag === 'nonfood';
  }
  return offer.canonicalCategory?.isNonFood === true;
}

/**
 * Re-mark an offer with a strong non-food signal as non-food: set
 * `foodFlag="nonfood"` and `canonicalCategory.isNonFood=true` so every downstream
 * consumer (`isNonFoodOffer`, the strict filter, the week split, the app) treats
 * it as non-food. Adds a traceable `repair:strong_nonfood` reason. Never touches
 * price/validity/store/image — only the food classification.
 */
function markOfferStrongNonFood(offer: CategorizedOffer): CategorizedOffer {
  const prior = offer.canonicalCategory ?? {};
  const reasons = Array.isArray(prior.reasons) ? prior.reasons : [];
  return {
    ...offer,
    foodFlag: 'nonfood',
    canonicalCategory: {
      ...prior,
      isNonFood: true,
      reasons: reasons.includes('repair:strong_nonfood')
        ? reasons
        : [...reasons, 'repair:strong_nonfood'],
    },
  };
}

/**
 * Shared strong-non-food repair (Scan 1.0 + 2.0): move every live offer that
 * carries an unambiguous non-food signal (LIVARNO / Insektenschutz, see
 * {@link hasStrongNonFoodSignal}) into the filtered bucket and mark it non-food.
 * Pure — returns new arrays and never mutates the inputs. Both engine branches of
 * {@link runOffersCategorizerPipeline} feed through here, so it applies uniformly.
 */
export function repairStrongNonFoodOffers<T extends Offer>(
  liveOffers: readonly T[],
  filteredOffers: readonly T[],
): { live: T[]; filtered: T[]; repaired: number } {
  const live: T[] = [];
  const filtered: T[] = [...filteredOffers];
  let repaired = 0;
  for (const offer of liveOffers) {
    if (hasStrongNonFoodSignal(offer)) {
      filtered.push(markOfferStrongNonFood(offer as CategorizedOffer) as unknown as T);
      repaired += 1;
    } else {
      live.push(offer);
    }
  }
  return { live, filtered, repaired };
}

/**
 * Counterpart to {@link repairStrongNonFoodOffers}: rescue offers the MODEL
 * classified as non-food although the retailer's own raw source category says
 * food ("Frühstück" coffee pads, "Frische & Convenience" Würstchen) and no
 * rule-based non-food signal exists. The model verdict is overridden with a
 * traceable `repair:food_source_category` reason; the canonical main is
 * cleared so the (wrong) "Non-Food" main can never map into `category`.
 * Pure — returns new arrays, never mutates inputs.
 */
export function rescueStrongFoodOffers<T extends Offer>(
  liveOffers: readonly T[],
  filteredOffers: readonly T[],
): { live: T[]; filtered: T[]; rescued: number } {
  const live: T[] = [...liveOffers];
  const filtered: T[] = [];
  let rescued = 0;
  for (const offer of filteredOffers) {
    const categorized = offer as CategorizedOffer;
    if (isNonFoodOffer(categorized) && hasStrongFoodSourceSignal(offer)) {
      const prior = categorized.canonicalCategory ?? {};
      const reasons = Array.isArray(prior.reasons) ? prior.reasons : [];
      live.push({
        ...offer,
        foodFlag: 'food',
        canonicalCategory: {
          ...prior,
          main: undefined,
          isNonFood: false,
          reasons: reasons.includes('repair:food_source_category')
            ? reasons
            : [...reasons, 'repair:food_source_category'],
        },
      } as T);
      rescued += 1;
    } else {
      filtered.push(offer);
    }
  }
  return { live, filtered, rescued };
}

function stripStaleFoodState(offer: CategorizedOffer): CategorizedOffer {
  const next = { ...offer };
  delete next.foodFlag;
  delete next.foodReasons;
  delete next.nonfoodReasons;
  delete next.offerAvailability;
  return next;
}

// Übernimmt die (reichhaltige) kanonische Kategorie der Python-Pipeline in das
// einfache `category`-Feld, das Admin/Datenqualität/Mobile-Fallback lesen.
// Bisher wurde `canonicalCategory.main` verworfen, sodass viele Angebote trotz
// guter KI-Klassifizierung als "Sonstiges" liegen blieben. Nur sichere
// Food-Treffer überschreiben — unsichere/Non-Food bleiben unverändert (Review).
function applyCanonicalSimpleCategory(offer: CategorizedOffer): CategorizedOffer {
  const mapped = mapCanonicalToSimpleCategory(offer.canonicalCategory ?? null);
  if (!mapped || mapped === offer.category) {
    return offer;
  }
  return { ...offer, category: mapped };
}

// Repariert wenige, eindeutige Kategorie-Fehlgriffe anhand des Produktnamens
// (Grillkäse≠Getränke, Milchreis≠Obst, Falafel≠Obst, Barilla/Knorr Fix→
// Trockenware, Nimm 2 Lachgummi→Snacks, Spargel/Kiwi→Obst). Läuft NACH der
// kanonischen Übernahme und nur auf Food (Live), damit weniger Angebote als
// "Sonstiges"/falsch live bleiben. Pure + hochpräzise (siehe offerCategory).
/**
 * Repariert den kanonischen "Getränke alkoholfrei"-Fehlgriff des Modells, wenn
 * der NAME regelbasiert eindeutig Alkohol ist (Grappa/Likör/% Vol …). Der
 * Konflikt "Grappa = alkoholfrei" ist in sich widersprüchlich — die präzise
 * Namensregel gewinnt, nachvollziehbar via repair:alcohol_conflict.
 */
export function repairCanonicalAlcoholConflict(offer: CategorizedOffer): CategorizedOffer {
  const canonical = offer.canonicalCategory;
  if (!canonical || canonical.main !== 'Getränke alkoholfrei') {
    return offer;
  }
  if (toSimpleOfferCategory(undefined, offer.name) !== 'Alkohol') {
    return offer;
  }
  const reasons = Array.isArray(canonical.reasons) ? canonical.reasons : [];
  return {
    ...offer,
    canonicalCategory: {
      ...canonical,
      main: 'Alkohol',
      reasons: reasons.includes('repair:alcohol_conflict')
        ? reasons
        : [...reasons, 'repair:alcohol_conflict'],
    },
  };
}

// Plant-based products whose NAME carries a meat/fish noun ("Vegane Mühlen
// Rostbratwürstchen", "Veganer Aufschnitt", "veganes Filet") must NOT be
// confidently classified as Fleisch/Fisch (P3). "vegan" is a hard signal: a
// vegan sausage is a meat SUBSTITUTE, never meat. Generic claim only, no brand
// list. Word-boundary matched so "vegan" never hides inside another word.
const VEGAN_CLAIM_PATTERN = /(?:^|\s|-)(?:vegan(?:e[rnms]?)?|vegetarisch(?:e[rnms]?)?|veggie|pflanzlich(?:e[rnms]?)?)(?:$|\s|-)/i;

/**
 * Resolve the "vegan product carries a meat/fish noun" conflict (P3). When the
 * name is explicitly vegan/vegetarian but the model placed it in "Fleisch & Wurst"
 * or "Fisch & Meeresfrüchte", we move it to the plant bucket ("Feinkost & Kühlung"
 * / "Tofu & Veggie" → simple "Milchalternativen") and flag it reviewNeeded with a
 * precise reason — the most conservative honest choice within the existing
 * taxonomy, never silently leaving a vegan item as meat.
 */
export function repairCanonicalVeganMeatConflict(offer: CategorizedOffer): CategorizedOffer {
  const canonical = offer.canonicalCategory;
  if (!canonical || (canonical.main !== 'Fleisch & Wurst' && canonical.main !== 'Fisch & Meeresfrüchte')) {
    return offer;
  }
  if (!VEGAN_CLAIM_PATTERN.test(` ${offer.name} `)) {
    return offer;
  }
  const reasons = Array.isArray(canonical.reasons) ? canonical.reasons : [];
  const existing = offer as CategorizedOffer & { reviewReason?: unknown };
  const priorReason = typeof existing.reviewReason === 'string' && existing.reviewReason ? existing.reviewReason : '';
  const reviewReason = priorReason.includes('vegan_meat_conflict')
    ? priorReason
    : [priorReason, 'vegan_meat_conflict'].filter(Boolean).join(',');
  return {
    ...offer,
    reviewNeeded: true,
    reviewReason,
    canonicalCategory: {
      ...canonical,
      main: 'Feinkost & Kühlung',
      sub: 'Tofu & Veggie',
      reasons: reasons.includes('repair:vegan_meat_conflict')
        ? reasons
        : [...reasons, 'repair:vegan_meat_conflict'],
    },
  } as CategorizedOffer;
}

/**
 * Quellenpriorität für die FINALE Kategorie (Task P3): eine vertrauenswürdige,
 * eindeutige Händler-Abteilung (sourceCategoryRaw/sourceDepartmentRaw) gewinnt
 * gegen schwache Produktnamen-, Keyword-, Cache- und Modell-Signale. Läuft als
 * LETZTER Kategorieschritt, damit weder die kanonische Übernahme noch die
 * Namens-Reparatur die feste Quellkategorie überschreiben — und es richtet
 * canonicalCategory.main mit, damit ein späterer Cache-/Python-Pass sie nicht
 * über die kanonische Kategorie zurückdreht.
 *
 * Guards: greift NIE für ein Non-Food-Angebot oder eines mit hartem Non-Food-
 * Signal — ein Gerät wie "Pizzamaker" wird so nie wegen "Pizza" zu Food/Tiefkühl,
 * ein "GIN TONIC Damen-Slipper" nie wegen "GIN TONIC" zu Alkohol. Pure.
 */
export function applyTrustedSourceCategory(offer: CategorizedOffer): CategorizedOffer {
  if (isNonFoodOffer(offer) || hasHardNonFoodSignal(offer)) {
    return offer;
  }
  const o = offer as CategorizedOffer & {
    sourceCategoryRaw?: unknown;
    sourceDepartmentRaw?: unknown;
  };
  const rawDepartment = `${String(o.sourceCategoryRaw ?? '')} ${String(o.sourceDepartmentRaw ?? '')}`;
  const forced = categoryFromTrustedSourceDepartment(rawDepartment);
  if (!forced || forced === offer.category) {
    return offer;
  }
  const prior = offer.canonicalCategory ?? {};
  const reasons = Array.isArray(prior.reasons) ? prior.reasons : [];
  const canonicalMain = simpleToCanonicalMain(forced);
  const nextMain = canonicalMain ?? prior.main;
  // Wechselt die Hauptkategorie, ist die von Python gewählte Unterkategorie für
  // die ALTE main abgeleitet worden und gilt hier nicht mehr. Python beendet
  // apply_auto_repair mit einer Gültigkeitsprüfung (sub muss zur main gehören);
  // dieser TS-Schritt läuft danach und hat die Taxonomie nicht — er würde sonst
  // unmögliche Paare erzeugen. Beobachtet im Lauf 2026-08-17: "Reine
  // Buttermilch" als Tiefkühl/Milch, "Zitronen" als Tiefkühl/Obst,
  // "Back-Camembert" als Tiefkühl/Käse. `unknown` ist ehrlich, eine fremde
  // Unterkategorie ist irreführend — der nächste Python-Pass leitet sie neu ab.
  const mainChanged = Boolean(nextMain) && nextMain !== prior.main;
  const nextSub = mainChanged ? 'unknown' : prior.sub;
  return {
    ...offer,
    category: forced,
    canonicalCategory: {
      ...prior,
      // Kanonische Hauptkategorie mit der Quellkategorie ausrichten (sofern
      // eindeutig mappbar), damit ein Re-Run/Cache sie nicht zurückdreht.
      main: nextMain,
      sub: nextSub,
      isNonFood: false,
      confidence: typeof prior.confidence === 'number' ? Math.max(prior.confidence, 0.95) : 0.95,
      reasons: reasons.includes('repair:trusted_source_category')
        ? reasons
        : [...reasons, 'repair:trusted_source_category'],
    },
  };
}

function repairSimpleCategoryOnOffer(offer: CategorizedOffer): CategorizedOffer {
  const repaired = repairSimpleOfferCategory({
    name: offer.name,
    brand: offer.brand,
    category: offer.category,
  });
  if (repaired === offer.category) {
    return offer;
  }
  return { ...offer, category: repaired };
}

function countAiClassifiedOffers(offers: CategorizedOffer[]): number {
  let count = 0;

  for (const offer of offers) {
    const reasons = offer.canonicalCategory?.reasons;
    if (!Array.isArray(reasons)) {
      continue;
    }

    // Real KI = a fresh "llm" reason OR a versioned "cache:hit" (the cache now
    // only holds valid, current-schema answers). Conflict-corrected results have
    // these markers stripped in Python, so they correctly do NOT count as KI.
    const hasAiReason = reasons.some((reason) => {
      const s = String(reason).toLowerCase();
      return s.includes('llm') || s === 'cache:hit';
    });
    if (hasAiReason) {
      count += 1;
    }
  }

  return count;
}

function parseOffersPayload(payload: unknown): CategorizedOffer[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const rawOffers = (payload as CategorizedOffersFile).offers;
  if (!Array.isArray(rawOffers)) {
    return [];
  }

  return rawOffers.filter((item): item is CategorizedOffer => {
    return (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Offer).id === 'string' &&
      typeof (item as Offer).name === 'string' &&
      typeof (item as Offer).storeChain === 'string'
    );
  });
}

function parseReviewNeededCount(payload: unknown): number {
  if (!payload || typeof payload !== 'object') {
    return 0;
  }
  const rawOffers = (payload as ReviewNeededFile).offers;
  return Array.isArray(rawOffers) ? rawOffers.length : 0;
}

function readJsonFile(filePath: string): Promise<unknown> {
  return fs
    .readFile(filePath, 'utf8')
    .then((raw) => JSON.parse(raw));
}

function runSpawn(
  command: string,
  args: string[],
  cwd: string,
  onStdoutLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: 'cancelled', cancelled: true });
      return;
    }

    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutLineBuffer = '';
    let cancelled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const onAbort = (): void => {
      cancelled = true;
      // SIGTERM first so Python can unwind; force-kill shortly after if it
      // ignores the signal (a urllib request blocked on Ollama can be stubborn).
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 2000);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      stdoutLineBuffer += text;

      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        onStdoutLine?.(trimmed);
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const cleanup = (): void => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      cleanup();
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n${message}`.trim(),
        cancelled,
      });
    });

    child.on('close', (code) => {
      cleanup();
      const finalLine = stdoutLineBuffer.trim();
      if (finalLine) {
        onStdoutLine?.(finalLine);
      }
      resolve({
        code,
        stdout,
        stderr,
        cancelled,
      });
    });
  });
}

async function runOffersCategorizerCli(options: {
  projectRoot: string;
  inputDir: string;
  outDir: string;
  mode: 'overlap' | 'starts';
  tryOllama: boolean;
  onProgress?: (progress: OffersCategorizerProgress) => void;
  signal?: AbortSignal;
  ollamaTimeoutMs?: number;
  ollamaRetries?: number;
  model?: string;
}): Promise<void> {
  const model = trimValue(
    options.model ?? process.env.VITE_OLLAMA_MODEL ?? process.env.OLLAMA_MODEL,
    appConfig.ollamaModel,
  );
  const host = trimValue(
    process.env.VITE_OLLAMA_HOST ?? process.env.OLLAMA_HOST,
    appConfig.ollamaHost,
  );

  const baseArgs = [
    '-m',
    'offers_categorizer',
    '--input',
    options.inputDir,
    '--out',
    options.outDir,
    '--mode',
    options.mode,
    '--ollama',
    options.tryOllama ? 'on' : 'off',
    '--model',
    model,
    '--ollama-host',
    host,
    // Central Ollama robustness config (env-driven) handed to the Python CLI.
    '--ollama-timeout',
    String(ollamaTimeoutSeconds(options.ollamaTimeoutMs)),
    '--ollama-max-consecutive-failures',
    String(appConfig.ollamaMaxConsecutiveFailures),
    '--ollama-retries',
    String(Math.max(0, Math.round(options.ollamaRetries ?? 0))),
    '--dump-stats',
  ];

  const configuredPython = process.env.PYTHON_BIN?.trim();
  const candidates: Array<{ cmd: string; args: string[]; label: string }> = [];
  if (configuredPython) {
    candidates.push({
      cmd: configuredPython,
      args: baseArgs,
      label: configuredPython,
    });
  }
  if (process.platform === 'win32') {
    candidates.push({
      cmd: 'py',
      args: ['-3', ...baseArgs],
      label: 'py -3',
    });
  }
  candidates.push(
    { cmd: 'python', args: baseArgs, label: 'python' },
    { cmd: 'python3', args: baseArgs, label: 'python3' },
  );

  const errors: string[] = [];

  const handleStdoutLine = (line: string): void => {
    if (!line.startsWith(progressPrefix)) {
      return;
    }

    const rawPayload = line.slice(progressPrefix.length).trim();
    if (!rawPayload) {
      return;
    }

    try {
      const payload = JSON.parse(rawPayload) as Partial<OffersCategorizerProgress>;
      const total = Number(payload.total);
      const processed = Number(payload.processed);
      const batch = Number(payload.batch);
      const totalBatches = Number(payload.totalBatches);
      const message =
        typeof payload.message === 'string' && payload.message.trim().length > 0
          ? payload.message.trim()
          : 'Kategorie-Pipeline';

      options.onProgress?.({
        total: Number.isFinite(total) ? Math.max(0, total) : 0,
        processed: Number.isFinite(processed) ? Math.max(0, processed) : 0,
        batch: Number.isFinite(batch) ? Math.max(0, batch) : 0,
        totalBatches: Number.isFinite(totalBatches)
          ? Math.max(0, totalBatches)
          : 0,
        message,
      });
    } catch {
      // Ignore malformed progress lines and continue.
    }
  };

  for (const candidate of candidates) {
    if (options.signal?.aborted) {
      throw new PipelineCancelledError();
    }
    const result = await runSpawn(
      candidate.cmd,
      candidate.args,
      options.projectRoot,
      handleStdoutLine,
      options.signal,
    );
    if (result.cancelled || options.signal?.aborted) {
      throw new PipelineCancelledError();
    }
    if (result.code === 0) {
      return;
    }

    const detail = (result.stderr || result.stdout || `exit=${result.code ?? 'null'}`)
      .trim()
      .replace(/\s+/g, ' ');
    errors.push(`${candidate.label}: ${detail}`);
  }

  throw new Error(
    `Kategorie-Pipeline konnte nicht gestartet werden. Details: ${errors.join(' | ')}`,
  );
}

async function runAichefOffersCli(options: {
  projectRoot: string;
  inputDir: string;
  outDir: string;
  mode: 'overlap' | 'starts';
  tryOllama: boolean;
  asOfDate?: string;
  onProgress?: (progress: OffersCategorizerProgress) => void;
  signal?: AbortSignal;
  ollamaTimeoutMs?: number;
  ollamaRetries?: number;
  model?: string;
}): Promise<void> {
  const model = trimValue(
    options.model ?? process.env.VITE_OLLAMA_MODEL ?? process.env.OLLAMA_MODEL,
    appConfig.ollamaModel,
  );
  const host = trimValue(
    process.env.VITE_OLLAMA_HOST ?? process.env.OLLAMA_HOST,
    appConfig.ollamaHost,
  );

  const baseArgs = [
    '-m',
    'aichef_offers',
    '--input',
    options.inputDir,
    '--out',
    options.outDir,
    '--mode',
    options.mode,
    '--as-of',
    options.asOfDate && options.asOfDate.trim().length > 0
      ? options.asOfDate.trim()
      : berlinDateIso(),
    '--ollama',
    options.tryOllama ? 'on' : 'off',
    '--ollama-url',
    host,
    '--ollama-model',
    model,
    '--include-locked',
    'on',
    '--emit-visible',
    'on',
    // Central Ollama robustness config (env-driven). Same timeout feeds both
    // the OFF nutrition client and the base category LLM; fail-fast aborts the
    // run after N consecutive Ollama transport errors.
    '--ollama-timeout',
    String(ollamaTimeoutSeconds(options.ollamaTimeoutMs)),
    '--ollama-max-consecutive-failures',
    String(appConfig.ollamaMaxConsecutiveFailures),
    // Per-item retry budget for a single slow product (default 0).
    '--ollama-retries',
    String(Math.max(0, Math.round(options.ollamaRetries ?? 0))),
    // Cheffity deals detail needs these; default ON, env-overridable for perf.
    '--nutrition',
    envFlagOnOff('CHEFFITY_OFFERS_NUTRITION', true),
    '--diet',
    envFlagOnOff('CHEFFITY_OFFERS_DIET', true),
    '--halal',
    envFlagOnOff('CHEFFITY_OFFERS_HALAL', true),
    '--dump-stats',
  ];

  const configuredPython = process.env.PYTHON_BIN?.trim();
  const candidates: Array<{ cmd: string; args: string[]; label: string }> = [];
  if (configuredPython) {
    candidates.push({
      cmd: configuredPython,
      args: baseArgs,
      label: configuredPython,
    });
  }
  if (process.platform === 'win32') {
    candidates.push({
      cmd: 'py',
      args: ['-3', ...baseArgs],
      label: 'py -3',
    });
  }
  candidates.push(
    { cmd: 'python', args: baseArgs, label: 'python' },
    { cmd: 'python3', args: baseArgs, label: 'python3' },
  );

  const errors: string[] = [];
  const handleStdoutLine = (line: string): void => {
    if (!line.startsWith(progressPrefix)) {
      return;
    }

    const rawPayload = line.slice(progressPrefix.length).trim();
    if (!rawPayload) {
      return;
    }

    try {
      const payload = JSON.parse(rawPayload) as Partial<OffersCategorizerProgress>;
      const total = Number(payload.total);
      const processed = Number(payload.processed);
      const batch = Number(payload.batch);
      const totalBatches = Number(payload.totalBatches);
      const message =
        typeof payload.message === 'string' && payload.message.trim().length > 0
          ? payload.message.trim()
          : 'AIChef-Offers-Pipeline';

      options.onProgress?.({
        total: Number.isFinite(total) ? Math.max(0, total) : 0,
        processed: Number.isFinite(processed) ? Math.max(0, processed) : 0,
        batch: Number.isFinite(batch) ? Math.max(0, batch) : 0,
        totalBatches: Number.isFinite(totalBatches)
          ? Math.max(0, totalBatches)
          : 0,
        message,
      });
    } catch {
      // Ignore malformed progress lines and continue.
    }
  };

  for (const candidate of candidates) {
    if (options.signal?.aborted) {
      throw new PipelineCancelledError();
    }
    const result = await runSpawn(
      candidate.cmd,
      candidate.args,
      options.projectRoot,
      handleStdoutLine,
      options.signal,
    );
    if (result.cancelled || options.signal?.aborted) {
      throw new PipelineCancelledError();
    }
    if (result.code === 0) {
      return;
    }
    const detail = (result.stderr || result.stdout || `exit=${result.code ?? 'null'}`)
      .trim()
      .replace(/\s+/g, ' ');
    errors.push(`${candidate.label}: ${detail}`);
  }

  throw new Error(
    `AIChef-Offers-Pipeline konnte nicht gestartet werden. Details: ${errors.join(' | ')}`,
  );
}

function parseAichefReviewNeededCount(payload: unknown): number {
  if (!payload || typeof payload !== 'object') {
    return 0;
  }
  const base = (payload as { base?: unknown }).base;
  if (!base || typeof base !== 'object') {
    return 0;
  }
  const raw = (base as { review_needed?: unknown }).review_needed;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function parseAichefScannedCount(
  payload: unknown,
  fallback: number,
): number {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }
  const base = (payload as { base?: unknown }).base;
  if (!base || typeof base !== 'object') {
    return fallback;
  }
  const raw = (base as { unique_offers?: unknown }).unique_offers;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, numeric);
}

function parseAichefLockedCount(payload: unknown): number {
  if (!payload || typeof payload !== 'object') {
    return 0;
  }
  const raw = (payload as { locked?: unknown }).locked;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

export interface OllamaRunDiagnostics {
  classifiedByAi: number;
  timedOut: number;
  reviewNeededFromTimeout: number;
  /** Items whose category contradicted strong keyword signals and were corrected
   *  + flagged reviewNeeded (NOT counted as clean KI). */
  conflictRejected: number;
  lastTimedOutOfferName: string | null;
  lastOllamaError: string | null;
}

function numField(obj: Record<string, unknown>, key: string): number {
  const n = Number(obj[key]);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function strField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Extract the Ollama run diagnostics the Python pipeline writes under
 * `stats.base` (ai_classified / ai_timeouts / ai_review_timeout / last_*). Safe
 * against missing fields (older pipeline output → all zero/null).
 */
export function parseOllamaRunDiagnostics(payload: unknown): OllamaRunDiagnostics {
  const empty: OllamaRunDiagnostics = {
    classifiedByAi: 0,
    timedOut: 0,
    reviewNeededFromTimeout: 0,
    conflictRejected: 0,
    lastTimedOutOfferName: null,
    lastOllamaError: null,
  };
  if (!payload || typeof payload !== 'object') return empty;
  const base = (payload as { base?: unknown }).base;
  if (!base || typeof base !== 'object') return empty;
  const b = base as Record<string, unknown>;
  return {
    classifiedByAi: numField(b, 'ai_classified'),
    timedOut: numField(b, 'ai_timeouts'),
    reviewNeededFromTimeout: numField(b, 'ai_review_timeout'),
    conflictRejected: numField(b, 'ai_conflict_rejected'),
    lastTimedOutOfferName: strField(b, 'last_timeout_offer'),
    lastOllamaError: strField(b, 'last_ollama_error'),
  };
}

export async function runOffersCategorizerPipeline(
  sourceOffers: Offer[],
  options: RunOffersCategorizerOptions,
): Promise<OffersCategorizerResult> {
  const total = sourceOffers.length;
  options.onProgress?.({
    total,
    processed: 0,
    batch: 0,
    totalBatches: total,
    message: 'Kategorie-Pipeline gestartet',
  });

  if (total === 0) {
    options.onProgress?.({
      total,
      processed: 0,
      batch: 0,
      totalBatches: 0,
      message: 'Keine Angebote zum Kategorisieren',
    });
    return {
      offers: [],
      filteredOffers: [],
      warnings: [],
      scannedCount: 0,
      aiClassifiedCount: 0,
      fallbackCount: 0,
      reviewNeededCount: 0,
      timedOutCount: 0,
      reviewNeededFromTimeout: 0,
      conflictRejected: 0,
      lastTimedOutOfferName: null,
      lastOllamaError: null,
    };
  }

  const projectRoot = resolveProjectRoot();
  const runRoot = path.join(projectRoot, 'backend', 'data', 'categorizer-runs');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const runDir = path.join(runRoot, runId);
  const inputDir = path.join(runDir, 'input');
  const outDir = path.join(runDir, 'out');
  const inputFile = path.join(inputDir, 'offers.json');
  const categorizedFile = path.join(outDir, 'categorized_offers.json');
  const reviewFile = path.join(outDir, 'review_needed.json');
  const allInWeekFile = path.join(outDir, 'all_in_week.json');
  const visibleInWeekFile = path.join(outDir, 'visible_in_week.json');
  const foodAllFile = path.join(outDir, 'food_all.json');
  const flaggedNonFoodFile = path.join(outDir, 'flagged_nonfood.json');
  const statsFile = path.join(outDir, 'stats.json');
  const engine = options.engine ?? 'offers_categorizer';

  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    inputFile,
    JSON.stringify({ offers: sourceOffers }, null, 2),
    'utf8',
  );

  try {
    let liveOffers: CategorizedOffer[] = [];
    let filteredOffers: CategorizedOffer[] = [];
    let reviewNeededCount = 0;
    let scannedCount = 0;
    let lockedCount = 0;
    let diagnostics: OllamaRunDiagnostics = {
      classifiedByAi: 0,
      timedOut: 0,
      reviewNeededFromTimeout: 0,
      conflictRejected: 0,
      lastTimedOutOfferName: null,
      lastOllamaError: null,
    };

    if (engine === 'aichef_offers') {
      await runAichefOffersCli({
        projectRoot,
        inputDir,
        outDir,
        mode: options.mode ?? appConfig.offerWeekMode,
        tryOllama: options.tryOllama,
        asOfDate: options.asOfDate,
        onProgress: options.onProgress,
        signal: options.signal,
        ollamaTimeoutMs: options.ollamaTimeoutMs,
        ollamaRetries: options.ollamaRetries,
        model: options.model,
      });

      const foodAllPayload = await readJsonFile(foodAllFile).catch(() => ({}));
      const visiblePayload = await readJsonFile(visibleInWeekFile).catch(() => ({}));
      const allInWeekPayload = await readJsonFile(allInWeekFile).catch(() => ({}));
      const nonfoodPayload = await readJsonFile(flaggedNonFoodFile).catch(() => ({}));
      const statsPayload = await readJsonFile(statsFile).catch(() => ({}));
      diagnostics = parseOllamaRunDiagnostics(statsPayload);

      const foodAllOffers = parseOffersPayload(foodAllPayload);
      const visibleOffers = parseOffersPayload(visiblePayload);
      const allInWeekOffers = parseOffersPayload(allInWeekPayload);
      const allNonfoodOffers = parseOffersPayload(nonfoodPayload);
      // Prefer the FULL food set (all weeks) so the snapshot week-split keeps
      // next-week offers. Fall back to this-week files for older pipeline
      // outputs that don't emit food_all.json yet.
      const allLiveCandidates =
        foodAllOffers.length > 0
          ? foodAllOffers
          : allInWeekOffers.length > 0
            ? allInWeekOffers
            : visibleOffers;
      liveOffers = allLiveCandidates.filter((offer) => !isNonFoodOffer(offer));
      filteredOffers = allNonfoodOffers.length > 0
        ? allNonfoodOffers
        : allLiveCandidates.filter((offer) => isNonFoodOffer(offer));

      reviewNeededCount = parseAichefReviewNeededCount(statsPayload);
      scannedCount = parseAichefScannedCount(
        statsPayload,
        liveOffers.length + filteredOffers.length,
      );
      lockedCount = parseAichefLockedCount(statsPayload);
    } else {
      await runOffersCategorizerCli({
        projectRoot,
        inputDir,
        outDir,
        mode: options.mode ?? appConfig.offerWeekMode,
        tryOllama: options.tryOllama,
        onProgress: options.onProgress,
        signal: options.signal,
        ollamaTimeoutMs: options.ollamaTimeoutMs,
        ollamaRetries: options.ollamaRetries,
        model: options.model,
      });

      const categorizedPayload = await readJsonFile(categorizedFile);
      const offers = parseOffersPayload(categorizedPayload).map(stripStaleFoodState);
      const reviewPayload = await readJsonFile(reviewFile).catch(() => ({}));
      reviewNeededCount = parseReviewNeededCount(reviewPayload);
      liveOffers = offers.filter((offer) => !isNonFoodOffer(offer));
      filteredOffers = offers.filter((offer) => isNonFoodOffer(offer));
      scannedCount = offers.length;
    }

    // Starke Non-Food-Reparatur (geteilt von Scan 1.0 + 2.0): Marken/Begriffe wie
    // LIVARNO / Insektenschutz sind eindeutig Non-Food, selbst wenn das Modell nur
    // foodFlag="unsure" / isNonFood=false geliefert hat. Solche Treffer werden hier
    // ehrlich als Non-Food markiert und aus dem Live-Bucket in `filtered`
    // verschoben — derselbe Pipeline-Pfad nutzen alle Scans, also greift es überall.
    const repair = repairStrongNonFoodOffers(liveOffers, filteredOffers);
    liveOffers = repair.live;
    filteredOffers = repair.filtered;
    const strongNonFoodRepaired = repair.repaired;

    // Gegenstück: vom Modell fälschlich als Non-Food einsortierte Angebote
    // zurückholen, wenn die Händler-Quellkategorie eindeutig Food ist
    // (Frühstück/Frische & Convenience/Wurst …) und keine Regel widerspricht.
    const foodRescue = rescueStrongFoodOffers(liveOffers, filteredOffers);
    liveOffers = foodRescue.live;
    filteredOffers = foodRescue.filtered;
    const strongFoodRescued = foodRescue.rescued;

    // Kanonische KI-Kategorie ins einfache `category`-Feld übernehmen (beide
    // Engines liefern dasselbe canonicalCategory-Format).
    liveOffers = liveOffers
      .map(repairCanonicalAlcoholConflict)
      .map(repairCanonicalVeganMeatConflict)
      .map(applyCanonicalSimpleCategory)
      .map(repairSimpleCategoryOnOffer)
      // Quellenpriorität als LETZTER Schritt: vertrauenswürdige Quellabteilung
      // gewinnt über Name/Keyword/Cache/Modell (Task P3).
      .map(applyTrustedSourceCategory);
    filteredOffers = filteredOffers.map(applyCanonicalSimpleCategory);

    const combinedOffers = [...liveOffers, ...filteredOffers];
    const aiClassifiedCount = countAiClassifiedOffers(combinedOffers);

    options.onProgress?.({
      total,
      processed: total,
      batch: total,
      totalBatches: total,
      message: 'Kategorie-Pipeline abgeschlossen',
    });

    const warnings: string[] = [];
    if (strongNonFoodRepaired > 0) {
      warnings.push(
        `Non-Food-Reparatur: ${strongNonFoodRepaired} Angebot(e) mit starkem Non-Food-Signal (z. B. LIVARNO/Insektenschutz) nach Filtered verschoben.`,
      );
    }
    if (strongFoodRescued > 0) {
      warnings.push(
        `Food-Rettung: ${strongFoodRescued} Angebot(e) mit eindeutiger Food-Quellkategorie aus Filtered zurückgeholt (Modell-Fehlklassifikation).`,
      );
    }
    if (reviewNeededCount > 0) {
      warnings.push(
        `Kategorie-Review empfohlen: ${reviewNeededCount} Angebot(e) mit niedriger Sicherheit.`,
      );
    }
    if (engine === 'aichef_offers' && lockedCount > 0) {
      warnings.push(
        `${lockedCount} Angebot(e) sind noch gesperrt und werden erst zum Startdatum sichtbar.`,
      );
    }
    if (diagnostics.timedOut > 0) {
      warnings.push(
        `${diagnostics.timedOut} Produkt(e) per KI-Timeout übersprungen (als Review markiert)` +
          `${diagnostics.lastTimedOutOfferName ? `, zuletzt: ${diagnostics.lastTimedOutOfferName}` : ''}.`,
      );
    }
    if (diagnostics.conflictRejected > 0) {
      warnings.push(
        `${diagnostics.conflictRejected} Angebot(e) wegen Kategorie-Konflikt korrigiert + zur Review markiert.`,
      );
    }

    return {
      offers: liveOffers,
      filteredOffers,
      warnings,
      scannedCount,
      aiClassifiedCount,
      fallbackCount: Math.max(0, scannedCount - aiClassifiedCount),
      reviewNeededCount,
      timedOutCount: diagnostics.timedOut,
      reviewNeededFromTimeout: diagnostics.reviewNeededFromTimeout,
      conflictRejected: diagnostics.conflictRejected,
      lastTimedOutOfferName: diagnostics.lastTimedOutOfferName,
      lastOllamaError: diagnostics.lastOllamaError,
    };
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Remove leftover `backend/data/categorizer-runs/<run>` directories older than
 * `maxAgeMs`. A normal run cleans its own dir in `finally`, but a crashed,
 * hard-killed, or pre-cancellation run could leave one behind. This is
 * intentionally conservative: it only ever touches the temp run-dir tree, never
 * snapshots or any user data, and only entries genuinely older than the cutoff.
 *
 * Disabled by default (server passes a 0/negative age to skip). Returns the
 * list of removed run IDs so callers can log what they cleaned.
 */
export async function cleanupStaleCategorizerRuns(
  maxAgeMs: number,
  projectRoot: string = resolveProjectRoot(),
): Promise<string[]> {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return [];
  }
  const runRoot = path.join(projectRoot, 'backend', 'data', 'categorizer-runs');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(runRoot, { withFileTypes: true });
  } catch {
    return []; // no run-dir tree yet — nothing to clean
  }

  const cutoff = Date.now() - maxAgeMs;
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runRoot, entry.name);
    try {
      const stat = await fs.stat(dir);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(dir, { recursive: true, force: true });
        removed.push(entry.name);
      }
    } catch {
      // Skip entries we cannot stat/remove; never fail the caller.
    }
  }
  return removed;
}
