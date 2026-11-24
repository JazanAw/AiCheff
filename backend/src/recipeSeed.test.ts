import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RecipeSeedSchema,
  parseRecipeSeeds,
  analyzeRecipe,
  findDuplicates,
  buildSeedReport,
  mapRecipeToPayload,
  deriveMealType,
  resolveRunMode,
  resolveImportStatus,
  isAiSourceType,
  partitionNewByTitle,
  recipeTitleKey,
  MEAL_TYPES,
} from './recipeSeed';

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Test Pasta',
    description: 'A simple test recipe.',
    servings: 2,
    cook_time_minutes: 20,
    difficulty: 'easy',
    tags: ['pasta'],
    allergens: ['gluten'],
    halal_status: 'halal',
    ingredients: [
      { name: 'Spaghetti', amount: 250, unit: 'g' },
      { name: 'Salz', notes: 'nach Geschmack' },
    ],
    steps: [
      'Wasser aufkochen und die Pasta hineingeben.',
      'Nach Packungsangabe bissfest kochen und abgießen.',
    ],
    source_type: 'human_verified',
    source_license: 'Cheffity original (own work)',
    ai_notice_required: false,
    verification_status: 'reviewed',
    ...overrides,
  };
}

function issuePaths(raw: unknown): string[] {
  const result = RecipeSeedSchema.safeParse(raw);
  if (result.success) return [];
  return result.error.issues.map((i) => i.path.join('.'));
}

describe('RecipeSeedSchema — acceptance', () => {
  it('accepts a valid recipe', () => {
    const result = RecipeSeedSchema.safeParse(validRaw());
    expect(result.success).toBe(true);
  });

  it('accepts null for optional bibliographic fields (JSON has no undefined)', () => {
    const result = RecipeSeedSchema.safeParse(
      validRaw({
        source_title: null,
        source_author: null,
        source_year: null,
        source_url: null,
        safety_notes: null,
        halal_notes: null,
      }),
    );
    expect(result.success).toBe(true);
  });

  it('parses a whole file and separates valid from invalid', () => {
    const { recipes, errors } = parseRecipeSeeds([
      validRaw(),
      validRaw({ title: '' }),
    ]);
    expect(recipes).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(1);
  });

  it('accepts both bare-array and { recipes: [...] } shapes', () => {
    expect(parseRecipeSeeds([validRaw()]).recipes).toHaveLength(1);
    expect(parseRecipeSeeds({ recipes: [validRaw()] }).recipes).toHaveLength(1);
  });
});

