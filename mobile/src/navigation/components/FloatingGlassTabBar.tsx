import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useThemeColors, fontFamilies } from '../../theme';

const BAR_HEIGHT = 64;
const SIDE_MARGIN = 16;
const ROW_PAD_H = 6;
// Narrow, CONSTANT pill width (content-hugging). Constant width means only
// translateX animates — no width-morph — for a butter-smooth slide.
const PILL_WIDTH = 74;
const PILL_HEIGHT = 46;
// Breathing room a screen keeps between its last content and the bar's TOP edge
// (added on top of the bar height + bottom gap in the clearance helper).
const CONTENT_GAP = 16;

/**
 * Visual gap between the bar's BOTTOM edge and the screen bottom. Modern iOS /
 * WhatsApp-style floating nav hugs the bottom: only ~8–12 px of air, NOT the
 * full safe-area inset. On a Home-Indicator device the inset (~34 px) is mostly
 * the indicator's own clearance, so we subtract it down to ~8–12 px; with no
 * safe area we keep a flat 8 px. The indicator + bar never overlap because the
 * bar's content sits inside its 64 px height, well above the indicator strip.
 */
export function floatingTabBarBottomGap(safeAreaBottom: number): number {
  return safeAreaBottom > 0 ? Math.max(8, Math.min(12, safeAreaBottom - 22)) : 8;
}

/**
 * Total vertical space the floating bar occupies from the screen bottom
 * (bottom gap + bar height + breathing room). Screens use this as their content
 * `paddingBottom` so the last item / buttons clear the overlaid bar — no longer
 * `insets.bottom + <const>`, which over-padded now that the bar sits lower.
 */
export function floatingTabBarClearance(safeAreaBottom: number): number {
  return floatingTabBarBottomGap(safeAreaBottom) + BAR_HEIGHT + CONTENT_GAP;
}

/**
 * Floating, glass-style bottom tab bar with an animated active pill.
 *
 * Glass: `expo-blur` is NOT installed, so this uses a translucent rgba surface
 * + hairline border + soft shadow (documented fallback). The active pill is a
 * React Native `Animated.Value` (same pattern as the app's bottom sheets) that
 * slides between tabs, honouring Reduced Motion (duration 0). Per-tab icons
 * come from each screen's `options.tabBarIcon`, so the existing locked-feature
 * colouring (colors.locked) is preserved untouched.
 */
export function FloatingGlassTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const colors = useThemeColors();
  const dark = useColorScheme() === 'dark';
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  const [rowWidth, setRowWidth] = useState(0);
  const tabCount = state.routes.length;
  const tabWidth = rowWidth > 0 ? rowWidth / tabCount : 0;

  // Active pill X — RN Animated (matches PortionModal/Toast; lint-clean, no
  // shared-value writes from effects).
  const pillX = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Centre the constant-width pill within the active cell — only X moves.
    const target = state.index * tabWidth + (tabWidth - PILL_WIDTH) / 2;
    Animated.timing(pillX, {
      toValue: target,
      duration: reduceMotion ? 0 : 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [state.index, tabWidth, reduceMotion, pillX]);

  // Hide the bar while the keyboard is open (e.g. deals search) so it never
  // floats over the keyboard.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, () => setKeyboardOpen(true));
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardOpen(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  if (keyboardOpen) return null;

  const glassBg = dark ? 'rgba(30,30,33,0.90)' : 'rgba(255,255,255,0.88)';
  const glassBorder = dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)';
  // Quiet translucent primary (#FF6B35) fill + a clean Primary hairline edge.
  // Low opacity avoids the muddy/brown block; the border gives a crisp pill.
  const pillBg = dark ? 'rgba(255,107,53,0.13)' : 'rgba(255,107,53,0.12)';
  const pillBorder = dark ? 'rgba(255,107,53,0.30)' : 'rgba(255,107,53,0.34)';

  // The row is already inside the bar's horizontal padding, so its measured
  // width IS the usable tab strip — do NOT subtract the padding again (that
  // double-subtraction previously made the pill too narrow + off-centre).
  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && Math.abs(w - rowWidth) > 0.5) setRowWidth(w);
  };

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { paddingBottom: floatingTabBarBottomGap(insets.bottom) }]}
    >
      <View
        style={[
          styles.bar,
          { backgroundColor: glassBg, borderColor: glassBorder, shadowColor: '#000' },
        ]}
      >
        <View style={styles.row} onLayout={onLayout}>
          {/* Animated active pill */}
          {tabWidth > 0 && (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.pill,
                {
                  width: PILL_WIDTH,
                  backgroundColor: pillBg,
                  borderColor: pillBorder,
                  borderWidth: 1,
                  transform: [{ translateX: pillX }],
                },
              ]}
            />
          )}

          {state.routes.map((route, index) => {
            const { options } = descriptors[route.key];
            const focused = state.index === index;
            const color = focused ? colors.tabBarActive : colors.tabBarInactive;

            const rawLabel =
              typeof options.tabBarLabel === 'string'
                ? options.tabBarLabel
                : typeof options.title === 'string'
                  ? options.title
                  : route.name;

            // Pass `focused: false` so the per-screen Icon never paints its
            // filled active state (e.g. the `swipe` icon's solid fill). The
            // active state is conveyed solely by the pill + the primary
            // `color` we hand in here. Locked colouring still applies in the
            // screen's tabBarIcon (hasFeature ? color : colors.locked).
            const icon = options.tabBarIcon?.({ focused: false, color, size: 23 });

            const onPress = () => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                navigation.navigate(route.name);
              }
            };

            const onLongPress = () => {
              navigation.emit({ type: 'tabLongPress', target: route.key });
            };

            return (
              <Pressable
                key={route.key}
                onPress={onPress}
                onLongPress={onLongPress}
                style={styles.tab}
                hitSlop={6}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={rawLabel}
              >
                <View style={styles.tabInner}>
                  {icon}
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.label,
                      { color, fontFamily: focused ? fontFamilies.semibold : fontFamilies.medium },
                    ]}
                  >
                    {rawLabel}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // True floating overlay: absolutely pinned to the bottom, transparent
  // surroundings (no reserved/white block). Screens add bottom padding
  // (floatingTabBarClearance) so their content clears it. box-none lets taps
  // in the transparent margins fall through to the content underneath.
  wrap: {
    position: 'absolute',
    left: SIDE_MARGIN,
    right: SIDE_MARGIN,
    bottom: 0,
    alignItems: 'stretch',
  },
  bar: {
    height: BAR_HEIGHT,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: ROW_PAD_H,
    // Subtle floating shadow. A strong shadow (opacity 0.5 / radius 17) cast a
    // dark halo ABOVE the bar that merged with the recipe card into a dark
    // "podest". Kept light + close so it reads as a floating edge, not a block.
    // No overflow:hidden → iOS shadow intact.
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  // Fills the full bar height so the absolute pill's vertical centring math
  // (relative to THIS row) matches the bar.
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', position: 'relative' },
  // Narrow, soft horizontal pill — constant width (only translateX animates),
  // vertically centred, full stadium radius, quiet fill + clean hairline edge.
  pill: {
    position: 'absolute',
    left: 0,
    top: (BAR_HEIGHT - PILL_HEIGHT) / 2,
    height: PILL_HEIGHT,
    borderRadius: PILL_HEIGHT / 2,
  },
  tab: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  tabInner: { alignItems: 'center', justifyContent: 'center', gap: 2 },
  label: { fontSize: 11, letterSpacing: -0.1, marginTop: 1 },
});
