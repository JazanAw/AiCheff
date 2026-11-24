// Strukturelle Prozess-Lifecycle-Protokollierung.
//
// HINTERGRUND / ECHTE URSACHE des „Prozess weg, kein Stacktrace"-Effekts:
// Das Backend lief in der bisherigen Betriebsart als ENKELPROZESS einer
// kurzlebigen Start-Shell:  cmd (Start-Process)  →  node (tsx-CLI)  →  node (Server).
// Der Server, der Port 8787 hält, ist damit an die Lebensdauer dieser Launcher-
// Kette gebunden. Verschwindet die Start-Shell/Konsole (Terminal geschlossen,
// Tool-/PowerShell-Session beendet, Parent-Prozess getötet), reißt Windows den
// GANZEN Baum über ein Konsolen-Close-/Terminierungs-Ereignis ab. Das ist eine
// SAUBERE Beendigung — es wird KEINE JS-Exception geworfen, also gibt es auch
// KEINEN Stacktrace auf stdout/stderr. Genau das erklärt das beobachtete
// „Server plötzlich weg, Port weg, keine Fehlermeldung".
//
// Diese Instrumentierung macht JEDEN Beendigungspfad nachvollziehbar:
//   - 'exit'        → finaler Exit-Code (synchron, letzte Chance zu loggen)
//   - 'beforeExit'  → Event-Loop leergelaufen (keine offenen Handles mehr)
//   - SIGTERM/SIGINT/SIGHUP → externes Signal bzw. Konsolen-Close (Windows: SIGHUP
//     beim Schließen der Konsole, SIGINT bei Ctrl+C)
// Damit gilt das Akzeptanzkriterium „kein Prozessende ohne erklärtes Signal/Exit":
// taucht der Prozess künftig wieder ab, steht im Log GENAU, welches Ereignis ihn
// beendet hat.
//
// Pure & injizierbar (process-Objekt, Logger, Exit-Funktion) → ohne echten
// Prozess-Tod unit-testbar.

export type LifecycleLogger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  context?: Record<string, unknown>,
) => void;

/** Signale, die wir explizit protokollieren. Reihenfolge = Registrierungsreihenfolge. */
export const LIFECYCLE_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
export type LifecycleSignal = (typeof LIFECYCLE_SIGNALS)[number];

/** Minimaler process-Ausschnitt, den wir brauchen — erlaubt einen Fake im Test. */
export interface ProcessLike {
  pid?: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ProcessLifecycleOptions {
  /** Wohin strukturierte Lifecycle-Events gehen (z. B. appendBackendDebugLog). */
  log: LifecycleLogger;
  /** Wird nach dem Loggen eines Signals aufgerufen. Default: process.exit(128+n) —
   *  das Default-Verhalten (Beenden) bleibt erhalten, ist aber jetzt protokolliert.
   *  Im Test injizierbar, damit der Testrunner NICHT beendet wird. */
  onSignalExit?: (signal: LifecycleSignal, exitCode: number) => void;
}

export interface ProcessLifecycleHandle {
  /** Entfernt alle registrierten Listener wieder (Tests/sauberes Herunterfahren). */
  dispose(): void;
}

const SIGNAL_NUMBER: Record<LifecycleSignal, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

/**
 * Registriert strukturierte Lifecycle-Logger auf dem (echten oder gefälschten)
 * process-Objekt. Loggt 'exit', 'beforeExit' sowie SIGTERM/SIGINT/SIGHUP. Für
 * Signale wird NACH dem Loggen `onSignalExit` aufgerufen (Default: sauberer
 * process.exit mit Code 128+Signalnummer) — das bisherige Beenden-Verhalten
 * bleibt, ist aber nun erklärt statt stumm.
 */
export function registerProcessLifecycleLogging(
  proc: ProcessLike,
  options: ProcessLifecycleOptions,
): ProcessLifecycleHandle {
  const { log } = options;
  const onSignalExit =
    options.onSignalExit ??
    ((_signal: LifecycleSignal, exitCode: number) => {
      (proc as unknown as { exit?: (code?: number) => void }).exit?.(exitCode);
    });

  const registered: Array<{ event: string; listener: (...args: unknown[]) => void }> = [];

  function add(event: string, listener: (...args: unknown[]) => void): void {
    proc.on(event, listener);
    registered.push({ event, listener });
  }

  add('exit', (...args: unknown[]) => {
    log('warn', 'process.lifecycle.exit', {
      code: typeof args[0] === 'number' ? args[0] : null,
      pid: proc.pid ?? null,
    });
  });

  add('beforeExit', (...args: unknown[]) => {
    // Tritt auf, wenn der Event-Loop leerläuft (KEINE aktiven Handles mehr). Bei
    // einem laufenden HTTP-Server sollte das NIE feuern — feuert es doch, fehlt
    // ein Server-Handle (z. B. versehentliches server.close()/unref()).
    log('warn', 'process.lifecycle.beforeExit', {
      code: typeof args[0] === 'number' ? args[0] : null,
      pid: proc.pid ?? null,
    });
  });

  for (const signal of LIFECYCLE_SIGNALS) {
    add(signal, () => {
      const exitCode = 128 + SIGNAL_NUMBER[signal];
      log('warn', 'process.lifecycle.signal', {
        signal,
        exitCode,
        pid: proc.pid ?? null,
        note:
          signal === 'SIGHUP'
            ? 'Konsole/Parent-Shell geschlossen — Prozessbaum wird abgerissen.'
            : undefined,
      });
      onSignalExit(signal, exitCode);
    });
  }

  return {
    dispose(): void {
      const remove =
        proc.off?.bind(proc) ?? proc.removeListener?.bind(proc) ?? null;
      if (!remove) return;
      for (const { event, listener } of registered) {
        remove(event, listener);
      }
      registered.length = 0;
    },
  };
}

/**
 * Härtet process.stdout/stderr gegen EPIPE. Wird die Ausgabe in eine Pipe/Datei
 * umgeleitet (Start-Process -RedirectStandardOutput) und der Leser verschwindet,
 * kann ein Schreibvorgang EPIPE werfen. Ohne 'error'-Listener eskaliert Node das
 * zu einer uncaughtException — der Server dürfte sonst an einer harmlosen
 * Log-Zeile sterben. Hier wird der Fehler einmalig protokolliert und geschluckt.
 */
export function guardStdioAgainstEpipe(
  streams: { stdout?: { on(e: string, l: (err: unknown) => void): unknown }; stderr?: { on(e: string, l: (err: unknown) => void): unknown } },
  log: LifecycleLogger,
): void {
  const attach = (name: 'stdout' | 'stderr', stream?: { on(e: string, l: (err: unknown) => void): unknown }): void => {
    if (!stream) return;
    stream.on('error', (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      // EPIPE/ERR_STREAM_DESTROYED: Leser weg — kein Grund, den Server zu killen.
      log('warn', 'process.lifecycle.stdioError', { stream: name, code: code ?? null });
    });
  };
  attach('stdout', streams.stdout);
  attach('stderr', streams.stderr);
}
