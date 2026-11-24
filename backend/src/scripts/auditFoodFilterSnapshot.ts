// Audit-Skript: klassifiziert einen gespeicherten Snapshot (backend/data/offers.json)
// mit der AKTUELLEN Filter-Wahrheit neu und listet jeden Widerspruch zwischen
// Bucket-Zugehörigkeit und Verdikt auf. Damit lässt sich nach jeder Regeländerung
// prüfen, ob Food/Non-Food auf der richtigen Seite liegt, ohne einen Scan zu fahren.
//
//   npx tsx backend/src/scripts/auditFoodFilterSnapshot.ts [pfad/zu/offers.json]
//
// „nonFoodLeak"        = Non-Food, das im sichtbaren Feed liegt   → Gate muss es ziehen
// „wrongFoodFiltered"  = Food, das im Filtered-Bucket liegt       → Rescue muss es holen
// Beide MÜSSEN nach einem vollständigen Reconciliation-Pass 0 sein.

import fs from 'node:fs';
import path from 'node:path';
import type { Offer } from '../../../src/types/models';
import {
  classifyFoodDecision,
  isFragmentOrSectionHeader,
  isMovementLocked,
  summarizeFoodDecisions,
} from '../foodDecision';
import { classifyLiveWindow } from '../snapshotLiveWindow';

// Dieselbe Zeitvalidität wie Rescue und Pre-Commit-Gate (s. server.ts): ein
// ABGELAUFENES Angebot bleibt korrekt im Filter und ist kein Fehler.
const MAX_VALIDITY_DAYS = 21;
const isTimeValid = (offer: Offer): boolean =>
  classifyLiveWindow(offer, new Date(), MAX_VALIDITY_DAYS) !== 'other';

interface SnapshotShape {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
}

function loadSnapshot(file: string): SnapshotShape {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SnapshotShape>;
  return {
    offers: raw.offers ?? [],
    nextWeekOffers: raw.nextWeekOffers ?? [],
    filteredOffers: raw.filteredOffers ?? [],
  };
}

function main(): void {
  const file = process.argv[2] ?? path.join('backend', 'data', 'offers.json');
  if (!fs.existsSync(file)) {
    console.error(`Snapshot nicht gefunden: ${file}`);
    process.exitCode = 1;
    return;
  }

  const buckets = loadSnapshot(file);
  console.log(`Snapshot: ${file}`);
  console.log(
    `  live=${buckets.offers.length} nextWeek=${buckets.nextWeekOffers.length} filtered=${buckets.filteredOffers.length}`,
  );

  const summary = summarizeFoodDecisions(buckets, { maxExamples: 1000, isTimeValid });
  console.log('\n--- Verdikt-Verteilung ---');
  console.log(`  confirmed_food sichtbar      : ${summary.confirmedFoodVisibleCount}`);
  console.log(`  uncertain sichtbar           : ${summary.uncertainVisibleCount}`);
  console.log(`  confirmed_non_food gefiltert : ${summary.confirmedNonFoodFilteredCount}`);
  console.log(`  uncertain gefiltert (Review) : ${summary.uncertainFilteredCount}`);

  console.log(`\n--- Non-Food im sichtbaren Feed (${summary.nonFoodLeakCount}) ---`);
  for (const name of summary.nonFoodLeakExamples) console.log(`  ${name}`);

  console.log(`\n--- Food im Filtered-Bucket (${summary.wrongFoodFilteredCount}) ---`);
  for (const name of summary.wrongFoodFilteredExamples) console.log(`  ${name}`);

  // Zusätzliche Diagnose: welche gefilterten Angebote hängen nur an einem
  // Bewegungs-Guard (Lock/Fragment) statt an einem echten Non-Food-Verdikt?
  let guardOnly = 0;
  for (const offer of buckets.filteredOffers) {
    if (!isMovementLocked(offer) && !isFragmentOrSectionHeader(offer)) continue;
    if (classifyFoodDecision(offer) !== 'confirmed_non_food') guardOnly += 1;
  }
  console.log(`\n--- Gefiltert nur wegen Lock/Fragment-Quarantäne: ${guardOnly} ---`);

  const clean = summary.nonFoodLeakCount === 0 && summary.wrongFoodFilteredCount === 0;
  console.log(`\nErgebnis: ${clean ? 'OK — beide Buckets konsistent' : 'INKONSISTENT (s. o.)'}`);
}

main();
