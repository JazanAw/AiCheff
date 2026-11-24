import React from 'react';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  Path,
  Polygon,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

export type IllustrationKey =
  | 'schnitzel'
  | 'spaetzle'
  | 'pasta'
  | 'soup'
  | 'bowl'
  | 'risotto';

export interface IllustrationPalette {
  bg1: string;
  bg2: string;
  plate: string;
  accent: string;
}

const PALETTES: Record<IllustrationKey, IllustrationPalette> = {
  schnitzel: { bg1: '#F4D8A8', bg2: '#E8B66B', plate: '#FBF3E2', accent: '#7B4A20' },
  spaetzle:  { bg1: '#F6E2A6', bg2: '#D8B25A', plate: '#FBF3E2', accent: '#6B4A14' },
  pasta:     { bg1: '#F1BFA8', bg2: '#D3603F', plate: '#FBF3E2', accent: '#7A1F0F' },
  soup:      { bg1: '#E8C195', bg2: '#A86B3E', plate: '#FBF3E2', accent: '#4A2A14' },
  bowl:      { bg1: '#CDE0B6', bg2: '#6E8F4D', plate: '#FBF3E2', accent: '#2E4516' },
  risotto:   { bg1: '#E9D5A9', bg2: '#A78250', plate: '#FBF3E2', accent: '#48311A' },
};

const ALL_KEYS: IllustrationKey[] = ['schnitzel', 'spaetzle', 'pasta', 'soup', 'bowl', 'risotto'];

/**
 * Pick a deterministic illustration for any recipe.
 * Uses a simple hash of recipe id so the same recipe always renders the same illustration.
 */
export function illustrationKeyForRecipe(id: string): IllustrationKey {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return ALL_KEYS[Math.abs(hash) % ALL_KEYS.length];
}

export function paletteForKey(key: IllustrationKey): IllustrationPalette {
  return PALETTES[key];
}

interface BackdropProps {
  p: IllustrationPalette;
  uid: string;
}

function PlateBackdrop({ p, uid }: BackdropProps) {
  return (
    <>
      <Defs>
        <RadialGradient id={`bg-${uid}`} cx="50%" cy="35%" r="80%">
          <Stop offset="0%" stopColor={p.bg1} />
          <Stop offset="100%" stopColor={p.bg2} />
        </RadialGradient>
        <RadialGradient id={`plate-${uid}`} cx="40%" cy="35%" r="65%">
          <Stop offset="0%" stopColor="#FFFFFF" />
          <Stop offset="100%" stopColor={p.plate} />
        </RadialGradient>
        <RadialGradient id={`plateShadow-${uid}`} cx="50%" cy="50%" r="50%">
          <Stop offset="80%" stopColor="rgba(0,0,0,0.18)" />
          <Stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </RadialGradient>
      </Defs>
      <Rect width="400" height="500" fill={`url(#bg-${uid})`} />
      <Circle cx="60" cy="80" r="3" fill={p.accent} opacity={0.08} />
      <Circle cx="350" cy="120" r="4" fill={p.accent} opacity={0.1} />
      <Circle cx="40" cy="380" r="5" fill={p.accent} opacity={0.08} />
      <Circle cx="370" cy="440" r="3" fill={p.accent} opacity={0.08} />
      <Circle cx="200" cy="50" r="2" fill={p.accent} opacity={0.08} />
      <Ellipse cx="200" cy="260" rx="155" ry="148" fill={`url(#plateShadow-${uid})`} />
      <Circle cx="200" cy="250" r="150" fill={p.plate} stroke={p.accent} strokeOpacity={0.1} strokeWidth={1} />
      <Circle cx="200" cy="250" r="138" fill={`url(#plate-${uid})`} />
      <Path
        d="M 80 250 a 120 120 0 0 1 200 -80"
        stroke="#FFFFFF"
        strokeOpacity={0.45}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />
    </>
  );
}

function ParsleyDots({ cx, cy }: { cx: number; cy: number }) {
  const dots: Array<[number, number, number]> = [
    [cx - 12, cy - 4, 4],
    [cx + 6, cy - 10, 3.5],
    [cx + 14, cy + 4, 4.5],
    [cx - 4, cy + 10, 3],
    [cx + 0, cy - 2, 3.5],
  ];
  return (
    <>
      {dots.map(([x, y, r], i) => (
        <Circle key={i} cx={x} cy={y} r={r} fill="#3F6B25" />
      ))}
    </>
  );
}

