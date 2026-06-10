import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { PhoneFrame } from '../components/PhoneFrame';
import { PartArt } from '../components/PartArt';
import { Stars, PopCaption, Pill, SocialBar } from '../components/ui';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';
import { SHOW_PRICING } from '../data/config';
import type { Product } from '../data/products';

export type UgcReviewProps = {
  reviewerName: string;
  reviewerRole: string;
  product: Product;
  quote: string;
  hook: string;
};

/**
 * UGC-style review: shot to feel like a customer filming on their phone.
 * Big captions, star rating, the part on a phone screen, honest testimonial.
 */
export const UgcReview: React.FC<UgcReviewProps> = ({ reviewerName, reviewerRole, product, quote, hook }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);

  return (
    <AbsoluteFill>
      {/* HOOK — talking to camera */}
      <Sequence durationInFrames={s(2.2)}>
        <NavyBg>
          <Selfie name={reviewerName} role={reviewerRole} />
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 360 }}>
            <PopCaption text={hook} delay={4} bg={COLORS.red} fontSize={66} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      {/* SHOWING THE PART on phone */}
      <Sequence from={s(2.2)} durationInFrames={s(3)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
            <PhoneFrame width={560} topLabel="calibreautoparts.co.uk">
              <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 24, paddingTop: 60 }}>
                <PartArt part={product.part} size={360} />
                <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 38, color: COLORS.white, textAlign: 'center', padding: '0 20px' }}>
                  {product.name}
                </div>
                {SHOW_PRICING && <div style={{ fontFamily: FONT_FAMILY.display, fontSize: 80, color: COLORS.gold }}>{product.price}</div>}
                <Pill text={`${product.condition} · Exact fit`} bg={COLORS.green} delay={10} />
              </AbsoluteFill>
            </PhoneFrame>
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      {/* THE VERDICT — review quote + stars */}
      <Sequence from={s(5.2)} durationInFrames={s(3)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30, padding: 70 }}>
            <Logo width={300} variant="badge" />
            <Stars count={5} size={70} delay={6} />
            <div
              style={{
                fontFamily: FONT_FAMILY.body,
                fontWeight: 700,
                fontSize: 50,
                lineHeight: 1.3,
                color: COLORS.white,
                textAlign: 'center',
                fontStyle: 'italic',
              }}
            >
              “{quote}”
            </div>
            <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 36, color: COLORS.silver }}>
              — {reviewerName}, {reviewerRole}
            </div>
            <SocialBar delay={20} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(8.2)} durationInFrames={s(3)}>
        <EndCard cta="Real parts. Real reviews. Order today" />
      </Sequence>
    </AbsoluteFill>
  );
};

/** Simple animated "selfie" avatar so the UGC opener has a human focal point. */
const Selfie: React.FC<{ name: string; role: string }> = ({ name, role }) => {
  const frame = useCurrentFrame();
  const bob = Math.sin(frame / 10) * 6;
  const intro = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: intro }}>
      <div style={{ transform: `translateY(${bob}px)`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
        <svg width={300} height={300} viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="96" fill={COLORS.navyDeep} />
          <circle cx="100" cy="86" r="46" fill="#F2C9A0" />
          <path d="M58 80 Q100 36 142 80 L142 64 Q100 34 58 64 Z" fill={COLORS.navyInk} />
          <circle cx="84" cy="88" r="6" fill="#222" />
          <circle cx="116" cy="88" r="6" fill="#222" />
          <path d="M82 110 Q100 124 118 110" stroke="#222" strokeWidth={5} fill="none" strokeLinecap="round" />
          <path d="M40 200 Q40 150 100 150 Q160 150 160 200 Z" fill={COLORS.red} />
        </svg>
        <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 40, color: COLORS.white }}>{name}</div>
        <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 600, fontSize: 28, color: COLORS.silver }}>{role}</div>
      </div>
    </AbsoluteFill>
  );
};

export { UGC_SECONDS } from '../data/durations';
