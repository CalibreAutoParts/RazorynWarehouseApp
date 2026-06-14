import prisma from "../db.server";
import { sendEmail } from "./email.server";

/**
 * inventory_levels/update fires with { inventory_item_id, available, ... }.
 * When stock returns (available > 0) we resolve the variant/product behind that
 * inventory item and email everyone who asked to be notified for it.
 *
 * Back-in-stock requests are captured by /api/notify (the theme's "Email me
 * when back in stock" form posts there). See README for the small theme wire-up.
 */
export async function notifyForInventory(payload, admin, shop) {
  const available = Number(payload.available);
  if (!available || available <= 0) return;

  // inventory_item_id → variant → product handle/title
  let product = null;
  try {
    const res = await admin.graphql(
      `#graphql
      query Variant($id: ID!) {
        inventoryItem(id: $id) {
          variant {
            id sku title
            product { id title handle onlineStoreUrl featuredImage { url } }
          }
        }
      }`,
      { variables: { id: `gid://shopify/InventoryItem/${payload.inventory_item_id}` } },
    );
    const body = await res.json();
    product = body.data?.inventoryItem?.variant?.product;
  } catch (err) {
    console.error("[backinstock] lookup failed", err);
    return;
  }
  if (!product) return;

  const pending = await prisma.backInStockRequest.findMany({
    where: { shop, productId: product.id, notifiedAt: null },
  });
  if (!pending.length) return;

  const url = product.onlineStoreUrl || `https://www.razoryn.co.uk/products/${product.handle}`;
  await Promise.all(
    pending.map(async (req) => {
      const ok = await sendEmail({
        to: req.email,
        subject: `Back in stock: ${product.title}`,
        html: `<p>Good news — <strong>${product.title}</strong> is back in stock at Razoryn e-Parts.</p>
               <p><a href="${url}">Order it here</a> before it sells out again. Order by 12pm Mon–Fri for same-day dispatch.</p>`,
      });
      if (ok) {
        await prisma.backInStockRequest.update({
          where: { id: req.id },
          data: { notifiedAt: new Date() },
        });
      }
    }),
  );
}
