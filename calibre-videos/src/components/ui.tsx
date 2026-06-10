import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from 'remotion';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';

/* ----------------------------------------------------------------------------
 * Kinetic headline — big Anton display text that springs in word-by-word.
 * The hook that stops the scroll in the first 2 seconds.
 * -------------------------------------------------------------------------- */
export const KineticHeadline: React.FC<{
  text: string;
  delay?: number;
  color?: string;
  highlight?: string;
  highlightColor?: string;
  fontSize?: number;
  align?: 'center' | 'left';
}> = ({
  text,
  delay = 0,
  color = COLORS.white,
  highlight,
  highlightColor = COLORS.red,
  fontSize = 110,
  align = 'center',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(' ');
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0 18px',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        fontFamily: FONT_FAMILY.display,
        fontSize,
        lineHeight: 1.0,
        textAlign: align,
        textTransform: 'uppercase',
        letterSpacing: 1,
        padding: '0 40px',
      }}
    >
      {words.map((w, i) => {
        const d = delay + i * 3;
        const s = spring({ frame: frame - d, fps, config: { damping: 200, mass: 0.5 } });
        const isHi = highlight && w.toLowerCase().replace(/[^a-z0-9]/g, '').includes(highlight.toLowerCase());
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              transform: `translateY(${interpolate(s, [0, 1], [70, 0])}px) scale(${interpolate(s, [0, 1], [0.7, 1])})`,
              opacity: interpolate(frame - d, [0, 6], [0, 1], { extrapolateRight: 'clamp' }),
              color: isHi ? highlightColor : color,
              textShadow: '0 6px 24px rgba(0,0,0,0.35)',
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

/* ----------------------------------------------------------------------------
 * TikTok-style auto caption — one phrase pops at a time, bold with a navy box.
 * -------------------------------------------------------------------------- */
export const PopCaption: React.FC<{
  text: string;
  delay?: number;
  bg?: string;
  color?: string;
  fontSize?: number;
}> = ({ text, delay = 0, bg = COLORS.navy, color = COLORS.white, fontSize = 58 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 14, mass: 0.6 } });
  return (
    <div
      style={{
        transform: `scale(${interpolate(s, [0, 1], [0.6, 1])})`,
        opacity: interpolate(frame - delay, [0, 5], [0, 1], { extrapolateRight: 'clamp' }),
        background: bg,
        color,
        fontFamily: FONT_FAMILY.body,
        fontWeight: 800,
        fontSize,
        lineHeight: 1.15,
        padding: '16px 30px',
        borderRadius: 18,
        boxShadow: '0 14px 40px rgba(0,0,0,0.35)',
        textAlign: 'center',
        maxWidth: 880,
      }}
    >
      {text}
    </div>
  );
};

/* ----------------------------------------------------------------------------
 * Star rating row.
 * -------------------------------------------------------------------------- */
export const Stars: React.FC<{ count?: number; size?: number; delay?: number; color?: string }> = ({
  count = 5,
  size = 64,
  delay = 0,
  color = COLORS.gold,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {Array.from({ length: count }).map((_, i) => {
        const s = spring({ frame: frame - delay - i * 4, fps, config: { damping: 12 } });
        return (
          <svg key={i} width={size} height={size} viewBox="0 0 24 24" style={{ transform: `scale(${s})` }}>
            <path
              fill={color}
              d="M12 2l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.77 6.1 20.17l1.13-6.57L2.45 8.94l6.6-.96z"
            />
          </svg>
        );
      })}
    </div>
  );
};

/* ----------------------------------------------------------------------------
 * Price tag — old price struck through, big Calibre price.
 * -------------------------------------------------------------------------- */
export const PriceTag: React.FC<{
  price: string;
  was?: string;
  delay?: number;
  label?: string;
}> = ({ price, was, delay = 0, label }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 12, mass: 0.7 } });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, transform: `scale(${s})` }}>
      {label && (
        <div
          style={{
            fontFamily: FONT_FAMILY.body,
            fontWeight: 800,
            fontSize: 30,
            letterSpacing: 4,
            color: COLORS.gold,
            textTransform: 'uppercase',
          }}
        >
          {label}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
        {was && (
          <span
            style={{
              fontFamily: FONT_FAMILY.body,
              fontWeight: 700,
              fontSize: 52,
              color: COLORS.steel,
              textDecoration: 'line-through',
            }}
          >
            {was}
          </span>
        )}
        <span style={{ fontFamily: FONT_FAMILY.display, fontSize: 150, color: COLORS.white, lineHeight: 1 }}>
          {price}
        </span>
      </div>
    </div>
  );
};

