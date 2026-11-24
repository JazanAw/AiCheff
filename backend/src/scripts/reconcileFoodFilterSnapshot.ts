// Wendet die BESTEHENDE Reconciliation (Non-Food-Gate + Food-Rescue) auf einen
// gespeicherten Snapshot an, damit Angebote, die nach einer Regeländerung auf der
// falschen Seite des Filters liegen, in den richtigen Bucket wandern — ohne einen
// vollständigen Scan (und ohne KI-Läufe) zu brauchen.
//
//   Dry-Run (nichts wird geschrieben):
//     npx tsx backend/src/scripts/reconcileFoodFilterSnapshot.ts
//   Anwenden (legt vorher <datei>.bak-<zeitstempel> an):
//     npx tsx backend/src/scripts/reconcileFoodFilterSnapshot.ts --apply
//
// Beide Pässe sind pure + idempotent: ein zweiter Lauf verschiebt nichts mehr.
// Abgelaufene Angebote werden nie reanimiert, Locks/manuelle Entscheidungen und
// die Fragment-Quarantäne bleiben unangetastet.

import fs from 'node:fs';
import path from 'node:path';
import type { Offer } from '../../../src/types/models';
import { evaluateFoodReconciliation, summarizeFoodDecisions } from '../foodDecision';
import { applyFinalNonFoodGate } from '../snapshotNonFoodGate';
import { applyFoodRescuePass, revertStaleRescues } from '../snapshotFoodRescue';
import { classifyLiveWindow } from '../snapshotLiveWindow';

// Dieselbe Zeitvalidität, die der Rescue benutzt (server.ts nutzt sie identisch):
// ein abgelaufenes Angebot wird nie reanimiert und darf den Gate nie blockieren.
const MAX_VALIDITY_DAYS = 21;
const isTimeValid = (offer: Offer): boolean =>
  classifyLiveWindow(offer, new Date(), MAX_VALIDITY_DAYS) !== 'other';

interface Snapshot {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
  [key: string]: unknown;
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const file = args.find((arg) => !arg.startsWith('--')) ?? path.join('backend', 'data', 'offers.json');

  if (!fs.existsSync(file)) {
    console.error(`Snapshot nicht gefunden: ${file}`);
    process.exitCode = 1;
    return;
  }

  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
  const before = {
    offers: snapshot.offers ?? [],
    nextWeekOffers: snapshot.nextWeekOffers ?? [],
    filteredOffers: snapshot.filteredOffers ?? [],
  };

  const beforeSummary = summarizeFoodDecisions(before, { maxExamples: 1000, isTimeValid });
  console.log(`Snapshot: ${file}${apply ? '' : '   (DRY-RUN)'}`);
  console.log(
    `  vorher : live=${before.offers.length} next=${before.nextWeekOffers.length} filtered=${before.filteredOffers.length}` +
      `  |  Non-Food live=${beforeSummary.nonFoodLeakCount}  Food gefiltert=${beforeSummary.wrongFoodFilteredCount}`,
  );

  // 1. Non-Food, das sichtbar liegt, in den Filter ziehen.
  const gated = applyFinalNonFoodGate(before);
  // 2. Blind gerettete Altlasten zurücknehmen (food_rescue-Tag ohne Food-Verdikt).
  const reverted = revertStaleRescues(gated);
  // 3. Food, das im Filter liegt, zurück in den sichtbaren Feed holen.
  const rescued = applyFoodRescuePass(reverted);

  const afterSummary = summarizeFoodDecisions(rescued, { maxExamples: 1000, isTimeValid });
  console.log(
    `  nachher: live=${rescued.offers.length} next=${rescued.nextWeekOffers.length} filtered=${rescued.filteredOffers.length}` +
      `  |  Non-Food live=${afterSummary.nonFoodLeakCount}  Food gefiltert=${afterSummary.wrongFoodFilteredCount}`,
  );

  console.log(`\n--- Non-Food in den Filter verschoben (${gated.movedCount}) ---`);
  for (const name of gated.movedExamples) console.log(`  ${name}`);
  console.log(`\n--- Blinde Rettungen zurückgenommen (${reverted.revertedCount}) ---`);
  for (const name of reverted.revertedExamples) console.log(`  ${name}`);
  console.log(`\n--- Food aus dem Filter geholt (${rescued.rescuedCount}) ---`);
  for (const name of rescued.rescuedExamples) console.log(`  ${name}`);
  console.log(`\n--- Als reviewNeeded markiert (${rescued.reviewNeededCount}) ---`);

  const gate = evaluateFoodReconciliation(rescued, { isTimeValid });
  console.log(`\nPre-Commit-Gate: ${gate.ok ? 'OK' : 'BLOCKIERT'}`);
  for (const reason of gate.reasons) console.log(`  ${reason}`);

  if (!apply) {
    console.log('\nDry-Run — nichts geschrieben. Mit --apply anwenden.');
    return;
  }

  if (!gate.ok) {
    console.error('\nGate blockiert — Snapshot wird NICHT geschrieben.');
    process.exitCode = 1;
    return;
  }

  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, backup);
  const next: Snapshot = {
    ...snapshot,
    offers: rescued.offers,
    nextWeekOffers: rescued.nextWeekOffers,
    filteredOffers: rescued.filteredOffers,
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  console.log(`\nBackup: ${backup}`);
  console.log(`Geschrieben: ${file}`);
}

main();
