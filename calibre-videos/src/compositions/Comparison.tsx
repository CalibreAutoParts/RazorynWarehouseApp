import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig, useCurrentFrame, spring } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { KineticHeadline, PopCaption, SocialBar } from '../components/ui';
import { PartArt } from '../components/PartArt';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';
import type { Product } from '../data/products';

export type ComparisonRow = { label: string; dealer: boolean; calibre: boolean };

export type ComparisonProps = {
  product: Product;
  hook: string;
  rows?: ComparisonRow[];
};

/** Main dealer vs Calibre — a service & quality comparison (no pricing). Leads
 *  on the things that actually set Calibre apart, including aftermarket doors
 *  that dealers only sell brand-new. */
export const Comparison: React.FC<ComparisonProps> = ({ product, hook, rows }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);

  const data: ComparisonRow[] = rows ?? [
    { label: 'Exact-fit for your model', dealer: true, calibre: true },
    { label: 'Aftermarket doors available', dealer: false, calibre: true },
    { label: 'Same-day dispatch before 12pm', dealer: false, calibre: true },
    { label: 'Talk to a real person', dealer: false, calibre: true },
  ];

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={s(2.4)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: 50 }}>
            <KineticHeadline text={hook} fontSize={100} highlight="dealer" />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(2.4)} durationInFrames={s(4.6)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-start', paddingTop: 110, gap: 20 }}>
            <Logo width={300} variant="badge" />
            <PartArt part={product.part} size={220} />
            <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 40, color: COLORS.white, textAlign: 'center', padding: '0 40px' }}>
              {product.name}
            </div>

            <div style={{ width: 920, marginTop: 6 }}>
              {/* header */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px 220px', alignItems: 'center', paddingBottom: 12 }}>
                <span />
                <span style={{ textAlign: 'center', fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 30, letterSpacing: 1, color: COLORS.silver }}>MAIN DEALER</span>
                <span style={{ textAlign: 'center', fontFamily: FONT_FAMILY.body, fontWeight: 900, fontSize: 32, letterSpacing: 1, color: COLORS.gold }}>CALIBRE</span>
              </div>
              {data.map((r, i) => (
                <Row key={r.label} row={r} delay={6 + i * 5} />
              ))}
            </div>
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(7)} durationInFrames={s(1.6)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
            <PopCaption text="Same fit. Better service. No dealer hassle." delay={2} bg={COLORS.red} fontSize={54} />
            <SocialBar delay={10} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(8.6)} durationInFrames={s(3)}>
        <EndCard cta={`Order your ${product.make} part at Calibre`} />
      </Sequence>
    </AbsoluteFill>
  );
};

const Row: React.FC<{ row: ComparisonRow; delay: number }> = ({ row, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sp = spring({ frame: frame - delay, fps, config: { damping: 16 } });
  return (
    <div
      style={{
        transform: `translateX(${(1 - sp) * 40}px)`,
        opacity: sp,
        display: 'grid',
        gridTemplateColumns: '1fr 220px 220px',
        alignItems: 'center',
        background: 'rgba(255,255,255,0.05)',
        borderRadius: 18,
        padding: '20px 26px',
        marginBottom: 14,
      }}
    >
      <span style={{ fontFamily: FONT_FAMILY.body, fontWeight: 700, fontSize: 34, color: COLORS.white }}>{row.label}</span>
      <span style={{ textAlign: 'center' }}>{row.dealer ? <Tick /> : <Cross />}</span>
      <span style={{ textAlign: 'center' }}>{row.calibre ? <Tick big /> : <Cross />}</span>
    </div>
  );
};

const Tick: React.FC<{ big?: boolean }> = ({ big }) => (
  <span style={{ fontFamily: FONT_FAMILY.display, fontSize: big ? 56 : 46, color: COLORS.green }}>✓</span>
);
const Cross: React.FC = () => (
  <span style={{ fontFamily: FONT_FAMILY.display, fontSize: 44, color: COLORS.steel }}>✗</span>
);

export { COMPARISON_SECONDS } from '../data/durations';
