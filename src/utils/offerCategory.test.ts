import { describe, expect, it } from 'vitest';
import {
  categoryFromTrustedSourceDepartment,
  mapCanonicalToSimpleCategory,
  repairSimpleOfferCategory,
  simpleToCanonicalMain,
  toSimpleOfferCategory,
} from './offerCategory';

describe('categoryFromTrustedSourceDepartment — Quellenpriorität (P3)', () => {
  it('eindeutige Tiefkühl-/Frozen-Abteilung → Tiefkühl', () => {
    expect(categoryFromTrustedSourceDepartment('Tiefkühl')).toBe('Tiefkühl');
    expect(categoryFromTrustedSourceDepartment('Tiefkühlkost')).toBe('Tiefkühl');
    expect(categoryFromTrustedSourceDepartment('Frozen Food')).toBe('Tiefkühl');
  });

  it('Wein/Spirituosen/Bier → Alkohol (alkoholfrei entwertet das Signal)', () => {
    expect(categoryFromTrustedSourceDepartment('Wein und Spirituosen')).toBe('Alkohol');
    expect(categoryFromTrustedSourceDepartment('Bier')).toBe('Alkohol');
    expect(categoryFromTrustedSourceDepartment('Wein & Spirituosen')).toBe('Alkohol');
    expect(categoryFromTrustedSourceDepartment('Getränke alkoholfrei')).not.toBe('Alkohol');
  });

  it('Obst/Gemüse-Abteilung → Obst/Gemüse', () => {
    expect(categoryFromTrustedSourceDepartment('Obst & Gemüse')).toBe('Obst/Gemüse');
    expect(categoryFromTrustedSourceDepartment('Gemüse')).toBe('Obst/Gemüse');
  });

  it('neutrale Abteilungen erzwingen keine Kategorie (→ null)', () => {
    for (const dept of [
      'Angebote',
      'Bonus-Aktionen',
      'Markenartikel',
      'Filialangebote',
      'NORMA Angebote',
      'Aktionen & Angebote',
    ]) {
      expect(categoryFromTrustedSourceDepartment(dept), dept).toBeNull();
    }
  });

  it('Non-Food-Abteilungen erzwingen keine Food-Kategorie (→ null)', () => {
    for (const dept of ['Drogerie', 'Haushalt', 'Tierbedarf', 'Bekleidung', 'Freizeit und Mode']) {
      expect(categoryFromTrustedSourceDepartment(dept), dept).toBeNull();
    }
  });

  it('leere/fehlende Abteilung → null', () => {
    expect(categoryFromTrustedSourceDepartment('')).toBeNull();
    expect(categoryFromTrustedSourceDepartment(undefined)).toBeNull();
  });

  it('simpleToCanonicalMain ist die Umkehrung für die vertrauenswürdigen Kategorien', () => {
    expect(simpleToCanonicalMain('Tiefkühl')).toBe('Tiefkühl');
    expect(simpleToCanonicalMain('Alkohol')).toBe('Alkohol');
    expect(simpleToCanonicalMain('Obst/Gemüse')).toBe('Obst & Gemüse');
  });
});

