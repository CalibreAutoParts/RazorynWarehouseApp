import React from 'react';
import { AbsoluteFill } from 'remotion';
import { NavyBg, LightBg, RedRule } from '../components/Backgrounds';
import { PartArt, type PartKey } from '../components/PartArt';
import { Pill, Stars, EbayBadge, SocialBar, Stamp } from '../components/ui';
import { Logo } from '../components/Logo';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';

export type CarouselSlide =
  | { kind: 'cover'; title: string; subtitle: string }
  | { kind: 'point'; index: number; title: string; body: string; part?: PartKey }
  | { kind: 'offer'; top: string; bottom: string; detail: string }
  | { kind: 'cta'; line: string };

export type CarouselProps = {
  slide: CarouselSlide;
  theme?: 'navy' | 'light';
};

/** One carousel slide (1080x1080). Catalog enumerates each slide separately. */
export const Carousel: React.FC<CarouselProps> = ({ slide, theme = 'navy' }) => {
  const Wrap = theme === 'navy' ? NavyBg : LightBg;
  const text = theme === 'navy' ? COLORS.white : COLORS.navyInk;
  const sub = theme === 'navy' ? COLORS.silver : COLORS.steel;

  return (
    <Wrap>
      <AbsoluteFill style={{ padding: 80, alignItems: 'center', justifyContent: 'center', gap: 28 }}>
        <div style={{ position: 'absolute', top: 60 }}>
          <Logo width={300} variant={theme === 'navy' ? 'badge' : 'plain'} animate={false} />
        </div>

        {slide.kind === 'cover' && (
          <>
            <div style={{ fontFamily: FONT_FAMILY.display, fontSize: 120, color: text, textAlign: 'center', lineHeight: 0.98 }}>
              {slide.title.toUpperCase()}
            </div>
            <RedRule width={400} delay={-1} />
            <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 700, fontSize: 46, color: sub, textAlign: 'center', padding: '0 40px' }}>
              {slide.subtitle}
            </div>
            <Pill text="Swipe →" bg={COLORS.red} delay={-1} fontSize={40} />
          </>
        )}

        {slide.kind === 'point' && (
          <>
            <div style={{ width: 150, height: 150, borderRadius: '50%', background: COLORS.red, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT_FAMILY.display, fontSize: 90, color: COLORS.white }}>
              {slide.index}
            </div>
            {slide.part && <PartArt part={slide.part} size={300} float={false} delay={-1} />}
            <div style={{ fontFamily: FONT_FAMILY.display, fontSize: 78, color: text, textAlign: 'center', padding: '0 20px' }}>
              {slide.title.toUpperCase()}
            </div>
            <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 600, fontSize: 44, color: sub, textAlign: 'center', lineHeight: 1.3, padding: '0 30px' }}>
              {slide.body}
            </div>
          </>
        )}

        {slide.kind === 'offer' && (
          <>
            <Stamp top={slide.top} bottom={slide.bottom} size={440} delay={-1} />
            <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 50, color: text, textAlign: 'center', padding: '0 30px' }}>
              {slide.detail}
            </div>
          </>
        )}

        {slide.kind === 'cta' && (
          <>
            <Stars count={5} size={64} delay={-1} />
            <div style={{ fontFamily: FONT_FAMILY.display, fontSize: 86, color: text, textAlign: 'center', lineHeight: 1.0, padding: '0 20px' }}>
              {slide.line.toUpperCase()}
            </div>
            <EbayBadge delay={-1} />
            <div style={{ background: COLORS.red, borderRadius: 22, padding: '20px 46px', fontFamily: FONT_FAMILY.display, fontSize: 54, color: COLORS.white }}>
              calibreautoparts.co.uk
            </div>
            <SocialBar delay={-1} />
          </>
        )}

        <div style={{ position: 'absolute', bottom: 50 }}>
          <SocialBar delay={-1} handle="@calibreautoparts · Watford" />
        </div>
      </AbsoluteFill>
    </Wrap>
  );
};
