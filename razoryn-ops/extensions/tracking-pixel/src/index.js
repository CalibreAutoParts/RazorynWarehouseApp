import { register } from "@shopify/web-pixels-extension";

/**
 * Razoryn tracking pixel.
 * Subscribes to the standard storefront/checkout events and relays each one to
 * the app backend (/api/track), which forwards to GA4 + Meta server-side.
 * The pixel runtime only loads when the visitor has granted analytics/marketing
 * consent (see customer_privacy in shopify.extension.toml), so this is GDPR-safe.
 */
register(({ analytics, browser, init, settings }) => {
  const endpoint = settings.trackEndpoint;
  if (!endpoint) return;

  // Stable per-browser id so GA4/Meta can stitch a session together.
  const getClientId = async () => {
    let id = await browser.localStorage.getItem("rz_client_id");
    if (!id) {
      id = `${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
      await browser.localStorage.setItem("rz_client_id", id);
    }
    return id;
  };

  const relay = async (name, event) => {
    try {
      const clientId = await getClientId();
      const body = JSON.stringify({
        name,
        clientId,
        event,
        context: {
          url: init.context?.document?.location?.href,
          userAgent: init.context?.navigator?.userAgent,
        },
      });
      // keepalive so the request survives the checkout-step navigation.
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
    } catch (_) {
      /* never block the storefront on a tracking failure */
    }
  };

  [
    "page_viewed",
    "product_viewed",
    "product_added_to_cart",
    "search_submitted",
    "checkout_started",
    "checkout_completed",
  ].forEach((name) => analytics.subscribe(name, (event) => relay(name, event)));
});
