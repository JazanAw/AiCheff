import type { ActivityLevel, BodyData, DietGoal, NutritionTargets } from '../types';

// Conservative daily target estimator for Cheffity tracking.
//
// IMPORTANT: these are orientation values / estimates, NOT medical advice. The
// UI must label them accordingly. The numbers below stay deliberately moderate
// (no aggressive deficits, protein within widely-cited everyday ranges).

const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  barely_active: 1.2,
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
};

// Sensible fallbacks when body data is incomplete.
const DEFAULT_CALORIES = 2000;
const DEFAULT_PROTEIN_G = 75;
const DEFAULT_WATER_ML = 2000;
const DEFAULT_AGE = 30;

// Never suggest eating below these floors; also the basis for the "too
// aggressive" warning. Conservative, widely-cited minimums.
const CALORIE_FLOOR: Record<BodyData['gender'], number> = {
  male: 1500,
  female: 1200,
};

function isActive(level: ActivityLevel | undefined): boolean {
  return level === 'moderately_active' || level === 'very_active';
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Mifflin-St Jeor basal metabolic rate (kcal/day). Returns null when the
 * required inputs (gender, weight, height) are missing. Age falls back to 30.
 */
export function basalMetabolicRate(body: Partial<BodyData>): number | null {
  const { gender, weightKg, heightCm } = body;
  if (!gender || !weightKg || !heightCm) return null;
  const age = body.age && body.age > 0 ? body.age : DEFAULT_AGE;
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(gender === 'male' ? base + 5 : base - 161);
}

/** Total daily energy expenditure = BMR × activity factor. Null if BMR null. */
export function totalDailyEnergyExpenditure(body: Partial<BodyData>): number | null {
  const bmr = basalMetabolicRate(body);
  if (bmr == null) return null;
  const factor = ACTIVITY_FACTORS[body.activityLevel ?? 'lightly_active'];
  return Math.round(bmr * factor);
}

// Conservative goal-based energy adjustment (fraction of TDEE).
function goalCalorieAdjustment(goalType: DietGoal['goalType']): number {
  switch (goalType) {
    case 'lose':
      return -0.15; // moderate deficit
    case 'gain':
      return 0.1; // lean surplus
    case 'recomp':
      return -0.05; // very slight deficit
    case 'maintain':
    default:
      return 0;
  }
}

// Conservative protein target in g per kg bodyweight.
function proteinPerKg(goalType: DietGoal['goalType'], level: ActivityLevel | undefined): number {
  switch (goalType) {
    case 'lose':
      return 1.6; // preserve muscle in a deficit
    case 'gain':
    case 'recomp':
      return 1.8;
    case 'maintain':
    default:
      return isActive(level) ? 1.4 : 1.0;
  }
}

/** Daily protein target (g). Uses an explicit override first, else weight×g/kg. */
export function proteinTargetGrams(body: Partial<BodyData>, goal: DietGoal): number {
  if (goal.proteinTargetG && goal.proteinTargetG > 0) {
    return Math.round(goal.proteinTargetG);
  }
  if (!body.weightKg) return DEFAULT_PROTEIN_G;
  return Math.round(body.weightKg * proteinPerKg(goal.goalType, body.activityLevel));
}

/** Daily water goal (ml). Override first, else ~35 ml/kg clamped to 2.0–4.0 L. */
export function waterTargetMl(body: Partial<BodyData>, goal: DietGoal): number {
  if (goal.waterTargetMl && goal.waterTargetMl > 0) {
    return goal.waterTargetMl;
  }
  if (!body.weightKg) return DEFAULT_WATER_ML;
  const raw = body.weightKg * 35;
  const clamped = Math.min(4000, Math.max(2000, raw));
  return roundTo(clamped, 250);
}

/**
 * Daily calorie target (kcal). Priority:
 *  1. manual dailyCalorieTarget when auto-calc is off,
 *  2. TDEE + conservative goal adjustment,
 *  3. a flat 2000 fallback (flagged estimate-only).
 * Returns the value plus whether it had to fall back to the default.
 */
function calorieTarget(
  body: Partial<BodyData>,
  goal: DietGoal,
): { calories: number; isEstimateOnly: boolean } {
  if (!goal.autoCalculateCalories && goal.dailyCalorieTarget && goal.dailyCalorieTarget > 0) {
    return { calories: Math.round(goal.dailyCalorieTarget), isEstimateOnly: false };
  }
  const tdee = totalDailyEnergyExpenditure(body);
  if (tdee == null) {
    return { calories: DEFAULT_CALORIES, isEstimateOnly: true };
  }
  const adjusted = tdee * (1 + goalCalorieAdjustment(goal.goalType));
  return { calories: roundTo(adjusted, 10), isEstimateOnly: false };
}

/**
 * Full conservative target set for the tracking dashboard. Always returns
 * usable numbers (falls back to defaults) and flags when it is estimate-only.
 * `aggressiveWarning` trips when the resulting calorie target dips below the
 * basal rate or the gender floor while losing/recomping.
 */
export function computeNutritionTargets(
  body: Partial<BodyData>,
  goal: DietGoal,
): NutritionTargets {
  const { calories, isEstimateOnly } = calorieTarget(body, goal);
  const protein = proteinTargetGrams(body, goal);
  const water = waterTargetMl(body, goal);

  const bmr = basalMetabolicRate(body);
  const floor = body.gender ? CALORIE_FLOOR[body.gender] : CALORIE_FLOOR.female;
  const cutting = goal.goalType === 'lose' || goal.goalType === 'recomp';
  const aggressiveWarning =
    cutting && (calories < floor || (bmr != null && calories < bmr));

  return {
    calories,
    protein,
    waterMl: water,
    isEstimateOnly,
    aggressiveWarning: aggressiveWarning || undefined,
  };
}

/** Remaining protein toward the target (never negative). */
export function remainingProtein(consumed: number, target: number): number {
  return Math.max(0, Math.round(target - consumed));
}

/** Progress fraction 0–1 (clamped) for ring/bar rendering. */
export function progressFraction(consumed: number, target: number): number {
  if (!target || target <= 0) return 0;
  return Math.min(1, Math.max(0, consumed / target));
}
