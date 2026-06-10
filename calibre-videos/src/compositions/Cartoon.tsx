import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig, useCurrentFrame, interpolate, spring } from 'remotion';
import { NavyBg, RedRule } from '../components/Backgrounds';
import { RoadScene, CartoonCar, Mechanic } from '../components/CarScene';
import { PartArt, type PartKey } from '../components/PartArt';
import { KineticHeadline, PopCaption, Pill, SocialBar } from '../components/ui';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';

export type CartoonProps = {
  title: string;
  scenes: { caption: string; kind: 'mechanic' | 'parts' | 'drive' | 'map'; parts?: PartKey[] }[];
};

/** Fully-animated cartoon explainer: who Calibre is and what they stand for. */
export const Cartoon: React.FC<CartoonProps> = ({ title, scenes }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);
  const dur = 3.1;
  const intro = 2.4;

  return (
    <AbsoluteFill>
      {/* TITLE */}
      <Sequence durationInFrames={s(intro)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
            <Logo width={560} variant="badge" />
            <RedRule width={400} delay={10} />
            <KineticHeadline text={title} fontSize={92} highlight="calibre" />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      {scenes.map((sc, i) => (
        <Sequence key={i} from={s(intro + i * dur)} durationInFrames={s(dur)}>
          <SceneStage kind={sc.kind} parts={sc.parts} />
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 300 }}>
            <PopCaption text={sc.caption} delay={6} bg={i % 2 ? COLORS.red : COLORS.navy} fontSize={62} />
          </AbsoluteFill>
        </Sequence>
      ))}

      <Sequence from={s(intro + scenes.length * dur)} durationInFrames={s(3.2)}>
        <EndCard cta="That’s Calibre Auto Parts. Family-run, Watford" />
      </Sequence>
    </AbsoluteFill>
  );
};

const SceneStage: React.FC<{ kind: CartoonProps['scenes'][number]['kind']; parts?: PartKey[] }> = ({ kind, parts }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (kind === 'drive') {
    const x = interpolate(frame, [0, 70], [-500, 1080]);
    return (
      <RoadScene>
        <svg width="100%" height="100%" viewBox="0 0 1080 1920" style={{ position: 'absolute' }}>
          <g transform={`translate(${x} 1430)`}>
            <CartoonCar scale={1.3} />
          </g>
        </svg>
      </RoadScene>
    );
  }

  if (kind === 'mechanic') {
    const pop = spring({ frame, fps, config: { damping: 12 } });
    return (
      <NavyBg>
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
          <svg width={700} height={760} viewBox="0 0 200 360" style={{ transform: `scale(${pop})` }}>
            <Mechanic scale={1} />
          </svg>
        </AbsoluteFill>
      </NavyBg>
    );
  }

  if (kind === 'map') {
    return (
      <NavyBg>
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 24 }}>
          <svg width={520} height={520} viewBox="0 0 200 200">
            <circle cx="100" cy="100" r="92" fill={COLORS.navyDeep} stroke={COLORS.silver} strokeWidth={3} />
            <path d="M60 60 L150 70 L140 150 L70 140 Z" fill={COLORS.navy} stroke={COLORS.silver} strokeWidth={2} />
            <path d="M100 70 C 70 70 70 110 100 150 C 130 110 130 70 100 70 Z" fill={COLORS.red} />
            <circle cx="100" cy="100" r="14" fill={COLORS.white} />
          </svg>
          <Pill text="Watford → all of the UK" bg={COLORS.red} delay={10} fontSize={40} />
        </AbsoluteFill>
      </NavyBg>
    );
  }

  // parts grid
  const list = parts ?? ['bumper', 'headlight', 'wing', 'taillight', 'grille', 'bonnet'];
  return (
    <NavyBg>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {list.slice(0, 6).map((p, i) => (
            <div key={p} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <PartArt part={p} size={250} delay={i * 4} />
            </div>
          ))}
        </div>
        <div style={{ position: 'absolute', top: 120, fontFamily: FONT_FAMILY.display, fontSize: 56, color: COLORS.white, textAlign: 'center', padding: '0 40px' }}>
          EXACT-FIT FOR YOUR MODEL
        </div>
      </AbsoluteFill>
    </NavyBg>
  );
};

export { CARTOON_SECONDS } from '../data/durations';
