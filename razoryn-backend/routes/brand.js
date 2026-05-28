// routes/brand.js — exposes the active brand to the frontend.
// Public endpoint (no auth required) so the login screen can already be branded.
// Never returns secrets like eBay tokens — only the display fields.
const express = require('express');
const brand = require('../lib/brand');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    code: brand.code,
    name: brand.name,
    fullName: brand.fullName,
    domain: brand.domain,
    logoUrl: brand.logoUrl,
    logoUrlDark: brand.logoUrlDark || brand.logoUrl,
    primaryColor: brand.primaryColor,
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
    })),
  });
});

module.exports = router;