/* ----------------------------------------------------------------------------
 * Pill badge (e.g. "IN STOCK", "FREE UK DELIVERY", "12 MONTH WARRANTY").
 * -------------------------------------------------------------------------- */
export const Pill: React.FC<{
  text: string;
  delay?: number;
  bg?: string;
  color?: string;
  fontSize?: number;
}> = ({ text, delay = 0, bg = COLORS.green, color = COLORS.white, fontSize = 34 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 14 } });
  return (
    <div
      style={{
        transform: `scale(${s})`,
        background: bg,
        color,
        fontFamily: FONT_FAMILY.body,
        fontWeight: 800,
        fontSize,
        letterSpacing: 1,
        padding: '12px 28px',
        borderRadius: 100,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        boxShadow: '0 10px 26px rgba(0,0,0,0.25)',
      }}
    >
      {text}
    </div>
  );
};

/* ----------------------------------------------------------------------------
 * Circular "stamp" sticker — rotates slightly, great for offers/trust marks.
 * -------------------------------------------------------------------------- */
export const Stamp: React.FC<{ top: string; bottom?: string; delay?: number; bg?: string; size?: number }> = ({
  top,
  bottom,
  delay = 0,
  bg = COLORS.red,
  size = 250,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 10, mass: 0.8 } });
  const wobble = Math.sin((frame - delay) / 14) * 3;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        border: `5px solid ${COLORS.white}`,
        transform: `scale(${s}) rotate(${-8 + wobble}deg)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: COLORS.white,
        fontFamily: FONT_FAMILY.display,
        textAlign: 'center',
        boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
        lineHeight: 0.95,
      }}
    >
      <div style={{ fontSize: size * 0.34 }}>{top}</div>
      {bottom && <div style={{ fontSize: size * 0.13, letterSpacing: 2, marginTop: 6 }}>{bottom}</div>}
    </div>
  );
};

/* ----------------------------------------------------------------------------
 * Bottom CTA bar — website + arrow, always on brand. Pinned near the bottom.
 * -------------------------------------------------------------------------- */
export const CtaBar: React.FC<{
  text?: string;
  sub?: string;
  delay?: number;
}> = ({ text = 'calibreautoparts.co.uk', sub = 'Shop now — UK delivery', delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 18 } });
  const pulse = 1 + Math.sin(frame / 8) * 0.02;
  return (
    <div
      style={{
        transform: `translateY(${interpolate(s, [0, 1], [120, 0])}px) scale(${pulse})`,
        opacity: s,
        background: COLORS.red,
        borderRadius: 24,
        padding: '24px 46px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        boxShadow: '0 18px 50px rgba(214,40,40,0.45)',
      }}
    >
      <div style={{ fontFamily: FONT_FAMILY.display, fontSize: 58, color: COLORS.white, letterSpacing: 1 }}>
        {text}
      </div>
      {sub && (
        <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 700, fontSize: 30, color: 'rgba(255,255,255,0.92)' }}>
          {sub}
        </div>
      )}
    </div>
  );
};

/* ----------------------------------------------------------------------------
 * Social handle strip — drives follows on TikTok + Instagram.
 * -------------------------------------------------------------------------- */
const TikTokGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={COLORS.white}>
    <path d="M16.6 5.82c-.9-.6-1.5-1.55-1.66-2.65V3h-2.7v10.9c0 1.3-1.06 2.36-2.36 2.36s-2.36-1.06-2.36-2.36 1.06-2.36 2.36-2.36c.26 0 .5.04.74.12V8.5a5.07 5.07 0 0 0-.74-.06A5.06 5.06 0 0 0 4.82 13.5a5.06 5.06 0 0 0 10.12 0V8.2c1 .72 2.22 1.14 3.54 1.14V6.64c-.7 0-1.36-.2-1.92-.55l.04-.27z" />
  </svg>
);
const IgGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={COLORS.white} strokeWidth={2}>
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17.3" cy="6.7" r="1.2" fill={COLORS.white} stroke="none" />
  </svg>
);

export const SocialBar: React.FC<{ delay?: number; handle?: string }> = ({
  delay = 0,
  handle = '@calibreautoparts',
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame - delay, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <div
      style={{
        opacity,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        background: 'rgba(11,18,32,0.55)',
        border: '1px solid rgba(255,255,255,0.16)',
        backdropFilter: 'blur(6px)',
        padding: '14px 26px',
        borderRadius: 100,
      }}
    >
      <TikTokGlyph size={42} />
      <IgGlyph size={40} />
      <span style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 38, color: COLORS.white }}>
        {handle}
      </span>
    </div>
  );
};

/* ----------------------------------------------------------------------------
 * eBay trust badge — shows the trusted-seller status the brief asks for.
 * -------------------------------------------------------------------------- */
export const EbayBadge: React.FC<{ delay?: number; rating?: string }> = ({ delay = 0, rating = '100%' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 16 } });
  return (
    <div
      style={{
        transform: `scale(${s})`,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        background: COLORS.white,
        borderRadius: 18,
        padding: '16px 28px',
        boxShadow: '0 14px 40px rgba(0,0,0,0.3)',
      }}
    >
      <span style={{ fontFamily: FONT_FAMILY.body, fontWeight: 900, fontSize: 46, letterSpacing: -1 }}>
        <span style={{ color: '#E53238' }}>e</span>
        <span style={{ color: '#0064D2' }}>b</span>
        <span style={{ color: '#F5AF02' }}>a</span>
        <span style={{ color: '#86B817' }}>y</span>
      </span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 30, color: COLORS.navy }}>
          {rating} positive
        </span>
        <span style={{ fontFamily: FONT_FAMILY.body, fontWeight: 700, fontSize: 24, color: COLORS.steel }}>
          Trusted UK seller
        </span>
      </div>
    </div>
  );
};

/* Cursor / tap indicator for "go follow" moments. */
export const TapHint: React.FC<{ x: number; y: number; delay?: number }> = ({ x, y, delay = 0 }) => {
  const frame = useCurrentFrame();
  const t = (frame - delay) % 30;
  const scale = interpolate(t, [0, 8, 20], [1, 0.78, 1], { extrapolateRight: 'clamp' });
  const ring = interpolate(t, [0, 20], [0.3, 1.4]);
  const ringO = interpolate(t, [0, 20], [0.6, 0]);
  return (
    <div style={{ position: 'absolute', left: x, top: y }}>
      <div
        style={{
          position: 'absolute',
          width: 120,
          height: 120,
          border: `4px solid ${COLORS.white}`,
          borderRadius: '50%',
          transform: `translate(-50%,-50%) scale(${ring})`,
          opacity: ringO,
        }}
      />
      <div
        style={{
          width: 70,
          height: 70,
          background: 'rgba(255,255,255,0.9)',
          borderRadius: '50%',
          transform: `translate(-50%,-50%) scale(${scale})`,
        }}
      />
    </div>
  );
};

export const easeInOut = Easing.bezier(0.45, 0, 0.55, 1);
