import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { typography, spacing, radius } from '../../theme';

const TOTAL_STEPS = 4;
const HAND_TRAVEL = 84;
const SLIDE_DURATION = 850;
const PULSE_DURATION = 700;

interface Props {
  onDone: () => void;
}

export function CheffityTutorial({ onDone }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fade, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [fade]);

  const dismiss = () => {
    Animated.timing(fade, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start(() => onDone());
  };

  const handleNext = () => {
    if (step < TOTAL_STEPS - 1) {
      setStep((s) => s + 1);
    } else {
      dismiss();
    }
  };

  const isLastStep = step === TOTAL_STEPS - 1;

  return (
    <Animated.View
      style={[
        styles.overlay,
        {
          opacity: fade,
          paddingTop: insets.top + spacing.xl,
          paddingBottom: insets.bottom + spacing.lg,
        },
      ]}
    >
      <View style={styles.demoArea} key={step}>
        <StepDemo step={step} t={t} />
      </View>

      <View style={styles.textArea}>
        <Text style={styles.title}>{t(`cheffity.tutorial.step${step + 1}.title`)}</Text>
        <Text style={styles.description}>
          {t(`cheffity.tutorial.step${step + 1}.description`)}
        </Text>
      </View>

      <View style={styles.dots}>
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i === step ? styles.dotActive : styles.dotInactive,
            ]}
          />
        ))}
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.nextButton} onPress={handleNext}>
          <Text style={styles.nextButtonText}>
            {isLastStep ? t('cheffity.tutorial.start') : t('cheffity.tutorial.next')}
          </Text>
        </Pressable>

        <View style={styles.skipSlot}>
          {!isLastStep && (
            <Pressable onPress={dismiss} hitSlop={8}>
              <Text style={styles.skipText}>{t('cheffity.tutorial.skip')}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Animated.View>
  );
}

interface StepDemoProps {
  step: number;
  t: (key: string) => string;
}

function StepDemo({ step, t }: StepDemoProps) {
  if (step === 0) {
    return (
      <View style={styles.demoStack}>
        <BadgeCircle bg="#10B981" symbol="📅" />
        <SlidingHand direction="right" emoji="👉" />
      </View>
    );
  }
  if (step === 1) {
    return (
      <View style={styles.demoStack}>
        <BadgeCircle bg="#EF4444" symbol="←" symbolStyle={{ fontSize: 38, fontWeight: '700' }} />
        <SlidingHand direction="left" emoji="👈" />
      </View>
    );
  }
  if (step === 2) {
    return (
      <View style={styles.demoRow}>
        <PulseIcon bg="#9CA3AF" symbol="⊘" label={t('cheffity.tutorial.step3.banLabel')} />
        <PulseIcon bg="#FF4D6D" symbol="♥" label={t('cheffity.tutorial.step3.heartLabel')} delay={PULSE_DURATION / 2} />
      </View>
    );
  }
  return (
    <View style={styles.demoStack}>
      <BadgeCircle bg="#6B7280" symbol="↕" symbolStyle={{ fontSize: 36, fontWeight: '700' }} />
      <SlidingHand direction="down" emoji="👇" />
    </View>
  );
}

function BadgeCircle({
  bg,
  symbol,
  symbolStyle,
}: {
  bg: string;
  symbol: string;
  symbolStyle?: { fontSize?: number; fontWeight?: '400' | '600' | '700' };
}) {
  return (
    <View style={[styles.badgeCircle, { backgroundColor: bg }]}>
      <Text style={[styles.badgeSymbol, symbolStyle]}>{symbol}</Text>
    </View>
  );
}

function SlidingHand({
  direction,
  emoji,
}: {
  direction: 'left' | 'right' | 'down';
  emoji: string;
}) {
  const translate = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(translate, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 200,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(translate, {
            toValue: 1,
            duration: SLIDE_DURATION,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.sequence([
            Animated.delay(SLIDE_DURATION - 250),
            Animated.timing(opacity, {
              toValue: 0,
              duration: 250,
              useNativeDriver: true,
            }),
          ]),
        ]),
        Animated.delay(180),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [translate, opacity]);

  const transform =
    direction === 'down'
      ? [
          {
            translateY: translate.interpolate({
              inputRange: [0, 1],
              outputRange: [0, HAND_TRAVEL],
            }),
          },
        ]
      : [
          {
            translateX: translate.interpolate({
              inputRange: [0, 1],
              outputRange: direction === 'right' ? [0, HAND_TRAVEL] : [0, -HAND_TRAVEL],
            }),
          },
        ];

  return (
    <Animated.View style={[styles.hand, { opacity, transform }]}>
      <Text style={styles.handEmoji}>{emoji}</Text>
    </Animated.View>
  );
}

function PulseIcon({
  bg,
  symbol,
  label,
  delay = 0,
}: {
  bg: string;
  symbol: string;
  label: string;
  delay?: number;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(scale, {
          toValue: 1.18,
          duration: PULSE_DURATION / 2,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: PULSE_DURATION / 2,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(PULSE_DURATION / 2),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [scale, delay]);

  return (
    <View style={styles.pulseColumn}>
      <Animated.View
        style={[styles.badgeCircle, { backgroundColor: bg, transform: [{ scale }] }]}
      >
        <Text style={styles.badgeSymbol}>{symbol}</Text>
      </Animated.View>
      <Text style={styles.pulseLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingHorizontal: spacing.xl,
    justifyContent: 'space-between',
    zIndex: 1000,
  },
  demoArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  demoStack: {
    alignItems: 'center',
    gap: spacing.xl,
  },
  demoRow: {
    flexDirection: 'row',
    gap: spacing.xl,
    alignItems: 'flex-start',
  },
  badgeCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeSymbol: {
    fontSize: 44,
    color: '#FFFFFF',
    textAlign: 'center',
  },
  hand: {
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
  },
  handEmoji: { fontSize: 44 },
  pulseColumn: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  pulseLabel: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  textArea: {
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.h1,
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  description: {
    ...typography.body,
    color: 'rgba(255,255,255,0.75)',
    textAlign: 'center',
    maxWidth: 320,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginBottom: spacing.lg,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  dotActive: {
    width: 24,
    backgroundColor: '#FFFFFF',
  },
  dotInactive: {
    width: 8,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  actions: {
    alignItems: 'center',
    gap: spacing.md,
  },
  nextButton: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  nextButtonText: {
    color: '#1A1A1A',
    fontSize: 16,
    fontWeight: '700',
  },
  skipSlot: {
    minHeight: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    fontWeight: '500',
  },
});
