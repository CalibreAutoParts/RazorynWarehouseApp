import { json } from "@remix-run/node";
import { sendGA4 } from "../lib/ga4.server";
import { sendMeta } from "../lib/meta.server";
import prisma from "../db.server"; // provided by the Remix app template

// Storefront event name → GA4 / Meta standard names.
const GA4_NAME = {
  page_viewed: "page_view",
  product_viewed: "view_item",
  product_added_to_cart: "add_to_cart",
  search_submitted: "search",
  checkout_started: "begin_checkout",
  checkout_completed: "purchase",
};
const META_NAME = {
  page_viewed: "PageView",
  product_viewed: "ViewContent",
  product_added_to_cart: "AddToCart",
  search_submitted: "Search",
  checkout_started: "InitiateCheckout",
  checkout_completed: "Purchase",
};

// Pull GA4/Meta-friendly params out of the raw Shopify pixel event.
function extractParams(name, event) {
  const d = event?.data ?? {};
  const out = { currency: "GBP" };
  const variant = d.productVariant || d.cartLine?.merchandise;
  if (variant) {
    out.value = Number(variant.price?.amount) || undefined;
    out.items = [
      {
        item_id: variant.sku || variant.id,
        item_name: variant.product?.title || variant.title,
        price: Number(variant.price?.amount) || undefined,
      },
    ];
  }
  const checkout = d.checkout;
  if (checkout) {
    out.value = Number(checkout.totalPrice?.amount) || undefined;
    out.transaction_id = checkout.order?.id || checkout.token;
    out.items = (checkout.lineItems || []).map((li) => ({
      item_id: li.variant?.sku || li.variant?.id,
      item_name: li.title,
      quantity: li.quantity,
      price: Number(li.variant?.price?.amount) || undefined,
    }));
  }
  if (d.searchResult?.query) out.search_term = d.searchResult.query;
  return out;
}

export async function action({ request }) {
  if (request.method !== "POST") return json({ ok: false }, { status: 405 });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, { status: 400 });
  }
  const { name, clientId, event, context } = body || {};
  if (!name) return json({ ok: false }, { status: 400 });

  const params = extractParams(name, event);
  const eventId = event?.id || event?.clientId || `${name}-${Date.now()}`;

  // Fan out (both are no-ops until the env vars are set).
  await Promise.allSettled([
    GA4_NAME[name] &&
      sendGA4([{ name: GA4_NAME[name], params }], clientId),
    META_NAME[name] &&
      sendMeta(META_NAME[name], {
        customData: params,
        eventId,
        sourceUrl: context?.url,
      }),
  ]);

  // Persist for the funnel view (best-effort).
  try {
    await prisma.trackedEvent.create({
      data: {
        name,
        clientId: clientId || null,
        value: params.value ?? null,
        url: context?.url || null,
        payload: JSON.stringify(params),
      },
    });
  } catch (err) {
    // Table may not exist yet on first run — see prisma/schema notes in README.
  }

  return json({ ok: true });
}

// No loader: this route is POST-only from the pixel.
export const loader = () => json({ ok: true });
