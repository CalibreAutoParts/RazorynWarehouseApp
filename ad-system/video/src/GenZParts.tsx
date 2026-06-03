import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, random, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, SITE, PARTS} from './brand';
import {Captions, Cue} from './Captions';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);

// quick shake for that hand-held / hype energy
const shake = (frame: number, amp = 6) => ({
  x: (random(`x${Math.floor(frame / 3)}`) - 0.5) * amp,
  y: (random(`y${Math.floor(frame / 3)}`) - 0.5) * amp,
});

const Big: React.FC<{children: React.ReactNode; bg: string; color?: string; size?: number}> = ({children, bg, color = '#fff', size = 130}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame, fps, config: {damping: 9, stiffness: 200}});
  const sh = shake(frame);
  return (
    <AbsoluteFill style={{background: bg, alignItems: 'center', justifyContent: 'center', padding: 70, textAlign: 'center'}}>
      <div style={{fontFamily: barlow, fontWeight: 800, fontSize: size, color, textTransform: 'uppercase', lineHeight: 0.86, transform: `scale(${interpolate(s, [0, 1], [0.7, 1])}) translate(${sh.x}px,${sh.y}px)`}}>{children}</div>
    </AbsoluteFill>
  );
};

const cues: Cue[] = [
  {text: 'don’t pay *dealer* prices', start: 42, end: 96},
  {text: 'brand-new · *half* the price', start: 150, end: 210},
  {text: 'razoryn.co.uk — *link in bio*', start: 220, end: 296},
];

export const GenZParts: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const fade = interpolate(frame, [0, 6, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], clamp);
  const hero = PARTS.find((p) => p.name.toLowerCase().includes('bumper')) || PARTS[1] || PARTS[0];
  const priceS = spring({frame: frame - 96, fps, config: {damping: 8, stiffness: 180}});

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      <Audio src={sfx('beat-trap')} loop volume={0.5} />
      {[0, 42, 96, 150, 210].map((f, i) => <Sequence key={i} from={f}><Audio src={sfx(i % 2 ? 'pop' : 'whoosh')} /></Sequence>)}

      {/* fast hooks */}
      <Sequence from={0} durationInFrames={42}><Big bg={RED}>POV: your<br />bumper’s<br />wrecked</Big></Sequence>
      <Sequence from={42} durationInFrames={54}><Big bg={NAVY}>dealer wants<br /><span style={{color: RED}}>£££?</span></Big></Sequence>

      {/* part + price slam */}
      <Sequence from={96} durationInFrames={114}>
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
          {(() => { const f = frame - 96; const sh = shake(frame, 4); const zin = interpolate(f, [0, 14], [0.6, 1], clamp);
            return (
            <>
              <div style={{width: 760, height: 760, background: '#fff', borderRadius: 40, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${zin}) translate(${sh.x}px,${sh.y}px)`}}>
                <Img src={hero.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 54}} />
              </div>
              <div style={{position: 'absolute', bottom: 380, transform: `rotate(-6deg) scale(${interpolate(priceS, [0, 1], [0.3, 1])})`, background: RED, color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 150, padding: '6px 40px', borderRadius: 20}}>{hero.price}</div>
              <div style={{position: 'absolute', top: 150, fontFamily: barlow, fontWeight: 800, fontSize: 90, color: '#fff', textTransform: 'uppercase'}}>brand-new btw</div>
            </>
          ); })()}
        </AbsoluteFill>
      </Sequence>

      {/* cta */}
      <Sequence from={210}>
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 70}}>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 150, color: '#fff', textTransform: 'uppercase', lineHeight: 0.86}}>we got<br /><span style={{color: RED}}>you</span></div>
          <Img src={staticFile('logo_white.png')} style={{height: 60, marginTop: 30}} />
          <div style={{fontFamily: inter, fontWeight: 800, fontSize: 50, color: '#fff', background: RED, display: 'inline-block', padding: '14px 40px', borderRadius: 100, marginTop: 18}}>{SITE}</div>
          <div style={{fontFamily: inter, fontWeight: 700, fontSize: 32, color: 'rgba(255,255,255,.8)', marginTop: 16}}>same-day dispatch · UK stock</div>
        </AbsoluteFill>
      </Sequence>

      <Captions cues={cues} bottom={250} />
    </AbsoluteFill>
  );
};
