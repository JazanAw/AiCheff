import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  berlinYmd,
  classifyLiveWindow,
  dropExpiredFromActiveBuckets,
  extractGermanStartYmd,
  offerEndYmd,
  offerStartYmd,
  splitOffersByLiveWindow,
} from './snapshotLiveWindow';

// Scan-2.0 Datenqualität #1/#2: ein Angebot darf nur dann live (offers) sein,
// wenn es am Scan-Datum tatsächlich gültig ist. Zukünftige Angebote
// (validFrom > heute oder "ab-montag,-08.06.26" in der sourceUrl) gehören nach
// nextWeek. REWE/nahkauf (manueller Import) darf NIE still verloren gehen.
// Alle Datumslogik ist Europe/Berlin-stabil (UTC-Eingabe → Berliner Kalendertag).

// Sonntag, 2026-06-07 (UTC-Tag 0) — der reale „böse Scan"-Zeitpunkt.
const SUNDAY = new Date('2026-06-07T04:12:49.000Z');

function offer(overrides: Partial<Offer> & { id: string }): Offer {
  return {
    name: overrides.id,
    normalizedName: overrides.id,
    storeChain: 'Lidl',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '',
    validityEnd: '',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  } as Offer;
}

describe('berlinYmd — Europe/Berlin-stabiler Kalendertag', () => {
  it('mappt eine UTC-Instant auf den Berliner Kalendertag (Sommerzeit +2h)', () => {
    // 2026-06-07T23:30Z ist in Berlin (CEST) bereits der 08.06.
    expect(berlinYmd(Date.parse('2026-06-07T23:30:00.000Z'))).toBe(20260608);
    expect(berlinYmd(Date.parse('2026-06-07T04:12:49.000Z'))).toBe(20260607);
  });
});

describe('extractGermanStartYmd — Datum aus sourceUrl/Text', () => {
  it('liest "ab-montag,-08.06.26" als 2026-06-08', () => {
    expect(extractGermanStartYmd('ab-montag,-08.06.26')).toBe(20260608);
  });
  it('liest volljähriges Format "08.06.2026"', () => {
    expect(extractGermanStartYmd('gueltig 08.06.2026')).toBe(20260608);
  });
  it('ignoriert Preise (nur ein Punkt) und gibt null zurück', () => {
    expect(extractGermanStartYmd('Red Bull 0.85 EUR 1,99')).toBeNull();
  });
});

describe('classifyLiveWindow — aktiv heute vs. Zukunft vs. abgelaufen', () => {
  it('strukturierter Zukunftsstart (08.06) am 07.06 ist next, nicht current', () => {
    const o = offer({ id: 'm', validityStart: '2026-06-08', validityEnd: '2026-06-14' });
    expect(classifyLiveWindow(o, SUNDAY)).toBe('next');
  });
  it('heute gültiges Angebot (01.06–07.06) ist current', () => {
    const o = offer({ id: 'now', validityStart: '2026-06-01', validityEnd: '2026-06-07' });
    expect(classifyLiveWindow(o, SUNDAY)).toBe('current');
  });
  it('abgelaufenes Angebot (endet 05.06) ist other', () => {
    const o = offer({ id: 'old', validityStart: '2026-05-30', validityEnd: '2026-06-05' });
    expect(classifyLiveWindow(o, SUNDAY)).toBe('other');
  });
  it('fehlende Daten + Zukunftsdatum in sourceUrl → next', () => {
    const o = offer({
      id: 'url',
      validityStart: '',
      validityEnd: '',
      sourceUrl: 'https://aldi.de/angebote/ab-mittwoch,-10.06.26/x',
    });
    expect(classifyLiveWindow(o, SUNDAY)).toBe('next');
  });
  it('gar keine Datumssignale → unknown (Aufrufer behält Wochenbucket)', () => {
    const o = offer({ id: 'none', validityStart: '', validityEnd: '', sourceUrl: 'https://x' });
    expect(classifyLiveWindow(o, SUNDAY)).toBe('unknown');
  });
});