describe('toSimpleOfferCategory', () => {
  it('ordnet typische frische Produkte korrekt zu', () => {
    expect(toSimpleOfferCategory('Obst und Gem\u00fcse')).toBe('Obst/Gem\u00fcse');
    expect(toSimpleOfferCategory('Fleischwaren')).toBe('Fleisch');
    expect(toSimpleOfferCategory('Fisch und Meeresfr\u00fcchte')).toBe('Fisch');
  });

  it('ordnet typische Vorrats-, Tiefkuehl- und Snack-Bereiche zu', () => {
    expect(toSimpleOfferCategory('Nudeln und Reis')).toBe('Trockenware');
    expect(toSimpleOfferCategory('Konserven')).toBe('Konserven');
    expect(toSimpleOfferCategory('Tiefk\u00fchlkost')).toBe('Tiefk\u00fchl');
    expect(toSimpleOfferCategory('S\u00fc\u00dfigkeiten')).toBe('Snacks/S\u00fc\u00dfes');
  });

  it('trennt alkoholische und alkoholfreie Getraenke', () => {
    expect(toSimpleOfferCategory(undefined, 'Red Bull Energy Drink')).toBe(
      'Getr\u00e4nke Alkoholfrei',
    );
    expect(toSimpleOfferCategory(undefined, 'Pils Bier')).toBe('Alkohol');
  });

  it('nutzt bei Bedarf den Hinttext', () => {
    expect(toSimpleOfferCategory('Sonstiges', 'Haferdrink Natur')).toBe('Milchalternativen');
  });

  it('faellt bei unbekannt auf Sonstiges zurueck', () => {
    expect(toSimpleOfferCategory('Unbekannt')).toBe('Sonstiges');
  });

  it('mappt gängige Marken/Produkte konservativ ohne Kategorie', () => {
    // Getränke alkoholfrei
    expect(toSimpleOfferCategory(undefined, 'Coca Cola 1,5l')).toBe('Getränke Alkoholfrei');
    expect(toSimpleOfferCategory(undefined, 'Fanta Orange')).toBe('Getränke Alkoholfrei');
    // Snacks/Süßes
    expect(toSimpleOfferCategory(undefined, 'Haribo Goldbären')).toBe('Snacks/Süßes');
    expect(toSimpleOfferCategory(undefined, 'Milka Alpenmilch')).toBe('Snacks/Süßes');
    // Milchprodukte
    expect(toSimpleOfferCategory(undefined, 'Buttermilch')).toBe('Milchprodukte');
    expect(toSimpleOfferCategory(undefined, 'Feta Schafskäse')).toBe('Milchprodukte');
    // Fleisch
    expect(toSimpleOfferCategory(undefined, 'Bratwurst grob')).toBe('Fleisch');
    // Obst/Gemüse
    expect(toSimpleOfferCategory(undefined, 'Frische Zucchini')).toBe('Obst/Gemüse');
  });

  it('erkennt Kompositum-Säfte als Getränk, nicht als Obst', () => {
    // "Apfel" am Wortanfang würde sonst fälschlich Obst/Gemüse ergeben.
    expect(toSimpleOfferCategory(undefined, 'Apfelsaft naturtrüb 1l')).toBe('Getränke Alkoholfrei');
    // "Orange" steht bewusst nicht in den Obst-Keywords; "saft" am Ende greift.
    expect(toSimpleOfferCategory(undefined, 'Orangensaft 1,0l')).toBe('Getränke Alkoholfrei');
    expect(toSimpleOfferCategory(undefined, 'Traubenschorle')).toBe('Getränke Alkoholfrei');
    // Alkohol-Signal hat Vorrang vor der Saft-Heuristik.
    expect(toSimpleOfferCategory(undefined, 'Weinschorle')).toBe('Alkohol');
  });

  it('deckt die geforderten schwierigen Fälle ab', () => {
    expect(toSimpleOfferCategory(undefined, 'Red Bull Energy Drink')).toBe('Getränke Alkoholfrei');
    expect(toSimpleOfferCategory(undefined, 'Coca Cola 1,5l')).toBe('Getränke Alkoholfrei');
    expect(toSimpleOfferCategory(undefined, 'Katjes Fruchtgummi')).toBe('Snacks/Süßes');
    expect(toSimpleOfferCategory(undefined, 'Milka Oreo Schokolade')).toBe('Snacks/Süßes');
    expect(toSimpleOfferCategory(undefined, 'Mozzarella di Bufala')).toBe('Milchprodukte');
    expect(toSimpleOfferCategory(undefined, 'Joghurt mild')).toBe('Milchprodukte');
    expect(toSimpleOfferCategory(undefined, 'Hähnchenbrust')).toBe('Fleisch');
    expect(toSimpleOfferCategory(undefined, 'Frischer Lachs')).toBe('Fisch');
    expect(toSimpleOfferCategory(undefined, 'Tomaten')).toBe('Obst/Gemüse');
    expect(toSimpleOfferCategory(undefined, 'Kartoffeln festkochend')).toBe('Obst/Gemüse');
    expect(toSimpleOfferCategory(undefined, 'Iglo')).toBe('Tiefkühl');
    expect(toSimpleOfferCategory(undefined, 'Frosta')).toBe('Tiefkühl');
    expect(toSimpleOfferCategory(undefined, 'Pils Bier')).toBe('Alkohol');
    expect(toSimpleOfferCategory(undefined, 'Riesling Wein')).toBe('Alkohol');
    expect(toSimpleOfferCategory(undefined, 'Sekt trocken')).toBe('Alkohol');
    // Non-Food hat in der einfachen Taxonomie keinen Lebensmittel-Bucket ->
    // ehrlich "Sonstiges" (im echten Flow filtert der Strict-Food-Filter raus).
    expect(toSimpleOfferCategory(undefined, 'Shampoo Repair')).toBe('Sonstiges');
    expect(toSimpleOfferCategory(undefined, 'Waschmittel Color')).toBe('Sonstiges');
    expect(toSimpleOfferCategory(undefined, 'Katzenfutter Adult')).toBe('Sonstiges');
    // Bewusst unbekannter Name bleibt Sonstiges.
    expect(toSimpleOfferCategory(undefined, 'Zxqwerty Mystery 500')).toBe('Sonstiges');
  });
});

