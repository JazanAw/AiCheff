import { describe, expect, it } from 'vitest';
import { categoryFromTrustedSourceDepartment } from './offerCategory';

// Falsche Hauptkategorien aus dem Lauf 2026-08-17. `applyTrustedSourceCategory`
// stempelt die Abteilung mit Konfidenz 0.95 auf die Hauptkategorie — greift sie
// bei einer GEMISCHTEN Abteilung, wird der Fehler praktisch unumkehrbar.
//
// Gemessen: Die Regel feuerte bei 21 Angeboten und erzeugte bei 16 davon ein
// Paar, das es in der Taxonomie gar nicht gibt (76 % Fehlerquote). Die
// auslösenden Abteilungen waren "Getränke, Spirituosen" (8), "Tiefkühl" (6),
// "Zeit für einen Aperitif" (3), "Gekühlte & tiefgekühlte Produkte" (2).
//
// Der Doc-Kontrakt der Funktion verlangt seit jeher, dass gemischte Abteilungen
// NICHTS erzwingen — nur geprüft wurde das bisher allein für "alkoholfrei".
describe('categoryFromTrustedSourceDepartment — gemischte Abteilungen erzwingen nichts', () => {
  it.each([
    ['Getränke, Spirituosen', 'kombinierter Gang: Cola/Wasser/Energy neben Spirituosen'],
    ['Getränke & Spirituosen', 'Schreibvariante desselben Gangs'],
    ['Alkoholfreie Getränke', 'alkoholfrei entwertet das Alkohol-Signal'],
    ['Gekühlte & tiefgekühlte Produkte', 'Frische UND Tiefkühl im selben Gang'],
  ])('%s → null', (dept) => {
    expect(categoryFromTrustedSourceDepartment(dept)).toBeNull();
  });

  // "Zeit für einen Aperitif" ist ein Werbethema, keine Abteilung — es enthielt
  // Physalis und Passionsfrucht. Anlass-Wörter gehören nicht ins Vokabular.
  it.each([
    ['Zeit für einen Aperitif'],
    ['Aperitif-Wochen'],
    ['Longdrink Special'],
  ])('Anlass-Thema %s erzwingt nichts', (dept) => {
    expect(categoryFromTrustedSourceDepartment(dept)).toBeNull();
  });

  // Gegenprobe: echte, eindeutige Abteilungen müssen weiter greifen.
  it.each<[string, string]>([
    ['Tiefkühl', 'Tiefkühl'],
    ['Tiefkühlkost', 'Tiefkühl'],
    ['Bedürfniswelten/Wein, Bier und Spirituosen/Wein/Rotwein', 'Alkohol'],
    ['Wein & Spirituosen', 'Alkohol'],
    ['Bier', 'Alkohol'],
    ['Obst & Gemüse', 'Obst/Gemüse'],
  ])('%s → %s', (dept, expected) => {
    expect(categoryFromTrustedSourceDepartment(dept)).toBe(expected);
  });

  it.each([['Angebote der Woche'], ['Markenartikel'], ['Drogerie'], ['']])(
    'neutrale/Non-Food-Abteilung %s erzwingt nichts',
    (dept) => {
      expect(categoryFromTrustedSourceDepartment(dept)).toBeNull();
    },
  );
});
