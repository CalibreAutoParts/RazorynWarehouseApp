// lib/uk-vat.js — UK VAT helpers for channel orders.
//
// eBay sends the seller a VAT-INCLUSIVE order total but reports tax = 0 (it doesn't
// split out the seller's VAT), so imported eBay sales had no VAT line. For a
// VAT-registered seller a DOMESTIC sale carries VAT (the portion of the gross);
// an INTERNATIONAL sale sent via eBay's Global/International Shipping is an export
// and is zero-rated. eBay routes those exports to its UK consolidation hub, so the
// ship-to postcode is the hub (WS13 8UR) rather than the buyer's country — that's
// the reliable "this is an export" signal.

// eBay Global Shipping / International Shipping UK hub postcode(s). Normalised
// (no spaces/case). Parcels addressed here are exports.
const GSP_HUB_POSTCODES = ['WS138UR'];

function normalise(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Is this order an eBay export (routed via the Global/International Shipping hub)?
function isGspExport(shippingAddress) {
  const n = normalise(shippingAddress);
  if (GSP_HUB_POSTCODES.some(pc => n.includes(pc))) return true;
  const t = String(shippingAddress || '').toLowerCase();
  return /global shipping (program|programme)|ebay international shipping|international shipping (centre|center)/.test(t);
}

// The VAT portion of a VAT-inclusive gross amount. rate accepts 20 or 0.2.
function vatPortion(gross, rate) {
  const r = rate > 1 ? rate / 100 : rate;
  const g = parseFloat(gross) || 0;
  if (!r || g <= 0) return 0;
  return +(g - g / (1 + r)).toFixed(2);
}

// Compute the VAT for a channel order. Domestic + VAT-registered → portion of the
// gross (goods + delivery). Export (GSP) or not registered → £0 (zero-rated).
// Returns { vat, international }.
function orderVat({ subtotal, shipping, shippingAddress, vatRegistered, vatRate }) {
  const international = isGspExport(shippingAddress);
  if (!vatRegistered || international) return { vat: 0, international };
  const gross = (parseFloat(subtotal) || 0) + (parseFloat(shipping) || 0);
  return { vat: vatPortion(gross, vatRate), international };
}

module.exports = { isGspExport, vatPortion, orderVat, normalise };
