import type { Recipe } from '../types';

/**
 * UI-facing provenance kinds for the recipe badge. Drives icon + color choice
 * in `CheffityScreen` / `PantryRecipesView`. `null` means "show nothing"
 * (the default for legacy / fully-human-verified-and-published rows where a
 * "Geprüft" badge would just be noise).
 */
export type RecipeProvenanceBadge =
  | 'verified'
  | 'ai_generated'
  | 'ai_adapted'
  | 'public_domain';

/**
 * Decide which badge — if any — to show for a recipe. v1 rule set:
 *
 *   - public_domain_adapted    → "Gemeinfreie Quelle"
 *   - ai_generated             → "KI-Vorschlag"
 *   - ai_adapted               → "KI-angepasst"
 *   - human_verified + reviewed/published
 *                              → "Geprüft" only if the recipe explicitly
 *                                 carries a non-published verification state
 *                                 OR carries safety notes / ai_notice_required.
 *
 * Note on the last bullet: every legacy recipe today is human_verified +
 * published, and slapping a "Geprüft" badge on literally everything dilutes
 * the signal. We surface "Geprüft" mainly to *contrast* with the AI/public-
 * domain cases on screens that mix them. If you want to show "Geprüft" on
 * every human row, change the last case to `return 'verified'`.
 */
export function recipeProvenanceBadge(
  recipe: Pick<
    Recipe,
    'sourceType' | 'verificationStatus' | 'aiNoticeRequired' | 'safetyNotes'
  >,
): RecipeProvenanceBadge | null {
  switch (recipe.sourceType) {
    case 'public_domain_adapted':
      return 'public_domain';
    case 'ai_generated':
      return 'ai_generated';
    case 'ai_adapted':
      return 'ai_adapted';
    case 'human_verified':
    default:
      // Only mark "Geprüft" when there's a reason to highlight it — otherwise
      // every legacy card would carry the badge and lose the comparison
      // signal against AI/public-domain rows.
      if (recipe.aiNoticeRequired) return 'ai_adapted';
      if (recipe.verificationStatus === 'reviewed') return 'verified';
      return null;
  }
}

/**
 * Whether the AI safety notice should be shown in the recipe detail.
 * Triggered explicitly by the editor (`ai_notice_required`) OR by the
 * source type being AI-derived. Public-domain rows do not get this banner
 * — they get the source citation block instead.
 */
export function shouldShowAiSafetyNotice(
  recipe: Pick<Recipe, 'sourceType' | 'aiNoticeRequired'>,
): boolean {
  if (recipe.aiNoticeRequired) return true;
  return (
    recipe.sourceType === 'ai_generated' || recipe.sourceType === 'ai_adapted'
  );
}

/** Whether the recipe has any structured citation data worth displaying. */
export function hasSourceCitation(
  recipe: Pick<
    Recipe,
    'sourceType' | 'sourceTitle' | 'sourceAuthor' | 'sourceYear' | 'sourceUrl' | 'sourceLicense'
  >,
): boolean {
  if (recipe.sourceType !== 'public_domain_adapted') return false;
  return Boolean(
    recipe.sourceTitle ||
      recipe.sourceAuthor ||
      recipe.sourceYear ||
      recipe.sourceUrl ||
      recipe.sourceLicense,
  );
}