describe('toSimpleOfferCategory — gehärtete Regeln (Datenqualität)', () => {
  it('erkennt Alkohol an der %-Vol-Angabe, auch wenn "Spritz" im Namen steht', () => {
    // Lidl "Limoncello Spritz 6,9% Vol" darf NICHT "Getränke Alkoholfrei" sein.
    expect(toSimpleOfferCategory('Getränke Alkoholfrei', 'Limoncello Spritz 6,9% Vol')).toBe(
      'Alkohol',
    );
    expect(toSimpleOfferCategory(undefined, 'Limoncello Spritz 6,9% Vol')).toBe('Alkohol');
    // %-Vol-Marker reicht, selbst ohne bekanntes Alkohol-Stichwort.
    expect(toSimpleOfferCategory(undefined, "Beck's Pils 4,9% Vol")).toBe('Alkohol');
  });

  it('respektiert "alkoholfrei" explizit und schlägt damit das Bier-/Wein-Signal', () => {
    expect(toSimpleOfferCategory(undefined, "Beck's Bier alkoholfrei")).toBe(
      'Getränke Alkoholfrei',
    );
    expect(toSimpleOfferCategory('Alkohol', 'Krombacher Pils alkoholfrei')).toBe(
      'Getränke Alkoholfrei',
    );
  });

  it('ordnet Chips/Crunchips als Snack ein, auch mit Gemüse-Geschmack im Namen', () => {
    // REWE "Lorenz Crunchips Paprika" darf nicht Obst/Gemüse sein.
    expect(toSimpleOfferCategory('Obst & Gemüse', 'Lorenz Crunchips Paprika')).toBe(
      'Snacks/Süßes',
    );
    expect(toSimpleOfferCategory(undefined, 'funny-frisch Kesselchips Sweet Chili')).toBe(
      'Snacks/Süßes',
    );
    expect(toSimpleOfferCategory(undefined, 'Kartoffelchips Paprika')).toBe('Snacks/Süßes');
    // Echtes Gemüse bleibt Obst/Gemüse (keine Snack-Fehlzuordnung).
    expect(toSimpleOfferCategory(undefined, 'Paprika rot 500g')).toBe('Obst/Gemüse');
  });

  it('ein Marketingwort wie "Snack" überstimmt echtes Obst nicht (P3)', () => {
    // "Snack Äpfel" ist Obst/Gemüse — der Umlaut-Plural Äpfel wird erkannt.
    expect(toSimpleOfferCategory(undefined, 'Snack Äpfel')).toBe('Obst/Gemüse');
    expect(toSimpleOfferCategory('Obst und Gemüse', 'Snack Äpfel „Gala" je 1-kg-Schale')).toBe(
      'Obst/Gemüse',
    );
    // Gegenprobe: echte Snacks ohne Obstsignal bleiben Snacks.
    expect(toSimpleOfferCategory(undefined, 'Lorenz Crunchips')).toBe('Snacks/Süßes');
  });

  it('ordnet Noodles/Pasta als Trockenware ein, nicht als Obst/Gemüse', () => {
    // REWE "Noodles Teriyaki" darf nicht Obst/Gemüse sein.
    expect(toSimpleOfferCategory('Obst & Gemüse', 'Noodles Teriyaki')).toBe('Trockenware');
    expect(toSimpleOfferCategory(undefined, 'Asia Noodles Wok')).toBe('Trockenware');
    expect(toSimpleOfferCategory('Obst & Gemüse', 'Spaghetti No.5')).toBe('Trockenware');
  });

  it('ordnet Pasta(-formen), Pesto und Barilla als Trockenware ein (REWE)', () => {
    expect(toSimpleOfferCategory(undefined, 'Barilla Collezione Farfalle')).toBe('Trockenware');
    expect(toSimpleOfferCategory(undefined, 'Barilla Pesto Rosso')).toBe('Trockenware');
    expect(toSimpleOfferCategory(undefined, 'Fusilli No.98')).toBe('Trockenware');
  });

  it('ordnet Eiscreme/Ben & Jerry’s als Tiefkühl ein, nicht Sonstiges', () => {
    expect(toSimpleOfferCategory(undefined, "Ben & Jerry's Ice Cream")).toBe('Tiefkühl');
    expect(toSimpleOfferCategory(undefined, 'Cornetto Classico')).toBe('Tiefkühl');
    // "Ice Tea" ist KEIN Speiseeis und darf nicht Tiefkühl werden.
    expect(toSimpleOfferCategory(undefined, 'Nestea Ice Tea Zitrone')).not.toBe('Tiefkühl');
  });

  it('ordnet Kopfsalat als Obst/Gemüse ein (REWE Bonduelle Kopfsalat)', () => {
    expect(toSimpleOfferCategory(undefined, 'Bonduelle Kopfsalat')).toBe('Obst/Gemüse');
    expect(toSimpleOfferCategory(undefined, 'Eisbergsalat')).toBe('Obst/Gemüse');
  });
});

