import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { KineticHeadline, PopCaption, PriceTag, Pill, SocialBar } from '../components/ui';
import { PartArt, PART_LABELS } from '../components/PartArt';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';
import { SHOW_PRICING } from '../data/config';
import type { Product } from '../data/products';

export type AdSpotProps = {
  product: Product;
  hook: string;
  audienceLine: string;
};

/** High-converting product ad: hook -> part -> price -> CTA end card. */
export const AdSpot: React.FC<AdSpotProps> = ({ product, hook, audienceLine }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);

  return (
    <AbsoluteFill>
      {/* HOOK */}
      <Sequence durationInFrames={s(2.4)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: 40 }}>
            <KineticHeadline text={hook} fontSize={118} highlight="overpaying" />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      {/* PART REVEAL */}
      <Sequence from={s(2.4)} durationInFrames={s(2.4)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
            <div style={{ position: 'absolute', top: 80 }}>
              <Logo width={300} variant="badge" />
            </div>
            <PartArt part={product.part} size={520} />
            <div style={{ fontFamily: FONT_FAMILY.display, fontSize: 76, color: COLORS.white, textAlign: 'center', padding: '0 40px', lineHeight: 1.0 }}>
              {product.name.toUpperCase()}
            </div>
            <div style={{ display: 'flex', gap: 14 }}>
              <Pill text={product.condition} bg={COLORS.navy} delay={8} />
              <Pill text={product.fitment} bg={COLORS.red} delay={12} fontSize={28} />
            </div>
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      {/* VALUE / MESSAGE */}
      <Sequence from={s(4.8)} durationInFrames={s(2.4)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 40 }}>
            <PopCaption text={audienceLine} delay={2} bg={COLORS.red} />
            {SHOW_PRICING ? (
              <>
                <PriceTag price={product.price} was={product.was} label={`${PART_LABELS[product.part]} from`} delay={10} />
                <Pill text="vs main dealer price" bg={COLORS.navy} delay={20} fontSize={32} />
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                <Pill text="EXACT-FIT GUARANTEED" bg={COLORS.green} delay={10} fontSize={40} />
                <Pill text="Same-day dispatch before 12pm" bg={COLORS.navy} delay={16} fontSize={30} />
                <Pill text="Free UK delivery over £25" bg={COLORS.navy} delay={20} fontSize={30} />
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              <SocialBar delay={26} />
            </div>
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      {/* END CARD (held) */}
      <Sequence from={s(7.2)} durationInFrames={s(3)}>
        <EndCard cta={`Order the ${product.make} part now`} />
      </Sequence>
    </AbsoluteFill>
  );
};

export { AD_SPOT_SECONDS } from '../data/durations';
