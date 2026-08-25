// routes/shipping.js — warehouse shipping toolkit.
//   • Carton presets: standard box sizes/weights for pre-packaged parcels, so
//     the handheld can fill a product's parcel fields in two taps.
//   • Courier rate cards: per-courier weight bands (+ volumetric divisor) used
//     by the quote calculator to compare couriers and surface the cheapest.
//   • Returns drop-off area: the designated spot in the warehouse where
//     returned parcels get put — shown as a banner on the Returns page.
// All config lives in app_settings.data.shipping (a jsonb blob) — no new
// tables, survives redeploys, editable from Settings.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

async function shippingBlob() {
  try {
    const r = await query(`SELECT data FROM app_settings WHERE id = 1`);
    return (r.rows[0]?.data || {}).shipping || {};
  } catch (_) { return {}; }
}

// GET /api/shipping/config
// Everyone gets cartons + the returns drop-off text (operational, no money).
// Courier rate cards are admin-only — rates are commercial terms and the
// staff app masks money everywhere else too.
router.get('/config', async (req, res) => {
  try {
    const s = await shippingBlob();
    const out = {
      cartons: Array.isArray(s.cartons) ? s.cartons : [],
      returnsDropoff: s.returnsDropoff || '',
    };
    if (req.user.role === 'admin') out.couriers = Array.isArray(s.couriers) ? s.couriers : [];
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'load_failed', message: e.message }); }
});

// POST /api/shipping/config — merge-update any of { cartons, couriers, returnsDropoff }.
router.post('/config', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
    const shipping = { ...(cur.shipping || {}) };
    if (b.cartons !== undefined) {
      shipping.cartons = (Array.isArray(b.cartons) ? b.cartons : []).slice(0, 60).map(c => ({
        name: String(c.name || '').trim().slice(0, 80),
        lengthCm: c.lengthCm != null && c.lengthCm !== '' ? +parseFloat(c.lengthCm).toFixed(1) : null,
        widthCm: c.widthCm != null && c.widthCm !== '' ? +parseFloat(c.widthCm).toFixed(1) : null,
        heightCm: c.heightCm != null && c.heightCm !== '' ? +parseFloat(c.heightCm).toFixed(1) : null,
        weightKg: c.weightKg != null && c.weightKg !== '' ? +parseFloat(c.weightKg).toFixed(2) : null,
      })).filter(c => c.name);
    }
    if (b.couriers !== undefined) {
      shipping.couriers = (Array.isArray(b.couriers) ? b.couriers : []).slice(0, 30).map(c => ({
        name: String(c.name || '').trim().slice(0, 80),
        volumetricDivisor: parseInt(c.volumetricDivisor) > 0 ? parseInt(c.volumetricDivisor) : 5000,
        maxLongestCm: c.maxLongestCm != null && c.maxLongestCm !== '' ? parseFloat(c.maxLongestCm) : null,
        notes: String(c.notes || '').trim().slice(0, 300),
        bands: (Array.isArray(c.bands) ? c.bands : []).slice(0, 60).map(bd => ({
          maxKg: parseFloat(bd.maxKg),
          price: parseFloat(bd.price),
          name: String(bd.name || '').trim().slice(0, 60),
        })).filter(bd => Number.isFinite(bd.maxKg) && Number.isFinite(bd.price))
          .sort((a, z) => a.maxKg - z.maxKg),
      })).filter(c => c.name);
    }
    if (b.returnsDropoff !== undefined) shipping.returnsDropoff = String(b.returnsDropoff || '').trim().slice(0, 500);
    await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
      [JSON.stringify({ ...cur, shipping })]);
    await audit(req, 'shipping_config', null, null, { keys: Object.keys(b) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

// POST /api/shipping/quote — { lengthCm, widthCm, heightCm, weightKg }
// Rough quote across every configured courier: chargeable weight is the
// greater of actual weight and volumetric weight (L×W×H / divisor, in cm→kg),
// then the first band that covers it. Cheapest first. Admin-only because it
// exposes the rate card.
router.post('/quote', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const L = parseFloat(b.lengthCm), W = parseFloat(b.widthCm), H = parseFloat(b.heightCm);
    const kg = parseFloat(b.weightKg);
    if (!Number.isFinite(kg) && !(Number.isFinite(L) && Number.isFinite(W) && Number.isFinite(H))) {
      return res.status(400).json({ error: 'dims_or_weight_required', message: 'Enter a weight or full dimensions.' });
    }
    const s = await shippingBlob();
    const couriers = Array.isArray(s.couriers) ? s.couriers : [];
    if (!couriers.length) return res.json({ quotes: [], noRates: true });
    const longest = [L, W, H].filter(Number.isFinite).sort((a, z) => z - a)[0] || null;
    const quotes = [];
    for (const c of couriers) {
      const div = c.volumetricDivisor > 0 ? c.volumetricDivisor : 5000;
      const volKg = (Number.isFinite(L) && Number.isFinite(W) && Number.isFinite(H)) ? (L * W * H) / div : null;
      const chargeableKg = Math.max(Number.isFinite(kg) ? kg : 0, volKg != null ? volKg : 0);
      let reason = null;
      if (c.maxLongestCm && longest && longest > c.maxLongestCm) reason = `over ${c.maxLongestCm}cm max length`;
      const band = (c.bands || []).find(bd => chargeableKg <= bd.maxKg);
      if (!reason && !band) reason = `over ${(c.bands || []).length ? Math.max(...c.bands.map(x => x.maxKg)) + 'kg max' : 'no bands set'}`;
      quotes.push({
        courier: c.name, notes: c.notes || '',
        volumetricKg: volKg != null ? +volKg.toFixed(2) : null,
        chargeableKg: +chargeableKg.toFixed(2),
        price: (!reason && band) ? +band.price.toFixed(2) : null,
        band: (!reason && band) ? (band.name || `≤${band.maxKg}kg`) : null,
        unavailable: reason,
      });
    }
    quotes.sort((a, z) => (a.price == null) - (z.price == null) || (a.price ?? 0) - (z.price ?? 0));
    res.json({ quotes });
  } catch (e) { res.status(500).json({ error: 'quote_failed', message: e.message }); }
});

module.exports = router;
