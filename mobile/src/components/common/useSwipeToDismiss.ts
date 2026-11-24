// Central "swipe down to dismiss" behaviour for the app's bottom sheets.
//
// Returns a gesture-handler Pan gesture plus a reanimated style to apply to the
// sheet container, so every sheet gets the same drag-to-close behaviour without
// re-implementing it. Works for touch (native) and mouse drag (react-native-web)
// because react-native-gesture-handler drives both.
//
// Key rules (per spec):
//   - A downward drag past a distance/velocity threshold dismisses the sheet.
//   - A short drag snaps the sheet back to its resting position.
//   - When the sheet contains a scroll view, the drag only engages if the
//     scroll was at the very top when the gesture began — otherwise the inner
//     scroll keeps working untouched.
//   - Existing design / close buttons / backdrop taps are untouched: this hook
//     only adds the drag layer.
//
// Two modes:
//   - 'modal'      (default): the sheet lives in an RN <Modal>, whose own
//     animationType="slide" owns enter/exit. The hook only adds the drag.
//   - 'standalone': the sheet has no RN Modal (it animates itself). The hook
//     also drives the slide-in / slide-out and a backdrop fade.

import { useEffect, useMemo } from 'react';
import { Dimensions } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import {
  runOnJS,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type AnimatedRef,
} from 'react-native-reanimated';

const { height: SCREEN_H } = Dimensions.get('window');

// Release past this travel (or velocity) commits the dismiss.
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 800;
// Pan must travel this far downward before it grabs the touch — keeps taps and
// small jitters from starting a drag, and leaves upward scrolling untouched.
const ACTIVATION_OFFSET = 12;
// Horizontal travel beyond this fails the pan, so left/right gestures inside
// the sheet (chips, sliders) still work.
const DIRECTION_LOCK = 16;
// How close to the top counts as "at the top" for the scroll-gate.
const EDGE_SLACK = 2;
const SNAP_SPRING = { damping: 24, stiffness: 260, overshootClamping: true } as const;
const SLIDE_IN = { duration: 240 } as const;
const SLIDE_OUT = { duration: 200 } as const;

export interface UseSwipeToDismissOptions {
  /** Whether the sheet is currently shown (drives reset + standalone slide). */
  visible: boolean;
  /** Called once a drag-down dismiss commits. Usually the sheet's onClose. */
  onDismiss: () => void;
  mode?: 'modal' | 'standalone';
}

export interface UseSwipeToDismiss {
  gesture: ReturnType<typeof Gesture.Pan>;
  /** Apply to the sheet container (a reanimated Animated.View). */
  sheetStyle: ReturnType<typeof useAnimatedStyle>;
  /** Optional: apply to a reanimated backdrop (standalone mode fades it). */
  backdropStyle: ReturnType<typeof useAnimatedStyle>;
  /** Attach to the sheet's inner Animated.ScrollView/FlatList onScroll. */
  scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
  /** Ref for the inner Animated.ScrollView/FlatList (scroll-gate + simultaneity).
   *  Loosely typed so it attaches to either an Animated ScrollView or FlatList. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scrollRef: AnimatedRef<any>;
}

export function useSwipeToDismiss({
  visible,
  onDismiss,
  mode = 'modal',
}: UseSwipeToDismissOptions): UseSwipeToDismiss {
  // Sheet vertical offset. modal: 0 at rest. standalone: SCREEN_H when hidden.
  const translateY = useSharedValue(mode === 'standalone' ? SCREEN_H : 0);
  const scrollOffset = useSharedValue(0);
  // Captured on gesture begin so a drag that starts mid-scroll never dismisses.
  const startedAtTop = useSharedValue(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrollRef = useAnimatedRef<any>();

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollOffset.value = event.contentOffset.y;
  });

  // Standalone mode owns the enter/exit animation.
  useEffect(() => {
    if (mode !== 'standalone') return;
    translateY.value = visible ? withTiming(0, SLIDE_IN) : withTiming(SCREEN_H, SLIDE_OUT);
  }, [visible, mode, translateY]);

  // Modal mode: the RN Modal owns enter/exit, but reset any leftover drag when
  // the sheet (re)appears so a previous partial drag doesn't persist.
  useEffect(() => {
    if (mode === 'modal' && visible) translateY.value = 0;
  }, [visible, mode, translateY]);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(ACTIVATION_OFFSET)
        .failOffsetX([-DIRECTION_LOCK, DIRECTION_LOCK])
        // Known gesture-handler ↔ reanimated AnimatedRef nominal-type mismatch;
        // an unattached ref (sheets without a scroll view) is a harmless no-op.
        .simultaneousWithExternalGesture(scrollRef as never)
        .onBegin(() => {
          startedAtTop.value = scrollOffset.value <= EDGE_SLACK;
        })
        .onUpdate((event) => {
          if (!startedAtTop.value) return;
          // Only downward travel moves the sheet (negative clamps to rest).
          translateY.value = Math.max(0, event.translationY);
        })
        .onEnd((event) => {
          if (!startedAtTop.value) return;
          const past =
            translateY.value > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY;
          if (past) {
            translateY.value = withTiming(SCREEN_H, SLIDE_OUT, (finished) => {
              if (finished) runOnJS(onDismiss)();
            });
          } else {
            translateY.value = withSpring(0, SNAP_SPRING);
          }
        }),
    // Shared values + scrollRef are stable; only onDismiss can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onDismiss],
  );

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  // Backdrop opacity tracks the sheet position (full at rest, fading as it is
  // dragged/slid away). Standalone sheets use it; modal sheets can ignore it.
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, Math.max(0, translateY.value) / SCREEN_H),
  }));

  return { gesture, sheetStyle, backdropStyle, scrollHandler, scrollRef };
}
