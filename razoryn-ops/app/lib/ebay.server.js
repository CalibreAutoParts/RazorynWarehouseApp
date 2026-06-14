// eBay integration for the reviews sync.
// Two pieces: (1) an OAuth token from the stored refresh token, (2) a feedback
// pull. eBay feedback is SELLER-level and per-transaction (positive/neutral/
// negative), so we normalise sentiment to a 1–5 score and aggregate per SKU.
// The exact feedback call uses the legacy Trading API (GetFeedback, XML) — the
// fetch shape is stubbed here; wire your credentials and uncomment to go live.

const OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";

export async function getEbayToken() {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  const refresh = process.env.EBAY_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return null;

  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
  });
  if (!res.ok) {
    console.error("[ebay] token failed", res.status);
    return null;
  }
  const data = await res.json();
  return data.access_token;
}

const SENTIMENT_SCORE = { Positive: 5, Neutral: 3, Negative: 1 };

/**
 * Returns normalised feedback rows: [{ sku, score }] where score is 1–5.
 * Replace the body with a real GetFeedback (Trading API) call. Until configured
 * it returns [] so the sync is a safe no-op.
 */
export async function fetchSellerFeedback() {
  const token = await getEbayToken();
  if (!token) return [];

  // TODO: Trading API GetFeedback (XML POST to https://api.ebay.com/ws/api.dll
  // with X-EBAY-API-CALL-NAME: GetFeedback). Parse each FeedbackDetail →
  // { itemId, sku (from transaction), commentType }.
  // For each row: { sku, score: SENTIMENT_SCORE[commentType] }.
  const rawRows = []; // <- populate from the parsed response
  return rawRows
    .filter((r) => r.sku && SENTIMENT_SCORE[r.commentType])
    .map((r) => ({ sku: r.sku, score: SENTIMENT_SCORE[r.commentType] }));
}

/** Aggregate normalised rows into per-SKU { rating (1dp), count }. */
export function aggregateBySku(rows) {
  const acc = {};
  for (const { sku, score } of rows) {
    acc[sku] = acc[sku] || { sum: 0, count: 0 };
    acc[sku].sum += score;
    acc[sku].count += 1;
  }
  const out = {};
  for (const sku of Object.keys(acc)) {
    out[sku] = {
      rating: Math.round((acc[sku].sum / acc[sku].count) * 10) / 10,
      count: acc[sku].count,
    };
  }
  return out;
}
