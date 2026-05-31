import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, INK, SITE, Part} from './brand';
import {Captions, Cue} from './Captions';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const sfx = (n: string) => staticFile(`audio/${n}.wav`);

const cues: Cue[] = [
  {text: 'Order in *seconds*', start: 10, end: 84},
  {text: 'Out before *12pm*', start: 90, end: 116},
  {text: 'On your *doorstep* fast', start: 196, end: 246},
];

// ---- phone with the Razoryn order screen ----
const Phone: React.FC<{part: Part; frame: number; fps: number}> = ({part, frame, fps}) => {
  const placed = frame > 84;
  const tap = spring({frame: frame - 70, fps, config: {damping: 12, stiffness: 200}});
  const tapScale = frame > 70 && frame < 86 ? 1 - 0.06 * interpolate(tap, [0, 1], [1, 0]) : 1;
  const ring = frame > 118 && frame < 150;
  return (
    <div style={{width: 540, height: 1130, background: '#0b0e12', borderRadius: 64, padding: 16, boxShadow: '0 50px 120px rgba(0,0,0,.6)'}}>
      <div style={{width: '100%', height: '100%', background: '#fff', borderRadius: 50, overflow: 'hidden', position: 'relative'}}>
        {/* app bar */}
        <div style={{height: 96, background: RED, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 38, letterSpacing: 1}}>RAZORYN E-PARTS</div>
        {/* product */}
        <div style={{height: 470, background: '#f7f8fa', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          <Img src={part.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 40}} />
        </div>
        <div style={{padding: '26px 34px'}}>
          <div style={{fontFamily: inter, fontWeight: 800, fontSize: 24, letterSpacing: 2, color: RED}}>{part.model.toUpperCase()}</div>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 44, color: INK, lineHeight: 1, marginTop: 6}}>{part.name}</div>
          <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 72, color: INK, marginTop: 14}}>{part.price}</div>
          <div style={{fontFamily: inter, fontWeight: 600, fontSize: 22, color: '#6b7785'}}>Website exclusive · same-day dispatch</div>
          {/* button */}
          <div style={{marginTop: 26, height: 92, borderRadius: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 38, transform: `scale(${tapScale})`, background: placed ? '#1a7f3e' : RED, transition: 'none'}}>
            {placed ? 'ORDER PLACED ✓' : 'ADD TO BASKET'}
          </div>
        </div>
        {/* dispatch toast */}
        {frame > 92 && (
          <div style={{position: 'absolute', left: 24, right: 24, bottom: 30, background: NAVY, color: '#fff', borderRadius: 16, padding: '18px 22px', fontFamily: inter, fontWeight: 700, fontSize: 24, opacity: interpolate(frame, [92, 104], [0, 1], clamp)}}>
            🚚 Dispatched today — out before 12pm
          </div>
        )}
        {/* doorbell notification */}
        {ring && (
          <div style={{position: 'absolute', left: 24, right: 24, top: 116, background: '#fff', border: `2px solid ${RED}`, borderRadius: 16, padding: '16px 20px', fontFamily: inter, fontWeight: 700, fontSize: 24, color: INK, boxShadow: '0 16px 40px rgba(0,0,0,.18)', transform: `translateY(${interpolate(frame, [118, 126], [-30, 0], clamp)}px)`}}>
            🔔 Doorbell · Your parts have arrived
          </div>
        )}
      </div>
    </div>
  );
};

// ---- delivered parcel on the doorstep ----
const Parcel: React.FC = () => (
  <div style={{width: 520, height: 380, position: 'relative'}}>
    <div style={{position: 'absolute', inset: 0, background: '#c89a6a', borderRadius: 18, boxShadow: '0 30px 70px rgba(0,0,0,.4)'}} />
    <div style={{position: 'absolute', top: 0, bottom: 0, left: '50%', width: 70, transform: 'translateX(-50%)', background: RED}} />
    <div style={{position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 10, padding: '10px 20px', fontFamily: barlow, fontWeight: 800, fontSize: 30, color: RED}}>RAZORYN E-PARTS</div>
  </div>
);

const InfoRow: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div style={{fontFamily: inter, fontWeight: 600, fontSize: 34, color: 'rgba(255,255,255,.9)', margin: '6px 0'}}>{children}</div>
);

