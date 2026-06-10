import React from 'react';
import { Img, staticFile, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * The official Calibre Auto Parts logo (PNG with transparent background).
 * `variant="badge"` wraps it on a white rounded card so it stays legible
 * on dark navy backgrounds.
 */
export const Logo: React.FC<{
  width?: number;
  variant?: 'plain' | 'badge';
  animate?: boolean;
  delay?: number;
}> = ({ width = 620, variant = 'plain', animate = true, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = animate
    ? spring({ frame: frame - delay, fps, config: { damping: 200, mass: 0.7 } })
    : 1;
  const opacity = animate ? interpolate(frame - delay, [0, 8], [0, 1], { extrapolateRight: 'clamp' }) : 1;
  const scale = animate ? interpolate(enter, [0, 1], [0.82, 1]) : 1;

  const img = (
    <Img
      src={staticFile('logo-calibre.png')}
      style={{ width, height: 'auto', display: 'block' }}
    />
  );

  if (variant === 'badge') {
    return (
      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          background: '#FFFFFF',
          padding: `${width * 0.07}px ${width * 0.09}px`,
          borderRadius: width * 0.06,
          boxShadow: '0 24px 70px rgba(0,0,0,0.40)',
          display: 'inline-flex',
        }}
      >
        {img}
      </div>
    );
  }

  return <div style={{ opacity, transform: `scale(${scale})` }}>{img}</div>;
};
