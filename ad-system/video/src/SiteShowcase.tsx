import React from 'react';
import {AbsoluteFill, Audio, Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {barlow, inter, NAVY, RED, RED_DARK, INK, SITE, Model} from './brand';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

// browser + page geometry
const VW = 980;
const VH = 1220;
const BAR1 = 44, BAR2 = 46, HEADER = 108, NAV = 62, HERO = 680, STATS = 180, CATHEAD = 210;
const CARD = 340, CARD_IMG = 210, GAP = 22, PAD = 44;
const GRID = PAD * 2 + 4 * CARD + 3 * GAP;            // 8 cards, 2 cols → 4 rows
const PAGE_H = BAR1 + BAR2 + HEADER + NAV + HERO + STATS + CATHEAD + GRID;
const SCROLL = PAGE_H - VH;

const NAVITEMS = ['HOME', 'CATALOG', 'CONTACT', 'TRADE ACCOUNT', 'SUPPLIER ENQUIRY'];
const STATSDATA: [string, string][] = [
  ['MULTI-MAKE', 'Vehicle coverage'],
  ['IN STOCK', 'Same-day dispatch'],
  ['12PM', 'Order cutoff'],
  ['100%', 'Fitment guarantee'],
];

const ModelCard: React.FC<{m: Model}> = ({m}) => (
  <div style={{height: CARD, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, overflow: 'hidden'}}>
    <div style={{height: CARD_IMG, background: '#f7f8fa', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
      <Img src={m.img} style={{width: '100%', height: '100%', objectFit: 'contain', padding: 16}} />
    </div>
    <div style={{height: CARD - CARD_IMG, padding: '0 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, boxSizing: 'border-box'}}>
      <div style={{minWidth: 0}}>
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 21, color: INK, textTransform: 'uppercase', lineHeight: 1.05, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'}}>{m.title}</div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 16, color: '#6b7785', marginTop: 6}}>IN STOCK</div>
      </div>
      <div style={{color: RED, fontSize: 26, fontWeight: 700, flex: '0 0 auto'}}>→</div>
    </div>
  </div>
);

export const SiteShowcase: React.FC<{models: Model[]}> = ({models}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();

  const full = 'razoryn.co.uk';
  const typed = full.slice(0, Math.round(interpolate(frame, [6, 42], [0, full.length], clamp)));
  const caretOn = frame < 46 && Math.floor(frame / 7) % 2 === 0;
  const go = interpolate(frame, [40, 50], [0, 1], clamp) * interpolate(frame, [56, 64], [1, 0], clamp);
  const load = interpolate(frame, [48, 66], [0, 1], clamp);
  const pageIn = interpolate(frame, [54, 74], [0, 1], clamp);
  const scrollY = interpolate(frame, [104, 296], [0, -SCROLL], {...clamp, easing: Easing.inOut(Easing.cubic)});
  const cta = interpolate(frame, [300, 322], [0, 1], clamp);
  const fade = interpolate(frame, [0, 10, durationInFrames - 10, durationInFrames], [0, 1, 1, 0], clamp);

  return (
    <AbsoluteFill style={{backgroundColor: NAVY, fontFamily: inter, alignItems: 'center', opacity: fade}}>
      <Audio src={staticFile('audio/beat-cinematic.wav')} loop volume={0.3} />
      <Sequence from={48}><Audio src={staticFile('audio/tap.wav')} /></Sequence>
      <Sequence from={104}><Audio src={staticFile('audio/whoosh.wav')} /></Sequence>
      <Sequence from={300}><Audio src={staticFile('audio/pop.wav')} /></Sequence>
      <div style={{position: 'absolute', top: 100, width: VW, borderRadius: 28, overflow: 'hidden', boxShadow: '0 50px 120px rgba(0,0,0,.55)', background: '#fff'}}>
        {/* chrome */}
        <div style={{display: 'flex', alignItems: 'center', gap: 12, padding: '20px 24px', background: '#e9ecef', height: 72, boxSizing: 'border-box'}}>
          <div style={{width: 15, height: 15, borderRadius: 8, background: '#ff5f57'}} />
          <div style={{width: 15, height: 15, borderRadius: 8, background: '#febc2e'}} />
          <div style={{width: 15, height: 15, borderRadius: 8, background: '#28c840'}} />
          <div style={{flex: 1, marginLeft: 14, background: '#fff', borderRadius: 100, padding: '11px 24px', fontFamily: inter, fontWeight: 600, fontSize: 27, color: INK}}>
            {typed}<span style={{opacity: caretOn ? 1 : 0}}>|</span>
          </div>
          <div style={{opacity: go, background: RED, color: '#fff', fontWeight: 800, fontSize: 22, padding: '8px 16px', borderRadius: 100}}>Go ↵</div>
        </div>

        {/* viewport */}
        <div style={{position: 'relative', height: VH, overflow: 'hidden', background: '#fff'}}>
          <div style={{position: 'absolute', top: 0, left: 0, height: 5, width: `${load * 100}%`, background: RED, zIndex: 9}} />
          <div style={{position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${scrollY}px)`, opacity: pageIn}}>
            {/* announcement bars */}
            <div style={{height: BAR1, background: NAVY, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 40px', fontSize: 19, fontWeight: 600}}>
              <span><span style={{color: RED_DARK}}>●</span> Next dispatch: Monday</span>
              <span>+44 7494 589542</span>
            </div>
            <div style={{height: BAR2, background: '#1a1f25', color: 'rgba(255,255,255,.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, fontWeight: 600}}>
              Free UK delivery on orders over £50 — large body panels ship at flat rate
            </div>
            {/* header */}
            <div style={{height: HEADER, background: '#fff', display: 'flex', alignItems: 'center', gap: 22, padding: '0 40px'}}>
              <Img src={staticFile('logo_red.png')} style={{height: 40}} />
              <div style={{flex: 1, border: '1px solid #e5e7eb', borderRadius: 100, padding: '14px 22px', color: '#9aa0a8', fontSize: 22, fontWeight: 500}}>Search parts, vehicles, SKUs…</div>
              <div style={{display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800, fontSize: 16, color: '#6b7785'}}>
                <span>VAT</span>
                <span style={{padding: '6px 12px', borderRadius: 100, background: '#f1f3f5'}}>EXCL</span>
                <span style={{padding: '6px 12px', borderRadius: 100, background: NAVY, color: '#fff'}}>INCL</span>
              </div>
            </div>
            {/* nav */}
            <div style={{height: NAV, background: '#fff', borderTop: '1px solid #f0f2f5', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 44}}>
              {NAVITEMS.map((n, i) => (
                <span key={n} style={{fontFamily: inter, fontWeight: 700, fontSize: 19, letterSpacing: 1, color: i === 0 ? RED : INK, borderBottom: i === 0 ? `3px solid ${RED}` : 'none', paddingBottom: 6}}>{n}</span>
              ))}
            </div>
            {/* hero */}
            <div style={{height: HERO, background: NAVY, color: '#fff', padding: 60, display: 'flex', flexDirection: 'column', justifyContent: 'center'}}>
              <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 92, lineHeight: 0.92, textTransform: 'uppercase'}}>Brand-new aftermarket parts.<br />Sharper service.</div>
              <div style={{fontFamily: inter, fontWeight: 500, fontSize: 30, color: 'rgba(255,255,255,.78)', marginTop: 26, maxWidth: 760, lineHeight: 1.35}}>UK-based supplier of headlights, body panels and sheet-metal parts. Same-day dispatch on in-stock items, real fitment support, no nonsense.</div>
              <div style={{display: 'flex', gap: 18, marginTop: 40}}>
                <div style={{background: RED, color: '#fff', fontWeight: 800, fontSize: 26, padding: '18px 34px', borderRadius: 12}}>SHOP ALL PARTS →</div>
                <div style={{border: '2px solid rgba(255,255,255,.5)', color: '#fff', fontWeight: 800, fontSize: 26, padding: '16px 34px', borderRadius: 12}}>TRADE ACCOUNT</div>
              </div>
            </div>
            {/* stats */}
            <div style={{height: STATS, background: '#f7f8fa', display: 'flex', alignItems: 'center'}}>
              {STATSDATA.map(([big, small], i) => (
                <div key={big} style={{flex: 1, textAlign: 'center', borderLeft: i ? '1px solid #e5e7eb' : 'none'}}>
                  <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 64, color: RED, lineHeight: 1}}>{big}</div>
                  <div style={{fontFamily: inter, fontWeight: 700, fontSize: 19, color: '#6b7785', letterSpacing: 1, textTransform: 'uppercase', marginTop: 6}}>{small}</div>
                </div>
              ))}
            </div>
            {/* catalogue header */}
            <div style={{height: CATHEAD, background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 60px'}}>
              <div style={{fontFamily: inter, fontWeight: 800, fontSize: 22, letterSpacing: 5, color: RED}}>CATALOGUE</div>
              <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 66, color: INK, textTransform: 'uppercase', marginTop: 6}}>Shop by vehicle model</div>
              <div style={{fontFamily: inter, fontWeight: 500, fontSize: 26, color: '#6b7785', marginTop: 8}}>Browse exact-fit parts for your specific make and model.</div>
            </div>
            {/* model grid */}
            <div style={{padding: PAD, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: GAP, background: '#fff'}}>
              {models.map((m, i) => <ModelCard key={i} m={m} />)}
            </div>
          </div>
        </div>
      </div>

      {/* end CTA */}
      <div style={{position: 'absolute', bottom: 0, width: '100%', padding: '0 0 90px', textAlign: 'center', opacity: cta, transform: `translateY(${interpolate(cta, [0, 1], [40, 0])}px)`}}>
        <Img src={staticFile('logo_white.png')} style={{height: 60}} />
        <div style={{fontFamily: barlow, fontWeight: 800, fontSize: 104, color: '#fff', marginTop: 14}}>{SITE}</div>
        <div style={{fontFamily: inter, fontWeight: 700, fontSize: 32, color: '#fff', background: RED, display: 'inline-block', padding: '12px 40px', borderRadius: 100, marginTop: 14}}>Free UK delivery over £50*</div>
      </div>
    </AbsoluteFill>
  );
};
