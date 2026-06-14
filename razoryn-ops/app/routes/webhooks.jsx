import { authenticate } from "../shopify.server"; // from the Remix app template
import prisma from "../db.server";
import { notifyForInventory } from "../lib/backinstock.server";

/**
 * Single webhook endpoint (matches uri = "/webhooks" in shopify.app.toml).
 * authenticate.webhook verifies the HMAC and gives us topic/shop/payload/admin.
 */
export async function action({ request }) {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  try {
    switch (topic) {
      case "ORDERS_CREATE":
        await onOrderCreate(payload, admin);
        break;
      case "ORDERS_FULFILLED":
        await prisma.orderRecord.updateMany({
          where: { shop, orderId: String(payload.id) },
          data: { fulfilled: true },
        });
        break;
      case "INVENTORY_LEVELS_UPDATE":
        await notifyForInventory(payload, admin, shop);
        break;
      case "CHECKOUTS_CREATE":
      case "CHECKOUTS_UPDATE":
        await upsertAbandoned(payload, shop);
        break;
      case "APP_UNINSTALLED":
        await prisma.session.deleteMany({ where: { shop } });
        break;
    }
  } catch (err) {
    console.error(`[webhook ${topic}]`, err);
  }
  return new Response();
}

function attr(order, key) {
  const a = (order.note_attributes || []).find((x) => x.name === key);
  return a ? a.value : null;
}

async function onOrderCreate(order, admin) {
  // The theme saves the customer's reg as a cart attribute → order note attribute.
  const reg = attr(order, "Vehicle reg");

  // Flag large-panel orders (tag "LP") for the dedicated courier by reading
  // the products' tags from the Admin API.
  let isLargePanel = false;
  try {
    const ids = (order.line_items || [])
      .map((li) => li.product_id)
      .filter(Boolean)
      .map((id) => `gid://shopify/Product/${id}`);
    if (ids.length) {
      const res = await admin.graphql(
        `#graphql
        query Tags($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { tags } } }`,
        { variables: { ids } },
      );
      const body = await res.json();
      isLargePanel = (body.data?.nodes || []).some((n) =>
        (n?.tags || []).includes("LP"),
      );
    }
  } catch (err) {
    console.error("[orders/create] tag lookup failed", err);
  }

  await prisma.orderRecord.create({
    data: {
      shop: order.__shop || "",
      orderId: String(order.id),
      name: order.name,
      email: order.email || order.contact_email || null,
      total: order.total_price ? Math.round(Number(order.total_price) * 100) : null,
      vehicleReg: reg,
      isLargePanel,
      // No reg supplied → surface in the "needs fitment confirmation" queue.
      needsFitment: !reg,
      fulfilled: false,
    },
  });
}

async function upsertAbandoned(checkout, shop) {
  if (!checkout?.email || checkout?.completed_at) return;
  await prisma.abandonedCheckout.upsert({
    where: { token: checkout.token },
    create: {
      shop,
      token: checkout.token,
      email: checkout.email,
      total: checkout.total_price
        ? Math.round(Number(checkout.total_price) * 100)
        : null,
      recoveredAt: null,
    },
    update: {
      total: checkout.total_price
        ? Math.round(Number(checkout.total_price) * 100)
        : null,
    },
  });
  // A scheduled job sends the recovery sequence to rows where recoveredAt is null
  // and updatedAt is older than N hours.
}
