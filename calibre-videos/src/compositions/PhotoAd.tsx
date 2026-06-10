import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { NavyBg, LightBg, RedRule } from '../components/Backgrounds';
import { PartArt } from '../components/PartArt';
import { Pill, Stars, EbayBadge, SocialBar } from '../components/ui';
import { Logo } from '../components/Logo';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';
import { SHOW_PRICING } from '../data/config';
import type { Product } from '../data/products';

export type PhotoAdProps = {
  product: Product;
  headline: string;
  theme?: 'navy' | 'light';
  /** Optional real product photo under /public (e.g. 'photos/tesla-m3-bumper.jpg').
   *  When provided the real image is shown; otherwise we fall back to the
   *  branded vector illustration. */
  photoSrc?: string;
};

/**
 * Single-image feed ad (1080x1350, IG portrait). Designed to read instantly
 * as a still — composition is settled, no reliance on motion.
 */
export const PhotoAd: React.FC<PhotoAdProps> = ({ product, headline, theme = 'navy', photoSrc }) => {
  const Wrap = theme === 'navy' ? NavyBg : LightBg;
  const text = theme === 'navy' ? COLORS.white : COLORS.navyInk;
  const sub = theme === 'navy' ? COLORS.silver : COLORS.steel;

  return (
    <Wrap>
      <AbsoluteFill style={{ padding: 90, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Logo width={360} variant={theme === 'navy' ? 'badge' : 'plain'} animate={false} />
          <Pill text={product.condition} bg={COLORS.green} delay={-1} fontSize={30} />
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          {photoSrc ? (
            <div style={{ width: 560, height: 420, borderRadius: 28, overflow: 'hidden', border: `4px solid ${theme === 'navy' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'}`, boxShadow: '0 24px 48px rgba(0,0,0,0.35)' }}>
              <Img src={staticFile(photoSrc)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          ) : (
            <PartArt part={product.part} size={460} float={false} delay={-1} />
          )}
          <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 800, fontSize: 34, letterSpacing: 3, color: theme === 'navy' ? COLORS.gold : COLORS.red }}>
            {headline.toUpperCase()}
          </div>
          <div style={{ fontFamily: FONT_FAMILY.display, fontSize: 72, color: text, textAlign: 'center', lineHeight: 1.0, padding: '0 20px' }}>
            {product.name.toUpperCase()}
          </div>
          <RedRule width={360} delay={-1} />
          <div style={{ fontFamily: FONT_FAMILY.body, fontWeight: 700, fontSize: 38, color: sub, textAlign: 'center' }}>{product.fitment}</div>
          {SHOW_PRICING ? (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, marginTop: 6 }}>
              <span style={{ fontFamily: FONT_FAMILY.display, fontSize: 150, color: theme === 'navy' ? COLORS.gold : COLORS.red }}>{product.price}</span>
              <span style={{ fontFamily: FONT_FAMILY.body, fontWeight: 700, fontSize: 50, color: sub, textDecoration: 'line-through' }}>{product.was}</span>
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>
              <Pill text="EXACT-FIT GUARANTEED" bg={COLORS.green} delay={-1} fontSize={36} />
            </div>
          )}
          <Stars count={5} size={56} delay={-1} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
          <EbayBadge delay={-1} />
          <div
            style={{
              background: COLORS.red,
              borderRadius: 22,
              padding: '22px 50px',
              fontFamily: FONT_FAMILY.display,
              fontSize: 56,
              color: COLORS.white,
              letterSpacing: 1,
            }}
          >
            calibreautoparts.co.uk
          </div>
          <SocialBar delay={-1} />
        </div>
      </AbsoluteFill>
    </Wrap>
  );
};
