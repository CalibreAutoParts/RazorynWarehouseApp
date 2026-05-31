import React from 'react';
import {Composition} from 'remotion';
import {PartsShowcase} from './PartsShowcase';
import {SiteShowcase} from './SiteShowcase';
import {PARTS} from './brand';

const FPS = 30;
const INTRO = 90;   // 3s
const PER = 78;     // ~2.6s per part
const OUTRO = 96;   // 3.2s

export const RemotionRoot: React.FC = () => {
  return (
    <>
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
        defaultProps={{parts: PARTS}}
      />
    </>
  );
};
