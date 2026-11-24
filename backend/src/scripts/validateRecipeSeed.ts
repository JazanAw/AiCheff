// Dry-run validator for recipe seed files.
//
// Reads a JSON seed file, validates it against the shared schema, and prints a
// normalization + warning report. It NEVER writes to Supabase or any remote
// target — this is a local sanity gate before a (separate, deliberate) import.
//
// Usage:
//   npm run recipes:validate                       # default example file
//   npm run recipes:validate -- path/to/seed.json  # custom file
//
// Exit codes: 0 = all recipes valid · 1 = validation errors · 2 = IO/JSON error.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { buildSeedReport } from '../recipeSeed';

const DEFAULT_PATH = 'data/recipes/recipes_seed.example.json';

function fail(code: number, message: string): never {
  console.error(`[validateRecipeSeed] ${message}`);
  process.exit(code);
}

function main(): void {
  const target = resolve(process.cwd(), process.argv[2] ?? DEFAULT_PATH);

  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (error) {
    fail(2, `cannot read ${target}: ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    fail(2, `invalid JSON in ${target}: ${(error as Error).message}`);
  }

  let report: ReturnType<typeof buildSeedReport>;
  try {
    report = buildSeedReport(json);
  } catch (error) {
    fail(2, (error as Error).message);
  }

  console.log(`\nRecipe seed dry-run — ${target}`);
  console.log('='.repeat(60));
  console.log(
    `Recipes: ${report.total} total · ${report.valid} valid · ${report.invalid} invalid`,
  );
  console.log(`Warnings: ${report.warningCount} · Duplicate groups: ${report.duplicates.length}`);

  if (report.errors.length > 0) {
    console.log('\n— Validation errors (recipe rejected) —');
    for (const err of report.errors) {
      const label = err.title ? `"${err.title}"` : '(untitled)';
      console.log(`  • #${err.index} ${label}`);
      for (const issue of err.issues) console.log(`      - ${issue}`);
    }
  }

  if (report.duplicates.length > 0) {
    console.log('\n— Duplicates (same title + source_url) —');
    for (const dup of report.duplicates) {
      console.log(`  • "${dup.title}" → entries #${dup.indexes.join(', #')}`);
    }
  }

  const withWarnings = report.recipeReports.filter((r) => r.warnings.length > 0);
  if (withWarnings.length > 0) {
    console.log('\n— Warnings (non-fatal) —');
    for (const r of withWarnings) {
      console.log(`  • #${r.index} "${r.title}"`);
      for (const w of r.warnings) console.log(`      - [${w.code}] ${w.message}`);
    }
  }

  if (report.invalid === 0 && report.duplicates.length === 0) {
    console.log('\nAll recipes valid and unique. No remote write performed (dry-run).');
  } else {
    console.log('\nResolve errors/duplicates before importing. No remote write performed (dry-run).');
  }

  process.exit(report.invalid > 0 ? 1 : 0);
}

main();
