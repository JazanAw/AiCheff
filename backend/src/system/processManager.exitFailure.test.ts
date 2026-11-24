import { describe, expect, it } from 'vitest';
import { describeExitFailure } from './processManager';

// Der Expo-QR-Code erschien im Admin nicht, obwohl "Start" gedrückt wurde.
// Ursache war ein STUMMER Fehlstart: Port 8081 war belegt, Expo fragte
// interaktiv nach einem Ausweichport, lief aber non-interaktiv und beendete
// sich mit Code 1. Das Admin zeigte nur "gestoppt" — `lastError` blieb null.
//
// Die folgenden Zeilen sind die ECHTE Ausgabe des Vorfalls vom 2026-08-19,
// unverändert aus `recentLogs` des verwalteten mobile-Prozesses.
const REAL_INCIDENT = [
  '[2026-08-19T19:49:21.454Z] starting: set REACT_NATIVE_PACKAGER_HOSTNAME=192.168.100.67&& npm.cmd start -- --go --lan --port 8081',
  '[stdout] > cheffity@1.0.0 start',
  '[stdout] > expo start --go --lan --port 8081',
  '[stdout] Starting project at C:/dev/AICheff/mobile',
  '[stdout] › Port 8081 is being used by another process',
  "[stderr] Input is required, but 'npx expo' is in non-interactive mode.",
  '[stderr] Required input:',
  '[stderr] > Use port 8082 instead?',
  '[stdout] › Skipping dev server',
];

describe('describeExitFailure', () => {
  it('macht den echten Port-Konflikt im Admin sichtbar', () => {
    const message = describeExitFailure(REAL_INCIDENT, 1);

    expect(message).toContain('Code 1');
    // Die entscheidende Zeile muss durchkommen — sonst bleibt der Fehler stumm.
    expect(message).toContain('Skipping dev server');
    expect(message).toMatch(/Use port 8082 instead|Required input/);
  });

  it('entfernt die stdout/stderr-Präfixe', () => {
    expect(describeExitFailure(['[stdout] kaputt', '[stderr] auch kaputt'], 2)).toBe(
      'Beendet mit Code 2: kaputt | auch kaputt',
    );
  });

  it('überspringt die Zeitstempel-Zeilen des Managers', () => {
    const message = describeExitFailure(
      ['[2026-08-19T19:49:21.454Z] starting: npm start', '[stdout] echter Fehler'],
      1,
    );
    expect(message).toBe('Beendet mit Code 1: echter Fehler');
  });

  it('bleibt ohne verwertbare Ausgabe verständlich', () => {
    expect(describeExitFailure([], 1)).toBe('Beendet mit Code 1.');
    expect(describeExitFailure(['[2026-08-19T19:49:21.454Z] starting: x'], 9)).toBe(
      'Beendet mit Code 9.',
    );
  });

  it('nimmt höchstens die letzten drei Zeilen', () => {
    const message = describeExitFailure(
      ['[stdout] a', '[stdout] b', '[stdout] c', '[stdout] d'],
      1,
    );
    expect(message).toBe('Beendet mit Code 1: b | c | d');
  });
});
