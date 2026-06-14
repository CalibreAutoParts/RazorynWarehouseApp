import { json } from "@remix-run/node";
import prisma from "../db.server";

/**
 * Back-in-stock signup capture. The theme's "Email me when back in stock" form
 * (sections/main-product.liquid) can POST here instead of (or as well as) the
 * Shopify contact form, so the app can auto-send when stock returns.
 *
 * Body: { email, productId (gid), variantId?, shop }
 * CORS-enabled so the storefront origin can call it directly.
 */
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function action({ request }) {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST")
    return json({ ok: false }, { status: 405, headers: cors });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, { status: 400, headers: cors });
  }
  const { email, productId, variantId, shop } = body || {};
  if (!email || !productId)
    return json({ ok: false }, { status: 400, headers: cors });

  await prisma.backInStockRequest.upsert({
    where: { email_productId: { email, productId } },
    create: { shop: shop || "", email, productId, variantId: variantId || null },
    update: { notifiedAt: null }, // re-arm if they sign up again
  });

  return json({ ok: true }, { headers: cors });
}

export const loader = () => json({ ok: true }, { headers: cors });
