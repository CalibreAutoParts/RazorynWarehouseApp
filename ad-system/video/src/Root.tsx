import React from 'react';
import {Composition} from 'remotion';
import {PartsShowcase} from './PartsShowcase';
import {SiteShowcase} from './SiteShowcase';
import {OrderStory} from './OrderStory';
import {PriceReveal} from './PriceReveal';
import {TradeAccount} from './TradeAccount';
import {FitmentSupport} from './FitmentSupport';
import {SameDayDispatch} from './SameDayDispatch';
import {CollectionAd, Col} from './CollectionAd';
import {RhdHeadlights} from './RhdHeadlights';
import {EbayTrust} from './EbayTrust';
import {GenZParts} from './GenZParts';
import {TikTokDeal} from './TikTokDeal';
import collectionsData from './collections.json';
import {PARTS, MODELS} from './brand';

const FPS = 30;
const INTRO = 48;   // 1.6s
const PER = 48;     // 1.6s per part — snappy montage
const OUTRO = 102;  // 3.4s — end card holds long enough to read
const COLLECTIONS = collectionsData as Col[];

// generic "all cars" collection for the brand-level TikTok deal
const TIKTOK_ALL: Col = {
  slug: 'all', title: 'Razoryn e-Parts', model: 'your car',
  img: PARTS[0].img, url: 'https://www.razoryn.co.uk', count: 0,
  from: PARTS[PARTS.length - 1].price,
  parts: PARTS.map((p) => ({img: p.img, name: p.name, price: p.price})),
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="OrderStory"
        component={OrderStory}
        durationInFrames={14 * FPS}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{parts: PARTS}}
      />
      <Composition
        id="PriceReveal"
        component={PriceReveal}
        durationInFrames={12 * FPS}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{parts: PARTS}}
      />
      <Composition
        id="PartsShowcase"
        component={PartsShowcase}
        durationInFrames={INTRO + PARTS.length * PER + OUTRO}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{parts: PARTS, intro: INTRO, per: PER, outro: OUTRO}}
      />
      <Composition
        id="SiteShowcase"
        component={SiteShowcase}
        durationInFrames={14 * FPS}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{models: MODELS}}
      />
      <Composition id="TradeAccount" component={TradeAccount} durationInFrames={12 * FPS} fps={FPS} width={1080} height={1920} />
      <Composition id="FitmentSupport" component={FitmentSupport} durationInFrames={12 * FPS} fps={FPS} width={1080} height={1920} />
      <Composition id="SameDayDispatch" component={SameDayDispatch} durationInFrames={11 * FPS} fps={FPS} width={1080} height={1920} />
      <Composition id="RhdHeadlights" component={RhdHeadlights} durationInFrames={14 * FPS} fps={FPS} width={1080} height={1920} />
      <Composition id="EbayTrust" component={EbayTrust} durationInFrames={13 * FPS} fps={FPS} width={1080} height={1920} />
      <Composition id="GenZParts" component={GenZParts} durationInFrames={11 * FPS} fps={FPS} width={1080} height={1920} />
      <Composition id="TikTokDeal" component={TikTokDeal} durationInFrames={11 * FPS} fps={FPS} width={1080} height={1920} defaultProps={{col: TIKTOK_ALL}} />

      {/* Per-collection conversion ads — two variants each (id: col-<slug> and col-<slug>-deal) */}
      {COLLECTIONS.map((c) => (
        <React.Fragment key={c.slug}>
          <Composition id={`col-${c.slug}`} component={CollectionAd} durationInFrames={14 * FPS} fps={FPS} width={1080} height={1920} defaultProps={{col: c, variant: 'showcase'}} />
          <Composition id={`col-${c.slug}-deal`} component={CollectionAd} durationInFrames={11 * FPS} fps={FPS} width={1080} height={1920} defaultProps={{col: c, variant: 'deal'}} />
        </React.Fragment>
      ))}

      {/* TikTok deal (code TIKTOK5) per collection — for A/B testing which model converts */}
      {COLLECTIONS.map((c) => (
        <Composition key={c.slug} id={`tiktok-${c.slug}`} component={TikTokDeal} durationInFrames={11 * FPS} fps={FPS} width={1080} height={1920} defaultProps={{col: c}} />
      ))}
    </>
  );
};
