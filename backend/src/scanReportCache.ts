// Strukturelle Absicherung der /api/offers/scan-report-Route.
//
// Der Report-Build (buildScanReport über ~2.600 Angebote) ist rein CPU-gebunden
// und läuft mehrere Sekunden VOLL SYNCHRON — er blockiert in dieser Zeit den
// einzigen Node-Event-Loop, sodass parallele /api/health-Checks auslaufen und der
// Prozess „weg" wirkt. Das Admin-Dashboard lädt den Report beim Öffnen des
// Imports-Tabs automatisch; mehrere schnelle Aufrufe stapelten so mehrere
// Sekunden-Builds hintereinander und hungerten den Loop dauerhaft aus.
//
// ROOT CAUSE des Burst-Crashes: Der ALTE Cache hat bei abgelaufenem TTL jeden
// (auch jeden parallelen) Aufrufer auf den synchronen Build WARTEN lassen. Ein
// Burst kurz nach Ablauf des TTL blockierte damit den Event-Loop für die volle
// Build-Dauer — /api/health lief aus und ein externer/IDE-Watchdog beendete den
// Prozess (Port weg). Einzelrequests gingen, weil der Build dort fertig wurde,
// BEVOR der nächste Health-Check kam.
//
// Dieser Cache löst genau das, OHNE die fachliche Klassifikation anzufassen:
//   - In-Flight-Coalescing: gleichzeitige Aufrufe teilen sich EINEN Build. Das
//     in-flight Promise wird SYNCHRON gesetzt, BEVOR der eigentliche (synchrone)
//     Build in einem Microtask läuft — ein zweiter Build kann so nie starten.
//   - Serialize-once: der fertige Report wird EINMAL serialisiert und die
//     JSON-Payload wird vorgehalten. Warm/Burst senden den String direkt, ohne
//     dasselbe große Objekt N-mal über JSON.stringify zu jagen.
//   - Stale-while-revalidate: ist der Cache abgelaufen, wird der LETZTE gute Wert
//     SOFORT geliefert und höchstens EIN Build im Hintergrund neu gestartet. Ein
//     Burst wartet damit nie auf den blockierenden Build — der Loop bleibt frei,
//     /api/health antwortet weiter.
//   - invalidate(): nach einem Snapshot-Wechsel wird der Cache verworfen, sodass
//     der nächste Aufruf frisch (und blockierend, aber genau einmal) neu baut —
//     es wird NIE veraltete Falschzahl serviert.
//   - Ein fehlgeschlagener Build wird NICHT gecacht; ein fehlgeschlagener
//     Hintergrund-Revalidate behält den letzten guten Wert (kein „poisoned
//     cache").
//
// Pure/IO-frei und damit trivially unit-testbar (injizierbare `now`/`serialize`).

export interface ScanReportCacheOptions<T> {
  /** Wie lange (ms) ein gebauter Report als „frisch" gilt. Danach wird er per
   *  stale-while-revalidate weiter ausgeliefert und im Hintergrund erneuert. */
  ttlMs?: number;
  /** Injizierbare Zeitquelle (Tests). Default: Date.now. */
  now?: () => number;
  /** Wie der Wert zur fertigen Response-Payload serialisiert wird. Wird EINMAL
   *  pro Build aufgerufen; das Ergebnis wird vorgehalten. Default: JSON.stringify. */
  serialize?: (value: T) => string;
  /** Wie ein Hintergrund-Revalidate (stale-while-revalidate) terminiert wird.
   *  Default: setImmediate — der synchrone, mehrere Sekunden lange Build läuft so
   *  ERST, NACHDEM die (stale) Response dieses Requests rausgegangen ist, und
   *  blockiert nicht den Burst. Injizierbar für deterministische Tests. */
  scheduleRevalidate?: (run: () => void) => void;
}

/** Vorgehaltener Eintrag: das Report-Objekt UND seine fertige JSON-Payload. */
export interface ScanReportCacheEntry<T> {
  value: T;
  json: string;
}