describe('RecipeSeedSchema — rejection', () => {
  it('rejects an empty title', () => {
    expect(issuePaths(validRaw({ title: '' }))).toContain('title');
  });

  it('rejects fewer than 2 ingredients', () => {
    expect(
      issuePaths(validRaw({ ingredients: [{ name: 'Salz', amount: 1, unit: 'g' }] })),
    ).toContain('ingredients');
  });

  it('rejects fewer than 2 steps', () => {
    expect(issuePaths(validRaw({ steps: ['only one step here'] }))).toContain('steps');
  });

  it('rejects a missing source_license (provenance must be present)', () => {
    const raw = validRaw();
    delete (raw as Partial<typeof raw>).source_license;
    const result = RecipeSeedSchema.safeParse(raw);
    expect(result.success).toBe(false);
    expect(issuePaths(raw)).toContain('source_license');
  });

  it('rejects an empty source_license', () => {
    expect(issuePaths(validRaw({ source_license: '' }))).toContain('source_license');
  });

  it('rejects a missing source_type', () => {
    const raw = validRaw();
    delete (raw as Partial<typeof raw>).source_type;
    expect(RecipeSeedSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects an invalid source_type', () => {
    expect(RecipeSeedSchema.safeParse(validRaw({ source_type: 'scraped' })).success).toBe(
      false,
    );
  });

  it('rejects a missing ai_notice_required flag', () => {
    const raw = validRaw();
    delete (raw as Partial<typeof raw>).ai_notice_required;
    expect(RecipeSeedSchema.safeParse(raw).success).toBe(false);
  });
});

describe('analyzeRecipe — warnings', () => {
  it('warns on a missing amount and an unknown unit', () => {
    const recipe = RecipeSeedSchema.parse(
      validRaw({
        ingredients: [
          { name: 'Walnüsse', amount: 1, unit: 'Handvoll' },
          { name: 'Honig', notes: 'nach Geschmack' },
        ],
      }),
    );
    const codes = analyzeRecipe(recipe).map((w) => w.code);
    expect(codes).toContain('unknown_unit');
    expect(codes).toContain('missing_amount');
  });

  it('does not flag known units or present amounts', () => {
    const recipe = RecipeSeedSchema.parse(validRaw());
    const codes = analyzeRecipe(recipe).map((w) => w.code);
    expect(codes).not.toContain('unknown_unit');
  });

  it('warns when no allergens are listed', () => {
    const recipe = RecipeSeedSchema.parse(validRaw({ allergens: [] }));
    expect(analyzeRecipe(recipe).map((w) => w.code)).toContain('missing_allergens');
  });

  it('warns when halal status is unclear', () => {
    const recipe = RecipeSeedSchema.parse(
      validRaw({ halal_status: 'unclear', halal_notes: null }),
    );
    expect(analyzeRecipe(recipe).map((w) => w.code)).toContain('halal_unclear');
  });

  it('warns when public-domain content has no citation', () => {
    const recipe = RecipeSeedSchema.parse(
      validRaw({
        source_type: 'public_domain_adapted',
        source_title: null,
        source_author: null,
        source_url: null,
      }),
    );
    expect(analyzeRecipe(recipe).map((w) => w.code)).toContain('missing_provenance_detail');
  });
});

describe('findDuplicates', () => {
  it('detects duplicates by title + source_url', () => {
    const { recipes } = parseRecipeSeeds([validRaw(), validRaw()]);
    const groups = findDuplicates(recipes);
    expect(groups).toHaveLength(1);
    expect(groups[0].indexes).toEqual([0, 1]);
  });

  it('treats a different source_url as not duplicate', () => {
    const { recipes } = parseRecipeSeeds([
      validRaw({ source_url: 'https://example.org/a' }),
      validRaw({ source_url: 'https://example.org/b' }),
    ]);
    expect(findDuplicates(recipes)).toHaveLength(0);
  });

  it('ignores case/punctuation differences in the title', () => {
    const { recipes } = parseRecipeSeeds([
      validRaw({ title: 'Test Pasta' }),
      validRaw({ title: '  test  pasta!  ' }),
    ]);
    expect(findDuplicates(recipes)).toHaveLength(1);
  });
});

describe('buildSeedReport + example seed file', () => {
  it('aggregates counts for a mixed file', () => {
    const report = buildSeedReport([validRaw(), validRaw({ title: '' })]);
    expect(report.total).toBe(2);
    expect(report.valid).toBe(1);
    expect(report.invalid).toBe(1);
  });

  it('validates the shipped example seed with no errors or duplicates', () => {
    const path = resolve(process.cwd(), 'data/recipes/recipes_seed.example.json');
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const report = buildSeedReport(json);
    expect(report.invalid).toBe(0);
    expect(report.valid).toBeGreaterThanOrEqual(5);
    expect(report.duplicates).toHaveLength(0);
    // The example deliberately includes recipes that surface warnings (e.g.
    // "Salz nach Geschmack" → missing_amount) to demonstrate the report.
    expect(report.warningCount).toBeGreaterThan(0);
  });
});

describe('image_url validation', () => {
  it('accepts an http(s) URL, empty string, null, or omitted', () => {
    expect(RecipeSeedSchema.safeParse(validRaw({ image_url: 'https://x.de/a.jpg' })).success).toBe(true);
    expect(RecipeSeedSchema.safeParse(validRaw({ image_url: 'http://x.de/a.jpg' })).success).toBe(true);
    expect(RecipeSeedSchema.safeParse(validRaw({ image_url: '' })).success).toBe(true);
    expect(RecipeSeedSchema.safeParse(validRaw({ image_url: null })).success).toBe(true);
    expect(RecipeSeedSchema.safeParse(validRaw()).success).toBe(true);
  });

  it('rejects a non-empty value that is not an http(s) URL', () => {
    expect(RecipeSeedSchema.safeParse(validRaw({ image_url: 'not-a-url' })).success).toBe(false);
    expect(RecipeSeedSchema.safeParse(validRaw({ image_url: 'ftp://x.de/a.jpg' })).success).toBe(false);
  });
});

describe('deriveMealType', () => {
  it('prefers an explicit meal_type', () => {
    expect(deriveMealType({ meal_type: 'dinner', tags: ['frühstück'], cuisine: undefined })).toBe('dinner');
  });
  it('falls back to a tag/cuisine heuristic', () => {
    expect(deriveMealType({ meal_type: undefined, tags: ['frühstück'], cuisine: undefined })).toBe('breakfast');
    expect(deriveMealType({ meal_type: undefined, tags: ['süß', 'kuchen'], cuisine: undefined })).toBe('sweet_baked');
    expect(deriveMealType({ meal_type: undefined, tags: ['smoothie'], cuisine: undefined })).toBe('drinks');
  });
  it('defaults to lunch when nothing matches', () => {
    expect(deriveMealType({ meal_type: undefined, tags: ['pasta'], cuisine: 'italienisch' })).toBe('lunch');
  });
});

describe('mapRecipeToPayload', () => {
  it('maps the new metadata fields onto the recipes row', () => {
    const recipe = RecipeSeedSchema.parse(
      validRaw({
        prep_time_minutes: 10,
        meal_type: 'dinner',
        cuisine: 'italienisch',
        tags: ['vegan', 'schnell'],
        diet_flags: ['vegan'],
        halal_status: 'halal',
        image_url: 'https://example.org/x.jpg',
        nutrition_per_serving: { calories: 500, protein_g: 20, carbs_g: 60, fat_g: 10 },
      }),
    );
    const { recipe: row } = mapRecipeToPayload(recipe);
    expect(row.prep_time_minutes).toBe(10);
    expect(row.meal_type).toBe('dinner');
    expect(row.cuisine).toBe('italienisch');
    expect(row.tags).toEqual(['vegan', 'schnell']);
    expect(row.diet_flags).toEqual(['vegan']);
    expect(row.halal_status).toBe('halal');
    expect(row.image_url).toBe('https://example.org/x.jpg');
    expect(row.calories).toBe(500);
    expect(row.name).toEqual({ de: 'Test Pasta' });
    expect(row.default_portions).toBe(2);
    expect(row.source_type).toBe('human_verified');
    expect(row.status).toBe('active');
  });

  it('defaults optional metadata to null and derives meal_type from tags', () => {
    const recipe = RecipeSeedSchema.parse(validRaw({ tags: ['frühstück'] }));
    const { recipe: row } = mapRecipeToPayload(recipe);
    expect(row.prep_time_minutes).toBeNull();
    expect(row.image_url).toBeNull();
    expect(row.cuisine).toBeNull();
    expect(row.meal_type).toBe('breakfast');
  });

  it('builds ingredient/instruction rows with the expected shape', () => {
    const recipe = RecipeSeedSchema.parse(validRaw());
    const payload = mapRecipeToPayload(recipe);
    expect(payload.ingredients).toHaveLength(2);
    expect(payload.ingredients[0].position).toBe(0);
    expect(payload.ingredients[0].name).toEqual({ de: 'Spaghetti' });
    // recipe-level allergens land on the first ingredient row only
    expect(payload.ingredients[0].allergens).toEqual(['gluten']);
    expect(payload.ingredients[1].allergens).toEqual([]);
    // "Salz" had no amount → imported as 0
    expect(payload.ingredients[1].amount).toBe(0);
    expect(payload.instructions).toHaveLength(2);
    expect(payload.instructions[0].step_number).toBe(1);
    expect(payload.instructions[0].text).toEqual({
      de: 'Wasser aufkochen und die Pasta hineingeben.',
    });
  });

  it('imports drafts as hidden and reviewed/published as active', () => {
    const draft = mapRecipeToPayload(
      RecipeSeedSchema.parse(validRaw({ verification_status: 'draft' })),
    );
    const reviewed = mapRecipeToPayload(
      RecipeSeedSchema.parse(validRaw({ verification_status: 'reviewed' })),
    );
    const published = mapRecipeToPayload(
      RecipeSeedSchema.parse(validRaw({ verification_status: 'published' })),
    );
    expect(draft.recipe.status).toBe('hidden');
    expect(reviewed.recipe.status).toBe('active');
    expect(published.recipe.status).toBe('active');
  });

  it('flags ingredients not halal when the recipe is not_halal', () => {
    const recipe = RecipeSeedSchema.parse(validRaw({ halal_status: 'not_halal' }));
    const payload = mapRecipeToPayload(recipe);
    expect(payload.recipe.halal_status).toBe('not_halal');
    expect(payload.ingredients.every((i) => i.is_halal === false)).toBe(true);
  });

  it('maps every example-seed recipe to a valid meal_type', () => {
    const path = resolve(process.cwd(), 'data/recipes/recipes_seed.example.json');
    const { recipes } = parseRecipeSeeds(JSON.parse(readFileSync(path, 'utf8')));
    for (const recipe of recipes) {
      expect(MEAL_TYPES).toContain(mapRecipeToPayload(recipe).recipe.meal_type);
    }
  });
});

describe('shipped v1 German seed (recipes_seed.v1.de.json)', () => {
  // Cuisine values the mobile taxonomy (utils/cuisine.ts CUISINE_ALIASES) maps
  // to a stable slug. Anything outside this set would normalize to the generic
  // "international" fallback and is treated as a seed authoring mistake here.
  const KNOWN_CUISINES = new Set([
    'deutsch', 'italienisch', 'türkisch', 'tuerkisch', 'japanisch', 'indisch',
    'mexikanisch', 'mediterran', 'asiatisch', 'orientalisch', 'französisch',
    'franzoesisch', 'griechisch', 'international',
  ]);

  const path = resolve(process.cwd(), 'data/recipes/recipes_seed.v1.de.json');
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const { recipes } = parseRecipeSeeds(json);

  it('parses with no validation errors and no duplicates', () => {
    const report = buildSeedReport(json);
    expect(report.invalid).toBe(0);
    expect(report.duplicates).toHaveLength(0);
  });

  it('contains ~100 recipes for the MVP', () => {
    expect(recipes.length).toBeGreaterThanOrEqual(100);
  });

  it('has unique recipe titles (no overwritten/duplicated entries)', () => {
    const keys = recipes.map((r) =>
      r.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim(),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every AI recipe is a guarded draft (notice + safety_notes), never auto-claimed verified', () => {
    const ai = recipes.filter((r) => isAiSourceType(r.source_type));
    expect(ai.length).toBeGreaterThan(0);
    for (const r of ai) {
      expect(r.ai_notice_required).toBe(true);
      expect((r.safety_notes ?? '').trim().length).toBeGreaterThan(0);
      // AI drafts must not masquerade as published.
      expect(r.verification_status).not.toBe('published');
    }
  });

  it('keeps human_verified at the original 25 and never adds public-domain claims', () => {
    const human = recipes.filter((r) => r.source_type === 'human_verified');
    const publicDomain = recipes.filter((r) => r.source_type === 'public_domain_adapted');
    // The 39 newly added recipes are all AI drafts — humans stay at 25.
    expect(human).toHaveLength(25);
    expect(publicDomain).toHaveLength(0);
  });

  it('uses only known cuisine values (so the mobile cuisine filter stays meaningful)', () => {
    for (const r of recipes) {
      if (r.cuisine == null || r.cuisine === '') continue;
      expect(KNOWN_CUISINES.has(r.cuisine.trim().toLowerCase())).toBe(true);
    }
  });

  it('every recipe maps to a valid meal_type and carries a non-empty source_license', () => {
    for (const r of recipes) {
      expect(MEAL_TYPES).toContain(mapRecipeToPayload(r).recipe.meal_type);
      expect(r.source_license.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('idempotent import — partitionNewByTitle', () => {
  const payloadFor = (titles: string[]) =>
    titles.map((t) => mapRecipeToPayload(RecipeSeedSchema.parse(validRaw({ title: t }))));

  it('normalizes titles deterministically (case/punctuation/whitespace insensitive)', () => {
    // ASCII: case + punctuation + extra spaces collapse to the same key.
    expect(recipeTitleKey('  Spaghetti  Aglio e Olio! ')).toBe('spaghetti aglio e olio');
    // The SAME (umlaut) title normalizes identically regardless of case/punct —
    // which is all the idempotent match needs (seed and DB hold the same string).
    expect(recipeTitleKey('Möhren-Püree!')).toBe(recipeTitleKey('  möhren püree '));
  });

  it('inserts only titles not already present in the DB', () => {
    const payloads = payloadFor(['Neu A', 'Schon da', 'Neu B']);
    const { toInsert, skipped } = partitionNewByTitle(payloads, ['Schon da']);
    expect(toInsert.map((p) => p.recipe.name.de)).toEqual(['Neu A', 'Neu B']);
    expect(skipped.map((p) => p.recipe.name.de)).toEqual(['Schon da']);
  });

  it('matches existing titles case/punctuation-insensitively (no accidental re-insert)', () => {
    const payloads = payloadFor(['Spaghetti Aglio e Olio']);
    const { toInsert, skipped } = partitionNewByTitle(payloads, ['  spaghetti  aglio e olio! ']);
    expect(toInsert).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it('is a no-op when every title already exists (idempotent re-run)', () => {
    const titles = ['A', 'B', 'C'];
    const { toInsert, skipped } = partitionNewByTitle(payloadFor(titles), titles);
    expect(toInsert).toHaveLength(0);
    expect(skipped).toHaveLength(3);
  });

  it('inserts everything when the DB is empty (first run)', () => {
    const { toInsert, skipped } = partitionNewByTitle(payloadFor(['A', 'B']), []);
    expect(toInsert).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });
});

describe('resolveRunMode — write is guarded', () => {
  it('defaults to dry-run without --write (never writes)', () => {
    const mode = resolveRunMode({ write: false, hasSupabaseUrl: true, hasServiceRoleKey: true });
    expect(mode.mode).toBe('dry-run');
    expect(mode.canWrite).toBe(false);
  });

  it('stays dry-run with --write but missing Supabase env', () => {
    expect(
      resolveRunMode({ write: true, hasSupabaseUrl: false, hasServiceRoleKey: true }).canWrite,
    ).toBe(false);
    expect(
      resolveRunMode({ write: true, hasSupabaseUrl: true, hasServiceRoleKey: false }).canWrite,
    ).toBe(false);
  });

  it('only enables write with --write AND full Supabase env', () => {
    const mode = resolveRunMode({ write: true, hasSupabaseUrl: true, hasServiceRoleKey: true });
    expect(mode.mode).toBe('write');
    expect(mode.canWrite).toBe(true);
  });
});

describe('AI safety gate + visibility', () => {
  it('isAiSourceType identifies AI source types', () => {
    expect(isAiSourceType('ai_generated')).toBe(true);
    expect(isAiSourceType('ai_adapted')).toBe(true);
    expect(isAiSourceType('human_verified')).toBe(false);
    expect(isAiSourceType('public_domain_adapted')).toBe(false);
  });

  it('rejects an AI recipe without ai_notice_required', () => {
    expect(
      RecipeSeedSchema.safeParse(
        validRaw({
          source_type: 'ai_generated',
          ai_notice_required: false,
          safety_notes: 'Gut durchgaren.',
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects an AI recipe without (non-empty) safety_notes', () => {
    expect(
      RecipeSeedSchema.safeParse(
        validRaw({ source_type: 'ai_generated', ai_notice_required: true, safety_notes: null }),
      ).success,
    ).toBe(false);
    expect(
      RecipeSeedSchema.safeParse(
        validRaw({ source_type: 'ai_adapted', ai_notice_required: true, safety_notes: '   ' }),
      ).success,
    ).toBe(false);
  });

  it('accepts a guarded AI recipe (notice + safety_notes)', () => {
    expect(
      RecipeSeedSchema.safeParse(
        validRaw({
          source_type: 'ai_generated',
          ai_notice_required: true,
          safety_notes: 'Gut durchgaren.',
          verification_status: 'draft',
        }),
      ).success,
    ).toBe(true);
  });

  it('imports a guarded AI recipe as active (not hidden), even when draft', () => {
    const recipe = RecipeSeedSchema.parse(
      validRaw({
        source_type: 'ai_generated',
        ai_notice_required: true,
        safety_notes: 'Gut durchgaren.',
        verification_status: 'draft',
      }),
    );
    expect(resolveImportStatus(recipe)).toBe('active');
    expect(mapRecipeToPayload(recipe).recipe.status).toBe('active');
  });

  it('keeps a non-AI draft hidden but human_verified reviewed active', () => {
    const draft = RecipeSeedSchema.parse(validRaw({ verification_status: 'draft' }));
    const reviewed = RecipeSeedSchema.parse(validRaw({ verification_status: 'reviewed' }));
    expect(resolveImportStatus(draft)).toBe('hidden');
    expect(resolveImportStatus(reviewed)).toBe('active');
  });
});
