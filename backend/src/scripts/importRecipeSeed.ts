// Recipe seed importer.
//
// Reads a seed JSON, validates it, builds insert-ready Supabase payloads for
// `recipes` / `recipe_ingredients` / `recipe_instructions`, and prints a
// summary. It is a DRY-RUN by default and writes NOTHING unless BOTH:
//   1) the explicit `--write` flag is passed, AND
//   2) SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are present in the env.
// Without both, it stays a dry-run (see `resolveRunMode`). The Supabase client
// is only imported inside the write branch, so a dry-run never connects.
//
// Usage:
//   npm run recipes:import                          # dry-run, default file
//   npm run recipes:import -- path/to/seed.json     # dry-run, custom file
//   npm run recipes:import -- --write               # write (needs env) — run deliberately
//
// Exit codes: 0 = ok · 1 = validation errors (refused) · 2 = IO/JSON/write error.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  buildSeedReport,
  mapRecipeToPayload,
  parseRecipeSeeds,
  partitionNewByTitle,
  resolveRunMode,
  type RecipeInsertPayload,
} from '../recipeSeed';
import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_PATH = 'data/recipes/recipes_seed.example.json';

function fail(code: number, message: string): never {
  console.error(`[importRecipeSeed] ${message}`);
  process.exit(code);
}

/** Read-only: the German titles already present in `public.recipes`. Used to
 *  keep the import idempotent (skip titles that already exist). */
async function fetchExistingTitles(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client.from('recipes').select('name').limit(10000);
  if (error) fail(2, `could not read existing recipes: ${error.message}`);
  const titles: string[] = [];
  for (const row of (data ?? []) as Array<{ name?: { de?: string } | null }>) {
    const de = row.name?.de;
    if (typeof de === 'string' && de.trim().length > 0) titles.push(de);
  }
  return titles;
}

/**
 * Real remote write — IDEMPOTENT. Only reachable with `--write` + Supabase env.
 * Inserts ONLY the recipes whose title is not already in the DB (`payloads` is
 * the pre-filtered "new" set), then its ingredients/instructions with the
 * returned recipe_id (same two-phase shape as services/recipeGeneration.ts).
 */
async function writeToSupabase(
  client: SupabaseClient,
  payloads: RecipeInsertPayload[],
): Promise<void> {
  let written = 0;
  for (const payload of payloads) {
    const { data, error } = await client
      .from('recipes')
      .insert(payload.recipe)
      .select('id')
      .single();
    if (error || !data) {
      fail(2, `recipes insert failed for "${payload.recipe.name.de}": ${error?.message ?? 'unknown'}`);
    }
    const recipeId = (data as { id: string }).id;

    if (payload.ingredients.length > 0) {
      const rows = payload.ingredients.map((row) => ({ ...row, recipe_id: recipeId }));
      const { error: ingError } = await client.from('recipe_ingredients').insert(rows);
      if (ingError) fail(2, `ingredients insert failed for ${recipeId}: ${ingError.message}`);
    }
    if (payload.instructions.length > 0) {
      const rows = payload.instructions.map((row) => ({ ...row, recipe_id: recipeId }));
      const { error: insError } = await client.from('recipe_instructions').insert(rows);
      if (insError) fail(2, `instructions insert failed for ${recipeId}: ${insError.message}`);
    }
    written += 1;
    console.log(`  ✓ wrote "${payload.recipe.name.de}" (${recipeId})`);
  }
  console.log(`\nWrote ${written} new recipe(s) to Supabase.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const pathArg = args.find((a) => !a.startsWith('--'));
  const target = resolve(process.cwd(), pathArg ?? DEFAULT_PATH);

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    fail(2, `cannot read/parse ${target}: ${(error as Error).message}`);
  }

  let report: ReturnType<typeof buildSeedReport>;
  try {
    report = buildSeedReport(json);
  } catch (error) {
    fail(2, (error as Error).message);
  }

  const { recipes } = parseRecipeSeeds(json);
  const payloads = recipes.map(mapRecipeToPayload);
  const ingredientCount = payloads.reduce((n, p) => n + p.ingredients.length, 0);
  const stepCount = payloads.reduce((n, p) => n + p.instructions.length, 0);

  const runMode = resolveRunMode({
    write,
    hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
    hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });

  console.log(`\nRecipe seed import — ${target}`);
  console.log('='.repeat(60));
  console.log(`Mode: ${runMode.mode.toUpperCase()} — ${runMode.reason}`);
  console.log(
    `Valid recipes: ${report.valid} · invalid: ${report.invalid} · ` +
      `ingredients: ${ingredientCount} · steps: ${stepCount}`,
  );
  console.log(`Warnings: ${report.warningCount} · Duplicate groups: ${report.duplicates.length}`);

  if (report.errors.length > 0) {
    console.log('\n— Validation errors (recipe rejected) —');
    for (const err of report.errors) {
      console.log(`  • #${err.index} ${err.title ? `"${err.title}"` : '(untitled)'}`);
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
      for (const w of r.warnings) console.log(`  • #${r.index} "${r.title}": [${w.code}] ${w.message}`);
    }
  }

  // Never write invalid data, regardless of mode.
  if (report.invalid > 0) {
    fail(1, `${report.invalid} recipe(s) failed validation — fix them before importing.`);
  }
  if (report.duplicates.length > 0 && runMode.canWrite) {
    fail(1, 'Duplicates detected — resolve them before a write.');
  }

  // ── Idempotent plan: when Supabase env is present we read the existing
  // titles (READ-ONLY) and show how many recipes are NEW vs already present.
  // This runs in dry-run too (a SELECT mutates nothing) so the plan can be
  // verified before any write. Without env we stay fully offline.
  const hasEnv = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (hasEnv) {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { persistSession: false } },
    );
    const existingTitles = await fetchExistingTitles(client);
    const { toInsert, skipped } = partitionNewByTitle(payloads, existingTitles);
    console.log(
      `\nRemote plan (idempotent): ${toInsert.length} new · ${skipped.length} already present (skipped) · ` +
        `${existingTitles.length} recipe titles currently in DB`,
    );
    if (toInsert.length > 0) {
      console.log('  New recipes to insert:');
      for (const p of toInsert) console.log(`    + ${p.recipe.name.de}`);
    }

    if (!runMode.canWrite) {
      console.log('\nDRY-RUN: no remote write performed. Pass --write to insert the new recipes.');
      process.exit(0);
    }

    if (toInsert.length === 0) {
      console.log('\nNothing to write — every seed recipe already exists. Import is a no-op (idempotent).');
      process.exit(0);
    }

    console.log('\nWRITE MODE: inserting only the new recipes…');
    await writeToSupabase(client, toInsert);
    process.exit(0);
  }

  // No Supabase env → fully offline dry-run (never connects).
  console.log('\nDRY-RUN (offline): no Supabase env present, no remote write. Existing-title check skipped.');
  process.exit(0);
}

main().catch((error) => fail(2, (error as Error).message));
