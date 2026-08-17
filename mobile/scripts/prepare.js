// Prepare the Capacitor build for a specific brand (calibre | razoryn).
//
// Writes capacitor.config.json (appId, appName, live URL, user-agent tag) from
// brands/<brand>.json and copies that brand's 1024px logo to assets/icon.png so
// `npx capacitor-assets generate` produces the correct Android launcher icon.
//
// Usage:  node scripts/prepare.js calibre     (or `razoryn`)
//         BRAND=razoryn node scripts/prepare.js
//         APP_URL=https://staging... node scripts/prepare.js calibre   (URL override)
const fs = require('fs');
const path = require('path');

const brand = (process.env.BRAND || process.argv[2] || 'calibre').toLowerCase();
const brandFile = path.join(__dirname, '..', 'brands', brand + '.json');
if (!fs.existsSync(brandFile)) {
  console.error(`Unknown brand "${brand}". Available: ${fs.readdirSync(path.join(__dirname, '..', 'brands')).map(f => f.replace('.json', '')).join(', ')}`);
  process.exit(1);
}
const b = JSON.parse(fs.readFileSync(brandFile, 'utf8'));
const url = (process.env.APP_URL && process.env.APP_URL.trim()) || b.url;

const config = {
  appId: b.appId,
  appName: b.appName,
  webDir: 'www',
  server: {
    url,
    cleartext: false,
    androidScheme: 'https',
    allowNavigation: b.allowNavigation || [],
  },
  appendUserAgent: b.userAgentTag,
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
};
fs.writeFileSync(path.join(__dirname, '..', 'capacitor.config.json'), JSON.stringify(config, null, 2) + '\n');

// Copy the brand logo → assets/icon.png (source for @capacitor/assets).
const iconSrc = path.resolve(__dirname, '..', b.icon);
if (!fs.existsSync(iconSrc)) { console.error('Brand icon not found:', iconSrc); process.exit(1); }
const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
fs.copyFileSync(iconSrc, path.join(assetsDir, 'icon.png'));

console.log(`Prepared "${brand}": ${b.appName} (${b.appId}) @ ${url} — icon ${path.basename(iconSrc)}`);
