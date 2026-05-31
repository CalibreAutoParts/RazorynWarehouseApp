import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, INK, SITE} from './brand';
import {Captions, Cue} from './Captions';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);

const cues: Cue[] = [
  {text: 'Not sure it *fits*?', start: 6, end: 60},
  {text: 'Send us your *reg*', start: 70, end: 150},
  {text: '*Confirmed* before you buy', start: 150, end: 215},
  {text: 'Buy with *confidence*', start: 222, end: 290},
];

// UK number plate
const Plate: React.FC<{reg: string; style?: React.CSSProperties}> = ({reg, style}) => (
  <div style={{background: '#f4c20d', border: '4px solid #111', borderRadius: 14, padding: '10px 26px', fontFamily: barlow, fontWeight: 800, fontSize: 92, letterSpacing: 6, color: '#111', ...style}}>{reg}</div>
);

const Bubble: React.FC<{side: 'l' | 'r'; bg: string; color: string; children: React.ReactNode; o: number}> = ({side, bg, color, children, o}) => (
  <div style={{alignSelf: side === 'r' ? 'flex-end' : 'flex-start', maxWidth: 760, background: bg, color, fontFamily: inter, fontWeight: 700, fontSize: 38, padding: '22px 30px', borderRadius: 26, margin: '12px 0', opacity: o, transform: `translateY(${interpolate(o, [0, 1], [24, 0])}px)`}}>{children}</div>
);

export const FitmentSupport: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const hookOut = interpolate(frame, [56, 66], [1, 0], clamp);
  const hookS = spring({frame, fps, config: {damping: 10, stiffness: 160}});
  const chatIn = interpolate(frame, [62, 76], [0, 1], clamp);
  const chatOut = interpolate(frame, [212, 222], [1, 0], clamp);
  const b1 = interpolate(frame, [80, 92], [0, 1], clamp);
  const b2 = interpolate(frame, [120, 132], [0, 1], clamp);
  const b3 = interpolate(frame, [165, 178], [0, 1], clamp);
  const ctaIn = interpolate(frame, [222, 240], [0, 1], clamp);
  const fade = interpolate(frame, [0, 8, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], clamp);

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      <Audio src={sfx('beat')} loop volume={0.32} />
      <Sequence from={0}><Audio src={sfx('whoosh')} /></Sequence>
      <Sequence from={80}><Audio src={sfx('pop')} /></Sequence>
      <Sequence from={120}><Audio src={sfx('tap')} /></Sequence>
      <Sequence from={165}><Audio src={sfx('chime')} /></Sequence>
      <Sequence from={222}><Audio src={sfx('whoosh')} /></Sequence>

      {/* hook */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 80, textAlign: 'center', opacity: hookOut}}>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 32, letterSpacing: 6, color: RED}}>BUY WITH CONFIDENCE</div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 130, color: '#fff', textTransform: 'uppercase', lineHeight: 0.9, marginTop: 14, transform: `scale(${interpolate(hookS, [0, 1], [0.8, 1])})`}}>
          Will it fit<br />your <span style={{color: RED}}>car?</span>
        </div>
      </AbsoluteFill>

      {/* chat */}
      <AbsoluteFill style={{justifyContent: 'center', padding: '0 80px', opacity: chatIn * chatOut}}>
        <div style={{display: 'flex', flexDirection: 'column'}}>
          <Bubble side="l" bg="#fff" color={INK} o={b1}>Not sure this part fits your car?</Bubble>
          <div style={{alignSelf: 'flex-end', opacity: b2, transform: `translateY(${interpolate(b2, [0, 1], [24, 0])}px)`, margin: '12px 0'}}>
            <Plate reg="AB12 CDE" />
          </div>
          <Bubble side="l" bg={RED} color="#fff" o={b3}>✓ Confirmed — that's the right part for your vehicle. Same-day dispatch.</Bubble>
        </div>
      </AbsoluteFill>

      {/* cta */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 80, opacity: ctaIn, transform: `translateY(${interpolate(ctaIn, [0, 1], [40, 0])}px)`}}>
        <Img src={staticFile('logo_white.png')} style={{height: 76}} />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 104, color: '#fff', textTransform: 'uppercase', lineHeight: 0.95, marginTop: 24}}>Real fitment<br /><span style={{color: RED}}>support</span></div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 36, color: '#fff', marginTop: 26}}>Send your reg or part no.</div>
        <div style={{fontFamily: inter, fontWeight: 600, fontSize: 32, color: 'rgba(255,255,255,.8)', marginTop: 8}}>{SITE} · WhatsApp +44 7494 589542</div>
      </AbsoluteFill>

      <Captions cues={cues} />
    </AbsoluteFill>
  );
};
