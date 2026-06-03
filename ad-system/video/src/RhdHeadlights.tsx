import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, Series, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, INK, SITE} from './brand';
import {Captions, Cue} from './Captions';
import headlights from './headlights.json';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);
type Head = {img: string; model: string; name: string; price: string};
const HEADS = headlights as Head[];

const RhdBadge: React.FC = () => (
  <div style={{display: 'inline-block', background: RED, color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 30, letterSpacing: 2, padding: '6px 18px', borderRadius: 10}}>RHD · UK SPEC</div>
);

const HeadSlide: React.FC<{h: Head}> = ({h}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const e = spring({frame, fps, config: {damping: 200}});
  const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], {extrapolateLeft: 'clamp'});
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: out}}>
      <div style={{width: 820, height: 720, background: '#fff', borderRadius: 40, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 40px 90px rgba(0,0,0,.45)', transform: `scale(${interpolate(e, [0, 1], [0.92, 1])})`}}>
        <Img src={h.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 50}} />
      </div>
      <div style={{textAlign: 'center', marginTop: 34, transform: `translateY(${interpolate(e, [0, 1], [40, 0])}px)`}}>
        <RhdBadge />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 64, color: '#fff', textTransform: 'uppercase', marginTop: 12}}>{h.model}</div>
        <div style={{display: 'inline-block', background: RED, color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 60, padding: '6px 32px', borderRadius: 20, marginTop: 12}}>{h.price}</div>
      </div>
    </AbsoluteFill>
  );
};

export const RhdHeadlights: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const fade = interpolate(frame, [0, 10, durationInFrames - 10, durationInFrames], [0, 1, 1, 0], clamp);
  const hookOut = interpolate(frame, [66, 78], [1, 0], clamp);
  const hookS = spring({frame, fps, config: {damping: 12, stiffness: 150}});
  const mFrom = 78, mDur = 168;
  const per = Math.floor(mDur / Math.min(HEADS.length, 6));
  const valIn = interpolate(frame, [mFrom + mDur, mFrom + mDur + 14], [0, 1], clamp);
  const valOut = interpolate(frame, [294, 304], [1, 0], clamp);
  const ctaIn = interpolate(frame, [304, 322], [0, 1], clamp);
  const cues: Cue[] = [
    {text: '*UK-spec* headlights', start: 8, end: 72},
    {text: 'Correct *RHD* beam pattern', start: 84, end: 150},
    {text: 'Shop at *razoryn.co.uk*', start: 312, end: 358},
  ];
  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      <Audio src={sfx('beat')} loop volume={0.34} />
      <Sequence from={0}><Audio src={sfx('whoosh')} /></Sequence>
      <Sequence from={mFrom}><Audio src={sfx('whoosh')} /></Sequence>
      <Sequence from={304}><Audio src={sfx('pop')} /></Sequence>
      {/* hook */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 80, textAlign: 'center', opacity: hookOut}}>
        <Img src={staticFile('logo_white.png')} style={{height: 64, marginBottom: 24}} />
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 34, letterSpacing: 6, color: RED}}>BUILT FOR UK ROADS</div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 150, color: '#fff', textTransform: 'uppercase', lineHeight: 0.86, marginTop: 14, transform: `scale(${interpolate(hookS, [0, 1], [0.8, 1])})`}}>Right-hand<br /><span style={{color: RED}}>drive</span> lights</div>
        <div style={{fontFamily: inter, fontWeight: 500, fontSize: 32, color: 'rgba(255,255,255,.78)', marginTop: 22}}>Correct UK beam pattern · aftermarket · in stock</div>
      </AbsoluteFill>
      {/* montage */}
      <Sequence from={mFrom} durationInFrames={mDur}>
        <Series>
          {HEADS.slice(0, 6).map((h, i) => (
            <Series.Sequence key={i} durationInFrames={per}><HeadSlide h={h} /></Series.Sequence>
          ))}
        </Series>
      </Sequence>
      {/* value */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 80, opacity: valIn * valOut}}>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 110, color: '#fff', textTransform: 'uppercase', lineHeight: 0.95}}>UK-spec lights<br /><span style={{color: RED}}>for your car</span></div>
        <div style={{fontFamily: inter, fontWeight: 600, fontSize: 34, color: 'rgba(255,255,255,.8)', marginTop: 18}}>Toyota · Hyundai · Kia · Nissan & more · same-day dispatch</div>
      </AbsoluteFill>
      {/* cta */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 80, opacity: ctaIn, transform: `translateY(${interpolate(ctaIn, [0, 1], [40, 0])}px)`}}>
        <Img src={staticFile('logo_white.png')} style={{height: 84}} />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 130, color: '#fff', textTransform: 'uppercase', marginTop: 22}}>Shop now</div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 44, color: '#fff', background: RED, display: 'inline-block', padding: '16px 46px', borderRadius: 100, marginTop: 16}}>{SITE}</div>
        <div style={{fontFamily: inter, fontWeight: 600, fontSize: 30, color: 'rgba(255,255,255,.75)', marginTop: 18}}>Search “headlight” + your model · free UK delivery over £50*</div>
      </AbsoluteFill>
      <Captions cues={cues} bottom={230} />
    </AbsoluteFill>
  );
};
