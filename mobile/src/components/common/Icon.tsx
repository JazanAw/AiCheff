import React from 'react';
import Svg, { Path, Circle, Rect } from 'react-native-svg';

export type IconName =
  | 'swipe'
  | 'plan'
  | 'cart'
  | 'pantry'
  | 'trends'
  | 'profile'
  | 'close'
  | 'heart'
  | 'ban'
  | 'star'
  | 'clock'
  | 'flame'
  | 'droplet'
  | 'trash'
  | 'cheffity-hat'
  | 'arrow-left'
  | 'plus'
  | 'minus'
  | 'tag'
  | 'sparkle'
  | 'check'
  | 'chevron-right'
  | 'comment'
  | 'flash'
  | 'trend-up'
  | 'info'
  | 'lock'
  | 'cart-plus'
  | 'pin'
  | 'leaf'
  | 'search'
  | 'sliders'
  | 'chevron-down'
  | 'swap'
  | 'refresh'
  | 'alert';

interface Props {
  name: IconName;
  size?: number;
  color?: string;
  active?: boolean;
  strokeWidth?: number;
}

export function Icon({ name, size = 24, color = '#000', active = false, strokeWidth = 1.8 }: Props) {
  const fill = active ? color : 'none';
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
  };
  const strokeProps = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (name) {
    case 'swipe':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M6 12c-1.5-0.5-2.5-2-2.5-3.5C3.5 6 5.5 4 8 4c0.5-1.2 1.8-2 3.5-2C13.2 2 14.5 2.8 15 4c2.5 0 4.5 2 4.5 4.5c0 1.5-1 3-2.5 3.5"
            fill={active ? color : 'none'}
            fillOpacity={active ? 0.18 : 0}
          />
          <Path
            {...strokeProps}
            d="M6 12h12v8c0 0.8-0.7 1.5-1.5 1.5h-9c-0.8 0-1.5-0.7-1.5-1.5z"
            fill={fill}
            fillOpacity={active ? 0.5 : 0}
          />
          <Path {...strokeProps} d="M9 16v3M12 16v3M15 16v3" />
        </Svg>
      );
    case 'plan':
      return (
        <Svg {...props}>
          <Rect
            x="3.5"
            y="5"
            width="17"
            height="15.5"
            rx="2.5"
            {...strokeProps}
            fill={fill}
            fillOpacity={active ? 0.18 : 0}
          />
          <Path {...strokeProps} d="M3.5 9.5h17" />
          <Path {...strokeProps} d="M8 3v4M16 3v4" />
          <Circle cx="8" cy="14" r="1" fill={color} opacity={active ? 1 : 0.6} />
          <Circle cx="12" cy="14" r="1" fill={color} opacity={active ? 1 : 0.6} />
          <Circle cx="16" cy="14" r="1" fill={color} opacity={active ? 1 : 0.6} />
        </Svg>
      );
    case 'cart':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M3 4h2.5l2.5 11.5c0.2 0.9 1 1.5 1.9 1.5h7.6c0.9 0 1.7-0.6 1.9-1.5l1.6-6.5h-13"
            fill={fill}
            fillOpacity={active ? 0.18 : 0}
          />
          <Circle cx="10" cy="20" r="1.5" {...strokeProps} fill={fill} fillOpacity={active ? 1 : 0} />
          <Circle cx="17" cy="20" r="1.5" {...strokeProps} fill={fill} fillOpacity={active ? 1 : 0} />
        </Svg>
      );
    case 'pantry':
      return (
        <Svg {...props}>
          <Rect
            x="5.5"
            y="3"
            width="13"
            height="3"
            rx="1.2"
            {...strokeProps}
            fill={fill}
            fillOpacity={active ? 0.3 : 0}
          />
          <Path
            {...strokeProps}
            d="M6 6.5h12v13.5c0 0.8-0.7 1.5-1.5 1.5h-9c-0.8 0-1.5-0.7-1.5-1.5z"
            fill={fill}
            fillOpacity={active ? 0.18 : 0}
          />
          <Path {...strokeProps} d="M6 12h12" opacity={0.6} />
          <Path {...strokeProps} d="M9.5 15.5l1.5 1.5l3.5-3.5" opacity={active ? 1 : 0.7} />
        </Svg>
      );
    case 'trends':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M3 17l5-6l4 3l3-4l6 4" />
          <Circle cx="3" cy="17" r="1.2" fill={color} />
          <Circle cx="8" cy="11" r="1.2" fill={color} />
          <Circle cx="12" cy="14" r="1.2" fill={color} />
          <Circle cx="15" cy="10" r="1.2" fill={color} />
          <Circle cx="21" cy="14" r="1.6" fill={active ? color : '#fff'} stroke={color} strokeWidth={strokeWidth} />
        </Svg>
      );
    case 'profile':
      return (
        <Svg {...props}>
          <Circle cx="12" cy="9" r="3.5" {...strokeProps} fill={fill} fillOpacity={active ? 0.18 : 0} />
          <Path
            {...strokeProps}
            d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6"
            fill={fill}
            fillOpacity={active ? 0.18 : 0}
          />
        </Svg>
      );
    case 'close':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M6 6l12 12M18 6L6 18" />
        </Svg>
      );
    case 'heart':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M12 20.5s-7.5-4.7-7.5-10.2A4.3 4.3 0 0 1 12 7.5a4.3 4.3 0 0 1 7.5 2.8c0 5.5-7.5 10.2-7.5 10.2z"
            fill={fill}
            fillOpacity={active ? 1 : 0}
          />
        </Svg>
      );
    case 'ban':
      return (
        <Svg {...props}>
          <Circle cx="12" cy="12" r="9" {...strokeProps} />
          <Path {...strokeProps} d="M5.5 5.5l13 13" />
        </Svg>
      );
    case 'star':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M12 3.5l2.7 5.5l6 0.9l-4.4 4.3l1 6L12 17.5L6.7 20.2l1-6L3.3 9.9l6-0.9z"
            fill={fill}
            fillOpacity={active ? 1 : 0}
          />
        </Svg>
      );
    case 'clock':
      return (
        <Svg {...props}>
          <Circle cx="12" cy="12" r="8.5" {...strokeProps} />
          <Path {...strokeProps} d="M12 7.5v4.5l3 2" />
        </Svg>
      );
    case 'flame':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M12 21c-3.5 0-6-2.4-6-5.5c0-2 1.2-3.2 2-4.2c0.6 1.5 1.8 1.8 1.8 1.8c-0.5-2.5 0-5 4.2-7.5c0 2.5 1.5 3.5 2.5 5c1 1.5 1.5 3 1.5 4.9C18 18.6 15.5 21 12 21z"
            fill={fill}
            fillOpacity={active ? 1 : 0}
          />
        </Svg>
      );
    case 'droplet':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M12 3c0 0 6 6.2 6 10.2A6 6 0 0 1 6 13.2C6 9.2 12 3 12 3z"
            fill={fill}
            fillOpacity={active ? 1 : 0}
          />
        </Svg>
      );
    case 'trash':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7m4 4v6m4-6v6" />
        </Svg>
      );
    case 'cheffity-hat':
      return (
        <Svg {...props}>
          <Path
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 13c-1.6-0.6-2.8-2.2-2.8-4C2.2 6.6 4.2 4.5 6.7 4.5c0.6-1.5 2.2-2.5 4.3-2.5s3.7 1 4.3 2.5c2.5 0 4.5 2.1 4.5 4.5c0 1.8-1.2 3.4-2.8 4"
            fill={fill}
            fillOpacity={active ? 0.2 : 0}
          />
          <Path
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 13h14v7c0 0.8-0.7 1.5-1.5 1.5h-11c-0.8 0-1.5-0.7-1.5-1.5z"
            fill={fill}
            fillOpacity={active ? 0.5 : 0}
          />
        </Svg>
      );
    case 'arrow-left':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M15 5l-7 7l7 7" />
        </Svg>
      );
    case 'plus':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M12 5v14M5 12h14" />
        </Svg>
      );
    case 'minus':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M5 12h14" />
        </Svg>
      );
    case 'tag':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M3 12V4h8l10 10l-8 8z"
            fill={fill}
            fillOpacity={active ? 0.18 : 0}
          />
          <Circle cx="7.5" cy="7.5" r="1.4" fill={color} />
        </Svg>
      );
    case 'sparkle':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"
            fill={fill}
            fillOpacity={active ? 1 : 0}
          />
          <Path d="M18 16l0.7 1.7L20.5 18.5l-1.7 0.7L18 21l-0.8-1.7L15.5 18.5l1.7-0.8z" fill={color} />
        </Svg>
      );
    case 'check':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M5 12.5l4 4l10-10" />
        </Svg>
      );
    case 'chevron-right':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M9 6l6 6l-6 6" />
        </Svg>
      );
    case 'comment':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M4 5h16v11h-9l-4 4v-4H4z"
            fill={fill}
            fillOpacity={active ? 0.18 : 0}
          />
        </Svg>
      );
    case 'flash':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M13 2L4.5 13.5H11l-1 8.5L18.5 10H12z"
            fill={fill}
            fillOpacity={active ? 1 : 0}
          />
        </Svg>
      );
    case 'trend-up':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M3 17l6-6 4 4 7.5-7.5" />
          <Path {...strokeProps} d="M16 7.5h4.5V12" />
        </Svg>
      );
    case 'info':
      return (
        <Svg {...props}>
          <Circle cx="12" cy="12" r="9" {...strokeProps} fill={fill} fillOpacity={active ? 0.18 : 0} />
          <Path {...strokeProps} d="M12 11v5" />
          <Circle cx="12" cy="7.8" r="0.6" fill={color} stroke={color} strokeWidth={1} />
        </Svg>
      );
    case 'lock':
      return (
        <Svg {...props}>
          <Rect x="5" y="11" width="14" height="9.5" rx="2" {...strokeProps} fill={fill} fillOpacity={active ? 0.18 : 0} />
          <Path {...strokeProps} d="M8 11V8a4 4 0 0 1 8 0v3" />
          <Circle cx="12" cy="15.5" r="1.1" fill={color} />
        </Svg>
      );
    case 'cart-plus':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M3 4h2.2l2.3 11c0.2 0.9 1 1.5 1.9 1.5h7.2c0.9 0 1.7-0.6 1.9-1.5l1.3-5.5"
            fill={fill}
            fillOpacity={active ? 0.18 : 0}
          />
          <Circle cx="10" cy="20" r="1.4" {...strokeProps} fill={fill} fillOpacity={active ? 1 : 0} />
          <Circle cx="17" cy="20" r="1.4" {...strokeProps} fill={fill} fillOpacity={active ? 1 : 0} />
          <Path {...strokeProps} d="M16.5 3v5M14 5.5h5" />
        </Svg>
      );
    case 'pin':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M12 21c4-4 6.5-7.2 6.5-10.5A6.5 6.5 0 0 0 5.5 10.5C5.5 13.8 8 17 12 21z"
            fill={fill}
            fillOpacity={active ? 0.18 : 0}
          />
          <Circle cx="12" cy="10.3" r="2.4" {...strokeProps} fill={active ? '#fff' : 'none'} />
        </Svg>
      );
    case 'leaf':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M5 19c-1-7 4-13 14-13 0 9-5 13-11 13-1.5 0-3-0.5-3-0.5z"
            fill={fill}
            fillOpacity={active ? 0.18 : 0}
          />
          <Path {...strokeProps} d="M5 19c4-4 7-6 11-7" />
        </Svg>
      );
    case 'search':
      return (
        <Svg {...props}>
          <Circle cx="11" cy="11" r="7" {...strokeProps} fill={fill} fillOpacity={active ? 0.18 : 0} />
          <Path {...strokeProps} d="M16.5 16.5L21 21" />
        </Svg>
      );
    case 'sliders':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M3 7h12M19 7h2M3 17h2M9 17h12" />
          <Circle cx="17" cy="7" r="2.4" {...strokeProps} fill={fill} fillOpacity={active ? 1 : 0} />
          <Circle cx="7" cy="17" r="2.4" {...strokeProps} fill={fill} fillOpacity={active ? 1 : 0} />
        </Svg>
      );
    case 'chevron-down':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M6 9l6 6 6-6" />
        </Svg>
      );
    case 'swap':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M7 4L4 7l3 3" />
          <Path {...strokeProps} d="M4 7h13" />
          <Path {...strokeProps} d="M17 20l3-3-3-3" />
          <Path {...strokeProps} d="M20 17H7" />
        </Svg>
      );
    case 'refresh':
      return (
        <Svg {...props}>
          <Path {...strokeProps} d="M20 11a8 8 0 1 0-1.6 5.5" />
          <Path {...strokeProps} d="M20 4v6h-6" />
        </Svg>
      );
    case 'alert':
      return (
        <Svg {...props}>
          <Path
            {...strokeProps}
            d="M12 3.5L21 19H3z"
            fill={fill}
            fillOpacity={active ? 0.18 : 0}
          />
          <Path {...strokeProps} d="M12 9.5v4.5" />
          <Circle cx="12" cy="16.6" r="0.6" fill={color} stroke={color} strokeWidth={1} />
        </Svg>
      );
    default:
      return null;
  }
}