describe('mapCanonicalToSimpleCategory', () => {
  const cc = (main: string, sub = 'unknown', confidence = 0.95, isNonFood = false) => ({
    main,
    sub,
    confidence,
    isNonFood,
  });

  it('übernimmt die reichhaltige Python-Hauptkategorie in die einfache Taxonomie', () => {
    expect(mapCanonicalToSimpleCategory(cc('Fleisch & Wurst'))).toBe('Fleisch');
    expect(mapCanonicalToSimpleCategory(cc('Fisch & Meeresfrüchte'))).toBe('Fisch');
    expect(mapCanonicalToSimpleCategory(cc('Milchprodukte & Eier'))).toBe('Milchprodukte');
    expect(mapCanonicalToSimpleCategory(cc('Obst & Gemüse'))).toBe('Obst/Gemüse');
    expect(mapCanonicalToSimpleCategory(cc('Backwaren'))).toBe('Backwaren');
    expect(mapCanonicalToSimpleCategory(cc('Getränke alkoholfrei'))).toBe('Getränke Alkoholfrei');
    expect(mapCanonicalToSimpleCategory(cc('Alkohol'))).toBe('Alkohol');
    expect(mapCanonicalToSimpleCategory(cc('Süßwaren & Snacks'))).toBe('Snacks/Süßes');
    expect(mapCanonicalToSimpleCategory(cc('Grundnahrungsmittel', 'Nudeln & Reis'))).toBe('Trockenware');
    expect(mapCanonicalToSimpleCategory(cc('Tiefkühl'))).toBe('Tiefkühl');
    expect(mapCanonicalToSimpleCategory(cc('Konserven & Fertiggerichte'))).toBe('Konserven');
    expect(mapCanonicalToSimpleCategory(cc('Gewürze/Saucen/Aufstriche', 'Saucen'))).toBe('Trockenware');
  });

  it('nutzt Sub für Milchalternativen', () => {
    expect(mapCanonicalToSimpleCategory(cc('Milchprodukte & Eier', 'Milchalternativen'))).toBe('Milchalternativen');
    expect(mapCanonicalToSimpleCategory(cc('Feinkost & Kühlung', 'Tofu & Veggie'))).toBe('Milchalternativen');
  });

  it('bleibt ehrlich offen (null) bei Non-Food, niedriger Confidence oder unklarem Main', () => {
    // Non-Food -> kein Lebensmittel-Bucket.
    expect(mapCanonicalToSimpleCategory(cc('Non-Food', 'Körperpflege'))).toBeNull();
    // Reiner No-Match-Fallback der Pipeline (niedrige Confidence) -> nicht übernehmen.
    expect(mapCanonicalToSimpleCategory(cc('Grundnahrungsmittel', 'unknown', 0.42))).toBeNull();
    // Gemischtes Kühlregal ohne klares Sub bleibt offen.
    expect(mapCanonicalToSimpleCategory(cc('Feinkost & Kühlung', 'Kühlregal'))).toBeNull();
    // Fehlende Eingabe.
    expect(mapCanonicalToSimpleCategory(null)).toBeNull();
    expect(mapCanonicalToSimpleCategory(undefined)).toBeNull();
  });
});

