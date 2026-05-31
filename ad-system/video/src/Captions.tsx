import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';
import {barlow, RED_DARK} from './brand';

export type Cue = {text: string; start: number; end: number};
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

// Render caption text; *word* segments are highlighted red.
const render = (text: string) =>
  text.split('*').map((seg, i) =>
    i % 2 === 1 ? <span key={i} style={{color: RED_DARK}}>{seg}</span> : <React.Fragment key={i}>{seg}</React.Fragment>);

/** Big bottom captions for muted autoplay. Pass cue ranges in frames. */
export const Captions: React.FC<{cues: Cue[]; bottom?: number}> = ({cues, bottom = 300}) => {
  const frame = useCurrentFrame();
  const cue = cues.find((c) => frame >= c.start && frame < c.end);
  if (!cue) return null;
  const local = frame - cue.start;
  const pop = interpolate(local, [0, 6], [0.82, 1], clamp);
  const op = interpolate(local, [0, 4], [0, 1], clamp);
  return (
    <div style={{position: 'absolute', left: 0, right: 0, bottom, textAlign: 'center', padding: '0 70px', opacity: op, zIndex: 50}}>
      <span style={{display: 'inline-block', background: 'rgba(15,19,24,.92)', color: '#fff', fontFamily: barlow, fontWeight: 800, fontSize: 58, textTransform: 'uppercase', lineHeight: 1.08, padding: '14px 30px', borderRadius: 16, transform: `scale(${pop})`, boxShadow: '0 12px 34px rgba(0,0,0,.45)'}}>
        {render(cue.text)}
      </span>
    </div>
  );
};
