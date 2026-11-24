import { describe, expect, it } from 'vitest';
import {
  createLifecycleFileLogger,
  formatLifecycleLine,
} from './lifecycleFileLog';

describe('formatLifecycleLine', () => {
  it('baut eine JSON-Zeile mit ts/level/message/pid/context und \\n', () => {
    const line = formatLifecycleLine(
      new Date('2026-06-17T08:00:00.000Z'),
      'warn',
      'process.lifecycle.signal',
      { signal: 'SIGTERM' },
      4242,
    );
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      ts: '2026-06-17T08:00:00.000Z',
      level: 'warn',
      message: 'process.lifecycle.signal',
      pid: 4242,
      context: { signal: 'SIGTERM' },
    });
  });

  it('lässt context weg, wenn undefined, und schreibt pid:null ohne pid', () => {
    const parsed = JSON.parse(
      formatLifecycleLine(new Date('2026-06-17T08:00:00.000Z'), 'info', 'x', undefined, undefined),
    );
    expect(parsed.pid).toBeNull();
    expect('context' in parsed).toBe(false);
  });

  it('fällt bei zirkulärem context auf eine context-freie Zeile zurück (kein Throw)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      formatLifecycleLine(new Date('2026-06-17T08:00:00.000Z'), 'error', 'boom', circular, 1),
    ).not.toThrow();
    const parsed = JSON.parse(
      formatLifecycleLine(new Date('2026-06-17T08:00:00.000Z'), 'error', 'boom', circular, 1),
    );
    expect(parsed.message).toBe('boom');
    expect('context' in parsed).toBe(false);
  });
});

describe('createLifecycleFileLogger', () => {
  it('hängt jede Zeile SYNCHRON an die konfigurierte Datei an (injizierter append)', () => {
    const writes: Array<{ filePath: string; line: string }> = [];
    const log = createLifecycleFileLogger({
      filePath: '/tmp/backend-lifecycle.log',
      pid: 99,
      now: () => new Date('2026-06-17T08:00:00.000Z'),
      append: (filePath, line) => writes.push({ filePath, line }),
    });

    log('warn', 'process.lifecycle.exit', { code: 0 });

    expect(writes).toHaveLength(1);
    expect(writes[0].filePath).toBe('/tmp/backend-lifecycle.log');
    const parsed = JSON.parse(writes[0].line);
    expect(parsed.message).toBe('process.lifecycle.exit');
    expect(parsed.pid).toBe(99);
    expect(parsed.context).toEqual({ code: 0 });
  });
});