function SchnitzelIllu({ p, uid }: { p: IllustrationPalette; uid: string }) {
  return (
    <>
      <PlateBackdrop p={p} uid={uid} />
      <Ellipse cx="200" cy="230" rx="110" ry="78" fill="#C9924E" />
      <Ellipse cx="200" cy="228" rx="108" ry="76" fill="#D9A465" />
      <Ellipse cx="200" cy="226" rx="104" ry="72" fill="#E2B074" />
      {Array.from({ length: 38 }).map((_, i) => {
        const a = (i * 73) % 360;
        const r = 25 + ((i * 17) % 60);
        const x = 200 + Math.cos((a * Math.PI) / 180) * r;
        const y = 226 + Math.sin((a * Math.PI) / 180) * r * 0.7;
        return <Circle key={i} cx={x} cy={y} r={1.4 + ((i * 3) % 3) * 0.6} fill="#7C4A1D" opacity={0.5} />;
      })}
      <Ellipse cx="170" cy="200" rx="38" ry="14" fill="#F2C98E" opacity={0.55} />
      <G transform="translate(295 280) rotate(-30)">
        <Path d="M 0 0 L 40 -22 A 46 46 0 0 1 40 22 Z" fill="#F5D34A" />
        <Path d="M 4 2 L 38 -18 A 38 38 0 0 1 38 18 Z" fill="#FAE585" />
        <Path d="M 8 0 L 36 -14 M 8 0 L 36 14 M 8 0 L 38 0" stroke="#E6BC2F" strokeWidth={1.5} />
      </G>
      <G transform="translate(105 320)">
        <Ellipse cx="0" cy="0" rx="44" ry="22" fill="#E7C763" />
        <Circle cx="-18" cy="-8" r="10" fill="#F0D584" />
        <Circle cx="-2" cy="-12" r="11" fill="#EDD074" />
        <Circle cx="16" cy="-9" r="9" fill="#F0D584" />
        <Circle cx="-10" cy="-2" r="8" fill="#F4DC93" />
        <Circle cx="10" cy="0" r="8" fill="#F4DC93" />
        <Rect x="-15" y="-15" width="6" height="1.5" fill="#3F6B25" />
        <Rect x="6" y="-3" width="7" height="1.5" fill="#3F6B25" />
        <Rect x="-4" y="2" width="5" height="1.5" fill="#3F6B25" />
      </G>
      <ParsleyDots cx={240} cy={170} />
    </>
  );
}

function SpaetzleIllu({ p, uid }: { p: IllustrationPalette; uid: string }) {
  const blobs: Array<[number, number, number]> = [
    [-70, -30, 0], [-40, -50, 12], [-10, -45, -8], [25, -55, 20], [55, -30, -10],
    [-80, 0, -5], [-50, 10, 15], [-15, 5, -10], [20, 0, 8], [60, 10, -18],
    [-65, 35, 5], [-30, 45, -12], [10, 50, 18], [45, 40, -5], [-5, 25, 22],
    [70, -5, 12], [-20, -20, -22],
  ];
  const onions: Array<[number, number]> = [
    [-30, -15], [10, -25], [-50, 20], [30, 30], [50, -5], [-10, 35],
  ];
  return (
    <>
      <PlateBackdrop p={p} uid={uid} />
      <G transform="translate(200 250)">
        <Ellipse cx="0" cy="0" rx="110" ry="92" fill="#F6D77A" />
        <Ellipse cx="0" cy="-5" rx="105" ry="84" fill="#FBE497" />
        {blobs.map(([x, y, rot], i) => (
          <G key={i} transform={`translate(${x} ${y}) rotate(${rot})`}>
            <Path d="M -16 0 q 6 -8 12 0 q 6 8 12 0 q 6 -8 12 0" stroke="#D8A640" strokeWidth={6} fill="none" strokeLinecap="round" />
            <Path d="M -16 -1 q 6 -8 12 0 q 6 8 12 0 q 6 -8 12 0" stroke="#F2CD75" strokeWidth={3} fill="none" strokeLinecap="round" />
          </G>
        ))}
        <Ellipse cx="-20" cy="-20" rx="35" ry="14" fill="#FFF1B8" opacity={0.6} />
        {onions.map(([x, y], i) => (
          <G key={i} transform={`translate(${x} ${y}) rotate(${(i * 37) % 180})`}>
            <Path d="M -12 0 q 6 -3 12 0 q 6 3 12 0" stroke="#8B4A18" strokeWidth={3.5} fill="none" strokeLinecap="round" />
            <Path d="M -12 -0.5 q 6 -3 12 0 q 6 3 12 0" stroke="#C0712A" strokeWidth={1.8} fill="none" strokeLinecap="round" />
          </G>
        ))}
        <Rect x="-25" y="-40" width="6" height="1.6" fill="#3F6B25" />
        <Rect x="20" y="35" width="7" height="1.6" fill="#3F6B25" />
        <Rect x="-50" y="-5" width="5" height="1.6" fill="#3F6B25" />
        <Rect x="45" y="15" width="6" height="1.6" fill="#3F6B25" />
      </G>
    </>
  );
}

