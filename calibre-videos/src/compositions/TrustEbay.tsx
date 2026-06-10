import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { KineticHeadline, PopCaption, EbayBadge, Stars, Pill, SocialBar, Stamp } from '../components/ui';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';

export type TrustEbayProps = {
  feedback: string; // "100%"
  reviewsLine: string; // "thousands of happy UK buyers"
  hook: string;
};

/** Trust builder — leans on the eBay trusted-seller status from the brief. */
export const TrustEbay: React.FC<TrustEbayProps> = ({ feedback, reviewsLine, hook }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={s(2.2)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: 50 }}>
            <KineticHeadline text={hook} fontSize={104} highlight="trusted" />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(2.2)} durationInFrames={s(3)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 36 }}>
            <Logo width={360} variant="badge" />
            <EbayBadge delay={4} />
            <Stars count={5} size={76} delay={12} />
            <PopCaption text={reviewsLine} delay={18} bg={COLORS.navy} fontSize={52} />
            <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 700, fontSize: 34, color: COLORS.silver }}>
              eBay store: EVBODYPARTS · trading as Calibre Auto Parts
            </div>
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(5.2)} durationInFrames={s(2.4)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
            <Stamp top={feedback.toUpperCase()} bottom="SELLER" bg={COLORS.green} size={360} delay={2} />
            <PopCaption text="Buy with confidence — same trusted team on our website" delay={10} bg={COLORS.red} fontSize={46} />
            <SocialBar delay={18} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(7.6)} durationInFrames={s(3)}>
        <EndCard cta="Trusted on eBay · shop our full range" />
      </Sequence>
    </AbsoluteFill>
  );
};

export { TRUST_SECONDS } from '../data/durations';
