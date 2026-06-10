import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { PartArt, PART_LABELS, type PartKey } from '../components/PartArt';
import { KineticHeadline, Pill, PriceTag, SocialBar, PopCaption } from '../components/ui';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';
import type { Product } from '../data/products';

export type PartsShowcaseProps = {
  category: PartKey;
  headline: string;
  items: Product[]; // products in this category
};

/** Category showcase — e.g. "Bumpers for every make" with rotating products. */
export const PartsShowcase: React.FC<PartsShowcaseProps> = ({ category, headline, items }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);
  const per = 1.9;

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={s(2.2)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 24 }}>
            <Logo width={360} variant="badge" />
            <PartArt part={category} size={400} />
            <KineticHeadline text={headline} fontSize={92} highlight="every" />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      {items.map((p, i) => (
        <Sequence key={p.sku} from={s(2.2 + i * per)} durationInFrames={s(per)}>
          <NavyBg>
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 22 }}>
              <PartArt part={p.part} size={380} delay={2} />
              <div style={{ fontFamily: FONT_FAMILY.display, fontSize: 70, color: COLORS.white, textAlign: 'center', padding: '0 40px' }}>
                {p.make.toUpperCase()}
              </div>
              <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 700, fontSize: 36, color: COLORS.silver }}>{p.fitment}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
                <span style={{ fontFamily: FONT_FAMILY.display, fontSize: 110, color: COLORS.gold }}>{p.price}</span>
                <span style={{ fontFamily: FONT_FAMILY.body, fontWeight: 700, fontSize: 44, color: COLORS.steel, textDecoration: 'line-through' }}>{p.was}</span>
              </div>
              <Pill text={p.condition} bg={COLORS.green} delay={6} />
            </AbsoluteFill>
          </NavyBg>
        </Sequence>
      ))}

      <Sequence from={s(2.2 + items.length * per)} durationInFrames={s(2)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 28 }}>
            <PopCaption text={`Exact-fit ${PART_LABELS[category]} — Tesla, MG, BYD, Honda & Toyota`} delay={2} bg={COLORS.red} fontSize={46} />
            <PriceTag price={items[0]?.price ?? '£49'} label="from" delay={8} />
            <SocialBar delay={16} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(2.2 + items.length * per + 2)} durationInFrames={s(3)}>
        <EndCard cta={`Shop ${PART_LABELS[category]} now`} />
      </Sequence>
    </AbsoluteFill>
  );
};

export { SHOWCASE_SECONDS } from '../data/durations';