describe('repairSimpleOfferCategory — offensichtliche Kategorie-Fehler korrigieren', () => {
  it('korrigiert die gemeldeten Live-Fehlkategorien anhand des Produktnamens', () => {
    // Grillkäse(mix) ist Milchprodukt, nie "Getränke Alkoholfrei".
    expect(repairSimpleOfferCategory({ name: 'Grillkäse Mix', category: 'Getränke Alkoholfrei' })).toBe('Milchprodukte');
    // Milchreis ist Milchprodukt, nie Obst/Gemüse.
    expect(repairSimpleOfferCategory({ name: 'Müller Milchreis Natur', category: 'Obst/Gemüse' })).toBe('Milchprodukte');
    // Falafel / Gemüsebällchen sind Fertiggericht, nie Obst/Gemüse.
    expect(repairSimpleOfferCategory({ name: 'Vegane Falafel', category: 'Obst/Gemüse' })).not.toBe('Obst/Gemüse');
    expect(repairSimpleOfferCategory({ name: 'Gemüsebällchen', category: 'Obst/Gemüse' })).not.toBe('Obst/Gemüse');
    // Barilla Pesto / Pasta-Sauce / Knorr Fix gehören in die Trockenware.
    expect(repairSimpleOfferCategory({ name: 'Barilla Pesto alla Genovese', category: 'Tiefkühl' })).toBe('Trockenware');
    expect(repairSimpleOfferCategory({ name: 'Knorr Fix Spaghetti Bolognese', category: 'Sonstiges' })).toBe('Trockenware');
    // Nimm 2 Lachgummi ist Süßware, nie Sonstiges.
    expect(repairSimpleOfferCategory({ name: 'Nimm 2 Lachgummi', category: 'Sonstiges' })).toBe('Snacks/Süßes');
    // Spargel / Kiwi sind Obst/Gemüse, nicht Sonstiges.
    expect(repairSimpleOfferCategory({ name: 'Deutscher Spargel weiß', category: 'Sonstiges' })).toBe('Obst/Gemüse');
    expect(repairSimpleOfferCategory({ name: 'Zespri Kiwi', category: 'Sonstiges' })).toBe('Obst/Gemüse');
  });

  it('übersperrt nicht: korrekte Kategorien und Getränke/Schorlen bleiben unverändert', () => {
    // Eine Kiwi-Schorle ist ein Getränk und darf nicht zu Obst/Gemüse werden.
    expect(repairSimpleOfferCategory({ name: 'Kiwi-Apfel-Schorle', category: 'Getränke Alkoholfrei' })).toBe('Getränke Alkoholfrei');
    // Kein Reparatur-Stichwort -> Kategorie bleibt, wie sie ist.
    expect(repairSimpleOfferCategory({ name: 'Thunfisch Pizza', category: 'Tiefkühl' })).toBe('Tiefkühl');
    expect(repairSimpleOfferCategory({ name: 'Gouda jung', category: 'Milchprodukte' })).toBe('Milchprodukte');
    // Leerer Name -> unverändert.
    expect(repairSimpleOfferCategory({ name: '', category: 'Sonstiges' })).toBe('Sonstiges');
  });
});

describe('repairSimpleOfferCategory — Datenqualität #4 (hochpräzise Reparaturen)', () => {
  it('repariert die real beobachteten Sonstiges-Fehlgriffe', () => {
    const cases: [{ name: string; brand?: string; category: string }, string][] = [
      [{ name: 'Grilltaler', category: 'Sonstiges' }, 'Milchprodukte'],
      [{ name: 'Deutschland-Griller', category: 'Sonstiges' }, 'Fleisch'],
      [{ name: 'Der Große Bauer Vanille', category: 'Sonstiges' }, 'Milchprodukte'],
      [{ name: 'Götterspeise XXL', category: 'Sonstiges' }, 'Snacks/Süßes'],
      [{ name: 'High Protein Pudding', category: 'Sonstiges' }, 'Milchprodukte'],
      [{ name: 'Kibbelinge', category: 'Sonstiges' }, 'Fisch'],
      [{ name: 'Kretischer Honig', category: 'Sonstiges' }, 'Trockenware'],
      [{ name: 'Pita-Taschen', category: 'Sonstiges' }, 'Backwaren'],
      [{ name: 'Reibekäse Auflauf', category: 'Sonstiges' }, 'Milchprodukte'],
      [{ name: 'Schlemmerfilet Bordelaise', category: 'Sonstiges' }, 'Fisch'],
      [{ name: 'Wachsbrechbohnen', category: 'Sonstiges' }, 'Konserven'],
      [{ name: 'Wagner Piccolinis', category: 'Sonstiges' }, 'Tiefkühl'],
      [{ name: 'Kinder Bueno', category: 'Sonstiges' }, 'Snacks/Süßes'],
      [{ name: 'Knoppers Riegel', category: 'Sonstiges' }, 'Snacks/Süßes'],
      [{ name: 'Zott Monte Drink', category: 'Sonstiges' }, 'Milchprodukte'],
      [{ name: 'Wasa Knäckebrot', category: 'Sonstiges' }, 'Backwaren'],
    ];
    for (const [input, expected] of cases) {
      expect(repairSimpleOfferCategory(input)).toBe(expected);
    }
  });

  it('macht keine riskanten Generalisierungen (keine False Positives)', () => {
    // Honigmelone bleibt Obst (kein bare 'honig'); Montepulciano bleibt Alkohol
    // (kein bare 'monte'); Wasabi wird nicht zu Backwaren (kein bare 'wasa').
    expect(repairSimpleOfferCategory({ name: 'Honigmelone', category: 'Obst/Gemüse' })).toBe('Obst/Gemüse');
    expect(repairSimpleOfferCategory({ name: 'Montepulciano d’Abruzzo', category: 'Alkohol' })).toBe('Alkohol');
    expect(repairSimpleOfferCategory({ name: 'Wasabi Erdnüsse', category: 'Snacks/Süßes' })).toBe('Snacks/Süßes');
    expect(repairSimpleOfferCategory({ name: 'Puddingpulver Vanille', category: 'Trockenware' })).toBe('Trockenware');
  });
});

