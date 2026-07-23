import React from 'react';
import {AbsoluteFill, Audio, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, SITE} from './brand';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

export type Product = {
  id: string;
  vehicle: string;   // "NISSAN JUKE F16"
  part: string;      // "Rear Quarter Wheel Arch Moulding"
  years: string;     // "2019–2026"
  side: string;      // "Left side" / "Front right"
  price: string;     // "£25.26"
  img: string;       // product photo URL (fetched at render time)
  url: string;       // product page URL
  note?: string;     // "Left & right available"
  deliveryFree?: boolean;
};

// Product photo inside a clean white card.
const Card: React.FC<{img: string; size: number; scale?: number}> = ({img, size, scale = 1}) => (
  <div
    style={{
      width: size,
      height: size,
      background: '#fff',
      borderRadius: 40,
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 40px 100px rgba(0,0,0,.5)',
      transform: `scale(${scale})`,
    }}
  >
    <Img src={img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 56}} />
  </div>
);

const Logo: React.FC = () => (
  <Img src={staticFile('logo_white.png')} style={{position: 'absolute', top: 60, left: 66, height: 62}} />
);

export const ProductAd: React.FC<{product: Product}> = ({product: p}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();

  // scene windows (30fps, ~20s = 600 frames)
  const S1 = 96;   // hook  (0.0 – 3.2s)
  const S2 = 430;  // product (3.2 – 14.3s)
  // scene 3 CTA: S2 – end

  const master = interpolate(frame, [0, 10, durationInFrames - 10, durationInFrames], [0, 1, 1, 0], clamp);

  // scene opacities
  const s1 = interpolate(frame, [0, 12, S1 - 12, S1], [0, 1, 1, 0], clamp);
  const s2 = interpolate(frame, [S1 - 6, S1 + 12, S2 - 12, S2], [0, 1, 1, 0], clamp);
  const s3 = interpolate(frame, [S2 - 6, S2 + 14], [0, 1], clamp);

  // scene 1 animation
  const hookS = spring({frame, fps, config: {damping: 16}});
  // scene 2 slow zoom + callout timing
  const zoom = interpolate(frame, [S1, S2], [1.0, 1.09], clamp);
  const nameIn = interpolate(frame, [S1 + 14, S1 + 34], [0, 1], clamp);
  const fitIn = interpolate(frame, [S1 + 30, S1 + 52], [0, 1], clamp);
  const priceS = spring({frame: frame - (S1 + 46), fps, config: {damping: 9, stiffness: 170}});
  const priceO = interpolate(frame, [S1 + 46, S1 + 56], [0, 1], clamp);
  // scene 3
  const ctaS = spring({frame: frame - S2, fps, config: {damping: 18}});

  const fit = `${p.years} · ${p.side}`;
  const deliveryLine = p.deliveryFree ? 'Free UK delivery over £50' : 'UK delivery · same-day dispatch';

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: master}}>
      {/* subtle brand glow */}
      <AbsoluteFill style={{background: `radial-gradient(circle at 50% 34%, rgba(200,32,45,.28), transparent 60%)`}} />
      <Audio src={staticFile('audio/beat-cinematic.wav')} loop volume={0.26} />

      {frame < S2 - 6 && <Logo />}

      {/* ---------- Scene 1 · hook ---------- */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 80, opacity: s1}}>
        <div style={{transform: `translateY(${interpolate(hookS, [0, 1], [40, 0])}px) scale(${interpolate(hookS, [0, 1], [0.9, 1])})`}}>
          <Card img={p.img} size={720} />
        </div>
        <div style={{textAlign: 'center', marginTop: 44}}>
          <div style={{display: 'inline-block', background: RED, color: '#fff', fontFamily: inter, fontWeight: 800, fontSize: 32, letterSpacing: 6, padding: '10px 30px', borderRadius: 100}}>NEW IN</div>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 118, color: '#fff', textTransform: 'uppercase', lineHeight: 0.9, marginTop: 20}}>{p.vehicle}</div>
        </div>
      </AbsoluteFill>

      {/* ---------- Scene 2 · product + callouts ---------- */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: s2}}>
        {/* part name */}
        <div style={{position: 'absolute', top: 210, width: 900, textAlign: 'center', opacity: nameIn, transform: `translateY(${interpolate(nameIn, [0, 1], [-24, 0])}px)`}}>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 66, color: '#fff', textTransform: 'uppercase', lineHeight: 0.98}}>{p.part}</div>
        </div>
        {/* product card with slow zoom */}
        <Card img={p.img} size={780} scale={zoom} />
        {/* fitment chip */}
        <div style={{position: 'absolute', bottom: 470, opacity: fitIn, transform: `translateY(${interpolate(fitIn, [0, 1], [24, 0])}px)`}}>
          <div style={{fontFamily: inter, fontWeight: 700, fontSize: 38, color: '#fff', background: 'rgba(255,255,255,.12)', border: '2px solid rgba(255,255,255,.28)', padding: '12px 34px', borderRadius: 100}}>
            Fits {fit}
          </div>
        </div>
        {/* price slam */}
        <div style={{position: 'absolute', bottom: 210, textAlign: 'center', opacity: priceO, transform: `scale(${interpolate(priceS, [0, 1], [0.5, 1])})`}}>
          <div style={{fontFamily: inter, fontWeight: 700, fontSize: 30, letterSpacing: 3, color: 'rgba(255,255,255,.7)'}}>AFTERMARKET · DIRECT FIT</div>
          <div style={{display: 'inline-block', background: RED, color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 168, lineHeight: 1, padding: '4px 44px', borderRadius: 26, marginTop: 8}}>{p.price}</div>
          {p.note ? <div style={{fontFamily: inter, fontWeight: 600, fontSize: 30, color: 'rgba(255,255,255,.8)', marginTop: 16}}>{p.note}</div> : null}
        </div>
      </AbsoluteFill>

      {/* ---------- Scene 3 · CTA ---------- */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 80, opacity: s3}}>
        <div style={{transform: `translateY(${interpolate(ctaS, [0, 1], [40, 0])}px)`}}>
          <Img src={staticFile('logo_white.png')} style={{height: 88}} />
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 150, color: '#fff', textTransform: 'uppercase', lineHeight: 0.9, marginTop: 20}}>Shop now</div>
          <div style={{fontFamily: inter, fontWeight: 700, fontSize: 46, color: '#fff', background: RED, display: 'inline-block', padding: '16px 48px', borderRadius: 100, marginTop: 20}}>{SITE}</div>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 52, color: '#fff', textTransform: 'uppercase', marginTop: 34, lineHeight: 1.05}}>{p.vehicle}</div>
          <div style={{fontFamily: inter, fontWeight: 600, fontSize: 36, color: 'rgba(255,255,255,.85)', marginTop: 6}}>{p.part} · <span style={{color: '#fff', fontWeight: 800}}>{p.price}</span></div>
          <div style={{fontFamily: inter, fontWeight: 600, fontSize: 30, color: 'rgba(255,255,255,.62)', marginTop: 18}}>{deliveryLine}</div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