describe('classifyLiveWindow — PENNY ISO-Wochen-Validity (UTC/Berlin-Regression)', () => {
  // PENNY liefert pro Tile KEINE Datumsfelder; der Connector stempelt die
  // Validity aus dem ISO-Wochen-Token der Seite (Mo 00:00:00Z bis
  // So 23:59:59.999Z). Diese Form darf nie durch UTC/Berlin-Drift in den
  // falschen Bucket kippen.
  const PENNY_WEEK = {
    storeChain: 'PENNY',
    validityStart: '2026-06-08T00:00:00.000Z',
    validityEnd: '2026-06-14T23:59:59.999Z',
  };
  const PENNY_NEXT_WEEK = {
    storeChain: 'PENNY',
    validityStart: '2026-06-15T00:00:00.000Z',
    validityEnd: '2026-06-21T23:59:59.999Z',
  };

  it('Wochen-Angebot ist mitten in der Woche (Freitag) current', () => {
    const o = offer({ id: 'p-cur', ...PENNY_WEEK });
    expect(classifyLiveWindow(o, new Date('2026-06-12T10:00:00.000Z'))).toBe('current');
  });

  it('Angebot der Folgewoche ist next, nicht current', () => {
    const o = offer({ id: 'p-next', ...PENNY_NEXT_WEEK });
    expect(classifyLiveWindow(o, new Date('2026-06-12T10:00:00.000Z'))).toBe('next');
  });

  it('Enddatum ist Berlin-lokal End-of-Day inklusiv (So 23:30 Berlin → noch current)', () => {
    const o = offer({ id: 'p-eod', ...PENNY_WEEK });
    // 2026-06-14T21:30Z = Sonntag 23:30 Berlin (CEST) — letzter Gültigkeitstag.
    expect(classifyLiveWindow(o, new Date('2026-06-14T21:30:00.000Z'))).toBe('current');
  });

  it('UTC/Berlin-Off-by-one: Mo 00:30 Berlin (So 22:30Z) macht die Folgewoche current, nicht next', () => {
    const o = offer({ id: 'p-mo', ...PENNY_NEXT_WEEK });
    // 2026-06-14T22:30Z ist in Berlin bereits Montag, 15.06. — der Start der
    // Folgewoche. Ein UTC-Kalendertag-Vergleich würde hier fälschlich 'next'
    // liefern und die frisch gestartete Woche aus dem Live-Feed halten.
    expect(classifyLiveWindow(o, new Date('2026-06-14T22:30:00.000Z'))).toBe('current');
  });
});

describe('strukturiertes Datum = Angebots-Kalendertag (Datumsteil, kein Berlin-Shift)', () => {
  // Der Datumsteil eines validityStart/End ist der Angebots-Kalendertag, exakt
  // wie Cheffity/Supabase ihn lesen (toDate → YYYY-MM-DD). Eine Berlin-Zeitzonen-
  // Konvertierung von 23:59:59.999Z auf den Folgetag machte abgelaufene Angebote
  // fälschlich aktuell (nahkauf „22 expired in current"-Drift).
  const NOW = new Date('2026-06-22T12:00:00.000Z');

  it('Akzeptanz 1: validityEnd 2026-06-21T23:59:59.999Z → offerEndYmd 20260621, classify "other"', () => {
    const o = offer({
      id: 'exp',
      validityStart: '2026-06-15T00:00:00.000Z',
      validityEnd: '2026-06-21T23:59:59.999Z',
    });
    expect(offerEndYmd(o)).toBe(20260621);
    expect(classifyLiveWindow(o, NOW)).toBe('other');
  });

  it('Akzeptanz 2: validityEnd 2026-06-22T23:59:59.999Z bei heute 2026-06-22 → current', () => {
    const o = offer({
      id: 'cur',
      validityStart: '2026-06-16T00:00:00.000Z',
      validityEnd: '2026-06-22T23:59:59.999Z',
    });
    expect(offerEndYmd(o)).toBe(20260622);
    expect(classifyLiveWindow(o, NOW)).toBe('current');
  });

  it('Akzeptanz 3: validityStart 2026-06-23T00:00:00.000Z → offerStartYmd 20260623, classify "next"', () => {
    const o = offer({
      id: 'fut',
      validityStart: '2026-06-23T00:00:00.000Z',
      validityEnd: '2026-06-29T23:59:59.999Z',
    });
    expect(offerStartYmd(o)).toBe(20260623);
    expect(classifyLiveWindow(o, NOW)).toBe('next');
  });

  it('Akzeptanz 4: validityStart 2026-06-22T00:00:00.000Z bei heute 2026-06-22 → current', () => {
    const o = offer({
      id: 'starts-today',
      validityStart: '2026-06-22T00:00:00.000Z',
      validityEnd: '2026-06-28T23:59:59.999Z',
    });
    expect(offerStartYmd(o)).toBe(20260622);
    expect(classifyLiveWindow(o, NOW)).toBe('current');
  });

  it('reines YYYY-MM-DD (ohne Zeit) bleibt unverändert der Datumsteil', () => {
    const o = offer({ id: 'plain', validityStart: '2026-06-20', validityEnd: '2026-06-21' });
    expect(offerStartYmd(o)).toBe(20260620);
    expect(offerEndYmd(o)).toBe(20260621);
    expect(classifyLiveWindow(o, NOW)).toBe('other');
  });
});

