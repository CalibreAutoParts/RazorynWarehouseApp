import React from 'react';
import { Composition } from 'remotion';
import { CATALOG, type TemplateKey } from './data/catalog';
import { AdSpot } from './compositions/AdSpot';
import { UgcReview } from './compositions/UgcReview';
import { StoryTime } from './compositions/StoryTime';
import { Cartoon } from './compositions/Cartoon';
import { PartsShowcase } from './compositions/PartsShowcase';
import { Promo } from './compositions/Promo';
import { TrustEbay } from './compositions/TrustEbay';
import { Comparison } from './compositions/Comparison';
import { Testimonial } from './compositions/Testimonial';
import { TipCard } from './compositions/TipCard';
import { PhotoAd } from './compositions/PhotoAd';
import { Carousel } from './compositions/Carousel';

// Map template keys -> their React component.
const REGISTRY: Record<TemplateKey, React.FC<any>> = {
  AdSpot,
  UgcReview,
  StoryTime,
  Cartoon,
  PartsShowcase,
  Promo,
  TrustEbay,
  Comparison,
  Testimonial,
  TipCard,
  PhotoAd,
  Carousel,
};

/**
 * Every catalog entry is registered as its own composition/still, so the whole
 * library (hundreds of unique videos + photo/carousel assets) shows up in
 * Remotion Studio and can be rendered individually or in bulk by id.
 */
export const RemotionRoot: React.FC = () => (
  <>
    {CATALOG.map((entry) => {
      const Comp = REGISTRY[entry.template];
      // Stills are registered as short compositions so renderStill can grab a
      // settled frame (frame 0 would be mid-entrance-animation).
      return (
        <Composition
          key={entry.id}
          id={entry.id}
          component={Comp}
          durationInFrames={entry.durationInFrames}
          fps={entry.fps}
          width={entry.width}
          height={entry.height}
          defaultProps={entry.props as any}
        />
      );
    })}
  </>
);
