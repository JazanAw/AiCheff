import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface FilterRulesState {
  addBlockedKeywords: string[];
  removeBlockedKeywords: string[];
  learnedAllowedOfferNames: string[];
  learnedBlockedOfferNames: string[];
}

const defaultFilterRulesState: FilterRulesState = {
  addBlockedKeywords: [],
  removeBlockedKeywords: [],
  learnedAllowedOfferNames: [],
  learnedBlockedOfferNames: [],
};

function resolveRulesFile(): string {
  const customPath = process.env.FILTER_RULES_FILE?.trim();
  if (customPath) {
    return path.resolve(process.cwd(), customPath);
  }

  return path.resolve(process.cwd(), 'backend/data/filter-rules.json');
}

const filterRulesFile = resolveRulesFile();

async function ensureDataDirectory(): Promise<void> {
  const directory = path.dirname(filterRulesFile);
  await fs.mkdir(directory, { recursive: true });
}

export async function loadFilterRulesState(): Promise<FilterRulesState> {
  await ensureDataDirectory();

  try {
    const raw = await fs.readFile(filterRulesFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<FilterRulesState>;

    return {
      addBlockedKeywords: Array.isArray(parsed.addBlockedKeywords)
        ? parsed.addBlockedKeywords
        : [],
      removeBlockedKeywords: Array.isArray(parsed.removeBlockedKeywords)
        ? parsed.removeBlockedKeywords
        : [],
      learnedAllowedOfferNames: Array.isArray(parsed.learnedAllowedOfferNames)
        ? parsed.learnedAllowedOfferNames
        : [],
      learnedBlockedOfferNames: Array.isArray(parsed.learnedBlockedOfferNames)
        ? parsed.learnedBlockedOfferNames
        : [],
    };
  } catch {
    return defaultFilterRulesState;
  }
}

export async function saveFilterRulesState(
  state: FilterRulesState,
): Promise<void> {
  await ensureDataDirectory();
  await fs.writeFile(filterRulesFile, JSON.stringify(state, null, 2), 'utf8');
}