describe('splitOffersByLiveWindow — Snapshot-Aufteilung ohne stillen Verlust', () => {
  const weekBucketOf = (): 'current' | 'next' | 'other' => 'other';

  it('schiebt "ab-montag/-mittwoch/-freitag/-15.06" aus live nach next', () => {
    const offers = [
      offer({ id: 'mo', sourceUrl: 'https://x/ab-montag,-08.06.26' }),
      offer({ id: 'mi', sourceUrl: 'https://x/ab-mittwoch,-10.06.26' }),
      offer({ id: 'fr', sourceUrl: 'https://x/ab-freitag,-12.06.26' }),
      offer({ id: 'mo2', sourceUrl: 'https://x/ab-montag,-15.06.26' }),
    ];
    const split = splitOffersByLiveWindow(offers, { now: SUNDAY, weekBucketOf });
    expect(split.current).toHaveLength(0);
    expect(split.next.map((o) => o.id).sort()).toEqual(['fr', 'mi', 'mo', 'mo2']);
  });

  it('heute gültige Angebote bleiben live', () => {
    const offers = [offer({ id: 'today', validityStart: '2026-06-03', validityEnd: '2026-06-09' })];
    const split = splitOffersByLiveWindow(offers, { now: SUNDAY, weekBucketOf });
    expect(split.current.map((o) => o.id)).toEqual(['today']);
  });

  it('preserved REWE OHNE Datumssignal bleibt live (Manuell-Import verschwindet nie)', () => {
    const offers = [
      offer({ id: 'rewe', storeChain: 'REWE', validityStart: '', validityEnd: '', sourceUrl: 'https://x' }),
    ];
    const split = splitOffersByLiveWindow(offers, {
      now: SUNDAY,
      weekBucketOf,
      isPreserved: (o) => o.storeChain.toLowerCase() === 'rewe',
    });
    expect(split.current.map((o) => o.id)).toEqual(['rewe']);
    expect(split.dropped).toHaveLength(0);
  });

  it('preserved REWE mit valid_to in der Vergangenheit ist abgelaufen → verworfen, NICHT live', () => {
    // Datumshygiene schlägt die Preserve-Regel: ein abgelaufenes Angebot darf
    // auch für einen manuellen Import nie als current erscheinen.
    const offers = [
      offer({ id: 'rewe', storeChain: 'REWE', validityStart: '2026-05-20', validityEnd: '2026-05-26' }),
    ];
    const split = splitOffersByLiveWindow(offers, {
      now: SUNDAY,
      weekBucketOf,
      isPreserved: (o) => o.storeChain.toLowerCase() === 'rewe',
    });
    expect(split.current).toHaveLength(0);
    expect(split.next).toHaveLength(0);
    expect(split.dropped.map((o) => o.id)).toEqual(['rewe']);
  });

  it('preserved REWE mit Zukunftsstart bleibt erhalten, landet aber in next', () => {
    const offers = [
      offer({ id: 'rewe_next', storeChain: 'REWE', validityStart: '2026-06-10', validityEnd: '2026-06-16' }),
    ];
    const split = splitOffersByLiveWindow(offers, {
      now: SUNDAY,
      weekBucketOf,
      isPreserved: (o) => o.storeChain.toLowerCase() === 'rewe',
    });
    expect(split.next.map((o) => o.id)).toEqual(['rewe_next']);
    expect(split.dropped).toHaveLength(0);
  });

  it('datenlose Nicht-REWE-Angebote folgen dem Wochenbucket (kein Promoten ins Live)', () => {
    const offers = [offer({ id: 'dl', validityStart: '', validityEnd: '', sourceUrl: 'https://x' })];
    const split = splitOffersByLiveWindow(offers, {
      now: SUNDAY,
      weekBucketOf: () => 'current',
    });
    expect(split.current.map((o) => o.id)).toEqual(['dl']);
  });
});

