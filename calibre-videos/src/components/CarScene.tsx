import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { COLORS } from '../brand/theme';

const Wheel: React.FC<{ cx: number; cy: number; r: number; spin: number }> = ({ cx, cy, r, spin }) => (
  <g transform={`translate(${cx} ${cy})`}>
    <circle r={r} fill={COLORS.navyInk} stroke="#000" strokeWidth={3} />
    <circle r={r * 0.55} fill={COLORS.silver} />
    <g transform={`rotate(${spin})`}>
      {Array.from({ length: 5 }).map((_, i) => {
        const a = (i / 5) * 360;
        return <rect key={i} x={-3} y={-r * 0.5} width={6} height={r * 0.5} fill={COLORS.navy} transform={`rotate(${a})`} />;
      })}
    </g>
    <circle r={r * 0.16} fill={COLORS.red} />
  </g>
);

/**
 * Side-view cartoon car (Calibre navy with red accent). Wheels spin and the
 * body bobs; pass `driving` to animate the road for a "back on the road" feel.
 */
export const CartoonCar: React.FC<{ scale?: number; driving?: boolean }> = ({ scale = 1, driving = true }) => {
  const frame = useCurrentFrame();
  const spin = driving ? frame * 9 : 0;
  const bob = Math.sin(frame / 9) * 4;
  return (
    <g transform={`translate(0 ${bob}) scale(${scale})`}>
      {/* body */}
      <path d="M40 150 Q60 150 70 120 Q120 78 220 80 Q300 82 340 120 L420 130 Q450 134 452 150 L452 175 Q452 185 440 185 L60 185 Q40 185 40 168 Z" fill={COLORS.navy} stroke="#0A1430" strokeWidth={5} />
      {/* roof window */}
      <path d="M120 92 Q170 70 240 74 L300 96 L120 96 Z" fill="#BFD6F5" stroke="#0A1430" strokeWidth={4} />
      <line x1="210" y1="74" x2="210" y2="96" stroke="#0A1430" strokeWidth={4} />
      {/* red accent stripe (logo underline echo) */}
      <rect x="60" y="150" width="392" height="9" fill={COLORS.red} />
      {/* headlight + tail */}
      <circle cx="446" cy="140" r="8" fill={COLORS.gold} />
      <rect x="44" y="135" width="10" height="14" rx="3" fill={COLORS.red} />
      <Wheel cx={140} cy={185} r={42} spin={spin} />
      <Wheel cx={360} cy={185} r={42} spin={spin} />
    </g>
  );
};

export const RoadScene: React.FC<{ children?: React.ReactNode; sky?: string }> = ({ children, sky }) => {
  const frame = useCurrentFrame();
  const dash = (frame * 14) % 120;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: sky ?? `linear-gradient(180deg, ${COLORS.navy} 0%, ${COLORS.navyDeep} 60%)` }} />
      {/* hills */}
      <svg width="100%" height="100%" viewBox="0 0 1080 1920" preserveAspectRatio="none" style={{ position: 'absolute' }}>
        <path d="M0 1250 Q300 1140 620 1230 Q860 1300 1080 1210 L1080 1920 L0 1920 Z" fill={COLORS.navyInk} opacity={0.7} />
        {/* road */}
        <rect x="0" y="1430" width="1080" height="490" fill="#1B2334" />
        <rect x="0" y="1430" width="1080" height="10" fill={COLORS.red} opacity={0.5} />
        {Array.from({ length: 8 }).map((_, i) => (
          <rect key={i} x={i * 160 - dash} y={1660} width={90} height={16} rx={8} fill={COLORS.gold} opacity={0.85} />
        ))}
      </svg>
      {children}
    </AbsoluteFill>
  );
};

/** A simple friendly mechanic character (waves), for cartoon explainers. */
export const Mechanic: React.FC<{ scale?: number }> = ({ scale = 1 }) => {
  const frame = useCurrentFrame();
  const wave = Math.sin(frame / 6) * 18;
  return (
    <g transform={`scale(${scale})`}>
      <ellipse cx="100" cy="300" rx="80" ry="16" fill="rgba(0,0,0,0.25)" />
      {/* legs */}
      <rect x="74" y="210" width="22" height="80" rx="10" fill={COLORS.navyInk} />
      <rect x="104" y="210" width="22" height="80" rx="10" fill={COLORS.navyInk} />
      {/* overalls */}
      <rect x="62" y="120" width="76" height="110" rx="22" fill={COLORS.navy} stroke="#0A1430" strokeWidth={4} />
      <rect x="86" y="150" width="28" height="40" rx="6" fill={COLORS.red} />
      {/* waving arm */}
      <g transform={`rotate(${wave} 138 140)`}>
        <rect x="132" y="130" width="56" height="20" rx="10" fill={COLORS.navy} />
        <circle cx="190" cy="140" r="14" fill="#F2C9A0" />
      </g>
      {/* other arm */}
      <rect x="40" y="135" width="34" height="18" rx="9" fill={COLORS.navy} />
      {/* head */}
      <circle cx="100" cy="92" r="34" fill="#F2C9A0" stroke="#0A1430" strokeWidth={3} />
      <path d="M66 86 Q100 50 134 86 L134 72 Q100 44 66 72 Z" fill={COLORS.red} />
      <circle cx="90" cy="92" r="4" fill="#222" />
      <circle cx="112" cy="92" r="4" fill="#222" />
      <path d="M88 106 Q100 116 114 106" stroke="#222" strokeWidth={3} fill="none" strokeLinecap="round" />
    </g>
  );
};

export const wobble = (frame: number, amp = 4, speed = 9) => Math.sin(frame / speed) * amp;
export const noop = interpolate; // keep import used in tree-shaken builds