function PastaIllu({ p, uid }: { p: IllustrationPalette; uid: string }) {
  return (
    <>
      <PlateBackdrop p={p} uid={uid} />
      <G transform="translate(200 250)">
        {Array.from({ length: 14 }).map((_, i) => {
          const r = 38 + i * 4;
          const offset = (i * 23) % 360;
          return (
            <Ellipse
              key={`s-${i}`}
              cx="0"
              cy="0"
              rx={r}
              ry={r * 0.78}
              fill="none"
              stroke="#E8B26B"
              strokeWidth={3}
              strokeDasharray={`${40 + (i * 7) % 80} ${10 + (i * 11) % 30}`}
              strokeDashoffset={offset}
              opacity={0.9}
              transform={`rotate(${(i * 11) % 60})`}
            />
          );
        })}
        {Array.from({ length: 10 }).map((_, i) => {
          const r = 50 + i * 4;
          return (
            <Ellipse
              key={`hl-${i}`}
              cx="0"
              cy="-3"
              rx={r}
              ry={r * 0.78}
              fill="none"
              stroke="#F8D9A3"
              strokeWidth={1.2}
              strokeDasharray="20 25"
              strokeDashoffset={i * 13}
              opacity={0.7}
            />
          );
        })}
        <Ellipse cx="0" cy="-5" rx="42" ry="28" fill="#B5301A" />
        <Ellipse cx="-4" cy="-9" rx="36" ry="22" fill="#D24B2F" />
        <Ellipse cx="-8" cy="-12" rx="14" ry="8" fill="#E76A4A" opacity={0.7} />
        <G transform="translate(8 -8) rotate(20)">
          <Ellipse cx="0" cy="0" rx="14" ry="7" fill="#3F6B25" />
          <Ellipse cx="0" cy="0" rx="13" ry="6" fill="#4F8230" />
          <Line x1="-14" y1="0" x2="14" y2="0" stroke="#2E4E1A" strokeWidth={0.8} />
        </G>
        <G transform="translate(-14 8) rotate(-30)">
          <Ellipse cx="0" cy="0" rx="11" ry="5" fill="#3F6B25" />
          <Ellipse cx="0" cy="0" rx="10" ry="4" fill="#4F8230" />
        </G>
        <Polygon points="-30,-18 -22,-22 -20,-14" fill="#F6E8B6" />
        <Polygon points="28,-15 36,-19 34,-10" fill="#F6E8B6" />
        <Polygon points="-18,18 -10,15 -12,22" fill="#F6E8B6" />
      </G>
    </>
  );
}

