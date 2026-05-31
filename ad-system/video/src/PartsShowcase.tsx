import React from 'react';
import {AbsoluteFill, Img, Series, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, RED_DARK, MUT, SITE, Part} from './brand';

const Logo: React.FC = () => (
  <Img src={staticFile('logo_white.png')} style={{position: 'absolute', top: 70, left: 70, height: 70}} />
);

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const e = spring({frame, fps, config: {damping: 200}});
  const y = interpolate(e, [0, 1], [60, 0]);
  const o = interpolate(frame, [0, 12], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{justifyContent: 'center', padding: 90, opacity: o, transform: `translateY(${y}px)`}}>
      <div style={{color: RED, fontFamily: inter, fontWeight: 800, fontSize: 34, letterSpacing: 6}}>AFTERMARKET BODY PANELS &amp; TRIM</div>
      <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 150, lineHeight: 0.92, textTransform: 'uppercase', marginTop: 16}}>
        Quality car parts <span style={{color: RED}}>without the markup</span>
      </div>
      <div style={{fontFamily: inter, fontWeight: 500, fontSize: 36, color: MUT, marginTop: 28}}>Toyota · Hyundai · Kia · Nissan · Peugeot · Vauxhall</div>
    </AbsoluteFill>
  );
};

const PartCard: React.FC<{part: Part}> = ({part}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const e = spring({frame, fps, config: {damping: 200}});
  const imgScale = interpolate(frame, [0, durationInFrames], [1.06, 1.14]); // slow ken-burns
  const cardScale = interpolate(e, [0, 1], [0.92, 1]);
  const slide = interpolate(e, [0, 1], [70, 0]);
  const out = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {extrapolateLeft: 'clamp'});
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', padding: 80, opacity: out}}>
      <div style={{width: 860, height: 860, background: '#fff', borderRadius: 48, overflow: 'hidden', boxShadow: '0 40px 90px rgba(0,0,0,.45)', transform: `scale(${cardScale})`, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
        <Img src={part.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 60, transform: `scale(${imgScale})`}} />
      </div>
      <div style={{transform: `translateY(${slide}px)`, textAlign: 'center', marginTop: 50}}>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 32, letterSpacing: 4, color: RED_DARK, textTransform: 'uppercase'}}>{part.model}</div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 78, textTransform: 'uppercase', lineHeight: 0.95, marginTop: 6}}>{part.name}</div>
        <div style={{display: 'inline-block', background: RED, color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 76, padding: '8px 40px', borderRadius: 24, marginTop: 22}}>{part.price}</div>
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const e = spring({frame, fps, config: {damping: 200}});
  const s = interpolate(e, [0, 1], [0.9, 1]);
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', transform: `scale(${s})`}}>
      <Img src={staticFile('logo_white.png')} style={{height: 110}} />
      <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 120, marginTop: 30}}>{SITE}</div>
      <div style={{fontFamily: inter, fontWeight: 600, fontSize: 40, color: MUT, marginTop: 16, textAlign: 'center'}}>
        Same-day dispatch · Free UK delivery over £50
      </div>
      <div style={{fontFamily: inter, fontWeight: 700, fontSize: 34, color: '#fff', background: RED, padding: '14px 44px', borderRadius: 100, marginTop: 40}}>
        Order before 12pm — dispatched today
      </div>
    </AbsoluteFill>
  );
};

export const PartsShowcase: React.FC<{parts: Part[]; intro: number; per: number; outro: number}> = ({parts, intro, per, outro}) => {
  return (
    <AbsoluteFill style={{backgroundColor: NAVY, color: '#fff', fontFamily: inter}}>
      <Logo />
      <Series>
        <Series.Sequence durationInFrames={intro}>
          <Intro />
        </Series.Sequence>
        {parts.map((p, i) => (
          <Series.Sequence key={i} durationInFrames={per}>
            <PartCard part={p} />
          </Series.Sequence>
        ))}
        <Series.Sequence durationInFrames={outro}>
          <Outro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
