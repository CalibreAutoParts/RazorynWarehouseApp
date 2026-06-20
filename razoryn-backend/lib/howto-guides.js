// lib/howto-guides.js — built-in How-To guides that are auto-published into the
// Key Information (knowledge base) so admins always have step-by-step docs for
// the features in this app. Seeded on boot (insert-if-missing by title), so a
// guide an admin later edits is never overwritten.
//
// Body format matches the KB convention: "<short description>\n\n<full steps>".
// Keep plain text (the KB view renders it pre-wrapped) — no HTML tags.

const GUIDES = [
  {
    title: 'Pre-order & incoming stock — full workflow',
    category: 'How-to',
    body:
`How to handle a new part you don't stock yet, set it up for pre-order, and make it live when the container lands.

1) CREATE THE PRODUCT ON SHOPIFY (pre-order)
   - Create the product on Shopify with stock 0.
   - Turn on "Continue selling when out of stock" so it can be pre-ordered.
   - It syncs into the Warehouse app and links automatically.

2) CREATE THE eBAY LISTING (hidden)
   - Use Listing Mirror to create/mirror the eBay listing.
   - Set its quantity to 0 so it is NOT visible to buyers on eBay yet.

3) ADD IT TO INCOMING STOCK
   - Go to the Incoming tab > + Add incoming.
   - Set the Container number/name (use the real container number — it is unique and trackable), supplier, a rough ETA, and a container note (what's inside / which suppliers).
   - Add the products: search inventory and pick them, or paste a packing list (one "SKU/part, qty" per line). It matches each line to a product automatically.

4) WHILE IT'S ON THE WAY
   - The Inventory page shows a "Pre-order" pill and "ETA ~date" for items that are at 0 stock with units incoming.
   - The Quote Builder shows a clear "Not in stock — pre-order only, arriving ~date" notice so staff can tell customers.
   - You can print labels in advance from the Incoming tab (the label button) ready to apply when goods arrive.

5) WHEN THE CONTAINER IS UNLOADED
   - Go to Incoming. Either press Receive on each line, or "Receive all" on the container card to do the whole container at once.
   - Tick "Push to sales channels" (default on). This:
       * adds the units to warehouse stock,
       * sets the live quantity on Shopify (it flips from pre-order to in stock),
       * sets the quantity on the hidden eBay listing (it becomes visible and in stock).
   - Optionally tick "Print labels for the received units".

That's it — the only action needed once stock arrives is to Receive it, which pushes the new quantity to both sales channels.`,
  },
  {
    title: 'Push notifications on phones & tablets',
    category: 'How-to',
    body:
`Get returns and low-stock alerts pushed to staff devices.

ANDROID / DESKTOP CHROME
1) Open the app, go to Notifications.
2) Tap "Enable on this device" and allow the browser prompt.
3) Use "Send test" to confirm it works.

iPHONE / iPAD (important)
- iOS only allows web push from the INSTALLED app. In Safari, tap Share > Add to Home Screen.
- Open the app FROM the Home Screen icon, then go to Notifications > Enable on this device > allow.
- Use "Send test" to confirm.

NOTES
- When the app is CLOSED, the device's own notification sound is used — custom in-app sounds can't override a background push (an OS limitation, strictest on iOS).
- When the app is OPEN, your custom notification sounds (Settings) play instead.`,
  },
  {
    title: 'Shopify <-> eBay price sync',
    category: 'How-to',
    body:
`Keep the two channels in a fixed price relationship.

1) Settings > "Shopify <-> eBay price sync".
2) Choose the direction:
     - eBay is master: Shopify = eBay minus X%.
     - Shopify is master: eBay = Shopify plus X%.
3) Enter the gap % and click "Preview changes" — review the before/after table.
4) Untick anything you don't want, then "Apply selected to live channel". This writes the new price to the live listing (Shopify variant price, or revises every linked eBay listing).

Also: the bank-transfer (trade) price is set to equal the Shopify price.`,
  },
];

// Seed missing guides into kb_entries. Idempotent: only inserts a guide whose
// title isn't already present, so admin edits are preserved.
async function seedHowtoGuides(query) {
  try {
    await query(`CREATE TABLE IF NOT EXISTS kb_entries (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, category TEXT, body TEXT,
      sensitive BOOLEAN NOT NULL DEFAULT false, created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    let added = 0;
    for (const g of GUIDES) {
      const exists = await query(`SELECT 1 FROM kb_entries WHERE title = $1 LIMIT 1`, [g.title]);
      if (exists.rows.length) continue;
      await query(`INSERT INTO kb_entries (title, category, body, sensitive) VALUES ($1,$2,$3,false)`,
        [g.title, g.category, g.body]);
      added++;
    }
    if (added) console.log(`[boot] seeded ${added} how-to guide(s) into Key Information`);
  } catch (e) {
    console.warn('[howto-guides] seed failed:', e.message);
  }
}

module.exports = { GUIDES, seedHowtoGuides };