function SoupIllu({ p, uid }: { p: IllustrationPalette; uid: string }) {
  const sausages: Array<[number, number, number]> = [
    [165, 215, 14], [240, 235, 12], [195, 285, 13], [155, 270, 10],
  ];
  return (
    <>
      <PlateBackdrop p={p} uid={uid} />
      <Circle cx="200" cy="250" r="138" fill={p.plate} />
      <Circle cx="200" cy="250" r="120" fill="#B9743A" />
      <Circle cx="200" cy="250" r="115" fill="#A86B3E" />
      {Array.from({ length: 90 }).map((_, i) => {
        const a = (i * 47) % 360;
        const r = 8 + ((i * 19) % 100);
        const x = 200 + Math.cos((a * Math.PI) / 180) * r;
        const y = 250 + Math.sin((a * Math.PI) / 180) * r;
        return <Ellipse key={i} cx={x} cy={y} rx="3" ry="2.4" fill="#6F3D17" opacity={0.55} />;
      })}
      {sausages.map(([x, y, r], i) => (
        <G key={i}>
          <Circle cx={x} cy={y} r={r} fill="#C95B5B" />
          <Circle cx={x} cy={y} r={r - 2} fill="#E07878" />
          <Circle cx={x} cy={y} r={r - 5} fill="#EE9090" opacity={0.6} />
        </G>
      ))}
      <Rect x="220" y="200" width="14" height="10" rx="2" fill="#F0D584" transform="rotate(20 227 205)" />
      <Rect x="178" y="290" width="12" height="9" rx="2" fill="#F0D584" transform="rotate(-15 184 295)" />
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i * 67) % 360;
        const r = 30 + ((i * 23) % 70);
        const x = 200 + Math.cos((a * Math.PI) / 180) * r;
        const y = 250 + Math.sin((a * Math.PI) / 180) * r;
        return <Rect key={i} x={x} y={y} width="5" height="1.6" fill="#3F6B25" transform={`rotate(${a} ${x} ${y})`} />;
      })}
      <G opacity={0.5}>
        <Path d="M 170 130 q 8 -10 0 -20 q -8 -10 0 -20" stroke="#FFFFFF" strokeWidth={3} fill="none" strokeLinecap="round" />
        <Path d="M 200 120 q 8 -10 0 -20 q -8 -10 0 -20" stroke="#FFFFFF" strokeWidth={3} fill="none" strokeLinecap="round" />
        <Path d="M 230 130 q 8 -10 0 -20 q -8 -10 0 -20" stroke="#FFFFFF" strokeWidth={3} fill="none" strokeLinecap="round" />
      </G>
    </>
  );
}

function BowlIllu({ p, uid }: { p: IllustrationPalette; uid: string }) {
  const beetChunks: Array<[number, number, number, number, number, number, string]> = [
    [115, 180, 22, 22, 3, 15, '#7E1F38'],
    [140, 195, 20, 20, 3, -10, '#9A2A48'],
    [155, 175, 18, 18, 3, 25, '#7E1F38'],
  ];
  const falafels: Array<[number, number]> = [[170, 300], [195, 312], [220, 300], [245, 310]];
  const cucumbers: Array<[number, number]> = [[140, 285], [155, 300], [130, 305]];
  return (
    <>
      <PlateBackdrop p={p} uid={uid} />
      <Circle cx="200" cy="250" r="138" fill={p.plate} />
      <Circle cx="200" cy="250" r="128" fill="#F2E7CB" />
      <Path d="M 200 250 m -120 0 a 120 120 0 0 1 240 0 Z" fill="#E8C77A" opacity={0.4} />
      {Array.from({ length: 60 }).map((_, i) => {
        const x = 110 + (i % 12) * 16;
        const y = 175 + Math.floor(i / 12) * 12;
        return <Circle key={i} cx={x + ((i * 3) % 4)} cy={y} r="1.8" fill="#D4A746" opacity={0.7} />;
      })}
      {beetChunks.map(([x, y, w, h, rx, rot, color], i) => (
        <Rect key={i} x={x} y={y} width={w} height={h} rx={rx} fill={color} transform={`rotate(${rot} ${x + w/2} ${y + h/2})`} />
      ))}
      <Ellipse cx="265" cy="200" rx="34" ry="20" fill="#E8D5A0" />
      <Ellipse cx="265" cy="198" rx="30" ry="16" fill="#F2E0B0" />
      <Circle cx="258" cy="194" r="2" fill="#C25A1F" />
      <Circle cx="270" cy="200" r="1.6" fill="#C25A1F" />
      <Circle cx="262" cy="204" r="1.6" fill="#C25A1F" />
      {falafels.map(([x, y], i) => (
        <G key={i}>
          <Circle cx={x} cy={y} r={13} fill="#5A3F1A" />
          <Circle cx={x} cy={y} r={12} fill="#7A571F" />
          <Circle cx={x - 3} cy={y - 3} r={3} fill="#A07840" opacity={0.6} />
        </G>
      ))}
      {cucumbers.map(([x, y], i) => (
        <G key={i}>
          <Circle cx={x} cy={y} r={9} fill="#A8C778" />
          <Circle cx={x} cy={y} r={7} fill="#C0D89A" />
          <Circle cx={x} cy={y} r={2} fill="#86A85E" />
        </G>
      ))}
      <ParsleyDots cx={210} cy={232} />
      <G transform="translate(285 290)">
        <Circle cx="0" cy="0" r="14" fill="#F5D34A" />
        <Circle cx="0" cy="0" r="11" fill="#FAE585" />
        <Path d="M 0 0 L 0 -11 M 0 0 L 10 5 M 0 0 L -10 5 M 0 0 L 9 -7 M 0 0 L -9 -7" stroke="#E6BC2F" strokeWidth={1.2} />
      </G>
    </>
  );
}

