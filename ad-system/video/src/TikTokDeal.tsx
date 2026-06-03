import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, INK, SITE, PARTS} from './brand';
import {Captions, Cue} from './Captions';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);
const CODE = 'TIKTOK5';

// faux TikTok right-action rail + handle, to feel native in-feed
const TikTokChrome: React.FC = () => (
  <>
    <div style={{position: 'absolute', right: 28, bottom: 360, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34}}>
      <div style={{width: 92, height: 92, borderRadius: 50, background: RED, border: '3px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: barlow, fontWeight: 800, fontSize: 50, color: '#fff'}}>R</div>
      {[['♥', '12.4k'], ['★', 'Save'], ['➤', 'Share']].map(([ic, n], i) => (
        <div key={i} style={{textAlign: 'center'}}>
          <div style={{width: 76, height: 76, borderRadius: 50, background: 'rgba(255,255,255,.16)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40, color: '#fff'}}>{ic}</div>
          <div style={{fontFamily: inter, fontWeight: 700, fontSize: 22, color: '#fff', marginTop: 6}}>{n}</div>
        </div>
      ))}
    </div>
    <div style={{position: 'absolute', left: 36, bottom: 150, maxWidth: 760}}>
      <div style={{fontFamily: inter, fontWeight: 800, fontSize: 34, color: '#fff'}}>@razoryn.eparts</div>
      <div style={{fontFamily: inter, fontWeight: 600, fontSize: 28, color: 'rgba(255,255,255,.92)', marginTop: 8}}>5% off your car parts · code {CODE} #carparts #fyp</div>
    </div>
  </>
);

const cues: Cue[] = [
  {text: 'TikTok *exclusive*', start: 8, end: 56},
  {text: 'code *TIKTOK5* = 5% off', start: 90, end: 200},
  {text: 'razoryn.co.uk · *save this*', start: 250, end: 296},
];

export const TikTokDeal: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const fade = interpolate(frame, [0, 6, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], clamp);
  const hero = PARTS.find((p) => p.name.toLowerCase().includes('bumper')) || PARTS[0];
  const hookOut = interpolate(frame, [56, 66], [1, 0], clamp);
  const codeIn = interpolate(frame, [66, 80], [0, 1], clamp);
  const codeOut = interpolate(frame, [206, 216], [1, 0], clamp);
  const codePulse = 1 + 0.04 * Math.sin(frame / 5);
  const partO = interpolate(frame, [120, 134], [0, 1], clamp) * interpolate(frame, [206, 216], [1, 0], clamp);
  const ctaIn = interpolate(frame, [216, 232], [0, 1], clamp);

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      <Audio src={sfx('beat-drive')} loop volume={0.5} />
      <Sequence from={0}><Audio src={sfx('whoosh')} /></Sequence>
      <Sequence from={66}><Audio src={sfx('pop')} /></Sequence>
      <Sequence from={120}><Audio src={sfx('pop')} /></Sequence>
      <Sequence from={216}><Audio src={sfx('chime')} /></Sequence>

      {/* hook */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 70, textAlign: 'center', opacity: hookOut}}>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 34, letterSpacing: 6, color: RED}}>TIKTOK EXCLUSIVE</div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 230, color: '#fff', lineHeight: 0.86, marginTop: 10}}>5% OFF</div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 36, color: 'rgba(255,255,255,.82)', marginTop: 8}}>your car parts — today only on TikTok</div>
      </AbsoluteFill>

      {/* code */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: codeIn * codeOut}}>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 40, letterSpacing: 4, color: '#fff'}}>USE CODE AT CHECKOUT</div>
        <div style={{marginTop: 24, transform: `scale(${codePulse})`, border: '6px dashed #fff', borderRadius: 28, padding: '28px 60px', background: 'rgba(255,255,255,.06)'}}>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 180, color: RED, lineHeight: 0.9}}>{CODE}</div>
        </div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 34, color: 'rgba(255,255,255,.85)', marginTop: 22}}>= 5% off your order</div>
        {/* hero part peeking */}
        <div style={{position: 'absolute', bottom: 80, width: 360, height: 360, opacity: partO}}>
          <Img src={hero.img} style={{width: '100%', height: '100%', objectFit: 'contain'}} />
        </div>
      </AbsoluteFill>

      {/* cta */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 70, opacity: ctaIn, transform: `translateY(${interpolate(ctaIn, [0, 1], [40, 0])}px)`}}>
        <Img src={staticFile('logo_white.png')} style={{height: 76}} />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 110, color: '#fff', textTransform: 'uppercase', marginTop: 20}}>Shop now</div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 44, color: '#fff', background: RED, display: 'inline-block', padding: '16px 46px', borderRadius: 100, marginTop: 14}}>{SITE}</div>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 40, color: '#fff', marginTop: 18}}>code <span style={{color: RED}}>{CODE}</span> · 5% off</div>
      </AbsoluteFill>

      <TikTokChrome />
      <Captions cues={cues} bottom={250} />
    </AbsoluteFill>
  );
};
