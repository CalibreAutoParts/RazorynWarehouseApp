import React from 'react';
import {AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, MUT, SITE, Part} from './brand';

// Stylised browser window showcasing the storefront. Drop a real screen-recording
// or homepage screenshot into public/ and swap the <Img> tiles for it if you prefer.
const Browser: React.FC<{parts: Part[]; t: number}> = ({parts, t}) => {
  const tiles = parts.slice(0, 6);
  return (
    <div style={{width: 900, background: '#fff', borderRadius: 32, overflow: 'hidden', boxShadow: '0 50px 110px rgba(0,0,0,.5)'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 12, padding: '20px 24px', background: '#f1f3f5'}}>
        <div style={{width: 16, height: 16, borderRadius: 8, background: '#ff5f57'}} />
        <div style={{width: 16, height: 16, borderRadius: 8, background: '#febc2e'}} />
        <div style={{width: 16, height: 16, borderRadius: 8, background: '#28c840'}} />
        <div style={{flex: 1, marginLeft: 16, background: '#fff', borderRadius: 100, padding: '12px 24px', fontFamily: inter, fontWeight: 600, fontSize: 28, color: '#2c353e'}}>
          🔒 www.razoryn.co.uk
        </div>
      </div>
      <div style={{padding: 28, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, background: '#fff'}}>
        {tiles.map((p, i) => {
          const pop = interpolate(t, [i * 0.08, i * 0.08 + 0.4], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          return (
            <div key={i} style={{aspectRatio: '1 / 1', background: '#f7f8fa', borderRadius: 16, border: '1px solid #e5e7eb', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: pop, transform: `scale(${0.9 + pop * 0.1})`}}>
              <Img src={p.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 14}} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const SiteShowcase: React.FC<{parts: Part[]}> = ({parts}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const e = spring({frame, fps, config: {damping: 200}});
  const headY = interpolate(e, [0, 1], [-40, 0]);
  const browserY = interpolate(spring({frame: frame - 18, fps, config: {damping: 200}}), [0, 1], [120, 0]);
  const t = frame / durationInFrames;
  const fade = interpolate(frame, [0, 14, durationInFrames - 14, durationInFrames], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{backgroundColor: RED, color: '#fff', fontFamily: inter, alignItems: 'center', opacity: fade}}>
      <Img src={staticFile('logo_white.png')} style={{height: 64, marginTop: 90}} />
      <div style={{transform: `translateY(${headY}px)`, textAlign: 'center', marginTop: 40, padding: '0 70px'}}>
        <div style={{fontFamily: inter, fontWeight: 800, fontSize: 32, letterSpacing: 6}}>SHOP THE FULL RANGE ONLINE</div>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 130, lineHeight: 0.9, marginTop: 10}}>BUY DIRECT &amp; SAVE</div>
      </div>
      <div style={{transform: `translateY(${browserY}px)`, marginTop: 60}}>
        <Browser parts={parts} t={t} />
      </div>
      <div style={{position: 'absolute', bottom: 120, textAlign: 'center', width: '100%'}}>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 96}}>{SITE}</div>
        <div style={{fontFamily: inter, fontWeight: 600, fontSize: 36, color: 'rgba(255,255,255,.85)', marginTop: 8}}>Free UK delivery over £50 · Same-day dispatch</div>
      </div>
    </AbsoluteFill>
  );
};
