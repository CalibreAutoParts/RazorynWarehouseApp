import {loadFont as loadBarlow} from '@remotion/google-fonts/BarlowCondensed';
import {loadFont as loadInter} from '@remotion/google-fonts/Inter';
import partsData from './parts.json';
import modelsData from './models.json';

export const barlow = loadBarlow('normal', {weights: ['700', '800'], subsets: ['latin']}).fontFamily;
export const inter = loadInter('normal', {weights: ['400', '500', '600', '700', '800'], subsets: ['latin']}).fontFamily;

export const RED = '#c8202d';
export const RED_DARK = '#e83948';
export const NAVY = '#0f1318';
export const INK = '#2c353e';
export const MUT = 'rgba(255,255,255,.66)';
export const SITE = 'RAZORYN.CO.UK';

export type Part = {img: string; model: string; name: string; price: string};
export type Model = {img: string; title: string; parts: number};

// Auto-generated from the collection data:
//   python3 gen_parts.py    -> parts.json   (PartsShowcase)
//   python3 gen_models.py   -> models.json  ("Shop by vehicle model" grid)
export const PARTS: Part[] = partsData as Part[];
export const MODELS: Model[] = modelsData as Model[];