export interface ScanReportCache<T> {
  /** Liefert das (ggf. gecachte/stale) Report-Objekt. Baut höchstens einmal pro
   *  TTL-Fenster und coalesct gleichzeitige Aufrufe zu einem einzigen Build. */
  get(build: () => T | Promise<T>): Promise<T>;
  /** Wie get(), liefert aber das Objekt UND die einmalig serialisierte JSON-
   *  Payload. Die Route sendet die Payload direkt (kein wiederholtes Stringify). */
  getEntry(build: () => T | Promise<T>): Promise<ScanReportCacheEntry<T>>;
  /** Verwirft den Cache, sodass der nächste get()/getEntry() frisch neu baut. */
  invalidate(): void;
  /** Aktuell gecachter Wert (ohne TTL-Prüfung) oder null. Nur Diagnostik. */
  peek(): T | null;
}

const DEFAULT_TTL_MS = 3000;

export function createScanReportCache<T>(
  options: ScanReportCacheOptions<T> = {},
): ScanReportCache<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const serialize = options.serialize ?? ((value: T) => JSON.stringify(value));
  const scheduleRevalidate =
    options.scheduleRevalidate ?? ((run: () => void) => void setImmediate(run));

  let cached: { entry: ScanReportCacheEntry<T>; at: number } | null = null;
  let inFlight: Promise<ScanReportCacheEntry<T>> | null = null;
  let revalidateScheduled = false;

  // Baut JETZT (höchstens einmal) und coalesct gleichzeitige Aufrufe. `inFlight`
  // wird SYNCHRON gesetzt, bevor `build()` aufgerufen wird — ein zweiter (auch
  // paralleler) Aufruf coalesct dadurch sicher auf denselben Build. Das Ergebnis
  // wird genau EINMAL serialisiert und mitsamt JSON-Payload vorgehalten.
  function buildNow(build: () => T | Promise<T>): Promise<ScanReportCacheEntry<T>> {
    if (inFlight) {
      return inFlight;
    }
    let resolve!: (entry: ScanReportCacheEntry<T>) => void;
    let reject!: (reason: unknown) => void;
    const pending = new Promise<ScanReportCacheEntry<T>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    inFlight = pending.finally(() => {
      inFlight = null;
    });
    try {
      Promise.resolve(build()).then((value) => {
        const entry: ScanReportCacheEntry<T> = { value, json: serialize(value) };
        cached = { entry, at: now() };
        resolve(entry);
      }, reject);
    } catch (error) {
      // Synchron geworfener Build-Fehler — Cache bleibt unverändert (kein poison).
      reject(error);
    }
    return inFlight;
  }

  return {
    getEntry(build: () => T | Promise<T>): Promise<ScanReportCacheEntry<T>> {
      if (cached) {
        const fresh = now() - cached.at < ttlMs;
        if (fresh) {
          return Promise.resolve(cached.entry);
        }
        // Stale-while-revalidate: den letzten guten Eintrag SOFORT liefern und den
        // (synchronen, mehrere Sekunden langen) Rebuild NUR im Hintergrund und
        // NUR EINMAL anstoßen. Entscheidend: der Build läuft per scheduleRevalidate
        // (setImmediate) ERST NACH dem Flush dieser Response — ein Burst wird so
        // nie hinter dem blockierenden Build aufgehalten, und /api/health bleibt
        // erreichbar. Ein fehlgeschlagener Revalidate behält den letzten guten
        // Eintrag (kein poisoned cache).
        const lastGood = cached.entry;
        if (!inFlight && !revalidateScheduled) {
          revalidateScheduled = true;
          scheduleRevalidate(() => {
            revalidateScheduled = false;
            void buildNow(build).catch(() => {
              /* Hintergrund-Revalidate-Fehler: letzten guten Eintrag behalten. */
            });
          });
        }
        return Promise.resolve(lastGood);
      }
      // Kalt: es gibt nichts auszuliefern → genau einmal bauen und darauf warten.
      return buildNow(build);
    },

    async get(build: () => T | Promise<T>): Promise<T> {
      const entry = await this.getEntry(build);
      return entry.value;
    },

    invalidate(): void {
      cached = null;
    },

    peek(): T | null {
      return cached ? cached.entry.value : null;
    },
  };
}
