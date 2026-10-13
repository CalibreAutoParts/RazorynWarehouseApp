// Reads the Warehouse Hub invoice the Hub stamped onto the order
// (metafields razoryn.invoice_url / razoryn.invoice_number).
export const NOT_READY =
  'The invoice is still being prepared. It appears within about 30 minutes of the order, or straight away after "Pull latest" in the Warehouse Hub.';

export async function loadInvoice(orderId) {
  const res = await shopify.query(
    `query WarehouseInvoice($id: ID!) {
      order(id: $id) {
        name
        url: metafield(namespace: "razoryn", key: "invoice_url") { value }
        number: metafield(namespace: "razoryn", key: "invoice_number") { value }
      }
    }`,
    {variables: {id: orderId}},
  );
  const order = res?.data?.order;
  if (!order) throw new Error((res?.errors && res.errors[0]?.message) || 'Order not found.');
  return {name: order.name, url: order.url?.value || null, number: order.number?.value || ''};
}
