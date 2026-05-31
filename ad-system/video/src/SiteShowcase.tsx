import React from 'react';
import {AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, INK, SITE, Part} from './brand';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

const VW = 980;            // browser inner width
const VH = 1190;           // viewport (visible page) height
const HERO_H = 720;
const HEAD_H = 120;
const PAGE_H = HERO_H + HEAD_H + 1340;
const SCROLL = PAGE_H - VH; // how far the page scrolls

const Tile: React.FC<{part: Part}> = ({part}) => (
  <div style={{position: 'relative', height: 300, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 18, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
    <Img src={part.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 22}} />
    <div style={{position: 'absolute', left: 14, bottom: 14, background: RED, color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 30, padding: '4px 14px', borderRadius: 10}}>{part.price}</div>
    <div style={{position: 'absolute', left: 14, top: 12, fontFamily: inter, fontWeight: 800, fontSize: 16, letterSpacing: 1, color: '#6b7785', textTransform: 'uppercase'}}>{part.model}</div>
  </div>
);

export const SiteShowcase: React.FC<{parts: Part[]}> = ({parts}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();

  // address-bar typing
  const full = 'razoryn.co.uk';
  const typed = full.slice(0, Math.round(interpolate(frame, [6, 40], [0, full.length], clamp)));
  const caretOn = frame < 44 && Math.floor(frame / 7) % 2 === 0;
  const go = interpolate(frame, [40, 48], [0, 1], clamp) * interpolate(frame, [52, 60], [1, 0], clamp);

  // loading bar + page reveal
  const load = interpolate(frame, [46, 64], [0, 1], clamp);
  const pageIn = interpolate(frame, [52, 70], [0, 1], clamp);

  // snappy scroll from hero down through the range
  const scrollY = interpolate(frame, [96, 210], [0, -SCROLL], {...clamp, easing: Easing.inOut(Easing.cubic)});

  // end CTA band
  const cta = interpolate(frame, [224, 250], [0, 1], clamp);
  const fade = interpolate(frame, [0, 10, durationInFrames - 10, durationInFrames], [0, 1, 1, 0], clamp);

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, alignItems: 'center', opacity: fade}}>
      {/* browser window */}
      <div style={{position: 'absolute', top: 150, width: VW, borderRadius: 28, overflow: 'hidden', boxShadow: '0 50px 120px rgba(0,0,0,.55)', background: '#fff'}}>
        {/* chrome */}
        <div style={{display: 'flex', alignItems: 'center', gap: 12, padding: '20px 24px', background: '#f1f3f5', height: 72, boxSizing: 'border-box'}}>
          <div style={{width: 15, height: 15, borderRadius: 8, background: '#ff5f57'}} />
          <div style={{width: 15, height: 15, borderRadius: 8, background: '#febc2e'}} />
          <div style={{width: 15, height: 15, borderRadius: 8, background: '#28c840'}} />
          <div style={{flex: 1, marginLeft: 14, background: '#fff', borderRadius: 100, padding: '10px 22px', fontFamily: inter, fontWeight: 600, fontSize: 27, color: INK, display: 'flex', alignItems: 'center'}}>
            <span style={{color: '#9aa0a8', marginRight: 8}}>🔒</span>{typed}<span style={{opacity: caretOn ? 1 : 0}}>|</span>
          </div>
          <div style={{opacity: go, background: RED, color: '#fff', fontWeight: 800, fontSize: 22, padding: '8px 16px', borderRadius: 100}}>Go ↵</div>
        </div>
        {/* viewport */}
        <div style={{position: 'relative', height: VH, overflow: 'hidden', background: '#fff'}}>
          {/* loading bar */}
          <div style={{position: 'absolute', top: 0, left: 0, height: 5, width: `${load * 100}%`, background: RED, zIndex: 5}} />
          {/* the page (scrolls) */}
          <div style={{position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${scrollY}px)`, opacity: pageIn}}>
            {/* hero */}
            <div style={{height: HERO_H, padding: 60, boxSizing: 'border-box'}}>
              <Img src={staticFile('logo_red.png')} style={{height: 50}} />
              <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 88, lineHeight: 0.92, color: INK, textTransform: 'uppercase', marginTop: 26}}>
                Quality car parts <span style={{color: RED}}>without the markup</span>
              </div>
              <div style={{fontFamily: inter, fontWeight: 500, fontSize: 27, color: '#6b7785', marginTop: 18}}>Aftermarket panels, bumpers, lights &amp; trim · UK stock · Same-day dispatch</div>
              <div style={{marginTop: 30, height: 300, background: '#f7f8fa', border: '1px solid #e5e7eb', borderRadius: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden'}}>
                <Img src={parts[0].img} style={{height: '100%', objectFit: 'contain', padding: 24}} />
              </div>
            </div>
            {/* range header */}
            <div style={{height: HEAD_H, padding: '0 60px', display: 'flex', flexDirection: 'column', justifyContent: 'center', background: '#0f1318', color: '#fff'}}>
              <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 54, textTransform: 'uppercase', lineHeight: 1}}>Shop the full range</div>
              <div style={{fontFamily: inter, fontWeight: 600, fontSize: 24, color: 'rgba(255,255,255,.7)', marginTop: 6}}>Toyota · Hyundai · Kia · Nissan · Peugeot · Vauxhall</div>
            </div>
            {/* product grid */}
            <div style={{padding: 40, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, background: '#fff'}}>
              {parts.map((p, i) => <Tile key={i} part={p} />)}
            </div>
          </div>
        </div>
      </div>

      {/* end CTA */}
      <div style={{position: 'absolute', bottom: 0, width: '100%', padding: '0 0 90px', textAlign: 'center', opacity: cta, transform: `translateY(${interpolate(cta, [0, 1], [40, 0])}px)`}}>
        <Img src={staticFile('logo_white.png')} style={{height: 60}} />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 104, color: '#fff', marginTop: 14}}>{SITE}</div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 32, color: '#fff', background: RED, display: 'inline-block', padding: '12px 40px', borderRadius: 100, marginTop: 14}}>Free UK delivery over £50</div>
      </div>
    </AbsoluteFill>
  );
};