export const OrderStory: React.FC<{parts: Part[]}> = ({parts}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const part = parts[1] || parts[0];

  // camera: phone full, then zoom OUT (shrink + drop) into the doorstep, then cut to CTA
  const zoom = interpolate(frame, [130, 210], [1, 0.34], {...clamp, easing: undefined});
  const phoneY = interpolate(frame, [130, 210], [0, -210], clamp);
  const sceneFade = interpolate(frame, [248, 262], [1, 0], clamp);     // story -> CTA
  const doorIn = interpolate(frame, [150, 200], [0, 1], clamp);
  const parcelUp = spring({frame: frame - 178, fps, config: {damping: 14}});
  const ctaIn = interpolate(frame, [262, 280], [0, 1], clamp);
  const ctaShift = interpolate(ctaIn, [0, 1], [40, 0]);
  const fade = interpolate(frame, [0, 10, durationInFrames - 10, durationInFrames], [0, 1, 1, 0], clamp);

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, opacity: fade}}>
      {/* audio */}
      <Audio src={sfx('beat')} loop volume={0.32} />
      <Sequence from={70}><Audio src={sfx('tap')} /></Sequence>
      <Sequence from={86}><Audio src={sfx('chime')} /></Sequence>
      <Sequence from={118}><Audio src={sfx('doorbell')} /></Sequence>
      <Sequence from={130}><Audio src={sfx('whoosh')} /></Sequence>
      <Sequence from={262}><Audio src={sfx('pop')} /></Sequence>

      {/* STORY (phone + doorstep), fades out before CTA */}
      <AbsoluteFill style={{opacity: sceneFade}}>
        {/* doorstep behind, fades in as we zoom out */}
        <AbsoluteFill style={{opacity: doorIn}}>
          <div style={{position: 'absolute', bottom: 0, width: '100%', height: 620, background: '#161b21'}} />
          <div style={{position: 'absolute', bottom: 620, left: '50%', transform: 'translateX(-50%)', width: 520, height: 760, background: '#272d35', borderRadius: '12px 12px 0 0', border: '8px solid #20262d'}} />
          <div style={{position: 'absolute', bottom: 980, left: 'calc(50% + 300px)', width: 34, height: 34, borderRadius: 20, background: RED, boxShadow: `0 0 ${interpolate(Math.sin(frame / 3), [-1, 1], [4, 26])}px ${RED}`}} />
          <div style={{position: 'absolute', bottom: 150, left: '50%', transform: `translateX(-50%) translateY(${interpolate(parcelUp, [0, 1], [400, 0])}px)`}}>
            <Parcel />
          </div>
        </AbsoluteFill>
        {/* phone */}
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
          <div style={{transform: `scale(${zoom}) translateY(${phoneY}px)`}}>
            <Phone part={part} frame={frame} fps={fps} />
          </div>
        </AbsoluteFill>
        {/* DING-DONG flash */}
        {frame > 118 && frame < 150 && (
          <AbsoluteFill style={{alignItems: 'center', justifyContent: 'flex-start', paddingTop: 150}}>
            <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 90, color: '#fff', opacity: interpolate(frame, [118, 126, 144, 150], [0, 1, 1, 0], clamp), letterSpacing: 4}}>DING · DONG</div>
          </AbsoluteFill>
        )}
      </AbsoluteFill>

      {/* CTA */}
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: ctaIn, transform: `translateY(${ctaShift}px)`, padding: 80, textAlign: 'center'}}>
        <Img src={staticFile('logo_white.png')} style={{height: 90}} />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 96, color: '#fff', textTransform: 'uppercase', lineHeight: 0.95, marginTop: 30}}>Order from<br /><span style={{color: RED}}>Razoryn e-Parts</span></div>
        <div style={{marginTop: 36}}>
          <InfoRow><b style={{fontFamily: barlow, fontSize: 46}}>{SITE}</b></InfoRow>
          <InfoRow>Call 01923 372432 · WhatsApp +44 7494 589542</InfoRow>
          <InfoRow>Same-day dispatch before 12pm · Free UK delivery over £50*</InfoRow>
          <InfoRow>Aftermarket · UK stock · Fitment support</InfoRow>
          <div style={{fontFamily: inter, fontWeight: 500, fontSize: 24, color: 'rgba(255,255,255,.6)', marginTop: 10}}>*Large body panels ship at a flat £50 per item</div>
        </div>
      </AbsoluteFill>

      <Captions cues={cues} bottom={200} />
    </AbsoluteFill>
  );
};
