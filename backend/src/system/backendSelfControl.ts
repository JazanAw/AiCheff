// Kontrolliertes Beenden/Neustarten DES BACKEND-EIGENEN Prozesses.
//
// Hintergrund: Der Server hält Port 8787 und schreibt seine eigene PID-/Lifecycle-/
// Heartbeat-Spur (siehe processLifecycle.ts + scripts/start-backend.ps1). Die zwei
// neuen Admin-v2-Kopfzeilen-Buttons („Backend neu starten" / „Backend beenden")
// brauchen deshalb einen SAUBEREN Pfad, der
//   • den HTTP-Server zuerst schließt (kein hartes TerminateProcess/SIGKILL),
//   • dann process.exit(0) ausführt (vom Lifecycle-Logger erklärt protokolliert),
//   • beim Neustart einen ENTKOPPELTEN Relauncher startet, der wartet bis die alte
//     PID den Port freigibt und danach den robusten Launcher scripts/start-backend.ps1
//     erneut aufruft.
//
// Alles hier ist PURE bzw. injizierbar (spawn/closeServer/exit/scheduler/log) →
// ohne echten Prozess-Tod und ohne echten Kindprozess unit-testbar. Die Endpunkte
// in server.ts sind die dünne Glue, die die echten Abhängigkeiten injiziert.

import path from 'node:path';

export type LifecycleLogger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  context?: Record<string, unknown>,
) => void;

/** Spawn-Spezifikation für den entkoppelten Relauncher (rein → testbar, kein IO). */
export interface BackendSpawnSpec {
  command: string;
  args: string[];
  options: {
    cwd: string;
    detached: boolean;
    stdio: 'ignore';
    windowsHide: boolean;
  };
}

export interface BuildBackendRestartSpecInput {
  /** process.platform des laufenden Backends. */
  platform: NodeJS.Platform;
  /** Repo-Wurzel (= process.cwd() des Backends). */
  repoRoot: string;
  /** Port, auf den der neue Prozess wieder binden soll. */
  port: number;
  /** PID des aktuell laufenden Backends — der Relauncher wartet auf deren Ende. */
  currentPid: number;
}

/**
 * Baut die Spawn-Spezifikation für den ENTKOPPELTEN Relauncher. Unter Windows ist
 * das `powershell.exe … scripts/restart-backend.ps1 -OldPid <pid> -Port <port>`:
 * der robuste, bestehende Lifecycle-Mechanismus bleibt die Single Source of Truth
 * für das tatsächliche Starten (start-backend.ps1). `detached`/`stdio:'ignore'`/
 * `windowsHide` koppeln den Relauncher vollständig vom sterbenden Backend ab, damit
 * dessen Exit ihn nicht mitreißt.
 *
 * Wirft bei nicht unterstützter Plattform — der Aufrufer hält das Backend dann am
 * Leben (kein blinder, gefährlicher Shell-Befehl).
 */
export function buildBackendRestartSpec(input: BuildBackendRestartSpecInput): BackendSpawnSpec {
  const { platform, repoRoot, port, currentPid } = input;
  if (platform !== 'win32') {
    throw new Error(
      `Backend-Neustart wird auf Plattform "${platform}" nicht unterstützt — ` +
        'der robuste Launcher scripts/start-backend.ps1 ist Windows-spezifisch.',
    );
  }
  const scriptPath = path.join(repoRoot, 'scripts', 'restart-backend.ps1');
  return {
    command: 'cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      'start',
      '""',
      '/min',
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-OldPid',
      String(currentPid),
      '-Port',
      String(port),
    ],
    options: {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  };
}

