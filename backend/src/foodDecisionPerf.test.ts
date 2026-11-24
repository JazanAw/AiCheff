import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';

// Regressionsschutz für die EIGENTLICHE Live-Ursache des „Prozess weg"-Fehlers:
// der Scan-Report klassifiziert jedes Angebot mehrfach (Gate/Rescue/Report/Phase2)
// — bei ~2.600 Angeboten sind das ~18k classifyFoodDecision-Aufrufe je Build.
// Vor dem Fix normalisierte JEDER Aufruf hunderte KONSTANTE Keywords neu und
// kompilierte für Wortgrenzen-Keywords jedes Mal ein frisches `new RegExp`,
// sodass ein Cold-Build ~18 s den Event-Loop blockierte und /api/health auslief
// (ein Watchdog tötete den „hängenden" Prozess → SIGTERM, kein JS-Stacktrace).
// Mit der Keyword-/RegExp-Memoisierung muss dieselbe Last in Sekundenbruchteilen
// laufen. Großzügige Schranke, damit der Test auf langsamer CI nicht flackert,
// aber die alte ~18-s-Regression zuverlässig fängt.

function makeOffer(overrides: Partial<Offer> & Record<string, unknown> = {}): Offer {
  const name = (overrides.name as string) ?? 'Produkt';
  return {
    id: 'o1',
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-05-26T00:00:00.000Z',
    validityEnd: '2026-06-01T23:59:59.999Z',
    sourceUrl: 'https://example.com/offer',
    tags: [],
    createdAt: '2026-05-26T08:00:00.000Z',
    ...overrides,
  } as Offer;
}

describe('classifyFoodDecision — Performance (Event-Loop-Schutz)', () => {
  it('klassifiziert tausende Angebote mehrfach in Sekundenbruchteilen', () => {
    // Gemischte Namen, damit Food-, Non-Food- und Unsicher-Pfade getroffen werden.
    const names = [
      'Bio Vollmilch 3,5%',
      'Basmati Reis 1kg',
      'Badeponcho Kinder',
      'Tankini Damen',
      'Spritzring Pool',
      'Jacobs Krönung gemahlen',
      'Rosenstrauss bunt',
      'Hähnchenbrustfilet',
      'LED Tischleuchte',
      'Gouda jung am Stück',
    ];
    const offers: Offer[] = Array.from({ length: 2000 }, (_, i) =>
      makeOffer({ name: `${names[i % names.length]} ${i}` }),
    );

    const start = performance.now();
    // 6 Durchläufe ahmen die mehrfache Klassifikation eines Report-Builds nach.
    for (let pass = 0; pass < 6; pass += 1) {
      for (const offer of offers) {
        classifyFoodDecision(offer);
      }
    }
    const elapsedMs = performance.now() - start;

    // Vor dem Fix: ~9–18 s (deutlich über 5 s). Nach dem Fix: < 1 s.
    expect(elapsedMs).toBeLessThan(5000);
  });
});
