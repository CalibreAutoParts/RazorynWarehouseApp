import {loadFont as loadBarlow} from '@remotion/google-fonts/BarlowCondensed';
import {loadFont as loadInter} from '@remotion/google-fonts/Inter';

export const barlow = loadBarlow().fontFamily;
export const inter = loadInter().fontFamily;

export const RED = '#c8202d';
export const RED_DARK = '#e83948';
export const NAVY = '#0f1318';
export const INK = '#2c353e';
export const MUT = 'rgba(255,255,255,.66)';
export const SITE = 'RAZORYN.CO.UK';

// Live Shopify product photos (load at render time — needs internet).
// Swap/extend freely; price is shown as-is.
export type Part = {img: string; name: string; price: string};
export const PARTS: Part[] = [
  {img: 'https://cdn.shopify.com/s/files/1/1033/6278/9714/files/57_d3a34985-af12-48a2-8ca7-17a9b77218cd.jpg?width=1200', name: 'Yaris Cross Bonnet', price: '£185.99'},
  {img: 'https://cdn.shopify.com/s/files/1/1033/6278/9714/files/57_b1844ee5-f596-4265-8a15-4ef544501ba6.png?width=1200', name: 'Yaris Cross Front Bumper', price: '£153.44'},
  {img: 'https://cdn.shopify.com/s/files/1/1033/6278/9714/files/57_afd551e2-7b6a-4bf4-8e38-51e5f3f8193a.jpg?width=1200', name: 'i20 LED Headlight', price: '£511.50'},
  {img: 'https://cdn.shopify.com/s/files/1/1033/6278/9714/files/57_982610c6-36b2-413a-bbc3-6a92b35ac54c.jpg?width=1200', name: 'Picanto Front Bumper', price: '£371.99'},
  {img: 'https://cdn.shopify.com/s/files/1/1033/6278/9714/files/57_9fea640d-7515-4a65-96dc-83b7d5896583.png?width=1200', name: 'Yaris Cross Lower Grille', price: '£102.29'},
  {img: 'https://cdn.shopify.com/s/files/1/1033/6278/9714/files/57_05ab952c-9052-4e06-8fc3-53d3e97c5263.jpg?width=1200', name: 'Kona Front Wing', price: '£162.74'},
];
