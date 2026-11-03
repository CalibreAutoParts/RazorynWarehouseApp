// routes/brand.js — exposes the active brand to the frontend.
// Public endpoint (no auth required) so the login screen can already be branded.
// Never returns secrets like eBay tokens — only the display fields.
const express = require('express');
const brand = require('../lib/brand');

const router = express.Router();

router.get('/', async (req, res) => {
  // Colours staff picked per sales channel (Settings → Sales channel colours).
  let channelColors = {};
  try {
    const { query } = require('../db');
    channelColors = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data?.channelColors || {};
  } catch (_) {}
  res.json({
    channelColors,
    onbuy: require('../services/onbuy').isConfigured(),
    code: brand.code,
    name: brand.name,
    fullName: brand.fullName,
    domain: brand.domain,
    logoUrl: brand.logoUrl,
    logoUrlDark: brand.logoUrlDark || brand.logoUrl,
    primaryColor: brand.primaryColor,
    primaryColorDark: brand.primaryColorDark || brand.primaryColor,
    secondaryColor: brand.secondaryColor,
    supportColor: brand.supportColor,
    invoicePrefix: brand.invoicePrefix,
    appTitle: brand.appTitle,
    tagline: brand.tagline,
    stores: brand.stores.map(s => ({
      code: s.code,
      name: s.name,
      channelCode: s.channelCode,
      primary: !!s.primary,
      // A shop with no token (e.g. a newly added account not set up yet) or one
      // switched off stays out of pickers/filters; its name still labels old orders.
      connected: !!s.token && !s.disabled,
    })),
  });
});

module.exports = router;
