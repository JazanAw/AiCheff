// Dry-run EDEKA offer-import inspector — DOES NOT touch the live snapshot.
//
// Usage:
//   npx tsx backend/src/scripts/dryRunEdeka.ts [--url=https://www.edeka.de/angebote]
//
// Fetches the official EDEKA offers page ONCE at a low request rate (the same
// public, unauthenticated page a browser loads — no captcha bypass, no login),
// runs the structured "edeka_neu" card parser and prints the honest counting
// chain (Quelle → Karten → Kandidaten → mit Angebotspreis → importiert →
// Dubletten → Ablehnungen) plus the EDEKA section of the scan report. Use this
// to verify the import before/after a parser change without booting the server.
//
// If the page is blocked (403/Captcha/HTTP-200 block page) it reports that
// honestly instead of inventing offers.

import {
  parseEdekaOffers,
  type EdekaImportDiagnostics,
} from '../../../src/services/offersIngest/sourceConnectors/officialSupermarketConnector';

const DEFAULT_URL = 'https://www.edeka.de/angebote';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const url = arg('url') ?? DEFAULT_URL;
  const store = { storeChain: 'EDEKA', url, parser: 'edeka' as const };

  console.log(`# EDEKA Dry-Run`);
  console.log(`Quelle: ${url}\n`);

  let html = '';
  let httpStatus: number | undefined;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    httpStatus = response.status;
    console.log(`HTTP ${response.status} ${response.statusText}`);
    console.log(`Final-URL: ${response.url}`);
    console.log(`Content-Type: ${response.headers.get('content-type')}`);
    html = await response.text();
    console.log(`Body-Länge: ${html.length}\n`);
  } catch (error) {
    console.error(
      `FETCH-FEHLER (blocked/unreachable): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }

  const { offers, diagnostics } = parseEdekaOffers(html, store, { httpStatus });

  printDiagnostics(diagnostics);

  console.log(`\nBeispiel-Angebote (max. 30):`);
  for (const offer of offers.slice(0, 30)) {
    console.log(
      ` - ${offer.name} | ${offer.price?.toFixed(2)} € | ` +
        `Grundpreis ${offer.basePrice ?? '–'}/${offer.baseUnit ?? '–'} | ` +
        `gültig ab ${offer.validityStart} | Bild ${offer.imageUrl ? 'ja' : 'nein'} | ` +
        `tags ${(offer.tags ?? []).join(',')}`,
    );
  }
}

function printDiagnostics(d: EdekaImportDiagnostics): void {
  console.log('## Zählkette (maschinenlesbar)');
  console.log(`- blocked: ${d.blocked}${d.blockReason ? ` (${d.blockReason})` : ''}`);
  console.log(`- Seite sieht nach Angeboten aus: ${d.pageLooksLikeOffers}`);
  console.log(`- Marktbezug: ${d.marketScope} (national_only — nie 'full')`);
  console.log(`- Angebotskarten (<dialog>): ${d.offerBlocks}`);
  console.log(`- Kandidaten (mit Name): ${d.candidates}`);
  console.log(`- mit echtem Angebotspreis: ${d.withOfferPrice}`);
  console.log(`- importiert (distinct): ${d.importedDistinct}`);
  console.log(`- Dubletten zusammengeführt: ${d.duplicatesMerged}`);
  console.log(
    `- abgelehnt: kein_angebotspreis=${d.rejectedByReason.kein_angebotspreis}, ` +
      `kein_preis=${d.rejectedByReason.kein_preis}, kein_name=${d.rejectedByReason.kein_name}`,
  );
  console.log(`- Karten ohne Produktbild: ${d.brokenImageCount}`);
  console.log(`- frühestes "Gültig ab": ${d.validityStartSeen ?? '–'}`);
  console.log(`- letzte erfolgreiche Verifikation: ${d.lastSuccessfulAt ?? 'keine'}`);
  if (d.rejectedExamples.length > 0) {
    console.log(`- abgelehnte Beispiele: ${d.rejectedExamples.slice(0, 8).join(', ')}`);
  }
}

void main();
