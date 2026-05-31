import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, INK, SITE, Part} from './brand';
import {Captions, Cue} from './Captions';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);

const cues: Cue[] = [
  {text: '*Stop* overpaying', start: 6, end: 56},
  {text: 'Brand-new *aftermarket*', start: 64, end: 146},
  {text: '*Website* exclusive price', start: 152, end: 222},
];

export const PriceReveal: React.FC<{parts: Part[]}> = ({parts}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const p = parts.find((x) => x.name.toLowerCase().includes('bumper')) || parts[0];

  // scenes (30fps): hook 0-60, part 60-150, price 150-225, cta 225-300
  const hookOut = interpolate(frame, [52, 62], [1, 0], clamp);
  const hookPunch = spring({frame, fps, config: {damping: 9, stiffness: 180}});
  const partIn = interpolate(frame, [62, 78], [0, 1], clamp);
  const partOut = interpolate(frame, [150, 160], [1, 0], clamp);
  const imgZoom = interpolate(frame, [62, 150], [1.05, 1.18], clamp);
  const priceIn = spring({frame: frame - 150, fps, config: {damping: 8, stiffness: 170}});
  const priceScale = interpolate(priceIn, [0, 1], [0.3, 1]);
  const priceOut = interpolate(frame, [220, 230], [1, 0], clamp);
  const ctaIn = interpolate(frame, [230, 248], [0, 1], clamp);
  const fade = interpolate(frame, [0, 8, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], clamp);

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      <Audio src={sfx('beat')} loop volume={0.4} />
      <Sequence from={0}><Audio src={sfx('whoosh')} /></Sequence>
      <Sequence from={62}><Audio src={sfx('whoosh')} /></Sequence>
      <Sequence from={150}><Audio src={sfx('pop')} /></Sequence>
      <Sequence from={230}><Audio src={sfx('whoosh')} /></Sequence>

      {/* HOOK */}
      <AbsoluteFill style={{background: RED, alignItems: 'center', justifyContent: 'center', padding: 80, textAlign: 'center', opacity: hookOut}}>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 130, color: '#fff', textTransform: 'uppercase', lineHeight: 0.9, transform: `scale(${interpolate(hookPunch, [0, 1], [0.7, 1])})`}}>
          Paying too much<br />for car parts?
        </div>
      </AbsoluteFill>

      {/* PART */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: partIn * partOut}}>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 34, letterSpacing: 6, color: RED, position: 'absolute', top: 230}}>BRAND-NEW · AFTERMARKET</div>
        <div style={{width: 820, height: 820, background: '#fff', borderRadius: 40, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 40px 100px rgba(0,0,0,.5)'}}>
          <Img src={p.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 60, transform: `scale(${imgZoom})`}} />
        </div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 72, color: '#fff', textTransform: 'uppercase', position: 'absolute', bottom: 360, textAlign: 'center'}}>{p.model}<br /><span style={{fontSize: 50, color: 'rgba(255,255,255,.85)'}}>{p.name}</span></div>
      </AbsoluteFill>

      {/* PRICE SLAM */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: priceOut}}>
        <div style={{opacity: interpolate(frame, [150, 158], [0, 1], clamp), transform: `scale(${priceScale})`, textAlign: 'center'}}>
          <div style={{fontFamily: inter, fontWeight: 800, fontSize: 40, letterSpacing: 6, color: RED}}>WEBSITE EXCLUSIVE PRICE</div>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 320, color: '#fff', lineHeight: 0.9}}>{p.price}</div>
          <div style={{fontFamily: inter, fontWeight: 700, fontSize: 38, color: 'rgba(255,255,255,.8)'}}>Buy direct &amp; save · same-day dispatch</div>
        </div>
      </AbsoluteFill>

      {/* CTA */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: ctaIn, textAlign: 'center', transform: `translateY(${interpolate(ctaIn, [0, 1], [40, 0])}px)`}}>
        <Img src={staticFile('logo_white.png')} style={{height: 84}} />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 120, color: '#fff', marginTop: 20}}>{SITE}</div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 36, color: '#fff', background: RED, display: 'inline-block', padding: '14px 44px', borderRadius: 100, marginTop: 18}}>Free UK delivery over £50</div>
      </AbsoluteFill>

      <Captions cues={cues} bottom={210} />
    </AbsoluteFill>
  );
};
