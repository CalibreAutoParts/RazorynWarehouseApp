// GA4 Measurement Protocol — server-side event delivery.
// Docs: https://developers.google.com/analytics/devguides/collection/protocol/ga4

const ENDPOINT = "https://www.google-analytics.com/mp/collect";

/**
 * @param {Array<{name: string, params: object}>} events
 * @param {string} clientId  stable per-browser id from the pixel
 */
export async function sendGA4(events, clientId) {
  const id = process.env.GA4_MEASUREMENT_ID;
  const secret = process.env.GA4_API_SECRET;
  if (!id || !secret || !events?.length) return;

  const url = `${ENDPOINT}?measurement_id=${id}&api_secret=${secret}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId || `${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
        events,
      }),
    });
  } catch (err) {
    console.error("[ga4] send failed", err);
  }
}
