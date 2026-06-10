/**
 * IDs of story-time parts that have a narration file at
 * /public/<VOICEOVER_DIR>/<id>.mp3.
 *
 * Populated by `npm run voiceover` (scripts/gen-voiceover.ts) once audio has
 * been generated, or add ids by hand if you drop in your own recordings named
 * `story-<storyId>-p<n>.mp3`. While empty, every story-time render is silent —
 * nothing references a missing file, so nothing breaks.
 */
export const VOICEOVER_IDS: string[] = [];
