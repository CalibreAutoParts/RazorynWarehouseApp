import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { NavyBg } from '../components/Backgrounds';
import { KineticHeadline, PopCaption, Pill, SocialBar } from '../components/ui';
import { PartArt, type PartKey } from '../components/PartArt';
import { Logo } from '../components/Logo';
import { EndCard } from '../components/EndCard';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';

export type TipCardProps = {
  hook: string;
  tipTitle: string;
  steps: string[];
  part?: PartKey;
};

/** Educational quick-tip / how-to — builds authority and saves & shares. */
export const TipCard: React.FC<TipCardProps> = ({ hook, tipTitle, steps, part = 'bumper' }) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);
  const per = 1.6;

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={s(2)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
            <Pill text="QUICK TIP" bg={COLORS.red} delay={2} fontSize={40} />
            <KineticHeadline text={hook} fontSize={96} highlight="save" />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(2)} durationInFrames={s(1.4)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 24 }}>
            <PartArt part={part} size={420} />
            <div style={{ fontFamily: FONT_FAMILY.display, fontSize: 78, color: COLORS.white, textAlign: 'center', padding: '0 40px' }}>
              {tipTitle.toUpperCase()}
            </div>
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      {steps.map((st, i) => (
        <Sequence key={i} from={s(3.4 + i * per)} durationInFrames={s(per)}>
          <NavyBg>
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30, padding: 60 }}>
              <div style={{ width: 120, height: 120, borderRadius: '50%', background: COLORS.red, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT_FAMILY.display, fontSize: 70, color: COLORS.white }}>
                {i + 1}
              </div>
              <PopCaption text={st} delay={4} bg={COLORS.navy} fontSize={58} />
              <Logo width={240} variant="badge" animate={false} />
            </AbsoluteFill>
          </NavyBg>
        </Sequence>
      ))}

      <Sequence from={s(3.4 + steps.length * per)} durationInFrames={s(1.6)}>
        <NavyBg>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 26 }}>
            <PopCaption text="Need the part? We’ve got it — trade prices" delay={2} bg={COLORS.red} fontSize={52} />
            <SocialBar delay={10} />
          </AbsoluteFill>
        </NavyBg>
      </Sequence>

      <Sequence from={s(3.4 + steps.length * per + 1.6)} durationInFrames={s(3)}>
        <EndCard cta="Save this · follow for more tips" />
      </Sequence>
    </AbsoluteFill>
  );
};

export { TIP_SECONDS } from '../data/durations';
