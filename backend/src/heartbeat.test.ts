import { describe, expect, it } from 'vitest';
import { formatHeartbeatLine, startHeartbeat } from './heartbeat';

describe('formatHeartbeatLine', () => {
  it('serialisiert Felder als JSON-Zeile mit \\n', () => {
    const line = formatHeartbeatLine({
      now: new Date('2026-06-17T08:00:00.000Z'),
      pid: 4242,
      uptimeSeconds: 12.3456,
      activeHandles: 3,
      rssBytes: 1024,
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      ts: '2026-06-17T08:00:00.000Z',
      event: 'heartbeat',
      pid: 4242,
      uptimeSeconds: 12.346,
      activeHandles: 3,
      rssBytes: 1024,
    });
  });

  it('erlaubt null für activeHandles/rssBytes/pid', () => {
    const parsed = JSON.parse(
      formatHeartbeatLine({
        now: new Date('2026-06-17T08:00:00.000Z'),
        pid: undefined,
        uptimeSeconds: 1,
        activeHandles: null,
        rssBytes: null,
      }),
    );
    expect(parsed.pid).toBeNull();
    expect(parsed.activeHandles).toBeNull();
    expect(parsed.rssBytes).toBeNull();
  });
});

describe('startHeartbeat', () => {
  function setup() {
    const writes: string[] = [];
    let truncated = false;
    let captured: (() => void) | null = null;
    let cleared = false;
    const handle = startHeartbeat({
      filePath: '/tmp/backend-heartbeat.log',
      intervalMs: 1000,
      now: () => new Date('2026-06-17T08:00:00.000Z'),
      pid: 7,
      uptimeSeconds: () => 5,
      rssBytes: () => 2048,
      activeHandles: () => 4,
      append: (_fp, line) => writes.push(line),
      truncate: () => {
        truncated = true;
      },
      setIntervalFn: (cb) => {
        captured = cb;
        return 'TIMER';
      },
      clearIntervalFn: (h) => {
        cleared = h === 'TIMER';
      },
    });
    return { writes, handleApi: handle, getCaptured: () => captured, isTruncated: () => truncated, isCleared: () => cleared };
  }

  it('leert die Datei und schreibt sofort eine erste Zeile', () => {
    const s = setup();
    expect(s.isTruncated()).toBe(true);
    expect(s.writes).toHaveLength(1);
    expect(JSON.parse(s.writes[0]).event).toBe('heartbeat');
  });

  it('schreibt bei jedem Intervall-Tick eine weitere Zeile', () => {
    const s = setup();
    const tick = s.getCaptured();
    expect(tick).toBeTypeOf('function');
    tick?.();
    tick?.();
    expect(s.writes).toHaveLength(3); // 1 initial + 2 ticks
  });

  it('stop() gibt den Timer frei (clearIntervalFn mit dem Handle)', () => {
    const s = setup();
    s.handleApi.stop();
    expect(s.isCleared()).toBe(true);
  });
});
