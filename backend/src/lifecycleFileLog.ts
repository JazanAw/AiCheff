// Synchroner, DATEI-basierter Lifecycle-Logger.
//
// ECHTE URSACHE, warum bisher NIE ein Lifecycle-Log erschien:
// Die bisherige Instrumentierung (registerProcessLifecycleLogging,
// uncaughtException/unhandledRejection) loggte ausschließlich über
// `appendBackendDebugLog` — und das schreibt NUR in ein In-Memory-Array und via
// `console.*` an stdout/stderr. Im Launcher wurde stdout/stderr per
// `Start-Process -RedirectStandardOutput` in eine Datei UMGELEITET. Schreiben auf
// eine umgeleitete Pipe ist unter Windows ASYNCHRON: Beim Prozessabbau
// (Konsolen-Close/CTRL_CLOSE, Signal, harter Kill) wird der noch gepufferte
// console-Output NICHT mehr in die Datei geflusht. Genau deshalb blieben
// backend.out.log/backend.err.log ohne process.lifecycle.* — egal welcher Killer.
//
// Dieser Logger umgeht stdout vollständig: `fs.appendFileSync` schreibt SYNCHRON
// und sofort in eine eigene Datei. Damit ist ein 'exit'-/Signal-/Exception-Pfad
// garantiert protokolliert, BEVOR der Prozess verschwindet — auch wenn stdout
// längst tot ist. Pure Formatierung + injizierbares `append`/`now` → unit-testbar.

import * as fs from 'node:fs';

export type LifecycleFileLevel = 'info' | 'warn' | 'error';

export type LifecycleFileLogger = (
  level: LifecycleFileLevel,
  message: string,
  context?: Record<string, unknown>,
) => void;

export interface LifecycleFileLoggerOptions {
  /** Zieldatei (z. B. backend/backend-lifecycle.log). */
  filePath: string;
  /** PID, die in jede Zeile geschrieben wird. Default: process.pid. */
  pid?: number;
  /** Zeitquelle. Default: () => new Date(). Im Test injizierbar. */
  now?: () => Date;
  /** Append-Implementierung. Default: fs.appendFileSync. Im Test injizierbar. */
  append?: (filePath: string, line: string) => void;
}

/** Baut EINE JSON-Lifecycle-Zeile (inkl. abschließendem \n). Pur & testbar. */
export function formatLifecycleLine(
  now: Date,
  level: LifecycleFileLevel,
  message: string,
  context: Record<string, unknown> | undefined,
  pid: number | undefined,
): string {
  const record: Record<string, unknown> = {
    ts: now.toISOString(),
    level,
    message,
    pid: pid ?? null,
  };
  if (context !== undefined) {
    record.context = context;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    // Niemals am Logging selbst sterben: Fallback ohne (zirkulären) Context.
    serialized = JSON.stringify({ ts: now.toISOString(), level, message, pid: pid ?? null });
  }
  return `${serialized}\n`;
}

/** Default-Append: synchron, schluckt eigene Fehler (Logging darf nie killen). */
function defaultAppend(filePath: string, line: string): void {
  try {
    fs.appendFileSync(filePath, line);
  } catch {
    // Bewusst geschluckt: ein fehlschlagender Log-Write darf den Prozess nie beenden.
  }
}

/**
 * Erzeugt einen `LifecycleFileLogger`, der jede Zeile SYNCHRON in `filePath`
 * anhängt. Die Signatur ist kompatibel zu `LifecycleLogger` aus processLifecycle.ts,
 * kann also direkt an registerProcessLifecycleLogging/guardStdioAgainstEpipe
 * übergeben (oder mit appendBackendDebugLog kombiniert) werden.
 */
export function createLifecycleFileLogger(
  options: LifecycleFileLoggerOptions,
): LifecycleFileLogger {
  const append = options.append ?? defaultAppend;
  const now = options.now ?? ((): Date => new Date());
  const pid = options.pid ?? (typeof process !== 'undefined' ? process.pid : undefined);
  return (level, message, context) => {
    append(options.filePath, formatLifecycleLine(now(), level, message, context, pid));
  };
}