describe('dropExpiredFromActiveBuckets — generische Expired-Bereinigung der aktiven Buckets', () => {
  // Scan-Kontext-Heute des realen Drift-Falls: 2026-06-22 (Berlin). Ein nahkauf-
  // Angebot mit valid_to 2026-06-21 liegt fälschlich im current-Bucket.
  const TODAY = new Date('2026-06-22T08:00:00.000Z');

  it('entfernt abgelaufene current-Angebote (valid_to gestern), behält gültige', () => {
    const result = dropExpiredFromActiveBuckets(
      {
        offers: [
          // nahkauf NUR als Fixture — keine Shop-Sonderlogik.
          offer({ id: 'nk_expired', storeChain: 'nahkauf', validityStart: '2026-06-15', validityEnd: '2026-06-21' }),
          offer({ id: 'nk_valid_today', storeChain: 'nahkauf', validityStart: '2026-06-16', validityEnd: '2026-06-22' }),
          offer({ id: 'lidl_valid', storeChain: 'Lidl', validityStart: '2026-06-20', validityEnd: '2026-06-26' }),
        ],
        nextWeekOffers: [],
        filteredOffers: [],
      },
      { now: TODAY },
    );
    expect(result.offers.map((o) => o.id).sort()).toEqual(['lidl_valid', 'nk_valid_today']);
    expect(result.removedCount).toBe(1);
    expect(result.removedExamples).toEqual(['nk_expired']);
  });

  it('valid_to == heute bleibt current, valid_from morgen bleibt in nextWeek', () => {
    const result = dropExpiredFromActiveBuckets(
      {
        offers: [offer({ id: 'ends_today', validityStart: '2026-06-18', validityEnd: '2026-06-22' })],
        nextWeekOffers: [offer({ id: 'starts_tomorrow', validityStart: '2026-06-23', validityEnd: '2026-06-29' })],
        filteredOffers: [],
      },
      { now: TODAY },
    );
    expect(result.offers.map((o) => o.id)).toEqual(['ends_today']);
    expect(result.nextWeekOffers.map((o) => o.id)).toEqual(['starts_tomorrow']);
    expect(result.removedCount).toBe(0);
  });

  it('lässt filteredOffers unberührt (auch abgelaufene bleiben gefiltert)', () => {
    const result = dropExpiredFromActiveBuckets(
      {
        offers: [],
        nextWeekOffers: [],
        filteredOffers: [offer({ id: 'f_expired', validityStart: '2026-06-01', validityEnd: '2026-06-05' })],
      },
      { now: TODAY },
    );
    expect(result.filteredOffers.map((o) => o.id)).toEqual(['f_expired']);
    expect(result.removedCount).toBe(0);
  });

  it('ist idempotent — ein zweiter Lauf entfernt nichts mehr', () => {
    const start = {
      offers: [
        offer({ id: 'expired', validityStart: '2026-06-10', validityEnd: '2026-06-20' }),
        offer({ id: 'valid', validityStart: '2026-06-20', validityEnd: '2026-06-26' }),
      ],
      nextWeekOffers: [] as Offer[],
      filteredOffers: [] as Offer[],
    };
    const first = dropExpiredFromActiveBuckets(start, { now: TODAY });
    expect(first.removedCount).toBe(1);
    const second = dropExpiredFromActiveBuckets(first, { now: TODAY });
    expect(second.removedCount).toBe(0);
    expect(second.offers.map((o) => o.id)).toEqual(['valid']);
  });
});
