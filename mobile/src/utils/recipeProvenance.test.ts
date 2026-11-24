import { describe, expect, it } from 'vitest';
import type { Recipe } from '../types';
import {
  hasSourceCitation,
  recipeProvenanceBadge,
  shouldShowAiSafetyNotice,
} from './recipeProvenance';

type ProvenanceFields = Pick<
  Recipe,
  | 'sourceType'
  | 'verificationStatus'
  | 'sourceTitle'
  | 'sourceAuthor'
  | 'sourceYear'
  | 'sourceUrl'
  | 'sourceLicense'
  | 'aiNoticeRequired'
  | 'safetyNotes'
>;

function fields(overrides: Partial<ProvenanceFields> = {}): ProvenanceFields {
  return {
    sourceType: 'human_verified',
    verificationStatus: 'published',
    aiNoticeRequired: false,
    ...overrides,
  };
}

describe('recipeProvenanceBadge', () => {
  it('returns null for a default human/published recipe — no UI noise', () => {
    expect(recipeProvenanceBadge(fields())).toBeNull();
  });

  it('returns "verified" for a human recipe explicitly in reviewed state', () => {
    expect(
      recipeProvenanceBadge(fields({ verificationStatus: 'reviewed' })),
    ).toBe('verified');
  });

  it('returns "ai_generated" for AI-generated recipes', () => {
    expect(recipeProvenanceBadge(fields({ sourceType: 'ai_generated' }))).toBe(
      'ai_generated',
    );
  });

  it('returns "ai_adapted" for AI-adapted recipes', () => {
    expect(recipeProvenanceBadge(fields({ sourceType: 'ai_adapted' }))).toBe(
      'ai_adapted',
    );
  });

  it('returns "public_domain" for public-domain adaptations', () => {
    expect(
      recipeProvenanceBadge(fields({ sourceType: 'public_domain_adapted' })),
    ).toBe('public_domain');
  });

  it('treats explicit ai_notice_required on a human recipe as ai_adapted', () => {
    // Editor flag escalates the badge — keeps the AI safety banner consistent
    // with what the user sees on the card.
    expect(
      recipeProvenanceBadge(fields({ aiNoticeRequired: true })),
    ).toBe('ai_adapted');
  });
});

describe('shouldShowAiSafetyNotice', () => {
  it('shows the notice for ai_generated', () => {
    expect(shouldShowAiSafetyNotice(fields({ sourceType: 'ai_generated' }))).toBe(true);
  });

  it('shows the notice for ai_adapted', () => {
    expect(shouldShowAiSafetyNotice(fields({ sourceType: 'ai_adapted' }))).toBe(true);
  });

  it('shows the notice when ai_notice_required is explicitly set', () => {
    expect(shouldShowAiSafetyNotice(fields({ aiNoticeRequired: true }))).toBe(true);
  });

  it('does NOT show the notice for plain human-verified recipes', () => {
    expect(shouldShowAiSafetyNotice(fields())).toBe(false);
  });

  it('does NOT show the notice for public-domain adaptations', () => {
    // Public-domain rows get the citation block, not the AI banner.
    expect(
      shouldShowAiSafetyNotice(fields({ sourceType: 'public_domain_adapted' })),
    ).toBe(false);
  });
});

describe('hasSourceCitation', () => {
  it('is false for non-public-domain rows even if citation fields are set', () => {
    expect(
      hasSourceCitation(
        fields({ sourceType: 'human_verified', sourceTitle: 'Foo' }),
      ),
    ).toBe(false);
  });

  it('is false for public-domain rows with no citation data', () => {
    expect(
      hasSourceCitation(fields({ sourceType: 'public_domain_adapted' })),
    ).toBe(false);
  });

  it('is true for public-domain rows with at least one citation field', () => {
    expect(
      hasSourceCitation(
        fields({
          sourceType: 'public_domain_adapted',
          sourceAuthor: 'Katharina Prato',
        }),
      ),
    ).toBe(true);
    expect(
      hasSourceCitation(
        fields({
          sourceType: 'public_domain_adapted',
          sourceYear: 1858,
        }),
      ),
    ).toBe(true);
  });
});
