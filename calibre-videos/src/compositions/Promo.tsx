import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { KineticHeadline, PopCaption, Stamp, Pill, SocialBar, TapHint } from '../components/ui';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';

export type PromoProps = {
  hook: string;
  offerTop: string; // e.g. "10%"
  offerBottom: string; // e.g. "OFF"
  code?: string;
  detail: string; // e.g. "Follow on TikTok for the code"
};

/** Offer / discount promo built to drive follows for "exclusive" codes. */
export const Promo: React.FC<PromoProps> = ({ hook, offerTop, offerBottom, code, detail }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={s(2.2)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: 50 }}>
            <KineticHeadline text={hook} fontSize={108} highlight="exclusive" />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(2.2)} durationInFrames={s(3)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 40 }}>
            <Logo width={340} variant="badge" />
            <Stamp top={offerTop} bottom={offerBottom} size={400} delay={4} />
            {code && <Pill text={`CODE: ${code}`} bg={COLORS.white} color={COLORS.navy} delay={16} fontSize={46} />}
            <PopCaption text={detail} delay={20} bg={COLORS.red} fontSize={50} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(5.2)} durationInFrames={s(2.4)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 40 }}>
            <PopCaption text="Tap follow for exclusive offers" delay={2} bg={COLORS.navy} fontSize={58} />
            <SocialBar delay={8} />
            <TapHint x={540} y={1400} delay={10} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(7.6)} durationInFrames={s(3)}>
        <EndCard cta="Don’t miss the next drop — follow now" />
      </Sequence>
    </AbsoluteFill>
  );
};

export { PROMO_SECONDS } from '../data/durations';
