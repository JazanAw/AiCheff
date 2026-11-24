import { describe, it, expect } from 'vitest';
import {
  summarizeRecipeRow,
  tallyByRecipeId,
  type RawRecipeRow,
} from './recipeAdmin';

function row(overrides: Partial<RawRecipeRow> = {}): RawRecipeRow {
  return {
    id: 'r1',
    name: { de: 'Tomatensuppe', en: 'Tomato soup' },
    status: 'active',
    source_type: 'human_verified',
    verification_status: 'reviewed',
    ai_notice_required: false,
    safety_notes: null,
    meal_type: 'lunch',
    difficulty: 'easy',
    cook_time_minutes: 20,
    prep_time_minutes: 10,
    cuisine: 'international',
    tags: ['suppe', 'vegan'],
    diet_flags: ['vegan'],
    halal_status: 'halal',
    halal_notes: null,
    calories: 200,
    protein_g: 6,
    carbs_g: 24,
    fat_g: 8,
    image_url: 'https://example.org/x.jpg',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-02T00:00:00Z',
    ...overrides,
  };
}

const NO_COUNTS = { ingredients: 0, instructions: 0 };

describe('summarizeRecipeRow', () => {
  it('extracts the German title from the jsonb name', () => {
    expect(summarizeRecipeRow(row(), NO_COUNTS).title).toBe('Tomatensuppe');
    expect(summarizeRecipeRow(row({ name: { en: 'Only EN' } }), NO_COUNTS).title).toBe('Only EN');
    expect(summarizeRecipeRow(row({ name: null }), NO_COUNTS).title).toBe('(ohne Name)');
  });

  it('maps counts, tags and diet_flags through', () => {
    const s = summarizeRecipeRow(row(), { ingredients: 5, instructions: 4 });
    expect(s.ingredientsCount).toBe(5);
    expect(s.instructionsCount).toBe(4);
    expect(s.tags).toEqual(['suppe', 'vegan']);
    expect(s.dietFlags).toEqual(['vegan']);
    expect(s.cookTimeMinutes).toBe(20);
    expect(s.prepTimeMinutes).toBe(10);
  });

  it('flags a clean human recipe with no warnings', () => {
    const s = summarizeRecipeRow(row(), NO_COUNTS);
    expect(s.isAi).toBe(false);
    expect(s.missingImage).toBe(false);
    expect(s.missingNutrition).toBe(false);
    expect(s.missingSafetyNotes).toBe(false);
    expect(s.halalUnclear).toBe(false);
    expect(s.needsReview).toBe(false);
  });

  it('marks an AI recipe and requires safety notes', () => {
    const withNotes = summarizeRecipeRow(
      row({ source_type: 'ai_generated', ai_notice_required: true, safety_notes: 'Gut garen.', verification_status: 'reviewed' }),
      NO_COUNTS,
    );
    expect(withNotes.isAi).toBe(true);
    expect(withNotes.missingSafetyNotes).toBe(false);
    expect(withNotes.needsReview).toBe(false);

    const withoutNotes = summarizeRecipeRow(
      row({ source_type: 'ai_adapted', ai_notice_required: true, safety_notes: null, verification_status: 'reviewed' }),
      NO_COUNTS,
    );
    expect(withoutNotes.isAi).toBe(true);
    expect(withoutNotes.missingSafetyNotes).toBe(true);
    expect(withoutNotes.needsReview).toBe(true);
  });

  it('flags missing image and missing nutrition', () => {
    const s = summarizeRecipeRow(
      row({ image_url: null, calories: null, protein_g: null, carbs_g: null, fat_g: null }),
      NO_COUNTS,
    );
    expect(s.missingImage).toBe(true);
    expect(s.hasImage).toBe(false);
    expect(s.missingNutrition).toBe(true);
  });

  it('treats null/unclear halal as halalUnclear', () => {
    expect(summarizeRecipeRow(row({ halal_status: null }), NO_COUNTS).halalUnclear).toBe(true);
    expect(summarizeRecipeRow(row({ halal_status: 'unclear' }), NO_COUNTS).halalUnclear).toBe(true);
    expect(summarizeRecipeRow(row({ halal_status: 'halal' }), NO_COUNTS).halalUnclear).toBe(false);
  });

  it('marks drafts as needsReview', () => {
    expect(summarizeRecipeRow(row({ verification_status: 'draft' }), NO_COUNTS).needsReview).toBe(true);
    expect(summarizeRecipeRow(row({ verification_status: 'published' }), NO_COUNTS).needsReview).toBe(false);
  });

  it('tolerates missing metadata columns (pre-migration rows)', () => {
    const s = summarizeRecipeRow(
      { id: 'r9', name: { de: 'Alt' }, status: 'active', source_type: 'human_verified', verification_status: 'reviewed' },
      NO_COUNTS,
    );
    expect(s.tags).toEqual([]);
    expect(s.dietFlags).toEqual([]);
    expect(s.cuisine).toBeNull();
    expect(s.prepTimeMinutes).toBeNull();
    // halal_status absent → unclear
    expect(s.halalUnclear).toBe(true);
  });
});

describe('tallyByRecipeId', () => {
  it('counts occurrences per recipe_id', () => {
    const counts = tallyByRecipeId([
      { recipe_id: 'a' },
      { recipe_id: 'a' },
      { recipe_id: 'b' },
      { recipe_id: null },
      {},
    ]);
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
    expect(counts.size).toBe(2);
  });
});
