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
import collectionsData from './collections.json';
import {PARTS, MODELS} from './brand';

const FPS = 30;
const INTRO = 48;   // 1.6s
const PER = 48;     // 1.6s per part — snappy montage
const OUTRO = 66;   // 2.2s
const COLLECTIONS = collectionsData as Col[];

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="OrderStory"
        component={OrderStory}
        durationInFrames={13 * FPS}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{parts: PARTS}}
      />
      <Composition
        id="PriceReveal"
        component={PriceReveal}
        durationInFrames={10 * FPS}
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
        durationInFrames={11 * FPS}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{models: MODELS}}
      />
      <Composition id="TradeAccount" component={TradeAccount} durationInFrames={10 * FPS} fps={FPS} width={1080} height={1920} />
      <Composition id="FitmentSupport" component={FitmentSupport} durationInFrames={10 * FPS} fps={FPS} width={1080} height={1920} />
      <Composition id="SameDayDispatch" component={SameDayDispatch} durationInFrames={9 * FPS} fps={FPS} width={1080} height={1920} />
      <Composition id="RhdHeadlights" component={RhdHeadlights} durationInFrames={12 * FPS} fps={FPS} width={1080} height={1920} />

      {/* Per-collection conversion ads — two variants each (id: col-<slug> and col-<slug>-deal) */}
      {COLLECTIONS.map((c) => (
        <React.Fragment key={c.slug}>
          <Composition id={`col-${c.slug}`} component={CollectionAd} durationInFrames={12 * FPS} fps={FPS} width={1080} height={1920} defaultProps={{col: c, variant: 'showcase'}} />
          <Composition id={`col-${c.slug}-deal`} component={CollectionAd} durationInFrames={10 * FPS} fps={FPS} width={1080} height={1920} defaultProps={{col: c, variant: 'deal'}} />
        </React.Fragment>
      ))}
    </>
  );
};
