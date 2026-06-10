import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { NavyBg, RedRule } from './Backgrounds';
import { Logo } from './Logo';
import { CtaBar, SocialBar, EbayBadge, Pill } from './ui';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';

/**
 * Reusable end card. Designed to be held ~2.5–3s so every detail (website,
 * eBay, socials, location) stays on screen long enough to read.
 */
export const EndCard: React.FC<{ cta?: string; showEbay?: boolean }> = ({
  cta = 'Order now — fast UK delivery',
  showEbay = true,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  // gentle fade-in; never fades out (stays readable to the very end)
  const o = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <NavyBg>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 46, opacity: o, padding: 60 }}>
        <Logo width={720} variant="badge" delay={2} />
        <RedRule width={420} delay={14} />
        <div
          style={{
            fontFamily: FONT_FAMILY.display,
            fontSize: 64,
            color: COLORS.white,
            textAlign: 'center',
            lineHeight: 1.05,
          }}
        >
          EXACT-FIT EV &amp; MODERN CAR PARTS
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Pill text="Exact-fit guaranteed" bg={COLORS.green} delay={20} fontSize={30} />
          <Pill text="Free delivery over £25" bg={COLORS.navy} delay={23} fontSize={30} />
          <Pill text="Same-day dispatch" bg={COLORS.red} delay={26} fontSize={30} />
        </div>
        <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 32, color: COLORS.silver }}>
          Tesla · MG · BYD · Honda · Toyota — Family-run, Watford
        </div>
        {showEbay && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 6 }}>
            <EbayBadge delay={28} />
          </div>
        )}
        <CtaBar text="calibreautoparts.co.uk" sub={cta} delay={26} />
        <div style={{ marginTop: 6 }}>
          <SocialBar delay={34} />
        </div>
        <div
          style={{
            fontFamily: FONT_FAMILY.body,
            fontWeight: 700,
            fontSize: 30,
            color: COLORS.silver,
            opacity: interpolate(frame, [40, 55], [0, 1], { extrapolateRight: 'clamp' }),
          }}
        >
          Follow for exclusive offers & discounts
        </div>
        {/* subtle progress so the viewer knows it lingers, not stalls */}
        <div style={{ position: 'absolute', bottom: 50, width: '70%', height: 6, background: 'rgba(255,255,255,0.15)', borderRadius: 6 }}>
          <div style={{ width: `${(frame / durationInFrames) * 100}%`, height: '100%', background: COLORS.red, borderRadius: 6 }} />
        </div>
      </AbsoluteFill>
    </NavyBg>
  );
};
