import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useThemeColors, typography, spacing, radius } from '../../theme';

interface Props {
  step: number;
  totalSteps: number;
  title: string;
  description: string;
  onNext: () => void;
  onSkip?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  children: React.ReactNode;
}

export function OnboardingLayout({
  step,
  totalSteps,
  title,
  description,
  onNext,
  onSkip,
  nextLabel,
  nextDisabled,
  children,
}: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Progress dots */}
      <View style={styles.progress}>
        {Array.from({ length: totalSteps }, (_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                backgroundColor: i <= step ? colors.primary : colors.borderLight,
                width: i === step ? 24 : 8,
              },
            ]}
          />
        ))}
      </View>

      <View style={styles.content}>
        <Text style={[typography.h2, { color: colors.text }]}>{title}</Text>
        <Text style={[typography.body, { color: colors.textSecondary, marginTop: spacing.sm }]}>
          {description}
        </Text>

        <View style={styles.body}>{children}</View>
      </View>

      <View style={styles.footer}>
        <Pressable
          style={[
            styles.nextButton,
            {
              backgroundColor: colors.primary,
              opacity: nextDisabled ? 0.5 : 1,
            },
          ]}
          onPress={onNext}
          disabled={nextDisabled}
        >
          <Text style={[typography.button, { color: '#FFFFFF' }]}>
            {nextLabel ?? t('common.continue')}
          </Text>
        </Pressable>

        {onSkip && (
          <Pressable style={styles.skipButton} onPress={onSkip}>
            <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
              {t('common.skip')}
            </Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  progress: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.md,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  body: {
    flex: 1,
    marginTop: spacing.xl,
  },
  footer: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  nextButton: {
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  skipButton: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
});
