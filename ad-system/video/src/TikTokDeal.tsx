import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, SITE} from './brand';
import {Captions, Cue} from './Captions';
import {Col} from './CollectionAd';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);
const CODE = 'TIKTOK5';

export const TikTokDeal: React.FC<{col: Col}> = ({col}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const fade = interpolate(frame, [0, 6, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], clamp);
  const parts = col.parts;
  const hero = parts.find((p) => /bumper|grille|headlight|light/i.test(p.name)) || parts[0];

  // scenes: hook 0-58 | product 60-150 | code 152-250 | cta 252-end
  const hookOut = interpolate(frame, [56, 66], [1, 0], clamp);
  const prodIn = interpolate(frame, [62, 76], [0, 1], clamp) * interpolate(frame, [150, 160], [1, 0], clamp);
  const prodS = spring({frame: frame - 62, fps, config: {damping: 16}});
  const codeIn = interpolate(frame, [160, 174], [0, 1], clamp) * interpolate(frame, [244, 254], [1, 0], clamp);
  const codePulse = 1 + 0.04 * Math.sin(frame / 5);
  const ctaIn = interpolate(frame, [254, 272], [0, 1], clamp);

  const cues: Cue[] = [
    {text: 'TikTok *exclusive*', start: 8, end: 56},
    {text: `*${col.model}* parts`, start: 70, end: 144},
    {text: 'code *TIKTOK5* = 5% off', start: 168, end: 244},
    {text: 'razoryn.co.uk · *save this*', start: 262, end: durationInFrames - 14},
  ];

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      <Audio src={sfx('beat-drive')} loop volume={0.5} />
      <Sequence from={0}><Audio src={sfx('whoosh')} /></Sequence>
      <Sequence from={62}><Audio src={sfx('pop')} /></Sequence>
      <Sequence from={160}><Audio src={sfx('pop')} /></Sequence>
      <Sequence from={254}><Audio src={sfx('chime')} /></Sequence>

      {/* hook */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 70, textAlign: 'center', opacity: hookOut}}>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 34, letterSpacing: 6, color: RED}}>TIKTOK EXCLUSIVE</div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 240, color: '#fff', lineHeight: 0.86, marginTop: 10}}>5% OFF</div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 38, color: 'rgba(255,255,255,.85)', marginTop: 8}}>{col.model} parts — today only on TikTok</div>
      </AbsoluteFill>

      {/* product — clean card, text BELOW the image (no overlap) */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 70, opacity: prodIn}}>
        <div style={{width: 760, height: 760, background: '#fff', borderRadius: 40, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 40px 100px rgba(0,0,0,.5)', transform: `scale(${interpolate(prodS, [0, 1], [0.9, 1])})`}}>
          <Img src={hero.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 56}} />
        </div>
        <div style={{textAlign: 'center', marginTop: 40, transform: `translateY(${interpolate(prodS, [0, 1], [40, 0])}px)`}}>
          <div style={{fontFamily: inter, fontWeight: 800, fontSize: 30, letterSpacing: 4, color: RED}}>{col.model.toUpperCase()}</div>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 70, color: '#fff', textTransform: 'uppercase', lineHeight: 0.95, marginTop: 6}}>{hero.name}</div>
          <div style={{display: 'inline-block', background: RED, color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 74, padding: '6px 36px', borderRadius: 22, marginTop: 16}}>{hero.price}</div>
        </div>
      </AbsoluteFill>

      {/* code — no image behind it */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 60, opacity: codeIn}}>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 40, letterSpacing: 4, color: '#fff'}}>USE CODE AT CHECKOUT</div>
        <div style={{marginTop: 24, transform: `scale(${codePulse})`, border: '6px dashed #fff', borderRadius: 28, padding: '28px 60px', background: 'rgba(255,255,255,.06)'}}>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 180, color: RED, lineHeight: 0.9}}>{CODE}</div>
        </div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 36, color: 'rgba(255,255,255,.9)', marginTop: 24}}>= 5% off your order</div>
      </AbsoluteFill>

      {/* cta */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 70, opacity: ctaIn, transform: `translateY(${interpolate(ctaIn, [0, 1], [40, 0])}px)`}}>
        <Img src={staticFile('logo_white.png')} style={{height: 76}} />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 110, color: '#fff', textTransform: 'uppercase', marginTop: 20}}>Shop now</div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 44, color: '#fff', background: RED, display: 'inline-block', padding: '16px 46px', borderRadius: 100, marginTop: 14}}>{SITE}</div>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 40, color: '#fff', marginTop: 18}}>code <span style={{color: RED}}>{CODE}</span> · 5% off</div>
      </AbsoluteFill>

      <Captions cues={cues} bottom={250} />
    </AbsoluteFill>
  );
};
