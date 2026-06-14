import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Badge,
  Text,
  InlineGrid,
  BlockStack,
  EmptyState,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [orders, needsFitment, lpOpen, pendingStock] = await Promise.all([
    prisma.orderRecord.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.orderRecord.count({ where: { shop, needsFitment: true, fulfilled: false } }),
    prisma.orderRecord.count({ where: { shop, isLargePanel: true, fulfilled: false } }),
    prisma.backInStockRequest.count({ where: { shop, notifiedAt: null } }),
  ]);

  return json({ orders, needsFitment, lpOpen, pendingStock });
}

function money(cents) {
  return cents == null ? "—" : "£" + (cents / 100).toFixed(2);
}

export default function Dashboard() {
  const { orders, needsFitment, lpOpen, pendingStock } = useLoaderData();

  const rows = orders.map((o, i) => (
    <IndexTable.Row id={o.id} key={o.id} position={i}>
      <IndexTable.Cell>
        <Text fontWeight="bold" as="span">{o.name}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{money(o.total)}</IndexTable.Cell>
      <IndexTable.Cell>
        {o.vehicleReg
          ? <Badge tone="success">{o.vehicleReg}</Badge>
          : <Badge tone="attention">No reg — confirm fitment</Badge>}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {o.isLargePanel ? <Badge tone="warning">Large panel — special courier</Badge> : "Standard"}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {o.fulfilled ? <Badge tone="success">Fulfilled</Badge> : <Badge>Open</Badge>}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page title="Razoryn Ops" subtitle="Orders, fitment & retention">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
            <Card><BlockStack gap="100">
              <Text variant="headingLg" as="p">{needsFitment}</Text>
              <Text tone="subdued" as="p">Orders needing fitment confirmation</Text>
            </BlockStack></Card>
            <Card><BlockStack gap="100">
              <Text variant="headingLg" as="p">{lpOpen}</Text>
              <Text tone="subdued" as="p">Open large-panel orders to route</Text>
            </BlockStack></Card>
            <Card><BlockStack gap="100">
              <Text variant="headingLg" as="p">{pendingStock}</Text>
              <Text tone="subdued" as="p">Back-in-stock requests waiting</Text>
            </BlockStack></Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {orders.length === 0 ? (
              <EmptyState heading="No orders yet" image="">
                <p>Orders will appear here as they come in, enriched with the customer's reg and a large-panel flag.</p>
              </EmptyState>
            ) : (
              <IndexTable
                itemCount={orders.length}
                selectable={false}
                headings={[
                  { title: "Order" },
                  { title: "Total" },
                  { title: "Vehicle reg" },
                  { title: "Shipping" },
                  { title: "Status" },
                ]}
              >
                {rows}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
