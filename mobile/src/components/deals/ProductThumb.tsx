import React from 'react';
import { Image, View } from 'react-native';
import Svg, { Path, Circle, Rect } from 'react-native-svg';
import { Icon } from '../common/Icon';
import { useDealsTheme } from './dealsTheme';

interface Props {
  imageUrl?: string;
  /** Selects one of six food-shape archetypes (tomato, milk, cheese, meat, bottle, pizza). */
  seed?: number;
  tint?: string;
  size?: number;
  /** Renders the "no image" fallback tile (dashed border + tag icon). */
  broken?: boolean;
  radius?: number;
}

/**
 * A believable product thumbnail without real imagery. We render simple shape
 * compositions on a warm tinted tile — the deals feed still reads as "food"
 * while backend imageUrls remain null. Mirrors the design prototype's
 * ProductThumb so the card anatomy stays pixel-consistent.
 */
export function ProductThumb({
  imageUrl,
  seed = 0,
  tint = '#F4D8A8',
  size = 88,
  broken = false,
  radius = 10,
}: Props) {
  const { colors, dark } = useDealsTheme();
  // Track which URL failed (not just a boolean) so recycled FlatList cells with
  // a new imageUrl don't inherit a stale "failed" state.
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);

  const hasImage = Boolean(imageUrl);
  const imageFailed = hasImage && failedUrl === imageUrl;

  // 1) Real image always wins, while it loads fine.
  if (hasImage && !imageFailed && !broken) {
    return (
      <Image
        source={{ uri: imageUrl }}
        onError={() => setFailedUrl(imageUrl ?? null)}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: colors.surface,
        }}
        resizeMode="cover"
      />
    );
  }

  // 2) Dashed "broken" tile ONLY when an image existed but failed to load, or
  //    when broken is explicitly requested. A simple "no imageUrl" never lands
  //    here — it falls through to the food-shape placeholder below.
  if (broken || imageFailed) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: colors.border,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="tag" size={Math.round(size * 0.25)} color={colors.textTertiary} />
      </View>
    );
  }

  // 3) No image at all → the warm food-shape placeholder.
  const inset = Math.round(size * 0.07);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        overflow: 'hidden',
        // RN can't do CSS gradients without a lib; a flat tinted fill is the
        // closest believable stand-in and keeps the dependency surface small.
        backgroundColor: dark ? `${tint}22` : `${tint}cc`,
      }}
    >
      <View style={{ position: 'absolute', top: inset, left: inset, right: inset, bottom: inset }}>
        <Shape seed={seed} />
      </View>
    </View>
  );
}

function Shape({ seed }: { seed: number }) {
  switch (((seed % 6) + 6) % 6) {
    case 0: // tomato / fruit cluster
      return (
        <Svg viewBox="0 0 80 80" width="100%" height="100%">
          <Circle cx="30" cy="48" r="18" fill="#D3603F" />
          <Circle cx="52" cy="46" r="14" fill="#E07B57" />
          <Path
            d="M28 32c0-6 4-10 8-8M50 34c-1-5 2-9 6-8"
            stroke="#3A7A3A"
            strokeWidth={3}
            strokeLinecap="round"
            fill="none"
          />
        </Svg>
      );
    case 1: // milk carton
      return (
        <Svg viewBox="0 0 80 80" width="100%" height="100%">
          <Path
            d="M28 22h24l6 8v32a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4V30z"
            fill="#FAFAFA"
            stroke="#D8D8D8"
            strokeWidth={1.5}
          />
          <Rect x="30" y="42" width="20" height="14" fill="#1F8AC9" rx="1" />
          <Path d="M30 22h24" stroke="#D8D8D8" strokeWidth={1.5} />
        </Svg>
      );
    case 2: // cheese wedge
      return (
        <Svg viewBox="0 0 80 80" width="100%" height="100%">
          <Path d="M14 58L62 24l10 8v22H14z" fill="#F4C95D" />
          <Circle cx="36" cy="48" r="3" fill="#E6A93C" />
          <Circle cx="50" cy="42" r="2.5" fill="#E6A93C" />
          <Circle cx="28" cy="52" r="2" fill="#E6A93C" />
        </Svg>
      );
    case 3: // meat steak
      return (
        <Svg viewBox="0 0 80 80" width="100%" height="100%">
          <Path
            d="M18 36c2-12 14-18 26-16s20 12 18 24s-14 18-26 16s-20-12-18-24z"
            fill="#C24B36"
          />
          <Path
            d="M28 38c4-4 14-4 18 0M32 50c4-2 12-2 16 2"
            stroke="#7A2A1F"
            strokeWidth={1.8}
            fill="none"
            strokeLinecap="round"
          />
        </Svg>
      );
    case 4: // bottle / drink
      return (
        <Svg viewBox="0 0 80 80" width="100%" height="100%">
          <Path
            d="M34 14h12v8l4 6v34a4 4 0 0 1-4 4H34a4 4 0 0 1-4-4V28l4-6z"
            fill="#3A8B5A"
          />
          <Rect x="32" y="40" width="16" height="10" fill="#FAFAFA" />
          <Rect x="36" y="14" width="8" height="4" fill="#2A6B43" rx="1" />
        </Svg>
      );
    default: // pizza / frozen meal
      return (
        <Svg viewBox="0 0 80 80" width="100%" height="100%">
          <Circle cx="40" cy="40" r="28" fill="#F4D08C" />
          <Circle cx="40" cy="40" r="22" fill="#D86A45" />
          <Circle cx="32" cy="35" r="3" fill="#F4D08C" />
          <Circle cx="46" cy="42" r="2.5" fill="#F4D08C" />
          <Circle cx="38" cy="48" r="2" fill="#F4D08C" />
          <Circle cx="44" cy="32" r="2" fill="#3A7A3A" />
          <Circle cx="34" cy="46" r="2" fill="#3A7A3A" />
        </Svg>
      );
  }
}

/** Deterministic shape seed from a deal id/name so the same product is stable. */
export function thumbSeed(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

const TINTS = ['#F1BFA8', '#EFF1F5', '#F6E2A6', '#F1A6A2', '#CDE0B6', '#F4D08C', '#3A8B5A'];
export function thumbTint(key: string): string {
  return TINTS[thumbSeed(key) % TINTS.length];
}
