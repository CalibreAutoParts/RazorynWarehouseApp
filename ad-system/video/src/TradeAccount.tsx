import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, SITE} from './brand';
import {Captions, Cue} from './Captions';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);

const BENEFITS: [string, string][] = [
  ['Trade-tier pricing', 'Better rates the more you order'],
  ['Priority same-day dispatch', 'Out before 12pm, jump the queue'],
  ['Account billing', '30-day terms & bulk ordering'],
  ['Dedicated support', 'Real fitment help, one contact'],
];

const cues: Cue[] = [
  {text: 'Run a *garage* or bodyshop?', start: 6, end: 56},
  {text: '*Trade pricing* on every part', start: 70, end: 120},
  {text: '*Priority* same-day dispatch', start: 120, end: 165},
  {text: 'Apply *free* in minutes', start: 215, end: 290},
];

const Check: React.FC = () => (
  <svg width="46" height="46" viewBox="0 0 24 24" style={{flex: '0 0 auto'}}><circle cx="12" cy="12" r="11" fill={RED} /><path d="M7 12.4l3 3 7-7" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const TradeAccount: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const hookOut = interpolate(frame, [56, 66], [1, 0], clamp);
  const hookS = spring({frame, fps, config: {damping: 10, stiffness: 160}});
  const listIn = interpolate(frame, [62, 76], [0, 1], clamp);
  const listOut = interpolate(frame, [206, 216], [1, 0], clamp);
  const ctaIn = interpolate(frame, [216, 236], [0, 1], clamp);
  const fade = interpolate(frame, [0, 8, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], clamp);

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      <Audio src={sfx('beat-lofi')} loop volume={0.34} />
      <Sequence from={0}><Audio src={sfx('whoosh')} /></Sequence>
      {[78, 110, 142, 174].map((f, i) => <Sequence key={i} from={f}><Audio src={sfx('pop')} /></Sequence>)}
      <Sequence from={216}><Audio src={sfx('whoosh')} /></Sequence>

      {/* hook */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 80, textAlign: 'center', opacity: hookOut}}>
        <Img src={staticFile('logo_white.png')} style={{height: 64, marginBottom: 26}} />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 128, color: '#fff', textTransform: 'uppercase', lineHeight: 0.9, transform: `scale(${interpolate(hookS, [0, 1], [0.78, 1])})`}}>
          Run a garage<br />or <span style={{color: RED}}>bodyshop?</span>
        </div>
      </AbsoluteFill>

      {/* benefits */}
      <AbsoluteFill style={{justifyContent: 'center', padding: '0 90px', opacity: listIn * listOut}}>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 32, letterSpacing: 5, color: RED, marginBottom: 30}}>RAZORYN TRADE ACCOUNT</div>
        {BENEFITS.map(([t, s], i) => {
          const a = spring({frame: frame - (74 + i * 32), fps, config: {damping: 16}});
          return (
            <div key={i} style={{display: 'flex', alignItems: 'center', gap: 26, marginBottom: 34, opacity: a, transform: `translateX(${interpolate(a, [0, 1], [60, 0])}px)`}}>
              <Check />
              <div>
                <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 62, color: '#fff', textTransform: 'uppercase', lineHeight: 1}}>{t}</div>
                <div style={{fontFamily: inter, fontWeight: 500, fontSize: 30, color: 'rgba(255,255,255,.7)', marginTop: 4}}>{s}</div>
              </div>
            </div>
          );
        })}
      </AbsoluteFill>

      {/* cta */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 80, opacity: ctaIn, transform: `translateY(${interpolate(ctaIn, [0, 1], [40, 0])}px)`}}>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 104, color: '#fff', textTransform: 'uppercase', lineHeight: 0.95}}>Apply for a<br /><span style={{color: RED}}>trade account</span></div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 36, color: '#fff', marginTop: 28}}>{SITE} · 01923 372432</div>
        <div style={{fontFamily: inter, fontWeight: 600, fontSize: 30, color: 'rgba(255,255,255,.75)', marginTop: 8}}>Free to apply · approved fast</div>
      </AbsoluteFill>

      <Captions cues={cues} />
    </AbsoluteFill>
  );
};
