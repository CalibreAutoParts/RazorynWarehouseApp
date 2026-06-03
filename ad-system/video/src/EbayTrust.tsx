import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, SITE, PARTS} from './brand';
import {Captions, Cue} from './Captions';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);

const Star: React.FC<{s: number; size?: number}> = ({s, size = 70}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{transform: `scale(${s})`}}>
    <path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z" fill="#f4c20d" />
  </svg>
);

const STATS: [string, string][] = [
  ['1,700+', 'items sold'],
  ['98.2%', 'positive feedback'],
  ['TOP-RATED', 'eBay seller'],
  ['UK', 'stock · fast dispatch'],
];

const cues: Cue[] = [
  {text: 'A seller you can *trust*', start: 8, end: 64},
  {text: '*98.2%* positive feedback', start: 78, end: 150},
  {text: 'Now buy *direct & save*', start: 250, end: 320},
];

export const EbayTrust: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const fade = interpolate(frame, [0, 10, durationInFrames - 10, durationInFrames], [0, 1, 1, 0], clamp);
  const hookOut = interpolate(frame, [66, 78], [1, 0], clamp);
  const starS = (i: number) => spring({frame: frame - 6 - i * 5, fps, config: {damping: 12, stiffness: 200}});
  const statsIn = interpolate(frame, [78, 92], [0, 1], clamp);
  const statsOut = interpolate(frame, [206, 218], [1, 0], clamp);
  const gridIn = interpolate(frame, [220, 236], [0, 1], clamp);
  const gridOut = interpolate(frame, [250, 262], [1, 0], clamp);
  const ctaIn = interpolate(frame, [262, 280], [0, 1], clamp);

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      <Audio src={sfx('beat-cinematic')} loop volume={0.4} />
      <Sequence from={0}><Audio src={sfx('whoosh')} /></Sequence>
      {[80, 116, 152, 188].map((f, i) => <Sequence key={i} from={f}><Audio src={sfx('pop')} /></Sequence>)}
      <Sequence from={262}><Audio src={sfx('whoosh')} /></Sequence>

      {/* hook */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 80, textAlign: 'center', opacity: hookOut}}>
        <Img src={staticFile('logo_white.png')} style={{height: 70, marginBottom: 30}} />
        <div style={{display: 'flex', gap: 8}}>{[0, 1, 2, 3, 4].map((i) => <Star key={i} s={interpolate(starS(i), [0, 1], [0, 1])} />)}</div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 120, color: '#fff', textTransform: 'uppercase', lineHeight: 0.9, marginTop: 24}}>Top-rated<br /><span style={{color: RED}}>on eBay</span></div>
        <div style={{fontFamily: inter, fontWeight: 600, fontSize: 32, color: 'rgba(255,255,255,.78)', marginTop: 20}}>Razoryn e-Parts · seller “2daypartsuk”</div>
      </AbsoluteFill>

      {/* stats */}
      <AbsoluteFill style={{justifyContent: 'center', padding: '0 90px', opacity: statsIn * statsOut}}>
        {STATS.map(([big, small], i) => {
          const a = spring({frame: frame - (84 + i * 34), fps, config: {damping: 16}});
          return (
            <div key={i} style={{display: 'flex', alignItems: 'baseline', gap: 24, marginBottom: 36, opacity: a, transform: `translateX(${interpolate(a, [0, 1], [60, 0])}px)`}}>
              <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 110, color: RED, lineHeight: 0.9, minWidth: 360}}>{big}</div>
              <div style={{fontFamily: inter, fontWeight: 700, fontSize: 40, color: '#fff', textTransform: 'uppercase'}}>{small}</div>
            </div>
          );
        })}
      </AbsoluteFill>

      {/* quick parts grid */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 70, opacity: gridIn * gridOut}}>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 70, color: '#fff', textTransform: 'uppercase', marginBottom: 24}}>1000s of parts in stock</div>
        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, width: '100%'}}>
          {PARTS.slice(0, 6).map((p, i) => (
            <div key={i} style={{aspectRatio: '1 / 1', background: '#fff', borderRadius: 16, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
              <Img src={p.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 14}} />
            </div>
          ))}
        </div>
      </AbsoluteFill>

      {/* cta */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 80, opacity: ctaIn, transform: `translateY(${interpolate(ctaIn, [0, 1], [40, 0])}px)`}}>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 96, color: '#fff', textTransform: 'uppercase', lineHeight: 0.95}}>Now shop<br /><span style={{color: RED}}>direct &amp; save</span></div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 46, color: '#fff', background: RED, display: 'inline-block', padding: '16px 46px', borderRadius: 100, marginTop: 22}}>{SITE}</div>
        <div style={{fontFamily: inter, fontWeight: 600, fontSize: 30, color: 'rgba(255,255,255,.75)', marginTop: 18}}>Same trusted seller · also on eBay: 2daypartsuk</div>
      </AbsoluteFill>

      <Captions cues={cues} bottom={230} />
    </AbsoluteFill>
  );
};
