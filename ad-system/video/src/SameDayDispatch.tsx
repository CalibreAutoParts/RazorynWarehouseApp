import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, INK, SITE} from './brand';
import {Captions, Cue} from './Captions';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);

const cues: Cue[] = [
  {text: 'Order before *12pm*', start: 8, end: 120},
  {text: '*Dispatched* today', start: 150, end: 210},
  {text: 'On your *doorstep* fast', start: 218, end: 285},
];

export const SameDayDispatch: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  // clock counts 11:55 -> 12:00 over frames 20..140
  const mins = Math.min(60, Math.round(interpolate(frame, [20, 140], [55, 60], clamp)));
  const hh = mins >= 60 ? 12 : 11;
  const mm = mins >= 60 ? 0 : mins;
  const clock = `${hh}:${String(mm).padStart(2, '0')}`;
  const cutoff = frame >= 140;
  const clockOut = interpolate(frame, [200, 212], [1, 0], clamp);
  const stampS = spring({frame: frame - 150, fps, config: {damping: 8, stiffness: 170}});
  const ctaIn = interpolate(frame, [212, 232], [0, 1], clamp);
  const fade = interpolate(frame, [0, 8, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], clamp);

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      <Audio src={sfx('beat-drive')} loop volume={0.32} />
      {/* ticking up to the cutoff */}
      {[40, 60, 80, 100, 120, 138].map((f, i) => <Sequence key={i} from={f}><Audio src={sfx('tick')} /></Sequence>)}
      <Sequence from={150}><Audio src={sfx('chime')} /></Sequence>
      <Sequence from={212}><Audio src={sfx('whoosh')} /></Sequence>

      {/* clock scene */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: clockOut, padding: 80, textAlign: 'center'}}>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 36, letterSpacing: 6, color: RED}}>SAME-DAY DISPATCH</div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 80, color: '#fff', textTransform: 'uppercase', marginTop: 10}}>Order before</div>
        <div style={{width: 560, height: 560, borderRadius: 40, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '24px 0', boxShadow: '0 40px 100px rgba(0,0,0,.5)', position: 'relative'}}>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 200, color: cutoff ? RED : INK}}>{clock}</div>
          <div style={{position: 'absolute', bottom: 40, fontFamily: inter, fontWeight: 800, fontSize: 34, letterSpacing: 4, color: '#6b7785'}}>NOON CUT-OFF</div>
        </div>
      </AbsoluteFill>

      {/* dispatched stamp */}
      {frame >= 150 && (
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: clockOut}}>
          <div style={{transform: `scale(${interpolate(stampS, [0, 1], [1.6, 1])}) rotate(-8deg)`, opacity: interpolate(stampS, [0, 0.4], [0, 1], clamp), border: `10px solid ${RED}`, color: RED, fontFamily: barlow, fontWeight: 800, fontSize: 120, textTransform: 'uppercase', padding: '20px 50px', borderRadius: 20, background: 'rgba(255,255,255,.96)'}}>
            Dispatched today
          </div>
        </AbsoluteFill>
      )}

      {/* cta */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 80, opacity: ctaIn, transform: `translateY(${interpolate(ctaIn, [0, 1], [40, 0])}px)`}}>
        <Img src={staticFile('logo_white.png')} style={{height: 80}} />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 110, color: '#fff', textTransform: 'uppercase', lineHeight: 0.95, marginTop: 24}}>Order today,<br /><span style={{color: RED}}>gone today</span></div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 36, color: '#fff', marginTop: 24}}>{SITE}</div>
        <div style={{fontFamily: inter, fontWeight: 600, fontSize: 32, color: 'rgba(255,255,255,.8)', marginTop: 8}}>Free UK delivery over £50* · 30-day returns</div>
        <div style={{fontFamily: inter, fontWeight: 500, fontSize: 24, color: 'rgba(255,255,255,.6)', marginTop: 10}}>*Large body panels: flat £50 per item</div>
      </AbsoluteFill>

      <Captions cues={cues} bottom={250} />
    </AbsoluteFill>
  );
};