export interface GracefulShutdownDeps {
  /** Schließt den HTTP-Server (stoppt neue Verbindungen) — z. B. httpServer.close. */
  closeServer: () => void;
  /** Beendet den Prozess SAUBER (vom Lifecycle-Logger erklärt) — z. B. process.exit. */
  exit: (code: number) => void;
  /** Verzögert das eigentliche Beenden, damit die HTTP-Antwort noch rausgeht. */
  schedule: (fn: () => void, ms: number) => void;
  log: LifecycleLogger;
  /** Exit-Code (Default 0 = sauberes, gewolltes Beenden). */
  exitCode?: number;
  /** Gnadenfrist in ms, bevor geschlossen/beendet wird (Default 250 ms). */
  graceMs?: number;
}

/**
 * Sauberer Herunterfahr-Ablauf: erst protokollieren, dann nach einer kurzen
 * Gnadenfrist (Antwort flushen) den Server schließen UND danach process.exit mit
 * dem gewünschten Code. NIE harter Kill. Vollständig injizierbar → testbar ohne den
 * echten Prozess zu beenden.
 */
export function performGracefulShutdown(reason: string, deps: GracefulShutdownDeps): void {
  const exitCode = deps.exitCode ?? 0;
  const graceMs = deps.graceMs ?? 250;
  deps.log('warn', 'backend.selfControl.shutdown.requested', { reason, exitCode, graceMs });
  deps.schedule(() => {
    try {
      deps.closeServer();
    } catch (error) {
      deps.log('error', 'backend.selfControl.shutdown.closeFailed', {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    deps.exit(exitCode);
  }, graceMs);
}

export interface BackendControlResult {
  ok: boolean;
  action: 'restart' | 'shutdown';
  message: string;
}

export interface RequestBackendShutdownDeps extends GracefulShutdownDeps {
  /** Menschliche Begründung (Audit/Log). */
  reason?: string;
}

/** Glue für den „Backend beenden"-Button: nur sauberes Herunterfahren (exit 0). */
export function requestBackendShutdown(deps: RequestBackendShutdownDeps): BackendControlResult {
  performGracefulShutdown(deps.reason ?? 'admin-v2:backend-off', deps);
  return {
    ok: true,
    action: 'shutdown',
    message: 'Backend wird sauber beendet (HTTP-Server schließt, Prozess endet mit Code 0).',
  };
}

export interface RequestBackendRestartDeps {
  /** Spawnt den entkoppelten Relauncher (z. B. child_process.spawn mit der Spec). */
  spawnRelauncher: (spec: BackendSpawnSpec) => void;
  /** Vorgebaute Spawn-Spezifikation (aus buildBackendRestartSpec). */
  spec: BackendSpawnSpec;
  /** Sauberer Herunterfahr-Ablauf NACH erfolgreichem Spawn des Relaunchers. */
  shutdown: GracefulShutdownDeps;
  log: LifecycleLogger;
}

/**
 * Glue für den „Backend neu starten"-Button: zuerst den ENTKOPPELTEN Relauncher
 * starten (er wartet auf das Ende dieser PID + die Portfreigabe, dann
 * start-backend.ps1), DANN dieses Backend sauber herunterfahren. Schlägt der Spawn
 * fehl, bleibt das Backend bewusst am Leben (kein „weder alt noch neu"-Zustand).
 */
export function requestBackendRestart(deps: RequestBackendRestartDeps): BackendControlResult {
  try {
    deps.spawnRelauncher(deps.spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log('error', 'backend.selfControl.restart.spawnFailed', { message });
    return {
      ok: false,
      action: 'restart',
      message: `Relauncher konnte nicht gestartet werden — Backend bleibt aktiv. (${message})`,
    };
  }
  deps.log('info', 'backend.selfControl.restart.relauncherSpawned', {
    command: deps.spec.command,
  });
  performGracefulShutdown('admin-v2:backend-restart', deps.shutdown);
  return {
    ok: true,
    action: 'restart',
    message:
      'Neustart angestoßen: Relauncher wartet auf die Portfreigabe und startet das ' +
      'Backend neu. Diese Instanz fährt jetzt sauber herunter.',
  };
}