describe('Kategorie-Reparatur — Kaufland-Fehlgriffe (Shop-Prompt 4)', () => {
  it('repariert Weinblätter (Konserve, nicht Alkohol) und Maultaschen (Fertiggericht, nicht Backwaren)', () => {
    expect(repairSimpleOfferCategory({ name: 'Weinblätter', category: 'Alkohol' })).toBe('Konserven');
    expect(
      repairSimpleOfferCategory({ name: 'BÜRGER Maultaschen Unsere Besten', category: 'Backwaren' }),
    ).toBe('Konserven');
  });

  it('laesst echten Wein und echte Backwaren unangetastet', () => {
    expect(repairSimpleOfferCategory({ name: 'Primitivo Rotwein trocken', category: 'Alkohol' })).toBe('Alkohol');
    expect(repairSimpleOfferCategory({ name: 'Laugenbrötchen', category: 'Backwaren' })).toBe('Backwaren');
  });
});

describe('toSimpleOfferCategory — Obst/Gemüse-Wortgrenzen (REWE-Shop-Prompt)', () => {
  it('klassifiziert Frische-Kompositum-Köpfe als Obst/Gemüse, nie als Getränk', () => {
    // 'nektar' darf NICHT als Präfix 'nektarine' treffen, 'mate' nie 'tomate'.
    expect(toSimpleOfferCategory(undefined, 'Gelbfleischige Nektarinen')).toBe('Obst/Gemüse');
    expect(toSimpleOfferCategory(undefined, 'Rispentomaten')).toBe('Obst/Gemüse');
    expect(toSimpleOfferCategory(undefined, 'Strauchtomaten')).toBe('Obst/Gemüse');
    expect(toSimpleOfferCategory(undefined, 'Cherrytomaten')).toBe('Obst/Gemüse');
    expect(toSimpleOfferCategory(undefined, 'Tomaten')).toBe('Obst/Gemüse');
  });

  it('lässt echte Getränke (Nektar/Saft/Schorle) weiterhin als Getränk durch', () => {
    expect(toSimpleOfferCategory(undefined, 'Fruchtnektar')).toBe('Getränke Alkoholfrei');
    expect(toSimpleOfferCategory(undefined, 'Pfirsichnektar')).toBe('Getränke Alkoholfrei');
    expect(toSimpleOfferCategory(undefined, 'Multivitamin Nektar')).toBe('Getränke Alkoholfrei');
    expect(toSimpleOfferCategory(undefined, 'Tomatensaft')).toBe('Getränke Alkoholfrei');
    expect(toSimpleOfferCategory(undefined, 'Apfelschorle')).toBe('Getränke Alkoholfrei');
  });

  it('lässt Tomaten-Geschmacksprodukte nicht zu frischer Ware werden', () => {
    // Paprikachips/Tomatensaft werden VOR der Frische-Prüfung als Snack/Getränk
    // erkannt — die Kompositum-Kopf-Regel kann sie nicht überstimmen.
    expect(toSimpleOfferCategory(undefined, 'Paprikachips')).toBe('Snacks/Süßes');
  });
});
