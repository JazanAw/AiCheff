import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  guardStdioAgainstEpipe,
  LIFECYCLE_SIGNALS,
  registerProcessLifecycleLogging,
  type LifecycleSignal,
} from './processLifecycle';

// Fake-„process": ein EventEmitter mit pid, der das echte process-Interface
// (on/off/emit) erfüllt — so testen wir die Lifecycle-Verdrahtung, OHNE den
// Testrunner zu beenden.
class FakeProcess extends EventEmitter {
  pid = 4242;
}

interface Logged {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

function makeLogger(): { sink: Logged[]; log: (l: string, m: string, c?: Record<string, unknown>) => void } {
  const sink: Logged[] = [];
  return {
    sink,
    log: (level, message, context) => {
      sink.push({ level, message, context });
    },
  };
}

describe('registerProcessLifecycleLogging', () => {
  it('protokolliert exit mit Exit-Code', () => {
    const proc = new FakeProcess();
    const { sink, log } = makeLogger();
    registerProcessLifecycleLogging(proc as never, { log, onSignalExit: () => {} });

    proc.emit('exit', 7);

    const entry = sink.find((e) => e.message === 'process.lifecycle.exit');
    expect(entry).toBeDefined();
    expect(entry?.context?.code).toBe(7);
    expect(entry?.context?.pid).toBe(4242);
  });

  it('protokolliert beforeExit (Hinweis auf fehlendes Server-Handle)', () => {
    const proc = new FakeProcess();
    const { sink, log } = makeLogger();
    registerProcessLifecycleLogging(proc as never, { log, onSignalExit: () => {} });

    proc.emit('beforeExit', 0);

    expect(sink.some((e) => e.message === 'process.lifecycle.beforeExit')).toBe(true);
  });

  it('protokolliert jedes Signal und ruft danach onSignalExit mit 128+n', () => {
    const proc = new FakeProcess();
    const { sink, log } = makeLogger();
    const exits: Array<{ signal: LifecycleSignal; code: number }> = [];
    registerProcessLifecycleLogging(proc as never, {
      log,
      onSignalExit: (signal, code) => exits.push({ signal, code }),
    });

    for (const signal of LIFECYCLE_SIGNALS) {
      proc.emit(signal);
    }

    const signalLogs = sink.filter((e) => e.message === 'process.lifecycle.signal');
    expect(signalLogs.map((e) => e.context?.signal)).toEqual([...LIFECYCLE_SIGNALS]);
    // 128 + {SIGTERM:15, SIGINT:2, SIGHUP:1}
    expect(exits).toEqual([
      { signal: 'SIGTERM', code: 143 },
      { signal: 'SIGINT', code: 130 },
      { signal: 'SIGHUP', code: 129 },
    ]);
  });

  it('markiert SIGHUP als Konsolen-/Parent-Close', () => {
    const proc = new FakeProcess();
    const { sink, log } = makeLogger();
    registerProcessLifecycleLogging(proc as never, { log, onSignalExit: () => {} });

    proc.emit('SIGHUP');

    const hup = sink.find((e) => e.context?.signal === 'SIGHUP');
    expect(String(hup?.context?.note)).toContain('Konsole');
  });

  it('dispose() entfernt alle Listener wieder', () => {
    const proc = new FakeProcess();
    const { sink, log } = makeLogger();
    const handle = registerProcessLifecycleLogging(proc as never, { log, onSignalExit: () => {} });

    handle.dispose();
    proc.emit('exit', 0);
    proc.emit('SIGTERM');

    expect(sink).toHaveLength(0);
    // alle Listener tatsächlich abgemeldet
    expect(proc.listenerCount('exit')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('guardStdioAgainstEpipe', () => {
  it('schluckt stdout/stderr-Fehler statt sie eskalieren zu lassen', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const { sink, log } = makeLogger();

    guardStdioAgainstEpipe({ stdout, stderr } as never, log);

    // Würde ein 'error' OHNE Listener emittiert, würfe der EventEmitter — hier nicht.
    expect(() => stdout.emit('error', Object.assign(new Error('broken'), { code: 'EPIPE' }))).not.toThrow();
    expect(() => stderr.emit('error', new Error('x'))).not.toThrow();

    const stdoutLog = sink.find((e) => e.context?.stream === 'stdout');
    expect(stdoutLog?.context?.code).toBe('EPIPE');
    expect(sink.some((e) => e.context?.stream === 'stderr')).toBe(true);
  });

  it('verwendet vi-Spy-Logger korrekt (Regress-Schutz Signatur)', () => {
    const stdout = new EventEmitter();
    const spy = vi.fn();
    guardStdioAgainstEpipe({ stdout } as never, spy);
    stdout.emit('error', { code: 'ERR_STREAM_DESTROYED' });
    expect(spy).toHaveBeenCalledWith('warn', 'process.lifecycle.stdioError', {
      stream: 'stdout',
      code: 'ERR_STREAM_DESTROYED',
    });
  });
});
