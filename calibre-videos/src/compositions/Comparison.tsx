import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig, useCurrentFrame, spring, interpolate } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { KineticHeadline, PopCaption, Pill, SocialBar } from '../components/ui';
import { PartArt } from '../components/PartArt';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';
import type { Product } from '../data/products';

export type ComparisonProps = {
  product: Product;
  hook: string;
};

/** Dealer vs Calibre price comparison — strong value/ savings story. */
export const Comparison: React.FC<ComparisonProps> = ({ product, hook }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);
  const dealer = parseInt(product.was.replace(/[^0-9]/g, ''), 10);
  const calibre = parseInt(product.price.replace(/[^0-9]/g, ''), 10);
  const saving = dealer - calibre;
  const pct = Math.round((saving / dealer) * 100);

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={s(2.2)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: 50 }}>
            <KineticHeadline text={hook} fontSize={104} highlight="dealer" />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(2.2)} durationInFrames={s(4)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-start', paddingTop: 130, gap: 24 }}>
            <Logo width={300} variant="badge" />
            <PartArt part={product.part} size={280} />
            <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 42, color: COLORS.white, textAlign: 'center', padding: '0 40px' }}>
              {product.name}
            </div>
            <div style={{ display: 'flex', gap: 26, marginTop: 10 }}>
              <Column label="MAIN DEALER" value={product.was} color={COLORS.steel} bg="rgba(255,255,255,0.06)" delay={6} bad />
              <Column label="CALIBRE" value={product.price} color={COLORS.gold} bg={COLORS.red} delay={14} />
            </div>
            <SaveBadge pct={pct} saving={saving} delay={26} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(6.2)} durationInFrames={s(2)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
            <PopCaption text={`Same part. £${saving} cheaper. Why pay more?`} delay={2} bg={COLORS.red} fontSize={54} />
            <SocialBar delay={10} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(8.2)} durationInFrames={s(3)}>
        <EndCard cta={`Save £${saving} — order at Calibre`} />
      </Sequence>
    </AbsoluteFill>
  );
};

const Column: React.FC<{ label: string; value: string; color: string; bg: string; delay: number; bad?: boolean }> = ({
  label,
  value,
  color,
  bg,
  delay,
  bad,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sp = spring({ frame: frame - delay, fps, config: { damping: 14 } });
  return (
    <div
      style={{
        transform: `scale(${sp})`,
        background: bg,
        borderRadius: 24,
        padding: '28px 40px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        minWidth: 300,
        border: bad ? '2px solid rgba(255,255,255,0.15)' : 'none',
      }}
    >
      <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 30, letterSpacing: 2, color: COLORS.white, opacity: 0.85 }}>
        {label}
      </div>
      <div style={{ fontFamily: FONT_FAMILY.display, fontSize: 96, color, textDecoration: bad ? 'line-through' : 'none' }}>
        {value}
      </div>
    </div>
  );
};

const SaveBadge: React.FC<{ pct: number; saving: number; delay: number }> = ({ pct, saving, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sp = spring({ frame: frame - delay, fps, config: { damping: 10 } });
  const pulse = 1 + Math.sin(frame / 7) * 0.03;
  return (
    <div style={{ transform: `scale(${interpolate(sp, [0, 1], [0, pulse])})`, marginTop: 16 }}>
      <Pill text={`YOU SAVE £${saving} · ${pct}% OFF`} bg={COLORS.green} fontSize={44} />
    </div>
  );
};

export { COMPARISON_SECONDS } from '../data/durations';
