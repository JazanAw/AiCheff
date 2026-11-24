import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';
import { floatingTabBarClearance } from '../../navigation/components/FloatingGlassTabBar';
import { useSubscription } from '../../store/SubscriptionContext';
import { LockedFeature } from '../../components/common/LockedFeature';
import { HeaderActions } from '../../components/common/HeaderActions';
import { ActivityLevel, BodyData, DietGoal, DietGoalType, Gender, ProgressEntry } from '../../types';
import {
  deleteProgressEntry,
  getBodyData,
  listProgressEntries,
  upsertBodyData,
  upsertProgressEntry,
} from '../../services/dietTrackingApi';
import { computeNutritionTargets } from '../../utils/nutritionTargets';
import { TrackingDashboard } from './components/TrackingDashboard';

const ACTIVITY_LEVELS: ActivityLevel[] = [
  'barely_active', 'lightly_active', 'moderately_active', 'very_active',
];

const GOAL_TYPES: DietGoalType[] = ['lose', 'maintain', 'gain', 'recomp'];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Props {
  /** Optional: when rendered as a pushed screen. Omitted when used as a bottom tab. */
  onBack?: () => void;
}

export function DietTrackingScreen({ onBack }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { hasFeature, requiredTier } = useSubscription();
  const insets = useSafeAreaInsets();

  const [bodyData, setBodyData] = useState<Partial<BodyData>>({});
  const [goals, setGoals] = useState<DietGoal>({
    autoCalculateCalories: true,
  });
  const [goalMode, setGoalMode] = useState(false);
  const [entries, setEntries] = useState<ProgressEntry[]>([]);
  // 'today' = tracking dashboard, 'settings' = body data / goals / progress.
  const [view, setView] = useState<'today' | 'settings'>('today');

  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingEntry, setSavingEntry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Progress entry form
  const [entryDate, setEntryDate] = useState(todayIso());
  const [entryWeight, setEntryWeight] = useState('');
  const [entryBodyFat, setEntryBodyFat] = useState('');
  const [entryNotes, setEntryNotes] = useState('');

  const featureUnlocked = hasFeature('diet_tracking');

  useEffect(() => {
    if (!featureUnlocked) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [body, list] = await Promise.all([
          getBodyData(),
          listProgressEntries(),
        ]);
        if (cancelled) return;
        if (body) {
          setBodyData({
            gender: body.gender,
            heightCm: body.heightCm,
            weightKg: body.weightKg,
            bodyFatPercent: body.bodyFatPercent,
            activityLevel: body.activityLevel,
            age: body.age,
          });
          setGoals({
            targetWeightKg: body.targetWeightKg,
            targetBodyFatPercent: body.targetBodyFatPercent,
            dailyCalorieTarget: body.dailyCalorieTarget,
            autoCalculateCalories: body.autoCalculateCalories ?? true,
            goalType: body.goalType,
            trainingDaysPerWeek: body.trainingDaysPerWeek,
            proteinTargetG: body.proteinTargetG,
            waterTargetMl: body.waterTargetMl,
          });
          setGoalMode(Boolean(body.goalModeEnabled));
        }
        setEntries(list);
      } catch (e) {
        if (!cancelled) setError(t('diet.loadError'));
        console.warn('[DietTrackingScreen] load failed:', (e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [featureUnlocked, t]);

  if (!featureUnlocked) {
    return (
      <LockedFeature requiredTier={requiredTier('diet_tracking')}>
        <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
          <View style={styles.header}>
            {onBack ? (
              <Pressable onPress={onBack}>
                <Text style={[typography.button, { color: colors.primary }]}>{t('common.back')}</Text>
              </Pressable>
            ) : (
              <View style={{ width: 50 }} />
            )}
            <Text style={[typography.h3, { color: colors.text }]}>{t('diet.title')}</Text>
            {onBack ? <View style={{ width: 50 }} /> : <HeaderActions />}
          </View>
        </SafeAreaView>
      </LockedFeature>
    );
  }

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    setError(null);
    setSuccess(null);
    try {
      const saved = await upsertBodyData({
        gender: bodyData.gender,
        heightCm: bodyData.heightCm,
        weightKg: bodyData.weightKg,
        bodyFatPercent: bodyData.bodyFatPercent,
        activityLevel: bodyData.activityLevel,
        age: bodyData.age,
        targetWeightKg: goals.targetWeightKg,
        targetBodyFatPercent: goals.targetBodyFatPercent,
        dailyCalorieTarget: goals.dailyCalorieTarget,
        autoCalculateCalories: goals.autoCalculateCalories,
        goalModeEnabled: goalMode,
        goalType: goals.goalType,
        trainingDaysPerWeek: goals.trainingDaysPerWeek,
        proteinTargetG: goals.proteinTargetG,
        waterTargetMl: goals.waterTargetMl,
      });
      // Re-sync from the persisted row so the UI reflects exactly what's stored.
      setBodyData({
        gender: saved.gender,
        heightCm: saved.heightCm,
        weightKg: saved.weightKg,
        bodyFatPercent: saved.bodyFatPercent,
        activityLevel: saved.activityLevel,
        age: saved.age,
      });
      setGoals({
        targetWeightKg: saved.targetWeightKg,
        targetBodyFatPercent: saved.targetBodyFatPercent,
        dailyCalorieTarget: saved.dailyCalorieTarget,
        autoCalculateCalories: saved.autoCalculateCalories ?? true,
        goalType: saved.goalType,
        trainingDaysPerWeek: saved.trainingDaysPerWeek,
        proteinTargetG: saved.proteinTargetG,
        waterTargetMl: saved.waterTargetMl,
      });
      setGoalMode(Boolean(saved.goalModeEnabled));
      setSuccess(t('diet.saved'));
    } catch (e) {
      setError(t('diet.saveError'));
      console.warn('[DietTrackingScreen] saveProfile failed:', (e as Error).message);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAddEntry = async () => {
    if (!entryDate) return;
    setSavingEntry(true);
    setError(null);
    setSuccess(null);
    try {
      const saved = await upsertProgressEntry({
        date: entryDate,
        weightKg: entryWeight ? Number(entryWeight) : undefined,
        bodyFatPercent: entryBodyFat ? Number(entryBodyFat) : undefined,
        notes: entryNotes || undefined,
      });
      setEntries((prev) => {
        // Drop any prior row for the same id/date (upsert may have replaced it),
        // then re-sort newest date first.
        const rest = prev.filter((e) => e.id !== saved.id && e.date !== saved.date);
        return [saved, ...rest].sort((a, b) => (a.date < b.date ? 1 : -1));
      });
      setEntryWeight('');
      setEntryBodyFat('');
      setEntryNotes('');
      setEntryDate(todayIso());
      setSuccess(t('diet.entrySaved'));
    } catch (e) {
      setError(t('diet.saveError'));
      console.warn('[DietTrackingScreen] addEntry failed:', (e as Error).message);
    } finally {
      setSavingEntry(false);
    }
  };

  const handleDeleteEntry = async (id: string) => {
    setError(null);
    try {
      await deleteProgressEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      setError(t('diet.saveError'));
      console.warn('[DietTrackingScreen] deleteEntry failed:', (e as Error).message);
    }
  };

  const targets = computeNutritionTargets(bodyData, goals);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable onPress={onBack}>
            <Text style={[typography.button, { color: colors.primary }]}>{t('common.back')}</Text>
          </Pressable>
        ) : (
          <View style={{ width: 50 }} />
        )}
        <Text style={[typography.h3, { color: colors.text }]}>{t('diet.title')}</Text>
        {onBack ? <View style={{ width: 50 }} /> : <HeaderActions />}
      </View>

      {/* Today (dashboard) / Settings (body data + goals) toggle */}
      <View style={styles.segmented}>
        {(['today', 'settings'] as const).map((mode) => {
          const active = view === mode;
          return (
            <Pressable
              key={mode}
              style={[styles.segmentedItem, {
                backgroundColor: active ? colors.primary : colors.surface,
                borderColor: active ? colors.primary : colors.border,
              }]}
              onPress={() => setView(mode)}
            >
              <Text style={[typography.button, { color: active ? '#FFF' : colors.text }]}>
                {t(mode === 'today' ? 'diet.tabToday' : 'diet.tabSettings')}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: floatingTabBarClearance(insets.bottom) }]}
      >
        {/* Status row */}
        {loading && (
          <View style={styles.statusRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
              {t('diet.loading')}
            </Text>
          </View>
        )}
        {error && (
          <Text style={[typography.bodySmall, { color: colors.error, marginBottom: spacing.sm }]}>
            {error}
          </Text>
        )}
        {success && (
          <Text style={[typography.bodySmall, { color: colors.success, marginBottom: spacing.sm }]}>
            {success}
          </Text>
        )}

        {view === 'today' && !loading && (
          <TrackingDashboard
            targets={targets}
            colors={colors}
            t={t}
            onOpenSettings={() => setView('settings')}
          />
        )}

        {view === 'settings' && (
        <>
        {/* Body Data */}
        <Text style={[typography.label, { color: colors.textSecondary }]}>
          {t('diet.bodyData')}
        </Text>

        {/* Gender */}
        <Text style={[typography.bodySmall, { color: colors.text, marginTop: spacing.md }]}>
          {t('diet.gender')}
        </Text>
        <View style={styles.toggleRow}>
          {(['male', 'female'] as Gender[]).map((g) => (
            <Pressable
              key={g}
              style={[styles.toggleButton, {
                backgroundColor: bodyData.gender === g ? colors.primary : colors.surface,
                borderColor: bodyData.gender === g ? colors.primary : colors.border,
              }]}
              onPress={() => setBodyData({ ...bodyData, gender: g })}
            >
              <Text style={[typography.button, {
                color: bodyData.gender === g ? '#FFF' : colors.text,
              }]}>
                {t(`diet.${g}`)}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Height, Weight, Body Fat */}
        <View style={styles.inputGrid}>
          <View style={styles.inputGroup}>
            <Text style={[typography.bodySmall, { color: colors.text }]}>{t('diet.height')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={bodyData.heightCm?.toString() ?? ''}
              onChangeText={(v) => setBodyData({ ...bodyData, heightCm: Number(v) || undefined })}
              keyboardType="numeric"
              placeholder="175"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={[typography.bodySmall, { color: colors.text }]}>{t('diet.weight')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={bodyData.weightKg?.toString() ?? ''}
              onChangeText={(v) => setBodyData({ ...bodyData, weightKg: Number(v) || undefined })}
              keyboardType="numeric"
              placeholder="75"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={[typography.bodySmall, { color: colors.text }]}>{t('diet.bodyFat')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={bodyData.bodyFatPercent?.toString() ?? ''}
              onChangeText={(v) => setBodyData({ ...bodyData, bodyFatPercent: Number(v) || undefined })}
              keyboardType="numeric"
              placeholder="20"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
        </View>

        {/* Activity Level */}
        <Text style={[typography.bodySmall, { color: colors.text, marginTop: spacing.lg }]}>
          {t('diet.activityLevel')}
        </Text>
        <View style={styles.activityList}>
          {ACTIVITY_LEVELS.map((level) => {
            const active = bodyData.activityLevel === level;
            return (
              <Pressable
                key={level}
                style={[styles.activityItem, {
                  backgroundColor: active ? colors.primaryLight : colors.surface,
                  borderColor: active ? colors.primary : colors.border,
                }]}
                onPress={() => setBodyData({ ...bodyData, activityLevel: level })}
              >
                <Text style={[typography.bodySmall, { color: active ? colors.primary : colors.text }]}>
                  {t(`diet.activity.${level}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Goals */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('diet.goals')}
        </Text>
        <View style={styles.inputGrid}>
          <View style={styles.inputGroup}>
            <Text style={[typography.bodySmall, { color: colors.text }]}>{t('diet.targetWeight')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={goals.targetWeightKg?.toString() ?? ''}
              onChangeText={(v) => setGoals({ ...goals, targetWeightKg: Number(v) || undefined })}
              keyboardType="numeric"
              placeholder="70"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={[typography.bodySmall, { color: colors.text }]}>{t('diet.targetBodyFat')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={goals.targetBodyFatPercent?.toString() ?? ''}
              onChangeText={(v) => setGoals({ ...goals, targetBodyFatPercent: Number(v) || undefined })}
              keyboardType="numeric"
              placeholder="15"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
        </View>

        {/* Goal type — 2-column pill grid */}
        <Text style={[typography.bodySmall, { color: colors.text, marginTop: spacing.lg }]}>
          {t('diet.goalType')}
        </Text>
        <View style={styles.goalGrid}>
          {GOAL_TYPES.map((gt) => {
            const active = goals.goalType === gt;
            return (
              <Pressable
                key={gt}
                style={[styles.goalPill, {
                  backgroundColor: active ? colors.primary : colors.surface,
                  borderColor: active ? colors.primary : colors.border,
                }]}
                onPress={() => setGoals({ ...goals, goalType: gt })}
              >
                <Text style={[typography.buttonSmall, { color: active ? '#FFF' : colors.text }]}>
                  {t(`diet.goalTypes.${gt}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Age, training days, water target */}
        <View style={styles.inputGrid}>
          <View style={styles.inputGroup}>
            <Text style={[typography.bodySmall, { color: colors.text }]}>{t('diet.age')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={bodyData.age?.toString() ?? ''}
              onChangeText={(v) => setBodyData({ ...bodyData, age: Number(v) || undefined })}
              keyboardType="numeric"
              placeholder="30"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={[typography.bodySmall, { color: colors.text }]}>{t('diet.trainingDays')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={goals.trainingDaysPerWeek?.toString() ?? ''}
              onChangeText={(v) => setGoals({ ...goals, trainingDaysPerWeek: Number(v) || undefined })}
              keyboardType="numeric"
              placeholder="3"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={[typography.bodySmall, { color: colors.text }]}>{t('diet.waterTargetL')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={goals.waterTargetMl != null ? (goals.waterTargetMl / 1000).toString() : ''}
              onChangeText={(v) => {
                const litres = Number(v.replace(',', '.'));
                setGoals({
                  ...goals,
                  waterTargetMl:
                    v.trim() !== '' && Number.isFinite(litres) && litres > 0
                      ? Math.round(litres * 1000)
                      : undefined,
                });
              }}
              keyboardType="numeric"
              placeholder="2,5"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
        </View>

        {/* Calculated targets preview (conservative estimate). */}
        <View style={[styles.targetsPreview, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[typography.bodySmall, { color: colors.text }]}>
            {t('diet.calcPreview', {
              kcal: Math.round(targets.calories),
              protein: Math.round(targets.protein),
              water: (targets.waterMl / 1000).toFixed(1).replace('.', ','),
            })}
          </Text>
          <Text style={[typography.caption, { color: colors.textTertiary, marginTop: spacing.xs }]}>
            {t('diet.nutritionDisclaimer')}
          </Text>
        </View>

        <View style={[styles.switchRow, { marginTop: spacing.md }]}>
          <Text style={[typography.body, { color: colors.text, flex: 1 }]}>
            {t('diet.autoCalculate')}
          </Text>
          <Switch
            value={goals.autoCalculateCalories}
            onValueChange={(v) => setGoals({ ...goals, autoCalculateCalories: v })}
            trackColor={{ false: colors.border, true: colors.primaryLight }}
            thumbColor={goals.autoCalculateCalories ? colors.primary : colors.textTertiary}
          />
        </View>

        {/* Goal mode toggle */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('diet.goalMode')}
        </Text>
        <View style={[styles.switchRow, { marginTop: spacing.sm }]}>
          <View style={{ flex: 1 }}>
            <Text style={[typography.body, { color: colors.text }]}>{t('diet.goalMode')}</Text>
            <Text style={[typography.caption, { color: colors.textTertiary }]}>
              {t('diet.goalModeDescription')}
            </Text>
          </View>
          <Switch
            value={goalMode}
            onValueChange={setGoalMode}
            trackColor={{ false: colors.border, true: colors.primaryLight }}
            thumbColor={goalMode ? colors.primary : colors.textTertiary}
          />
        </View>

        {/* Save body data + goals + goal mode */}
        <Pressable
          style={[styles.primaryButton, { backgroundColor: colors.primary, opacity: savingProfile ? 0.6 : 1 }]}
          onPress={handleSaveProfile}
          disabled={savingProfile}
        >
          <Text style={[typography.button, { color: '#FFF' }]}>
            {savingProfile ? t('diet.loading') : t('diet.saveProfile')}
          </Text>
        </Pressable>

        {/* Progress */}
        <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
          {t('diet.progress')}
        </Text>
        {entries.length === 0 ? (
          <Text style={[typography.bodySmall, { color: colors.textTertiary, marginTop: spacing.sm }]}>
            {t('common.noResults')}
          </Text>
        ) : (
          entries.map((entry) => (
            <View key={entry.id} style={[styles.entryRow, { borderBottomColor: colors.borderLight }]}>
              <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{entry.date}</Text>
              <View style={styles.entryValues}>
                {entry.weightKg != null && (
                  <Text style={[typography.bodySmall, { color: colors.text }]}>{entry.weightKg} kg</Text>
                )}
                {entry.bodyFatPercent != null && (
                  <Text style={[typography.bodySmall, { color: colors.text }]}>{entry.bodyFatPercent}%</Text>
                )}
                <Pressable onPress={() => handleDeleteEntry(entry.id)} hitSlop={8}>
                  <Text style={[typography.caption, { color: colors.error }]}>
                    {t('diet.deleteEntry')}
                  </Text>
                </Pressable>
              </View>
            </View>
          ))
        )}

        {/* New progress entry form */}
        <Text style={[typography.bodySmall, { color: colors.text, marginTop: spacing.lg }]}>
          {t('diet.newEntry')}
        </Text>
        <View style={styles.inputGroup}>
          <Text style={[typography.bodySmall, { color: colors.text, marginTop: spacing.sm }]}>
            {t('diet.entryDate')}
          </Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
            value={entryDate}
            onChangeText={setEntryDate}
            placeholder={todayIso()}
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
          />
        </View>
        <View style={styles.inputGrid}>
          <View style={styles.inputGroup}>
            <Text style={[typography.bodySmall, { color: colors.text }]}>{t('diet.weight')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={entryWeight}
              onChangeText={setEntryWeight}
              keyboardType="numeric"
              placeholder="75"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={[typography.bodySmall, { color: colors.text }]}>{t('diet.bodyFat')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={entryBodyFat}
              onChangeText={setEntryBodyFat}
              keyboardType="numeric"
              placeholder="20"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
        </View>
        <View style={styles.inputGroup}>
          <Text style={[typography.bodySmall, { color: colors.text, marginTop: spacing.sm }]}>
            {t('diet.notes')}
          </Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
            value={entryNotes}
            onChangeText={setEntryNotes}
            placeholder=""
            placeholderTextColor={colors.textTertiary}
            multiline
          />
        </View>

        <Pressable
          style={[styles.primaryButton, { backgroundColor: colors.primary, opacity: savingEntry ? 0.6 : 1 }]}
          onPress={handleAddEntry}
          disabled={savingEntry}
        >
          <Text style={[typography.button, { color: '#FFF' }]}>
            {savingEntry ? t('diet.loading') : t('diet.addEntry')}
          </Text>
        </Pressable>
        </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl * 2,
  },
  segmented: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  segmentedItem: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  targetsPreview: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  goalGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  goalPill: {
    flexBasis: '47%',
    flexGrow: 1,
    paddingVertical: 11,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  toggleButton: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  inputGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  inputGroup: {
    flex: 1,
  },
  input: {
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
    marginTop: spacing.xs,
  },
  activityList: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  activityItem: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  entryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
  },
  entryValues: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  primaryButton: {
    marginTop: spacing.lg,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
});
