import React, { useState } from 'react';
import { Img, interpolate, useCurrentFrame } from 'remotion';
import { PartArt } from './PartArt';
import type { Product } from '../data/products';

/**
 * Shows the REAL product photo (product.image) in a clean rounded card. If the
 * image can't load — e.g. when rendering in an environment without network
 * access to the Shopify CDN — it falls back to the branded vector illustration,
 * so a render never breaks. On a networked machine the genuine photo shows.
 */
export const ProductImage: React.FC<{
  product: Product;
  size?: number;
  float?: boolean;
  delay?: number;
}> = ({ product, size = 460, float = true, delay = 0 }) => {
  const [failed, setFailed] = useState(false);
  const frame = useCurrentFrame();
  const enter = interpolate(frame - delay, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const dy = float ? Math.sin((frame - delay) / 18) * 8 : 0;

  if (!product.image || failed) {
    return <PartArt part={product.part} size={size} float={float} delay={delay} />;
  }

  return (
    <div
      style={{
        transform: `translateY(${dy}px) scale(${interpolate(enter, [0, 1], [0.85, 1])})`,
        opacity: enter,
        width: size,
        height: size * 0.82,
        borderRadius: 28,
        overflow: 'hidden',
        background: '#fff',
        border: '4px solid rgba(255,255,255,0.14)',
        boxShadow: '0 24px 48px rgba(0,0,0,0.4)',
      }}
    >
      <Img src={product.image} onError={() => setFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    </div>
  );
};
