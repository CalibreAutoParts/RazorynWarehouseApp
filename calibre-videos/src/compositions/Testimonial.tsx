import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { KineticHeadline, Stars, PopCaption, SocialBar, Pill } from '../components/ui';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';

export type TestimonialProps = {
  name: string;
  role: string;
  stars: number;
  text: string;
};

/** Clean review-card testimonial — social proof, fast to produce at volume. */
export const Testimonial: React.FC<TestimonialProps> = ({ name, role, stars, text }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={s(1.8)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
            <KineticHeadline text="What our customers say" fontSize={92} highlight="customers" />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(1.8)} durationInFrames={s(4.4)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: 70 }}>
            <div
              style={{
                background: COLORS.white,
                borderRadius: 36,
                padding: '54px 50px',
                display: 'flex',
                flexDirection: 'column',
                gap: 28,
                alignItems: 'center',
                maxWidth: 900,
                boxShadow: '0 30px 80px rgba(0,0,0,0.4)',
              }}
            >
              <Stars count={stars} size={66} delay={4} />
              <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 700, fontSize: 50, lineHeight: 1.32, color: COLORS.navyInk, textAlign: 'center' }}>
                “{text}”
              </div>
              <div style={{ width: 80, height: 6, background: COLORS.red, borderRadius: 6 }} />
              <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 38, color: COLORS.navy }}>
                {name} · <span style={{ color: COLORS.steel, fontWeight: 600 }}>{role}</span>
              </div>
              <Logo width={300} animate={false} />
            </div>
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(6.2)} durationInFrames={s(1.8)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 26 }}>
            <Pill text="Join thousands of happy UK customers" bg={COLORS.red} delay={2} fontSize={40} />
            <PopCaption text="Your car could be next" delay={8} bg={COLORS.navy} fontSize={58} />
            <SocialBar delay={14} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(8)} durationInFrames={s(3)}>
        <EndCard cta="See why they choose Calibre Auto Parts" />
      </Sequence>
    </AbsoluteFill>
  );
};

export { TESTIMONIAL_SECONDS } from '../data/durations';
