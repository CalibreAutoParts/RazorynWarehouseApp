// routes/reviews.js — manual trigger for the eBay→Shopify reviews sync.
// The cron runs nightly; this lets an admin run it on demand from Settings.
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { syncEbayReviews } = require('../services/reviews-sync');

const router = express.Router();
router.use(requireAuth);

router.post('/sync', requireAdmin, async (req, res) => {
  try {
    const result = await syncEbayReviews();
    await audit(req, 'sync_ebay_reviews', null, null, result);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[reviews.sync]', e.message);
    res.status(500).json({ error: 'sync_failed', message: e.message });
  }
});

module.exports = router;
