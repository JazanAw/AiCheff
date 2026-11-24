import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Der Pfad wird beim Modul-Laden EINMAL aufgeloest, deshalb je Fall frisch
// importieren statt das Modul oben zu ziehen.
async function ladeGetter(): Promise<() => string> {
  vi.resetModules();
  const modul = await import('./offersStore');
  return modul.getOffersDataFile;
}

const vorher = process.env.OFFERS_DATA_FILE;

afterEach(() => {
  if (vorher === undefined) delete process.env.OFFERS_DATA_FILE;
  else process.env.OFFERS_DATA_FILE = vorher;
});

describe('getOffersDataFile', () => {
  it('zeigt ohne Override auf backend/data/offers.json', async () => {
    delete process.env.OFFERS_DATA_FILE;
    const datei = (await ladeGetter())();

    expect(path.isAbsolute(datei)).toBe(true);
    expect(datei.replace(/\\/g, '/')).toMatch(/backend\/data\/offers\.json$/);
  });

  // Der Snapshot-Download muss dieselbe Datei liefern, die das Backend liest —
  // sonst laedt man auf einem Rechner mit Override etwas anderes herunter, als
  // dort tatsaechlich ausgeliefert wird.
  it('folgt dem OFFERS_DATA_FILE-Override', async () => {
    process.env.OFFERS_DATA_FILE = 'tmp/eigener-snapshot.json';
    const datei = (await ladeGetter())();

    expect(path.isAbsolute(datei)).toBe(true);
    expect(datei.replace(/\\/g, '/')).toMatch(/tmp\/eigener-snapshot\.json$/);
  });

  it('ignoriert einen Override aus reinem Leerraum', async () => {
    process.env.OFFERS_DATA_FILE = '   ';
    const datei = (await ladeGetter())();

    expect(datei.replace(/\\/g, '/')).toMatch(/backend\/data\/offers\.json$/);
  });
});
