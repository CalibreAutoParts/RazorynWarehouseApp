import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, Series, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, RED_DARK, INK, SITE} from './brand';
import {Captions, Cue} from './Captions';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);

export type ColPart = {img: string; name: string; price: string};
export type Col = {slug: string; title: string; model: string; img: string; url: string; count: number; from: string; parts: ColPart[]};

const Logo: React.FC<{h?: number}> = ({h = 64}) => (
  <Img src={staticFile('logo_white.png')} style={{position: 'absolute', top: 64, left: 70, height: h}} />
);

// big conversion CTA — always drives to the website
const CTA: React.FC<{col: Col; o: number}> = ({col, o}) => (
  <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 80, opacity: o, transform: `translateY(${interpolate(o, [0, 1], [40, 0])}px)`}}>
    <Img src={staticFile('logo_white.png')} style={{height: 84}} />
    <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 150, color: '#fff', textTransform: 'uppercase', lineHeight: 0.9, marginTop: 24}}>Shop now</div>
    <div style={{fontFamily: inter, fontWeight: 700, fontSize: 44, color: '#fff', background: RED, display: 'inline-block', padding: '16px 46px', borderRadius: 100, marginTop: 18}}>{SITE}</div>
    <div style={{fontFamily: inter, fontWeight: 600, fontSize: 34, color: 'rgba(255,255,255,.85)', marginTop: 22}}>Search “{col.model}” · same-day dispatch</div>
    <div style={{fontFamily: inter, fontWeight: 500, fontSize: 26, color: 'rgba(255,255,255,.6)', marginTop: 10}}>Free UK delivery over £50* · *large panels £50/item</div>
  </AbsoluteFill>
);

const PartSlide: React.FC<{p: ColPart}> = ({p}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const e = spring({frame, fps, config: {damping: 200}});
  const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], {extrapolateLeft: 'clamp'});
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: out}}>
      <div style={{width: 760, height: 760, background: '#fff', borderRadius: 40, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 40px 90px rgba(0,0,0,.45)', transform: `scale(${interpolate(e, [0, 1], [0.92, 1])})`}}>
        <Img src={p.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 54}} />
      </div>
      <div style={{textAlign: 'center', marginTop: 40, transform: `translateY(${interpolate(e, [0, 1], [40, 0])}px)`}}>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 70, color: '#fff', textTransform: 'uppercase'}}>{p.name}</div>
        <div style={{display: 'inline-block', background: RED, color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 72, padding: '6px 36px', borderRadius: 22, marginTop: 16}}>{p.price}</div>
      </div>
    </AbsoluteFill>
  );
};

const Thumb: React.FC<{p: ColPart; o: number}> = ({p, o}) => (
  <div style={{position: 'relative', flex: 1, aspectRatio: '1 / 1', background: '#fff', borderRadius: 18, overflow: 'hidden', opacity: o, transform: `scale(${0.9 + o * 0.1})`}}>
    <Img src={p.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 16}} />
    <div style={{position: 'absolute', left: 10, bottom: 10, background: RED, color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 28, padding: '3px 12px', borderRadius: 8}}>{p.price}</div>
  </div>
);

