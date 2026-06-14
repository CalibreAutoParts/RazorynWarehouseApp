// Meta Conversions API — server-side event delivery.
// Docs: https://developers.facebook.com/docs/marketing-api/conversions-api

const API_VERSION = "v19.0";

/**
 * @param {string} eventName  Meta standard name (PageView, ViewContent, AddToCart, InitiateCheckout, Purchase, Search)
 * @param {object} opts       { customData, eventId, sourceUrl, userData }
 */
export async function sendMeta(eventName, opts = {}) {
  const pixel = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixel || !token || !eventName) return;

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: "website",
        event_id: opts.eventId, // pass-through for dedup against the browser pixel
        event_source_url: opts.sourceUrl,
        user_data: opts.userData || {},
        custom_data: opts.customData || {},
      },
    ],
  };
  if (process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  }

  try {
    await fetch(
      `https://graph.facebook.com/${API_VERSION}/${pixel}/events?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  } catch (err) {
    console.error("[meta] send failed", err);
  }
}
