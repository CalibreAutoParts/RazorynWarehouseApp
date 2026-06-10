import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { COLORS } from '../brand/theme';
import { PART_LABELS, type PartKey } from '../data/parts';

export { PART_LABELS };
export type { PartKey };

/**
 * Stylised SVG illustrations of the car body parts Calibre sells (the eBay
 * store trades as body parts). Drawn in brand navy/red/silver so part
 * showcases look intentional and on-brand without stock photography.
 */

const stroke = COLORS.navy;
const metal = COLORS.silver;
const sw = 6;

const Shapes: Record<PartKey, React.ReactNode> = {
  headlight: (
    <g>
      <path d="M30 60 Q40 30 110 32 L195 40 Q215 70 200 120 L120 140 Q50 138 35 110 Z" fill={metal} stroke={stroke} strokeWidth={sw} />
      <ellipse cx="95" cy="86" rx="34" ry="30" fill="#EAF0FA" stroke={stroke} strokeWidth={sw} />
      <ellipse cx="95" cy="86" rx="14" ry="13" fill={COLORS.navy} />
      <ellipse cx="158" cy="92" rx="20" ry="18" fill="#EAF0FA" stroke={stroke} strokeWidth={sw} />
      <path d="M40 118 L190 128" stroke={COLORS.red} strokeWidth={8} strokeLinecap="round" />
    </g>
  ),
  taillight: (
    <g>
      <path d="M40 50 L190 44 Q210 80 196 130 L46 138 Q30 90 40 50 Z" fill={COLORS.red} stroke={stroke} strokeWidth={sw} />
      <rect x="64" y="70" width="44" height="44" rx="10" fill="#FF6B6B" />
      <rect x="126" y="70" width="44" height="44" rx="10" fill="#FFD0A0" />
    </g>
  ),
  bumper: (
    <g>
      <path d="M20 90 Q120 50 220 90 L220 140 Q120 110 20 140 Z" fill={metal} stroke={stroke} strokeWidth={sw} />
      <rect x="70" y="108" width="100" height="18" rx="9" fill={COLORS.navy} />
      <circle cx="48" cy="120" r="9" fill={COLORS.navy} />
      <circle cx="192" cy="120" r="9" fill={COLORS.navy} />
      <path d="M20 92 Q120 54 220 92" stroke={COLORS.red} strokeWidth={7} fill="none" strokeLinecap="round" />
    </g>
  ),
  wing: (
    <g>
      <path d="M30 140 Q40 50 150 46 L210 60 Q220 120 200 150 Z" fill={metal} stroke={stroke} strokeWidth={sw} />
      <circle cx="120" cy="120" r="46" fill={COLORS.navyInk} stroke={stroke} strokeWidth={sw} />
      <circle cx="120" cy="120" r="20" fill={metal} />
    </g>
  ),
  bonnet: (
    <g>
      <path d="M30 60 Q120 40 210 60 L196 150 Q120 132 44 150 Z" fill={metal} stroke={stroke} strokeWidth={sw} />
      <path d="M70 70 Q120 60 170 70" stroke={stroke} strokeWidth={4} fill="none" />
      <path d="M64 150 L80 80 M176 150 L160 80" stroke={stroke} strokeWidth={4} />
    </g>
  ),
  grille: (
    <g>
      <rect x="36" y="56" width="168" height="92" rx="18" fill={COLORS.navyInk} stroke={stroke} strokeWidth={sw} />
      {[68, 88, 108, 128].map((y) => (
        <line key={y} x1="50" y1={y} x2="190" y2={y} stroke={metal} strokeWidth={6} />
      ))}
      <rect x="96" y="78" width="48" height="48" rx="8" fill={COLORS.red} />
    </g>
  ),
  mirror: (
    <g>
      <path d="M50 60 Q150 40 196 70 Q210 110 180 140 L80 150 Q40 120 50 60 Z" fill={metal} stroke={stroke} strokeWidth={sw} />
      <path d="M90 76 L176 70 Q188 100 168 124 L96 130 Z" fill="#CFE0F5" stroke={stroke} strokeWidth={4} />
      <rect x="40" y="120" width="34" height="20" rx="8" fill={COLORS.navy} />
    </g>
  ),
  door: (
    <g>
      <rect x="44" y="36" width="152" height="128" rx="16" fill={metal} stroke={stroke} strokeWidth={sw} />
      <rect x="64" y="54" width="112" height="40" rx="8" fill="#CFE0F5" stroke={stroke} strokeWidth={4} />
      <rect x="150" y="110" width="34" height="12" rx="6" fill={COLORS.navy} />
      <line x1="64" y1="130" x2="176" y2="130" stroke={COLORS.red} strokeWidth={6} />
    </g>
  ),
  tailgate: (
    <g>
      <rect x="40" y="40" width="160" height="120" rx="14" fill={metal} stroke={stroke} strokeWidth={sw} />
      <rect x="60" y="58" width="120" height="46" rx="8" fill="#CFE0F5" stroke={stroke} strokeWidth={4} />
      <rect x="92" y="120" width="56" height="16" rx="8" fill={COLORS.navy} />
      <circle cx="74" cy="128" r="7" fill={COLORS.red} />
      <circle cx="166" cy="128" r="7" fill={COLORS.red} />
    </g>
  ),
  wheel: (
    <g>
      <circle cx="120" cy="100" r="76" fill={COLORS.navyInk} stroke={stroke} strokeWidth={sw} />
      <circle cx="120" cy="100" r="44" fill={metal} stroke={stroke} strokeWidth={sw} />
      {Array.from({ length: 5 }).map((_, i) => {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        return (
          <line key={i} x1="120" y1="100" x2={120 + Math.cos(a) * 40} y2={100 + Math.sin(a) * 40} stroke={stroke} strokeWidth={8} strokeLinecap="round" />
        );
      })}
      <circle cx="120" cy="100" r="12" fill={COLORS.red} />
    </g>
  ),
  radiator: (
    <g>
      <rect x="40" y="44" width="160" height="112" rx="10" fill={metal} stroke={stroke} strokeWidth={sw} />
      {Array.from({ length: 9 }).map((_, i) => (
        <line key={i} x1={54 + i * 16} y1="54" x2={54 + i * 16} y2="146" stroke={COLORS.navy} strokeWidth={4} />
      ))}
      <rect x="40" y="44" width="160" height="16" fill={COLORS.red} />
    </g>
  ),
  splitter: (
    <g>
      <path d="M24 110 Q120 96 216 110 L210 132 Q120 120 30 132 Z" fill={COLORS.navyInk} stroke={stroke} strokeWidth={sw} />
      <path d="M40 132 L40 150 M120 124 L120 152 M200 132 L200 150" stroke={COLORS.navy} strokeWidth={6} />
      <path d="M24 110 Q120 96 216 110" stroke={COLORS.red} strokeWidth={6} fill="none" />
    </g>
  ),
};

export const PartArt: React.FC<{ part: PartKey; size?: number; float?: boolean; delay?: number }> = ({
  part,
  size = 360,
  float = true,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const dy = float ? Math.sin((frame - delay) / 18) * 10 : 0;
  const rot = float ? Math.sin((frame - delay) / 26) * 1.5 : 0;
  const enter = interpolate(frame - delay, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ transform: `translateY(${dy}px) rotate(${rot}deg) scale(${interpolate(enter, [0, 1], [0.8, 1])})`, opacity: enter, filter: 'drop-shadow(0 24px 40px rgba(0,0,0,0.45))' }}>
      <svg width={size} height={size * 0.83} viewBox="0 0 240 200">
        {Shapes[part]}
      </svg>
    </div>
  );
};
