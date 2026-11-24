import { describe, expect, it } from 'vitest';
import type { BodyData, DietGoal } from '../types';
import {
  basalMetabolicRate,
  computeNutritionTargets,
  progressFraction,
  proteinTargetGrams,
  remainingProtein,
  totalDailyEnergyExpenditure,
  waterTargetMl,
} from './nutritionTargets';

const maintainGoal: DietGoal = { autoCalculateCalories: true, goalType: 'maintain' };

const fullBody: Partial<BodyData> = {
  gender: 'male',
  weightKg: 80,
  heightCm: 180,
  age: 30,
  activityLevel: 'moderately_active',
};

describe('basalMetabolicRate', () => {
  it('uses Mifflin-St Jeor for men', () => {
    // 10*80 + 6.25*180 - 5*30 + 5 = 800 + 1125 - 150 + 5 = 1780
    expect(basalMetabolicRate(fullBody)).toBe(1780);
  });

  it('uses the female offset', () => {
    // 10*60 + 6.25*165 - 5*30 - 161 = 600 + 1031.25 - 150 - 161 = 1320.25 → 1320
    expect(
      basalMetabolicRate({ gender: 'female', weightKg: 60, heightCm: 165, age: 30 }),
    ).toBe(1320);
  });

  it('falls back to age 30 when age missing', () => {
    expect(basalMetabolicRate({ gender: 'male', weightKg: 80, heightCm: 180 })).toBe(1780);
  });

  it('returns null when inputs are incomplete', () => {
    expect(basalMetabolicRate({ gender: 'male', weightKg: 80 })).toBeNull();
    expect(basalMetabolicRate({})).toBeNull();
  });
});

describe('totalDailyEnergyExpenditure', () => {
  it('multiplies BMR by the activity factor', () => {
    // 1780 * 1.55 = 2759
    expect(totalDailyEnergyExpenditure(fullBody)).toBe(2759);
  });

  it('returns null without enough body data', () => {
    expect(totalDailyEnergyExpenditure({ gender: 'male' })).toBeNull();
  });
});

describe('proteinTargetGrams', () => {
  it('uses an explicit override when set', () => {
    expect(proteinTargetGrams(fullBody, { ...maintainGoal, proteinTargetG: 150 })).toBe(150);
  });

  it('uses 1.6 g/kg when losing', () => {
    expect(proteinTargetGrams(fullBody, { ...maintainGoal, goalType: 'lose' })).toBe(128);
  });

  it('uses 1.4 g/kg for active maintenance', () => {
    expect(proteinTargetGrams(fullBody, maintainGoal)).toBe(112);
  });

  it('uses 1.0 g/kg for sedentary maintenance', () => {
    expect(
      proteinTargetGrams(
        { ...fullBody, activityLevel: 'barely_active' },
        maintainGoal,
      ),
    ).toBe(80);
  });

  it('falls back to a default without weight', () => {
    expect(proteinTargetGrams({ gender: 'male' }, maintainGoal)).toBe(75);
  });
});

describe('waterTargetMl', () => {
  it('uses an override when set', () => {
    expect(waterTargetMl(fullBody, { ...maintainGoal, waterTargetMl: 3000 })).toBe(3000);
  });

  it('derives ~35 ml/kg rounded to 250, clamped to 2.0–4.0 L', () => {
    // 80 * 35 = 2800 → 2750 (rounded to 250)
    expect(waterTargetMl(fullBody, maintainGoal)).toBe(2750);
    // 50 * 35 = 1750 → clamped up to 2000
    expect(waterTargetMl({ weightKg: 50 }, maintainGoal)).toBe(2000);
    // 130 * 35 = 4550 → clamped down to 4000
    expect(waterTargetMl({ weightKg: 130 }, maintainGoal)).toBe(4000);
  });

  it('falls back to 2000 ml without weight', () => {
    expect(waterTargetMl({}, maintainGoal)).toBe(2000);
  });
});

describe('computeNutritionTargets', () => {
  it('applies a conservative deficit when losing', () => {
    const targets = computeNutritionTargets(fullBody, { ...maintainGoal, goalType: 'lose' });
    // 2759 * 0.85 = 2345.15 → 2350 (rounded to 10)
    expect(targets.calories).toBe(2350);
    expect(targets.isEstimateOnly).toBe(false);
  });

  it('honours a manual calorie target when auto-calc is off', () => {
    const targets = computeNutritionTargets(fullBody, {
      autoCalculateCalories: false,
      dailyCalorieTarget: 2100,
      goalType: 'maintain',
    });
    expect(targets.calories).toBe(2100);
  });

  it('flags estimate-only and uses defaults when body data is missing', () => {
    const targets = computeNutritionTargets({}, maintainGoal);
    expect(targets.calories).toBe(2000);
    expect(targets.isEstimateOnly).toBe(true);
  });

  it('warns when a manual cutting target dips below the floor', () => {
    const targets = computeNutritionTargets(
      { gender: 'female', weightKg: 60, heightCm: 165, age: 30 },
      { autoCalculateCalories: false, dailyCalorieTarget: 1000, goalType: 'lose' },
    );
    expect(targets.aggressiveWarning).toBe(true);
  });

  it('does not warn for a sensible maintenance target', () => {
    const targets = computeNutritionTargets(fullBody, maintainGoal);
    expect(targets.aggressiveWarning).toBeUndefined();
  });
});

describe('remainingProtein / progressFraction', () => {
  it('never goes negative', () => {
    expect(remainingProtein(120, 100)).toBe(0);
    expect(remainingProtein(40, 100)).toBe(60);
  });

  it('clamps the progress fraction to 0–1', () => {
    expect(progressFraction(50, 100)).toBe(0.5);
    expect(progressFraction(150, 100)).toBe(1);
    expect(progressFraction(10, 0)).toBe(0);
  });
});
