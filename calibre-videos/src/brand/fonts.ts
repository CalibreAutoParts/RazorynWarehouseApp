import { staticFile, delayRender, continueRender } from 'remotion';

/**
 * Fonts are bundled locally (public/fonts) and injected via @font-face so
 * rendering never depends on the Google Fonts CDN. We load them ourselves and
 * ALWAYS clear the delayRender handle (even on error) so a render can never
 * hang waiting on a font.
 *   - Anton       -> heavy display headlines (matches the bold logo lettering)
 *   - Montserrat  -> body / UI text (weights 400–900)
 */
const FACES = [
  { family: 'Anton', weight: 400, file: 'fonts/Anton-400.woff2' },
  { family: 'Montserrat', weight: 400, file: 'fonts/Montserrat-400.woff2' },
  { family: 'Montserrat', weight: 600, file: 'fonts/Montserrat-600.woff2' },
  { family: 'Montserrat', weight: 700, file: 'fonts/Montserrat-700.woff2' },
  { family: 'Montserrat', weight: 800, file: 'fonts/Montserrat-800.woff2' },
  { family: 'Montserrat', weight: 900, file: 'fonts/Montserrat-900.woff2' },
];

if (typeof document !== 'undefined') {
  const handle = delayRender('Loading Calibre brand fonts');
  const css = FACES.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:block;src:url(${staticFile(
        f.file,
      )}) format('woff2');}`,
  ).join('\n');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    continueRender(handle);
  };
  Promise.all(FACES.map((f) => document.fonts.load(`${f.weight} 1em ${f.family}`)))
    .catch(() => undefined)
    .finally(clear);
  // Hard fallback: never let font loading hang a render (stays under the
  // renderer's delayRender timeout). Fonts are local so this rarely fires.
  setTimeout(clear, 60000);
}

export const FONT_FAMILY = {
  display: 'Anton, "Arial Narrow", sans-serif',
  body: 'Montserrat, system-ui, sans-serif',
};
