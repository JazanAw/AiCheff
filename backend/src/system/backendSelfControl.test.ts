import { describe, expect, it, vi } from 'vitest';
import {
  buildBackendRestartSpec,
  performGracefulShutdown,
  requestBackendRestart,
  requestBackendShutdown,
  type BackendSpawnSpec,
  type GracefulShutdownDeps,
} from './backendSelfControl';

const noopLog = () => {};

function captureLog(): { log: GracefulShutdownDeps['log']; entries: Array<{ level: string; message: string }> } {
  const entries: Array<{ level: string; message: string }> = [];
  return {
    entries,
    log: (level, message) => {
      entries.push({ level, message });
    },
  };
}

describe('buildBackendRestartSpec', () => {
  it('win32 → entkoppelter powershell-Relauncher auf start-backend.ps1 mit OldPid/Port', () => {
    const spec = buildBackendRestartSpec({
      platform: 'win32',
      repoRoot: 'C:/repo',
      port: 8787,
      currentPid: 4242,
    });
    expect(spec.command).toBe('cmd.exe');
    expect(spec.args).toEqual(
      expect.arrayContaining(['/d', '/s', '/c', 'start', '""', '/min', 'powershell.exe']),
    );
    expect(spec.args).toContain('-File');
    expect(spec.args.some((a) => a.replace(/\\/g, '/').endsWith('scripts/restart-backend.ps1'))).toBe(true);
    expect(spec.args).toEqual(expect.arrayContaining(['-OldPid', '4242', '-Port', '8787']));
    // Vollständig entkoppelt, damit der sterbende Server den Relauncher nicht mitreißt.
    expect(spec.options.detached).toBe(true);
    expect(spec.options.stdio).toBe('ignore');
    expect(spec.options.windowsHide).toBe(true);
    expect(spec.options.cwd).toBe('C:/repo');
  });

  it('nicht-Windows → wirft (kein blinder, gefährlicher Shell-Befehl)', () => {
    expect(() =>
      buildBackendRestartSpec({ platform: 'linux', repoRoot: '/repo', port: 8787, currentPid: 1 }),
    ).toThrow(/nicht unterstützt/i);
  });
});

describe('performGracefulShutdown', () => {
  it('protokolliert, schließt den Server NACH der Gnadenfrist und exit(0) — kein harter Kill', () => {
    const closeServer = vi.fn();
    const exit = vi.fn();
    let scheduled: (() => void) | null = null;
    const { log, entries } = captureLog();
    performGracefulShutdown('test', {
      closeServer,
      exit,
      schedule: (fn) => {
        scheduled = fn;
      },
      log,
    });
    // Sofort nur geloggt — noch nichts geschlossen/beendet (Antwort muss erst raus).
    expect(closeServer).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(entries.some((e) => e.message.includes('shutdown.requested'))).toBe(true);
    // Gnadenfrist abgelaufen → erst schließen, dann sauber beenden.
    scheduled!();
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ein Fehler beim Schließen verhindert den sauberen Exit nicht', () => {
    const exit = vi.fn();
    let scheduled: (() => void) | null = null;
    performGracefulShutdown('test', {
      closeServer: () => {
        throw new Error('close boom');
      },
      exit,
      schedule: (fn) => {
        scheduled = fn;
      },
      log: noopLog,
    });
    scheduled!();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('respektiert exitCode/graceMs-Overrides', () => {
    const schedule = vi.fn();
    performGracefulShutdown('test', {
      closeServer: () => {},
      exit: () => {},
      schedule,
      log: noopLog,
      exitCode: 7,
      graceMs: 1000,
    });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1000);
  });
});

describe('requestBackendShutdown', () => {
  it('startet den sauberen Herunterfahr-Ablauf und meldet ok', () => {
    const schedule = vi.fn();
    const result = requestBackendShutdown({
      closeServer: () => {},
      exit: () => {},
      schedule,
      log: noopLog,
    });
    expect(result).toMatchObject({ ok: true, action: 'shutdown' });
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});

describe('requestBackendRestart', () => {
  const spec: BackendSpawnSpec = {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'start', '""', '/min', 'powershell.exe', '-File', 'restart-backend.ps1'],
    options: { cwd: '.', detached: true, stdio: 'ignore', windowsHide: true },
  };

  it('spawnt den Relauncher und fährt DANN sauber herunter', () => {
    const spawnRelauncher = vi.fn();
    const schedule = vi.fn();
    const exit = vi.fn();
    const result = requestBackendRestart({
      spawnRelauncher,
      spec,
      shutdown: { closeServer: () => {}, exit, schedule, log: noopLog },
      log: noopLog,
    });
    expect(spawnRelauncher).toHaveBeenCalledWith(spec);
    expect(schedule).toHaveBeenCalledTimes(1); // Herunterfahren erst nach dem Spawn angestoßen.
    expect(result).toMatchObject({ ok: true, action: 'restart' });
  });

  it('Spawn-Fehler → Backend bleibt am Leben (kein Shutdown, ok=false)', () => {
    const schedule = vi.fn();
    const exit = vi.fn();
    const result = requestBackendRestart({
      spawnRelauncher: () => {
        throw new Error('spawn EACCES');
      },
      spec,
      shutdown: { closeServer: () => {}, exit, schedule, log: noopLog },
      log: noopLog,
    });
    expect(result.ok).toBe(false);
    expect(schedule).not.toHaveBeenCalled(); // KEIN Herunterfahren angestoßen.
    expect(exit).not.toHaveBeenCalled();
  });
});