function RisottoIllu({ p, uid }: { p: IllustrationPalette; uid: string }) {
  const mushrooms: Array<[number, number, number]> = [
    [-30, -20, 0], [10, -30, 25], [35, 5, -15], [-20, 15, 30], [20, 30, 10], [-40, 25, -20],
  ];
  return (
    <>
      <PlateBackdrop p={p} uid={uid} />
      <G transform="translate(200 250)">
        <Ellipse cx="0" cy="0" rx="115" ry="95" fill="#F0DDA8" />
        <Ellipse cx="-5" cy="-5" rx="108" ry="88" fill="#F8E8BD" />
        {Array.from({ length: 110 }).map((_, i) => {
          const a = (i * 53) % 360;
          const r = ((i * 17) % 90);
          const x = Math.cos((a * Math.PI) / 180) * r;
          const y = Math.sin((a * Math.PI) / 180) * r * 0.85;
          return <Ellipse key={i} cx={x} cy={y} rx="2.2" ry="1.4" fill="#E2C481" opacity={0.7} transform={`rotate(${a} ${x} ${y})`} />;
        })}
        {mushrooms.map(([x, y, rot], i) => (
          <G key={i} transform={`translate(${x} ${y}) rotate(${rot})`}>
            <Ellipse cx="0" cy="2" rx="18" ry="10" fill="#5A3A18" />
            <Ellipse cx="0" cy="0" rx="17" ry="9" fill="#7C5226" />
            <Ellipse cx="-2" cy="-2" rx="14" ry="6" fill="#A07640" opacity={0.6} />
            <Path d="M -12 1 L 12 1" stroke="#3D2510" strokeWidth={0.7} />
          </G>
        ))}
        <Polygon points="-50,-30 -38,-36 -32,-24" fill="#F6E8B6" stroke="#D9C078" strokeWidth={0.6} />
        <Polygon points="40,-25 52,-32 52,-18" fill="#F6E8B6" stroke="#D9C078" strokeWidth={0.6} />
        <Polygon points="-5,38 8,36 4,46" fill="#F6E8B6" stroke="#D9C078" strokeWidth={0.6} />
        <G transform="translate(45 -45) rotate(40)">
          <Line x1="0" y1="0" x2="30" y2="0" stroke="#3F5424" strokeWidth={1.4} />
          {[5, 11, 17, 23, 29].map((x, i) => (
            <Ellipse key={i} cx={x} cy={i % 2 === 0 ? -3 : 3} rx="2.5" ry="1.4" fill="#5C7C36" />
          ))}
        </G>
        <G transform="translate(-50 35) rotate(-25)">
          <Line x1="0" y1="0" x2="25" y2="0" stroke="#3F5424" strokeWidth={1.4} />
          {[5, 11, 17, 23].map((x, i) => (
            <Ellipse key={i} cx={x} cy={i % 2 === 0 ? -3 : 3} rx="2.5" ry="1.4" fill="#5C7C36" />
          ))}
        </G>
        {Array.from({ length: 12 }).map((_, i) => {
          const a = (i * 87) % 360;
          const r = 20 + ((i * 13) % 50);
          const x = Math.cos((a * Math.PI) / 180) * r;
          const y = Math.sin((a * Math.PI) / 180) * r * 0.85;
          return <Circle key={i} cx={x} cy={y} r="1.2" fill="#1F1208" />;
        })}
      </G>
    </>
  );
}

interface Props {
  recipeId: string;
  illuKey?: IllustrationKey;
  width?: number | string;
  height?: number | string;
}

export function RecipeIllustration({ recipeId, illuKey, width = '100%', height = '100%' }: Props) {
  const key = illuKey ?? illustrationKeyForRecipe(recipeId);
  const p = PALETTES[key];
  const uid = `${key}-${recipeId.replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <Svg width={width} height={height} viewBox="0 0 400 500" preserveAspectRatio="xMidYMid slice">
      {key === 'schnitzel' && <SchnitzelIllu p={p} uid={uid} />}
      {key === 'spaetzle' && <SpaetzleIllu p={p} uid={uid} />}
      {key === 'pasta' && <PastaIllu p={p} uid={uid} />}
      {key === 'soup' && <SoupIllu p={p} uid={uid} />}
      {key === 'bowl' && <BowlIllu p={p} uid={uid} />}
      {key === 'risotto' && <RisottoIllu p={p} uid={uid} />}
    </Svg>
  );
}
