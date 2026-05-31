import React from 'react';
import {Composition} from 'remotion';
import {PartsShowcase} from './PartsShowcase';
import {SiteShowcase} from './SiteShowcase';
import {PARTS, MODELS} from './brand';

const FPS = 30;
const INTRO = 48;   // 1.6s
const PER = 48;     // 1.6s per part — snappy montage
const OUTRO = 66;   // 2.2s

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
        durationInFrames={11 * FPS}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{models: MODELS}}
      />
    </>
  );
};
