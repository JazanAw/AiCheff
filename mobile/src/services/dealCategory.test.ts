import { describe, expect, it } from 'vitest';
import { mapCategoryFromName, resolveDealCategory } from './dealCategory';

// Falsche Kategorien in der App. Das Backend hatte jedes dieser Produkte
// korrekt eingeordnet — die App warf das Ergebnis weg und riet per Substring
// aus dem Produktnamen neu. Gemessen am Lauf 2026-08-17: 214 von 1071
// sichtbaren Angeboten (20 %) wichen dadurch vom Backend ab.
//
// Der bekannteste Fall: /eis/ trifft mitten in "Sp-eis-emöhren" und machte aus
// Möhren eine Süßigkeit. Dieselbe Substring-Falle wie "saft" in "Entsafter".
describe('resolveDealCategory — Backend-Kategorie führt', () => {
  it.each([
    ['Speisemöhren', 'Obst & Gemüse', 'fruits_vegetables'],
    ['Dän. Snackmöhren', 'Obst & Gemüse', 'fruits_vegetables'],
    ['Butterweizenbrot', 'Backwaren', 'bakery'],
    ['Haribo Fruchtgummi Minis', 'Süßwaren & Snacks', 'snacks_sweets'],
    ['Corny Müsliriegel Milch Classic', 'Süßwaren & Snacks', 'snacks_sweets'],
    ['Landliebe Sahnepudding', 'Süßwaren & Snacks', 'snacks_sweets'],
    ['Jack Daniel’s Tennessee Whiskey', 'Alkohol', 'drinks'],
    ['Veltins Pilsener oder V+', 'Alkohol', 'drinks'],
    ['BEN & JERRY’S Cool-lection Eis', 'Tiefkühl', 'frozen'],
    ['Frosta à la Carte Wildlachs & Garnelen', 'Tiefkühl', 'frozen'],
  ])('%s (Backend: %s) → %s', (name, main, expected) => {
    expect(resolveDealCategory({ name, category: 'Sonstiges', canonicalCategory: { main } })).toBe(
      expected,
    );
  });

  // Die Hauptkategorie gewinnt auch gegen einen irrefuehrenden simple-category-
  // Wert, der frueher mit in die Regex floss.
  it('ignoriert eine widersprüchliche einfache Kategorie', () => {
    expect(
      resolveDealCategory({
        name: 'Speisemöhren',
        category: 'Tiefkühl',
        canonicalCategory: { main: 'Obst & Gemüse' },
      }),
    ).toBe('fruits_vegetables');
  });

  it.each([
    [undefined],
    [null],
    [{ main: '' }],
    [{ main: 'Voellig unbekannte Kategorie' }],
  ])('faellt ohne mappbare Hauptkategorie auf die Namensheuristik zurück (%s)', (canonical) => {
    expect(
      resolveDealCategory({
        name: 'Rinderhackfleisch',
        category: 'Fleisch',
        canonicalCategory: canonical as never,
      }),
    ).toBe('meat_fish');
  });
});

// Der Fallback bleibt bewusst unveraendert — diese Tests halten sein Verhalten
// fest und dokumentieren, warum er nicht mehr fuehrend sein darf.
describe('mapCategoryFromName — Fallback, mit bekannten Substring-Schwächen', () => {
  it('ordnet klare Fälle weiterhin korrekt zu', () => {
    expect(mapCategoryFromName('Fleisch', 'Rinderhack', [])).toBe('meat_fish');
    expect(mapCategoryFromName('Obst/Gemüse', 'Äpfel', [])).toBe('fruits_vegetables');
  });

  it('zeigt die Substring-Falle, die den Umbau nötig machte', () => {
    // "Sp-eis-emöhren" → /eis/ → Süßigkeit. Genau deshalb führt jetzt das Backend.
    expect(mapCategoryFromName('Sonstiges', 'Speisemöhren', [])).toBe('snacks_sweets');
  });
});

// Die drei neuen Eimer (Migration 20260819000001). Vorher fielen 211 von 214
// "other"-Angeboten hierher — es waren nie Restposten, sondern fehlende
// Kategorien.
describe('resolveDealCategory — Backwaren, Vorrat, Fertig', () => {
  it.each([
    ['Leicht & Cross Knusperbrot', 'Backwaren', 'bakery'],
    ['Bahlsen Comtess Kuchen', 'Backwaren', 'bakery'],
    ['Jacobs Krönung', 'Grundnahrungsmittel', 'pantry'],
    ['Barilla Spaghetti', 'Grundnahrungsmittel', 'pantry'],
    ['Heinz Curry Mango Sauce', 'Gewürze/Saucen/Aufstriche', 'pantry'],
    ['Schwartau Extra Konfitüre', 'Gewürze/Saucen/Aufstriche', 'pantry'],
    ['Kühne Schlemmertöpfchen', 'Konserven & Fertiggerichte', 'ready_meals'],
    ['Bonduelle Kidney Bohnen', 'Konserven & Fertiggerichte', 'ready_meals'],
    ['HOMANN Feinkostsalat', 'Feinkost & Kühlung', 'ready_meals'],
    ['Rügenwalder Vegane Mühlen Salami', 'Feinkost & Kühlung', 'ready_meals'],
  ])('%s (Backend: %s) → %s', (name, main, expected) => {
    expect(resolveDealCategory({ name, category: 'Sonstiges', canonicalCategory: { main } })).toBe(
      expected,
    );
  });

  it('laesst nur Non-Food in other', () => {
    expect(resolveDealCategory({ name: 'Pfanne', canonicalCategory: { main: 'Non-Food' } })).toBe(
      'other',
    );
  });
});
