import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, GRADIENTS } from '../brand/theme';

/** Subtle moving diagonal "speed line" texture used over navy backgrounds. */
const SpeedLines: React.FC<{ opacity?: number }> = ({ opacity = 0.06 }) => {
  const frame = useCurrentFrame();
  const shift = (frame * 1.4) % 80;
  return (
    <AbsoluteFill
      style={{
        opacity,
        backgroundImage: `repeating-linear-gradient(125deg, ${COLORS.white} 0px, ${COLORS.white} 2px, transparent 2px, transparent 80px)`,
        backgroundPosition: `${shift}px 0`,
      }}
    />
  );
};

/** Slow-drifting glow blob for depth. */
const Glow: React.FC<{ color: string; x: string; y: string; size?: number }> = ({
  color,
  x,
  y,
  size = 900,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = interpolate(frame, [0, durationInFrames], [0, 1]);
  const dy = Math.sin(t * Math.PI * 2) * 40;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: size,
        height: size,
        transform: `translate(-50%,-50%) translateY(${dy}px)`,
        background: `radial-gradient(circle, ${color} 0%, transparent 65%)`,
        filter: 'blur(8px)',
      }}
    />
  );
};

export const NavyBg: React.FC<{ children?: React.ReactNode; lines?: boolean; glow?: boolean }> = ({
  children,
  lines = true,
  glow = true,
}) => (
  <AbsoluteFill style={{ background: GRADIENTS.navy }}>
    {glow && <Glow color="rgba(70,110,200,0.28)" x="22%" y="20%" />}
    {glow && <Glow color="rgba(214,40,40,0.18)" x="85%" y="82%" size={760} />}
    {lines && <SpeedLines />}
    {children}
  </AbsoluteFill>
);

export const SpotlightBg: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: GRADIENTS.spotlight }}>
    <SpeedLines opacity={0.05} />
    {children}
  </AbsoluteFill>
);

export const LightBg: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: GRADIENTS.light }}>
    <AbsoluteFill
      style={{
        opacity: 0.5,
        backgroundImage: `radial-gradient(${COLORS.silver} 1.4px, transparent 1.4px)`,
        backgroundSize: '34px 34px',
      }}
    />
    {children}
  </AbsoluteFill>
);

/** Animated red accent bar (echoes the logo underline). */
export const RedRule: React.FC<{ width?: number; delay?: number; thickness?: number }> = ({
  width = 360,
  delay = 0,
  thickness = 10,
}) => {
  const frame = useCurrentFrame();
  const w = interpolate(frame - delay, [0, 14], [0, width], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <div style={{ width: w, height: thickness, background: COLORS.red, borderRadius: thickness }} />;
};
