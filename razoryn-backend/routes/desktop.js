// routes/desktop.js — in-app download of the desktop installers.
//
// The installers (.exe / .dmg / .AppImage) are built by GitHub Actions and
// attached to a GitHub Release. This route fetches the latest release and hands
// the right installer to the user's browser, so staff can install the desktop
// app from a button in the web app — no GitHub or command line needed.
//
// Public repo: we 302-redirect to the public asset URL.
// Private repo: set GITHUB_TOKEN (a PAT with `repo` read, or the Actions token)
// in Railway and we stream the asset with auth instead.
const express = require('express');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const REPO = process.env.DESKTOP_REPO || 'CalibreAutoParts/RazorynWarehouseApp';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;

function ghHeaders(extra = {}) {
  const h = { 'User-Agent': 'warehouse-app', Accept: 'application/vnd.github+json', ...extra };
  if (GH_TOKEN) h.Authorization = `Bearer ${GH_TOKEN}`;
  return h;
}

async function latestRelease() {
  const r = await axios.get(`https://api.github.com/repos/${REPO}/releases/latest`,
    { headers: ghHeaders(), timeout: 15000 });
  return r.data;
}

const EXT = { win: /\.exe$/i, mac: /\.dmg$/i, linux: /\.AppImage$/i };

// GET /api/desktop/info — is a build available, what version, which platforms.
router.get('/info', async (req, res) => {
  try {
    const rel = await latestRelease();
    const has = (re) => (rel.assets || []).some(a => re.test(a.name));
    res.json({
      available: true,
      version: rel.tag_name || rel.name || '',
      publishedAt: rel.published_at || null,
      win: has(EXT.win), mac: has(EXT.mac), linux: has(EXT.linux),
    });
  } catch (e) {
    if (e.response?.status === 404) return res.json({ available: false, reason: 'no_release' });
    res.status(502).json({ available: false, reason: 'error', message: e.message });
  }
});

// GET /api/desktop/download?platform=win|mac|linux — serve the installer.
router.get('/download', async (req, res) => {
  const platform = ['win', 'mac', 'linux'].includes(req.query.platform) ? req.query.platform : 'win';
  try {
    const rel = await latestRelease();
    const asset = (rel.assets || []).find(a => EXT[platform].test(a.name));
    if (!asset) return res.status(404).json({ error: 'no_installer', message: `No ${platform} installer in the latest release.` });

    if (GH_TOKEN) {
      // Private repo — stream the asset through with auth.
      const upstream = await axios.get(asset.url, {
        headers: ghHeaders({ Accept: 'application/octet-stream' }),
        responseType: 'stream', timeout: 120000,
      });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${asset.name}"`);
      upstream.data.pipe(res);
    } else {
      // Public repo — hand the browser the public download URL.
      res.redirect(asset.browser_download_url);
    }
  } catch (e) {
    if (e.response?.status === 404) return res.status(404).json({ error: 'no_release', message: 'No desktop build has been published yet.' });
    res.status(502).json({ error: 'github_error', message: e.message });
  }
});

module.exports = router;