export const CollectionAd: React.FC<{col: Col; variant: 'showcase' | 'deal'}> = ({col, variant}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const fade = interpolate(frame, [0, 10, durationInFrames - 10, durationInFrames], [0, 1, 1, 0], clamp);
  const parts = col.parts;

  if (variant === 'deal') {
    const hookOut = interpolate(frame, [50, 60], [1, 0], clamp);
    const hookS = spring({frame, fps, config: {damping: 10, stiffness: 160}});
    const heroIn = interpolate(frame, [58, 72], [0, 1], clamp);
    const heroOut = interpolate(frame, [146, 156], [1, 0], clamp);
    const priceS = spring({frame: frame - 100, fps, config: {damping: 8, stiffness: 170}});
    const directIn = interpolate(frame, [156, 170], [0, 1], clamp);
    const directOut = interpolate(frame, [206, 216], [1, 0], clamp);
    const ctaIn = interpolate(frame, [216, 234], [0, 1], clamp);
    const cues: Cue[] = [
      {text: `*${col.model}* owner?`, start: 8, end: 54},
      {text: 'Buy direct & *save 7%*', start: 158, end: 210},
      {text: 'Shop at *razoryn.co.uk*', start: 220, end: 290},
    ];
    return (
      <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
        <Audio src={sfx('beat')} loop volume={0.4} />
        <Sequence from={0}><Audio src={sfx('whoosh')} /></Sequence>
        <Sequence from={100}><Audio src={sfx('pop')} /></Sequence>
        <Sequence from={216}><Audio src={sfx('whoosh')} /></Sequence>
        {/* hook */}
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 80, textAlign: 'center', opacity: hookOut}}>
          <div style={{fontFamily: inter, fontWeight: 800, fontSize: 34, letterSpacing: 5, color: RED}}>{col.model.toUpperCase()}</div>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 150, color: '#fff', textTransform: 'uppercase', lineHeight: 0.88, marginTop: 12, transform: `scale(${interpolate(hookS, [0, 1], [0.78, 1])})`}}>Stop<br /><span style={{color: RED}}>overpaying</span></div>
        </AbsoluteFill>
        {/* hero + price slam */}
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: heroIn * heroOut}}>
          <div style={{width: 800, height: 800, background: '#fff', borderRadius: 40, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 40px 100px rgba(0,0,0,.5)'}}>
            <Img src={parts[0].img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 60, transform: `scale(${interpolate(frame, [58, 156], [1.05, 1.16], clamp)})`}} />
          </div>
          <div style={{position: 'absolute', bottom: 360, textAlign: 'center', transform: `scale(${interpolate(priceS, [0, 1], [0.4, 1])})`, opacity: interpolate(frame, [100, 108], [0, 1], clamp)}}>
            <div style={{fontFamily: inter, fontWeight: 800, fontSize: 34, letterSpacing: 4, color: RED}}>{parts[0].name.toUpperCase()}</div>
            <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 230, color: '#fff', lineHeight: 0.9}}>{parts[0].price}</div>
          </div>
        </AbsoluteFill>
        {/* buy direct + thumbs */}
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 70, opacity: directIn * directOut}}>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 96, color: '#fff', textTransform: 'uppercase', textAlign: 'center', lineHeight: 0.95}}>Buy direct<br /><span style={{color: RED}}>save 7%</span></div>
          <div style={{fontFamily: inter, fontWeight: 600, fontSize: 30, color: 'rgba(255,255,255,.75)', marginTop: 14, textAlign: 'center'}}>vs our eBay store · same-day dispatch</div>
          <div style={{display: 'flex', gap: 18, marginTop: 40, width: '100%'}}>
            {parts.slice(1, 5).map((p, i) => <Thumb key={i} p={p} o={interpolate(frame, [170 + i * 6, 182 + i * 6], [0, 1], clamp)} />)}
          </div>
        </AbsoluteFill>
        <CTA col={col} o={ctaIn} />
        <Captions cues={cues} bottom={230} />
      </AbsoluteFill>
    );
  }

  // ---- showcase ----
  const hookOut = interpolate(frame, [60, 72], [1, 0], clamp);
  const carIn = spring({frame, fps, config: {damping: 18}});
  const montageFrom = 72, montageDur = 168;
  const perPart = Math.floor(montageDur / Math.min(parts.length, 5));
  const valIn = interpolate(frame, [montageFrom + montageDur, montageFrom + montageDur + 14], [0, 1], clamp);
  const valOut = interpolate(frame, [294, 304], [1, 0], clamp);
  const ctaIn = interpolate(frame, [304, 322], [0, 1], clamp);
  const cues: Cue[] = [
    {text: `Parts for your *${col.model}*`, start: 8, end: 66},
    {text: `*${col.count}* in stock`, start: 250, end: 300},
    {text: 'Shop at *razoryn.co.uk*', start: 312, end: 358},
  ];
  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      <Audio src={sfx('beat')} loop volume={0.32} />
      <Sequence from={0}><Audio src={sfx('whoosh')} /></Sequence>
      <Sequence from={montageFrom}><Audio src={sfx('whoosh')} /></Sequence>
      <Sequence from={304}><Audio src={sfx('pop')} /></Sequence>
      {frame < 304 && <Logo />}
      {/* hook with collection render */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 80, textAlign: 'center', opacity: hookOut}}>
        <div style={{width: 880, height: 560, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `translateY(${interpolate(carIn, [0, 1], [40, 0])}px)`}}>
          <Img src={col.img} style={{maxWidth: '100%', maxHeight: '100%', objectFit: 'contain'}} />
        </div>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 32, letterSpacing: 5, color: RED, marginTop: 10}}>AFTERMARKET PARTS IN STOCK</div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 96, color: '#fff', textTransform: 'uppercase', lineHeight: 0.92, marginTop: 8}}>{col.model}</div>
      </AbsoluteFill>
      {/* parts montage */}
      <Sequence from={montageFrom} durationInFrames={montageDur}>
        <Series>
          {parts.slice(0, 5).map((p, i) => (
            <Series.Sequence key={i} durationInFrames={perPart}><PartSlide p={p} /></Series.Sequence>
          ))}
        </Series>
      </Sequence>
      {/* value */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 80, opacity: valIn * valOut}}>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 240, color: RED, lineHeight: 0.9}}>{col.count}</div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 80, color: '#fff', textTransform: 'uppercase'}}>parts in stock</div>
        <div style={{fontFamily: inter, fontWeight: 600, fontSize: 36, color: 'rgba(255,255,255,.8)', marginTop: 16}}>From {col.from} · UK stock · aftermarket · same-day dispatch</div>
      </AbsoluteFill>
      <CTA col={col} o={ctaIn} />
      <Captions cues={cues} bottom={230} />
    </AbsoluteFill>
  );
};
