import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig, useCurrentFrame, interpolate } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { RoadScene, CartoonCar } from '../components/CarScene';
import { KineticHeadline, PopCaption, Pill, SocialBar } from '../components/ui';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';
import type { StoryBeat } from '../data/brandFacts';

export type StoryTimeProps = {
  title: string;
  partLabel: string; // "Part 1"
  partIndex: number; // 0-based
  totalParts: number;
  beats: StoryBeat[];
};

/** Story-time format: kinetic captions over an animated drive. Built to run as
 *  a 2–3 part series — each part hooks the next. */
export const StoryTime: React.FC<StoryTimeProps> = ({ title, partLabel, partIndex, totalParts, beats }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);
  const beatDur = 2.0;
  const isLast = partIndex === totalParts - 1;

  return (
    <AbsoluteFill>
      {/* TITLE CARD */}
      <Sequence durationInFrames={s(2.2)}>
        <RoadScene>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-start', paddingTop: 230, gap: 28 }}>
            <Pill text={`${partLabel} of ${totalParts}`} bg={COLORS.red} delay={2} fontSize={40} />
            <KineticHeadline text={title} fontSize={104} highlight="story" />
          </AbsoluteFill>
          <DriveBy y={1430} />
        </RoadScene>
      </Sequence>

      {/* BEATS */}
      {beats.map((b, i) => (
        <Sequence key={i} from={s(2.2 + i * beatDur)} durationInFrames={s(beatDur)}>
          <RoadScene>
            <DriveBy y={1480} />
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', paddingBottom: 360 }}>
              <PopCaption
                text={b.text}
                delay={3}
                bg={b.emphasis ? COLORS.red : COLORS.navy}
                fontSize={b.text.length > 36 ? 60 : 72}
              />
            </AbsoluteFill>
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-start', paddingTop: 90 }}>
              <Logo width={260} variant="badge" animate={false} />
            </AbsoluteFill>
          </RoadScene>
        </Sequence>
      ))}

      {/* HOOK NEXT PART or END */}
      <Sequence from={s(2.2 + beats.length * beatDur)} durationInFrames={s(isLast ? 0.01 : 2.6)}>
        {!isLast && (
          <NavyBg>
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
              <KineticHeadline text={`Part ${partIndex + 2} drops next`} fontSize={96} highlight="next" />
              <PopCaption text="Follow @calibreautoparts so you don’t miss it" delay={10} bg={COLORS.red} fontSize={48} />
              <SocialBar delay={18} />
            </AbsoluteFill>
          </NavyBg>
        )}
      </Sequence>

      {/* END CARD (only on last part it’s longer; earlier parts still close on brand) */}
      <Sequence from={s(2.2 + beats.length * beatDur + (isLast ? 0 : 2.6))} durationInFrames={s(isLast ? 3 : 1.6)}>
        <EndCard cta={isLast ? 'This could be your next flip — shop Calibre' : 'Part of the story · calibreautoparts.co.uk'} />
      </Sequence>
    </AbsoluteFill>
  );
};

const DriveBy: React.FC<{ y: number }> = ({ y }) => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, 60], [-500, 1080], { extrapolateRight: 'clamp' });
  return (
    <svg width="100%" height="100%" viewBox="0 0 1080 1920" style={{ position: 'absolute' }}>
      <g transform={`translate(${x} ${y})`}>
        <CartoonCar scale={1.1} />
      </g>
    </svg>
  );
};

export { STORY_SECONDS } from '../data/durations';
