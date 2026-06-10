import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useVideoConfig, useCurrentFrame, interpolate } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { RoadScene, CartoonCar } from '../components/CarScene';
import { KineticHeadline, PopCaption, Pill, SocialBar } from '../components/ui';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';
import { STORY_BEAT_SECONDS } from '../data/durations';
import type { StoryBeat } from '../data/brandFacts';

export type StoryTimeProps = {
  title: string;
  partLabel: string; // "Part 1"
  partIndex: number; // 0-based
  totalParts: number;
  beats: StoryBeat[];
  /** Optional narration file under /public (e.g. 'vo/story-flip-tesla-p1.mp3').
   *  Only set by the catalog when the file actually exists, so renders never
   *  break before a voiceover has been generated/supplied. */
  voiceover?: string;
};

/** Story-time format: kinetic captions over an animated drive. Built to run as
 *  a 2–3 part series — each part hooks the next. Optional voiceover narrates
 *  the beats; pacing is timed so each line is readable with or without audio. */
export const StoryTime: React.FC<StoryTimeProps> = ({ title, partLabel, partIndex, totalParts, beats, voiceover }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);
  const beatDur = STORY_BEAT_SECONDS;
  const intro = 2.6;
  const isLast = partIndex === totalParts - 1;

  return (
    <AbsoluteFill>
      {voiceover && <Audio src={staticFile(voiceover)} />}
      {/* TITLE CARD */}
      <Sequence durationInFrames={s(intro)}>
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
        <Sequence key={i} from={s(intro + i * beatDur)} durationInFrames={s(beatDur)}>
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
      {/* HOOK NEXT PART (skipped entirely on the final part) */}
      {!isLast && (
        <Sequence from={s(intro + beats.length * beatDur)} durationInFrames={s(2.8)}>
          <NavyBg>
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
              <KineticHeadline text={`Part ${partIndex + 2} drops next`} fontSize={96} highlight="next" />
              <PopCaption text="Follow @calibreautoparts so you don’t miss it" delay={10} bg={COLORS.red} fontSize={48} />
              <SocialBar delay={18} />
            </AbsoluteFill>
          </NavyBg>
        </Sequence>
      )}

      {/* END CARD — held longer on the final part so the full CTA reads */}
      <Sequence from={s(intro + beats.length * beatDur + (isLast ? 0 : 2.8))} durationInFrames={s(isLast ? 3 : 1.6)}>
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
