// Unabhängiger Datei-Heartbeat.
//
// ZWECK: Wenn der Backend-Prozess „plötzlich weg" ist, brauchen wir den exakten
// ZEITPUNKT. Dieser Heartbeat schreibt SYNCHRON (fs.appendFileSync) einmal pro
// Sekunde eine Zeile mit Zeitstempel, PID, Uptime, Anzahl aktiver Handles und
// Speicher. Reißt die Heartbeat-Spur ab, wissen wir sekundengenau, wann der
// Prozess starb — selbst wenn KEIN Signal/Exit kam (harter TerminateProcess /
// SIGKILL, das JS nicht abfangen kann, hinterlässt sonst keinerlei Spur).
//
// Wichtig:
//   - Schreibt direkt in die DATEI, nicht über console/stdout (siehe
//     lifecycleFileLog.ts: umgeleitetes stdout flusht beim Abbau nicht).
//   - Das Intervall ist standardmäßig „ref'd" (Node-Default) → es hält den
//     Event-Loop aktiv, der Prozess kann also NICHT still über 'beforeExit'
//     auslaufen, solange der Heartbeat läuft.
//   - Pure Zeilenformatierung + injizierbare Timer/append/now → unit-testbar
//     ohne echte Timer oder echtes Dateisystem.

import * as fs from 'node:fs';

export interface HeartbeatSnapshot {
  now: Date;
  pid: number | undefined;
  uptimeSeconds: number;
  activeHandles: number | null;
  rssBytes: number | null;
}

export interface HeartbeatOptions {
  /** Zieldatei (z. B. backend/backend-heartbeat.log). */
  filePath: string;
  /** Intervall in ms. Default: 1000. */
  intervalMs?: number;
  /** Zeitquelle. Default: () => new Date(). */
  now?: () => Date;
  /** PID. Default: process.pid. */
  pid?: number;
  /** Uptime in Sekunden. Default: process.uptime(). */
  uptimeSeconds?: () => number;
  /** RSS in Bytes. Default: process.memoryUsage().rss. */
  rssBytes?: () => number | null;
  /** Anzahl aktiver Handles. Default: process._getActiveHandles().length (best effort). */
  activeHandles?: () => number | null;
  /** Append-Implementierung. Default: fs.appendFileSync. */
  append?: (filePath: string, line: string) => void;
  /** Datei zu Beginn leeren (frischer Lauf). Default: fs.writeFileSync(fp, ''). */
  truncate?: (filePath: string) => void;
  /** Timer-Factory. Default: setInterval (ref'd). Im Test injizierbar. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  /** Timer-Cleanup. Default: clearInterval. */
  clearIntervalFn?: (handle: unknown) => void;
}

export interface HeartbeatHandle {
  /** Stoppt den Heartbeat und gibt den Timer frei. */
  stop(): void;
  /** Schreibt sofort eine Heartbeat-Zeile (auch für Tests). */
  tick(): void;
}

/** Baut EINE JSON-Heartbeat-Zeile (inkl. \n). Pur & testbar. */
export function formatHeartbeatLine(snapshot: HeartbeatSnapshot): string {
  return `${JSON.stringify({
    ts: snapshot.now.toISOString(),
    event: 'heartbeat',
    pid: snapshot.pid ?? null,
    uptimeSeconds: Number(snapshot.uptimeSeconds.toFixed(3)),
    activeHandles: snapshot.activeHandles,
    rssBytes: snapshot.rssBytes,
  })}\n`;
}

function defaultActiveHandles(): number | null {
  // _getActiveHandles ist intern, aber für Diagnose nützlich; defensiv gekapselt.
  const fn = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (typeof fn !== 'function') return null;
  try {
    return fn.call(process).length;
  } catch {
    return null;
  }
}

function safeAppend(filePath: string, line: string): void {
  try {
    fs.appendFileSync(filePath, line);
  } catch {
    // Logging darf den Prozess nie beenden.
  }
}

function safeTruncate(filePath: string): void {
  try {
    fs.writeFileSync(filePath, '');
  } catch {
    // ignorieren — append fängt später ggf. selbst an.
  }
}

/**
 * Startet den Datei-Heartbeat. Leert die Datei einmalig (frischer Lauf), schreibt
 * sofort eine erste Zeile und danach alle `intervalMs` eine weitere. Rückgabe:
 * Handle mit stop()/tick().
 */
export function startHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const intervalMs = options.intervalMs ?? 1000;
  const now = options.now ?? ((): Date => new Date());
  const pid = options.pid ?? (typeof process !== 'undefined' ? process.pid : undefined);
  const uptimeSeconds = options.uptimeSeconds ?? ((): number => process.uptime());
  const rssBytes =
    options.rssBytes ??
    ((): number | null => {
      try {
        return process.memoryUsage().rss;
      } catch {
        return null;
      }
    });
  const activeHandles = options.activeHandles ?? defaultActiveHandles;
  const append = options.append ?? safeAppend;
  const truncate = options.truncate ?? safeTruncate;
  const setIntervalFn =
    options.setIntervalFn ?? ((cb: () => void, ms: number): unknown => setInterval(cb, ms));
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle: unknown): void => clearInterval(handle as never));

  const tick = (): void => {
    append(
      options.filePath,
      formatHeartbeatLine({
        now: now(),
        pid,
        uptimeSeconds: uptimeSeconds(),
        activeHandles: activeHandles(),
        rssBytes: rssBytes(),
      }),
    );
  };

  truncate(options.filePath);
  tick();
  const handle = setIntervalFn(tick, intervalMs);

  return {
    tick,
    stop(): void {
      clearIntervalFn(handle);
    },
  };
}
