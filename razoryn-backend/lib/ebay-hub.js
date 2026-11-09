// lib/ebay-hub.js — the eBay page: buyer messages (read + reply) for every eBay
// account, and offers to interested buyers (watchers).
//
// Messages use the Trading API with each account's own token:
//   GetMyMessages (headers, then bodies) → ebay_messages
//   AddMemberMessageRTQ  — reply to a message a BUYER sent (policy-safe: a
//                          response, never unsolicited; every reply is checked
//                          by lib/ebay-message-guard first)
//   ReviseMyMessages     — mark read on eBay
// Offers use the Negotiation API (OAuth, sell.inventory) — only the eBay account
// connected through OAuth (the app's refresh token) can send them.
const { query } = require('../db');
const brand = require('./brand');

let _ready = null;
function ensureSchema() {
  if (_ready) return _ready;
  _ready = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS ebay_messages (
      id SERIAL PRIMARY KEY, store_code TEXT NOT NULL, message_id TEXT NOT NULL, external_id TEXT,
      sender TEXT, recipient TEXT, subject TEXT, body TEXT, item_id TEXT, item_title TEXT, message_type TEXT,
      received_at TIMESTAMPTZ, is_read BOOLEAN NOT NULL DEFAULT false, replied BOOLEAN NOT NULL DEFAULT false,
      response_enabled BOOLEAN NOT NULL DEFAULT false, high_priority BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (store_code, message_id))`);
    await query(`CREATE INDEX IF NOT EXISTS ebay_messages_recv_idx ON ebay_messages (received_at DESC)`);
    await query(`ALTER TABLE ebay_messages ADD COLUMN IF NOT EXISTS media JSONB`);   // buyer's photos [{url,name}]
    // done = handled without a reply ("no reply needed"); last_from = who wrote
    // the last message in the conversation this email carries ('buyer'|'us').
    await query(`ALTER TABLE ebay_messages ADD COLUMN IF NOT EXISTS done BOOLEAN NOT NULL DEFAULT false`);
    await query(`ALTER TABLE ebay_messages ADD COLUMN IF NOT EXISTS last_from TEXT`);
    await query(`CREATE TABLE IF NOT EXISTS ebay_message_replies (
      id SERIAL PRIMARY KEY, message_row_id INTEGER NOT NULL, store_code TEXT, body TEXT NOT NULL,
      sent_by INTEGER, sent_at TIMESTAMPTZ NOT NULL DEFAULT now(), ok BOOLEAN NOT NULL DEFAULT true, error TEXT)`);
    await query(`ALTER TABLE ebay_message_replies ADD COLUMN IF NOT EXISTS media JSONB`);
    await query(`CREATE TABLE IF NOT EXISTS ebay_offers_sent (
      id SERIAL PRIMARY KEY, listing_id TEXT NOT NULL, product_id INTEGER, price NUMERIC(10,2), discount_pct NUMERIC(6,2),
      message TEXT, sent_by INTEGER, sent_at TIMESTAMPTZ NOT NULL DEFAULT now(), ok BOOLEAN NOT NULL DEFAULT true,
      offers INTEGER, error TEXT)`);
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

const ebay = () => require('../services/ebay');
// Accounts with a Trading token, not switched off.
function messageStores() {
  return (brand.allStores || brand.stores || []).filter(s => s.token && !s.disabled);
}

// ── Messages ──────────────────────────────────────────────────────────────
function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}
// eBay wraps the buyer's words in a full email template; their text sits in
// the "UserInputtedText" block when there is one.
function messageText(raw) {
  const E = ebay();
  const html = E.decodeEntities(String(raw || ''));
  const m = html.match(/id="UserInputtedText\d*"[^>]*>([\s\S]*?)<\/div>/i);
  return stripHtml(m ? m[1] : html).slice(0, 8000);
}

function parseHeaders(xml) {
  const E = ebay();
  return E.extractAll(xml, 'Message').map(b => ({
    messageId: E.extractOne(b, 'MessageID'),
    externalId: E.extractOne(b, 'ExternalMessageID'),
    sender: E.decodeEntities(E.extractOne(b, 'Sender') || ''),
    recipient: E.decodeEntities(E.extractOne(b, 'RecipientUserID') || ''),
    subject: E.decodeEntities(E.extractOne(b, 'Subject') || ''),
    received: E.extractOne(b, 'ReceiveDate'),
    itemId: E.extractOne(b, 'ItemID'),
    itemTitle: E.decodeEntities(E.extractOne(b, 'ItemTitle') || ''),
    read: E.extractOne(b, 'Read') === 'true',
    replied: E.extractOne(b, 'Replied') === 'true',
    type: E.extractOne(b, 'MessageType'),
    responseEnabled: (E.extractOne(b, 'ResponseEnabled') || '') === 'true',
    highPriority: E.extractOne(b, 'HighPriority') === 'true',
    text: E.extractOne(b, 'Text'),
    content: E.extractOne(b, 'Content'),
    media: E.extractAll(b, 'MessageMedia').map(mm => ({ url: E.decodeEntities(E.extractOne(mm, 'MediaURL') || ''), name: E.decodeEntities(E.extractOne(mm, 'MediaName') || '') })).filter(x => /^https?:\/\//.test(x.url)),
  })).filter(m => m.messageId);
}

async function tradingOk(call, body, store) {
  const E = ebay();
  const xml = await E.tradingCall(call, body, store);
  const ack = E.extractOne(xml, 'Ack') || '';
  if (ack !== 'Success' && ack !== 'Warning') {
    const msg = E.extractOne(xml, 'LongMessage') || E.extractOne(xml, 'ShortMessage') || 'eBay returned ' + (ack || 'an error');
    throw new Error(`${call}: ${E.decodeEntities(msg)}`);
  }
  return xml;
}

// Pull the inbox for one account: headers for the last `days`, then bodies for
// anything new. Returns { store, fetched, added }.
async function syncStore(store, { days = 5 } = {}) {
  await ensureSchema();
  const end = new Date(), start = new Date(Date.now() - days * 86400000);
  const xml = await tradingOk('GetMyMessages', `<DetailLevel>ReturnHeaders</DetailLevel><FolderID>0</FolderID>
    <StartTime>${start.toISOString()}</StartTime><EndTime>${end.toISOString()}</EndTime>`, store.code);
  const heads = parseHeaders(xml);
  let added = 0;
  const needBody = [], fresh = [];
  for (const h of heads) {
    const r = (await query(`INSERT INTO ebay_messages (store_code, message_id, external_id, sender, recipient, subject, item_id, item_title,
        message_type, received_at, is_read, replied, response_enabled, high_priority)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (store_code, message_id) DO UPDATE SET is_read = ebay_messages.is_read OR EXCLUDED.is_read,
        replied = ebay_messages.replied OR EXCLUDED.replied, response_enabled = EXCLUDED.response_enabled
      RETURNING (xmax = 0) AS inserted, body IS NULL AS no_body`,
      [store.code, h.messageId, h.externalId, h.sender, h.recipient, h.subject, h.itemId, h.itemTitle, h.type,
       h.received ? new Date(h.received) : null, h.read, h.replied, h.responseEnabled, h.highPriority])).rows[0];
    if (r.inserted) {
      added++;
      // New buyer message (not eBay's own notices, not old backfill) → alert.
      const isEbayMsg = /^ebay$/i.test(h.sender || '') || /@/.test(h.sender || '') || /^ebay /i.test(h.sender || '');
      if (!isEbayMsg && h.received && Date.now() - new Date(h.received).getTime() < 3 * 3600 * 1000) fresh.push(h);
    }
    if (r.no_body) needBody.push(h.messageId);
  }
  // Messages saved before photos / reply tracking existed: fetch again.
  const redo = (await query(`SELECT message_id FROM ebay_messages WHERE store_code = $1 AND (media IS NULL OR last_from IS NULL)
      AND received_at > now() - interval '45 days' ORDER BY received_at DESC LIMIT 60`, [store.code])).rows.map(r => r.message_id);
  for (const id of redo) if (!needBody.includes(id)) needBody.push(id);
  // Bodies, 10 per call (eBay's limit for ReturnMessages).
  for (let i = 0; i < needBody.length; i += 10) {
    const ids = needBody.slice(i, i + 10);
    try {
      const bx = await tradingOk('GetMyMessages', `<DetailLevel>ReturnMessages</DetailLevel>
        <MessageIDs>${ids.map(id => `<MessageID>${ebay().escapeXml(id)}</MessageID>`).join('')}</MessageIDs>`, store.code);
      for (const m of parseHeaders(bx)) {
        const body = m.content ? stripHtml(ebay().decodeEntities(m.content)) : messageText(m.text);
        // Photos: eBay's MessageMedia, else pictures the buyer uploaded that
        // only appear in the email (eBay Picture Services "/00/s/" URLs —
        // listing thumbnails use other paths).
        let media = m.media || [];
        if (!media.length && m.text) {
          const html = ebay().decodeEntities(m.text);
          media = [...new Set((html.match(/https:\/\/i\.ebayimg\.com\/00\/s\/[^"'\s<>)]+/g) || []))].slice(0, 10).map(u => ({ url: u.replace(/&amp;/g, '&'), name: 'Photo' }));
        }
        const snd = m.sender || (await query(`SELECT sender FROM ebay_messages WHERE store_code = $1 AND message_id = $2`, [store.code, m.messageId])).rows[0]?.sender || null;
        const conv = parseConversation(body || '', snd);
        await query(`UPDATE ebay_messages SET body = $3, media = $4::jsonb, last_from = $5 WHERE store_code = $1 AND message_id = $2`,
          [store.code, m.messageId, body || '', JSON.stringify(media), conv.length ? conv[conv.length - 1].from : 'buyer']);
      }
    } catch (e) { console.warn('[ebay-hub] bodies', store.code, e.message); }
  }
  if (fresh.length) {
    try {
      const notify = require('./notify');
      if (fresh.length === 1) {
        const h = fresh[0];
        const row = (await query(`SELECT id, body FROM ebay_messages WHERE store_code = $1 AND message_id = $2`, [store.code, h.messageId])).rows[0];
        const conv = row ? parseConversation(row.body, h.sender) : [];
        const text = (conv.filter(x => x.from === 'buyer').slice(-1)[0]?.text || h.subject || '').replace(/\s+/g, ' ').slice(0, 140);
        await notify.notifyEvent({ type: 'ebay_message', title: `💬 ${h.sender} · ${store.name}`, body: (h.itemTitle ? h.itemTitle.slice(0, 50) + ': ' : '') + text,
          relatedType: 'ebay_message', relatedId: row?.id || null, url: '/#ebay', tag: 'ebaymsg-' + h.messageId, force: true });
      } else {
        const who = [...new Set(fresh.map(h => h.sender))];
        await notify.notifyEvent({ type: 'ebay_message', title: `💬 ${fresh.length} new eBay messages · ${store.name}`,
          body: 'From ' + who.slice(0, 4).join(', ') + (who.length > 4 ? ` +${who.length - 4} more` : ''), url: '/#ebay', tag: 'ebaymsg-batch-' + Date.now(), force: true });
      }
    } catch (e) { console.warn('[ebay-hub] notify:', e.message); }
  }
  return { store: store.code, fetched: heads.length, added };
}

let _syncing = false, _lastSyncAt = null;
async function syncAll(opts = {}) {
  if (_syncing) return { skipped: 'running' };
  _syncing = true; _lastSyncAt = new Date();
  const out = [];
  try {
    for (const s of messageStores()) {
      try { out.push(await syncStore(s, opts)); } catch (e) { out.push({ store: s.code, error: e.message }); }
    }
  } finally { _syncing = false; }
  return out;
}

async function markRead(row) {
  await query(`UPDATE ebay_messages SET is_read = true WHERE id = $1`, [row.id]);
  if (row.is_read) return;
  try {
    await tradingOk('ReviseMyMessages', `<MessageIDs><MessageID>${ebay().escapeXml(row.message_id)}</MessageID></MessageIDs><Read>true</Read>`, row.store_code);
  } catch (e) { console.warn('[ebay-hub] mark read:', e.message); }
}

// Reply to a buyer's message (AddMemberMessageRTQ). Checked against eBay's
// member-to-member rules first; nothing is sent if it fails the check.
// eBay sends each message as an email with the earlier conversation pasted
// underneath ("Your previous message" = ours, the buyer's name = theirs).
// Turn that into separate messages, oldest first.
// eBay's email around a message: order details, account notices, footer.
// Pull out the order (number / status / item) and drop the rest.
const BOILER = /^(We scan messages|Email reference ID|We don'?t check replies|eBay sent this message|This email was sent by eBay|(?:&copy;|©)\s*\d{4}|Learn more about|If you have a question, go to|Only purchases on eBay|Asking to complete a transaction)/i;
function cleanBody(body) {
  let lines = String(body || '').replace(/&copy;/g, '©').split('\n').map(l => l.trim()).filter(Boolean);
  const cut = lines.findIndex(l => BOILER.test(l));
  if (cut >= 0) lines = lines.slice(0, cut);
  const order = {};
  const si = lines.findIndex(l => /^Order status:/i.test(l));
  lines = lines.filter((l, i) => {
    let m;
    if ((m = l.match(/^Order status:\s*(.+)$/i))) { order.status = m[1]; return false; }
    if ((m = l.match(/^Order number:\s*([\d-]+)/i))) { order.number = m[1]; return false; }
    if (/^View order details$/i.test(l) || /^Reply$/i.test(l) || /^→$/.test(l) || /^\(\s*\d+\s*\)$/.test(l)) return false;
    if (si > 0 && i === si - 1) { order.title = l; return false; }   // item title above "Order status"
    return true;
  });
  return { lines, order: order.number || order.status ? order : null };
}
// Every order number mentioned anywhere in the message (e.g. 17-15385-84786).
function orderNumbersIn(body) {
  return [...new Set((String(body || '').match(/\b\d{2}-\d{5}-\d{5}\b/g) || []))];
}

// eBay sends each message as an email with the earlier conversation pasted
// underneath ("Your previous message" = ours, the buyer's name = theirs).
// Turn that into separate messages, oldest first.
function parseConversation(body, buyer) {
  const { lines } = cleanBody(body);
  const isBuyer = l => buyer && l.toLowerCase() === String(buyer).toLowerCase();
  const nm = lines.findIndex(l => /^New message from:?$/i.test(l));
  if (nm < 0) {
    // No eBay header (e.g. the copy of a message WE sent): split on
    // "Dear X, … - Y" blocks; Y = the buyer → theirs, otherwise ours.
    const out = []; let cur = [];
    for (const l of lines) {
      const sig = l.match(/^-\s+(\S+)$/);
      if (sig) { const text = cur.filter(x => !/^Dear\s.+,$/.test(x)).join('\n').trim(); if (text) out.push({ from: isBuyer(sig[1]) ? 'buyer' : 'us', text }); cur = []; }
      else cur.push(l);
    }
    const rest = cur.filter(x => !/^Dear\s.+,$/.test(x)).join('\n').trim();
    if (rest) out.push({ from: 'buyer', text: rest });
    return out.length ? out.reverse() : [{ from: 'buyer', text: lines.join('\n') }];
  }
  let newest = lines.slice(0, nm).join('\n');
  const isOurs = l => /^your previous message$/i.test(l);
  const blocks = [];
  let i = nm + 1;
  if (isBuyer(lines[i])) i++;                                   // "New message from: <name>"
  // The top of eBay's email is a SHORTENED preview ("…"); the full text is in
  // the first "Dear <us>, … - <buyer>" block that follows — use that.
  {
    let j = i;
    while (j < lines.length && !/^Dear\s.+,$/.test(lines[j]) && !isOurs(lines[j]) && !isBuyer(lines[j])) j++;
    if (j < lines.length && /^Dear\s.+,$/.test(lines[j])) {
      let k = j + 1;
      while (k < lines.length && !/^-\s\S+/.test(lines[k])) k++;
      const full = lines.slice(j + 1, k).join('\n').trim();
      if (full && k < lines.length && isBuyer(lines[k].replace(/^-\s+/, '').trim())) { newest = full; i = k + 1; }
    }
  }
  while (i < lines.length) {
    const l = lines[i];
    if (isBuyer(l) || isOurs(l)) {
      const from = isOurs(l) ? 'us' : 'buyer';
      let j = i + 1;
      while (j < lines.length && !/^Dear\s.+,$/.test(lines[j])) j++;
      let k = j + 1;
      while (k < lines.length && !/^-\s\S+/.test(lines[k])) k++;
      const text = (j + 1 < k ? lines.slice(j + 1, k) : lines.slice(i + 1, j)).join('\n').trim();
      if (text) blocks.push({ from, text });
      i = k + 1; continue;
    }
    i++;
  }
  const out = blocks.reverse();
  if (newest && !(out.length && out[out.length - 1].from === 'buyer' && out[out.length - 1].text === newest)) out.push({ from: 'buyer', text: newest });
  return out.filter((m, idx) => idx === 0 || !(m.text === out[idx - 1].text && m.from === out[idx - 1].from));
}

// The buyer's order this message is about (by the order number eBay puts in
// the message) — so a reply may include the courier's tracking link.
async function orderForMessage(row) {
  const nums = orderNumbersIn(row.body);
  if (!nums.length) return null;
  const s = (await query(`SELECT id, invoice_number, external_order_id, status, dispatched_at, carrier, tracking_number,
      ${'tracking_url'} FROM sales WHERE external_order_id = ANY($1) AND channel LIKE 'ebay_%' ORDER BY occurred_at DESC LIMIT 1`, [nums]).catch(() => ({ rows: [] }))).rows[0];
  const info = cleanBody(row.body).order || {};
  return { number: nums[0], status: info.status || null, title: info.title || null, sale: s || null };
}

// Photos for a reply: bytes → eBay Picture Services. Returns [{url,name}].
async function uploadPhotos(rowId, files = []) {
  await ensureSchema();
  const row = (await query(`SELECT store_code FROM ebay_messages WHERE id = $1`, [rowId])).rows[0];
  if (!row) throw Object.assign(new Error('Message not found'), { status: 404 });
  const out = [];
  for (const f of files.slice(0, 5)) {
    const m = String(f.data || '').match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
    if (!m) continue;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 7 * 1024 * 1024) throw Object.assign(new Error(`${f.name || 'Photo'} is over 7MB`), { status: 400 });
    out.push({ url: await ebay().uploadPicture(row.store_code, buf, f.name || 'photo.jpg'), name: String(f.name || 'Photo').slice(0, 60) });
  }
  return out;
}

async function reply(rowId, body, userId, media = []) {
  await ensureSchema();
  const row = (await query(`SELECT * FROM ebay_messages WHERE id = $1`, [rowId])).rows[0];
  if (!row) throw Object.assign(new Error('Message not found'), { status: 404 });
  const text = String(body || '').trim() || ((media || []).length ? 'Photos attached.' : '');
  if (!text) throw Object.assign(new Error('Write a reply first'), { status: 400 });
  // Courier tracking links are fine when it's about an order they've placed.
  const order = await orderForMessage(row);
  require('./ebay-message-guard').assertClean('', text, { allowTracking: !!(order && order.sale) });
  if (!row.item_id) throw Object.assign(new Error("eBay only lets you reply from here to messages about one of your listings — reply to this one on eBay."), { status: 400 });
  if (!row.external_id) throw Object.assign(new Error('This message has no reply reference — reply on eBay.'), { status: 400 });
  const E = ebay();
  try {
    await tradingOk('AddMemberMessageRTQ', `<ItemID>${E.escapeXml(row.item_id)}</ItemID>
      <MemberMessage>
        <Body>${E.escapeXml(text.slice(0, 2000))}</Body>
        <DisplayToPublic>false</DisplayToPublic>
        <EmailCopyToSender>true</EmailCopyToSender>
        <ParentMessageID>${E.escapeXml(row.external_id)}</ParentMessageID>
        <RecipientID>${E.escapeXml(row.sender)}</RecipientID>
        ${(media || []).slice(0, 5).filter(x => /^https:\/\//.test(x.url || '')).map(x => `<MessageMedia><MediaURL>${E.escapeXml(x.url)}</MediaURL><MediaName>${E.escapeXml(String(x.name || 'Photo').slice(0, 60))}</MediaName></MessageMedia>`).join('')}
      </MemberMessage>`, row.store_code);
  } catch (e) {
    await query(`INSERT INTO ebay_message_replies (message_row_id, store_code, body, sent_by, ok, error) VALUES ($1,$2,$3,$4,false,$5)`,
      [row.id, row.store_code, text, userId || null, e.message.slice(0, 500)]);
    throw Object.assign(new Error(e.message), { status: 502 });
  }
  await query(`INSERT INTO ebay_message_replies (message_row_id, store_code, body, sent_by, media) VALUES ($1,$2,$3,$4,$5::jsonb)`, [row.id, row.store_code, text, userId || null, JSON.stringify(media || [])]);
  await query(`UPDATE ebay_messages SET replied = true, last_from = 'us' WHERE id = $1`, [row.id]);
  await markRead(row);
  return { ok: true };
}

// ── Offers to interested buyers (Negotiation API) ────────────────────────
async function eligibleItems() {
  const E = ebay();
  const ids = [];
  for (let off = 0; off < 2000; off += 200) {
    let r;
    try { r = await E.restHttp('GET', `/sell/negotiation/v1/find_eligible_items?limit=200&offset=${off}`); }
    catch (e) {
      const errs = e.response?.data?.errors;
      throw Object.assign(new Error('eBay offers: ' + (errs ? errs.map(x => x.longMessage || x.message).join(' | ') : e.message)), { status: 502 });
    }
    const items = r.data?.eligibleItems || [];
    for (const it of items) if (it.listingId) ids.push(String(it.listingId));
    if (items.length < 200) break;
  }
  if (!ids.length) return [];
  // Our part for each listing (cost, prices, floor) — via the listing link.
  const rows = (await query(`SELECT ml.ebay_item_id, ml.store_code, p.id, p.sku, p.title, p.image_url, p.qty_on_hand, p.price_ebay,
      p.cost_price, p.landed_cost, p.large_panel, p.shipping_band, p.shipping_cost, p.postage_in_price
    FROM mirror_links ml LEFT JOIN products p ON p.shopify_product_id::text = ml.shopify_product_id::text
    WHERE ml.ebay_item_id = ANY($1)`, [ids])).rows;
  const PF = require('./pricing-floor');
  const S = PF.resolveCostSettings((await query(`SELECT * FROM app_settings WHERE id = 1`)).rows[0] || {});
  const by = new Map(rows.map(r => [r.ebay_item_id, r]));
  return ids.map(id => {
    const p = by.get(id);
    if (!p || !p.id) return { listingId: id, unknown: true };
    const fl = p.cost_price != null ? PF.computeFloor({ costPrice: Number(p.cost_price), landedCost: p.landed_cost, isLarge: !!p.large_panel,
      band: p.shipping_band, shippingCost: p.shipping_cost, postageInPrice: p.postage_in_price, channel: 'ebay', settings: S }) : null;
    return { listingId: id, storeCode: p.store_code || null, productId: p.id, sku: p.sku, title: p.title, image: p.image_url,
      qty: p.qty_on_hand, price: p.price_ebay != null ? Number(p.price_ebay) : null,
      floor: fl?.floor ?? null, breakeven: fl?.breakeven ?? null };
  });
}

// items: [{ listingId, price? , discountPct? }]
async function sendOffers({ items = [], message = '', allowCounterOffer = false }, userId) {
  await ensureSchema();
  const E = ebay();
  const msg = String(message || '').trim().slice(0, 2000);
  if (msg) require('./ebay-message-guard').assertClean('', msg);
  const results = [];
  for (const it of items.slice(0, 50)) {
    const offered = { listingId: String(it.listingId), quantity: 1 };
    if (it.price != null && it.price !== '') offered.price = { currency: 'GBP', value: Number(it.price).toFixed(2) };
    else if (it.discountPct) offered.discountPercentage = String(Math.round(Number(it.discountPct)));
    else { results.push({ listingId: it.listingId, ok: false, error: 'No price or % given' }); continue; }
    const body = { allowCounterOffer: !!allowCounterOffer, offerDuration: { unit: 'DAY', value: 2 }, offeredItems: [offered] };
    if (msg) body.message = msg;
    try {
      const r = await E.restHttp('POST', '/sell/negotiation/v1/send_offer_to_interested_buyers', body);
      const n = (r.data?.offers || []).length;
      await query(`INSERT INTO ebay_offers_sent (listing_id, product_id, price, discount_pct, message, sent_by, offers) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [offered.listingId, it.productId || null, offered.price ? Number(offered.price.value) : null, offered.discountPercentage || null, msg || null, userId || null, n]);
      results.push({ listingId: it.listingId, ok: true, offers: n });
    } catch (e) {
      const errs = e.response?.data?.errors;
      const err = errs ? errs.map(x => x.longMessage || x.message).join(' | ') : e.message;
      await query(`INSERT INTO ebay_offers_sent (listing_id, product_id, price, discount_pct, message, sent_by, ok, error) VALUES ($1,$2,$3,$4,$5,$6,false,$7)`,
        [offered.listingId, it.productId || null, offered.price ? Number(offered.price.value) : null, offered.discountPercentage || null, msg || null, userId || null, err.slice(0, 500)]);
      results.push({ listingId: it.listingId, ok: false, error: err });
    }
  }
  return results;
}

// Live from eBay: is this order shipped, with what tracking? Then bring the
// warehouse in line — shipped on eBay but not here → mark dispatched (with
// eBay's tracking); dispatched here without tracking → add eBay's tracking.
async function checkOrderOnEbay(storeCode, orderId) {
  const E = ebay();
  const xml = await tradingOk('GetOrders', `<OrderIDArray><OrderID>${E.escapeXml(orderId)}</OrderID></OrderIDArray><DetailLevel>ReturnAll</DetailLevel>`, storeCode);
  const o = E.extractOne(xml, 'Order');
  if (!o) return { found: false };
  const tb = E.extractOne(o, 'ShipmentTrackingDetails') || '';
  const ebayInfo = {
    found: true, status: E.extractOne(o, 'OrderStatus'), shippedAt: E.extractOne(o, 'ShippedTime') || null,
    tracking: E.decodeEntities(E.extractOne(tb, 'ShipmentTrackingNumber') || '') || null,
    carrier: E.decodeEntities(E.extractOne(tb, 'ShippingCarrierUsed') || '') || null,
  };
  ebayInfo.shipped = !!(ebayInfo.shippedAt || ebayInfo.tracking);
  const sale = (await query(`SELECT id, dispatched_at, tracking_number, carrier FROM sales WHERE external_order_id = $1 AND channel LIKE 'ebay_%' LIMIT 1`, [orderId])).rows[0];
  let updated = null;
  if (sale && ebayInfo.shipped && !sale.dispatched_at) {
    await query(`UPDATE sales SET dispatched_at = COALESCE($4::timestamptz, now()), status = 'dispatched', channel_push_state = 'na',
        carrier = COALESCE($2, carrier), tracking_number = COALESCE($3, tracking_number),
        dispatch_notes = COALESCE(dispatch_notes, 'Shipped on eBay') WHERE id = $1`, [sale.id, ebayInfo.carrier, ebayInfo.tracking, ebayInfo.shippedAt]);
    updated = 'dispatched';
  } else if (sale && sale.dispatched_at && !sale.tracking_number && ebayInfo.tracking) {
    await query(`UPDATE sales SET tracking_number = $2, carrier = COALESCE(carrier, $3) WHERE id = $1`, [sale.id, ebayInfo.tracking, ebayInfo.carrier]);
    updated = 'tracking';
  }
  return { ebay: ebayInfo, saleId: sale?.id || null, updated };
}

// One row per conversation (account + buyer + item): its newest message.
const EBAY_SQL = `(lower(sender) = 'ebay' OR sender LIKE '%@%' OR lower(sender) LIKE 'ebay %')`;
const NEEDS_REPLY_SQL = `(response_enabled AND NOT replied AND NOT done AND COALESCE(last_from, 'buyer') = 'buyer' AND NOT ${EBAY_SQL})`;
const LATEST_SQL = `SELECT DISTINCT ON (store_code, lower(COALESCE(sender, '')), COALESCE(item_id, message_id)) *
  FROM ebay_messages ORDER BY store_code, lower(COALESCE(sender, '')), COALESCE(item_id, message_id), received_at DESC NULLS LAST`;
// The whole conversation a message belongs to.
async function conversationRows(row) {
  return (await query(`SELECT * FROM ebay_messages WHERE store_code = $1 AND lower(COALESCE(sender, '')) = lower(COALESCE($2, ''))
      AND COALESCE(item_id, message_id) = COALESCE($3, $4) ORDER BY received_at`, [row.store_code, row.sender, row.item_id, row.message_id])).rows;
}
// Staff marks: done (no reply needed) / needs reply / unread — whole conversation.
async function mark(rowId, what) {
  await ensureSchema();
  const row = (await query(`SELECT * FROM ebay_messages WHERE id = $1`, [rowId])).rows[0];
  if (!row) throw Object.assign(new Error('Message not found'), { status: 404 });
  const ids = (await conversationRows(row)).map(r => r.id);
  if (what === 'done') await query(`UPDATE ebay_messages SET done = true, is_read = true WHERE id = ANY($1)`, [ids]);
  else if (what === 'reply') await query(`UPDATE ebay_messages SET done = false, replied = false WHERE id = ANY($1)`, [ids]);
  else if (what === 'unread') await query(`UPDATE ebay_messages SET is_read = false WHERE id = $1`, [ids[ids.length - 1]]);
  else if (what === 'read') await query(`UPDATE ebay_messages SET is_read = true WHERE id = ANY($1)`, [ids]);
  return { ok: true };
}

// ── Overview: per account, what needs doing ──────────────────────────────
async function overview() {
  await ensureSchema();
  const stores = (brand.allStores || brand.stores || []).filter(s => s.channelCode && s.channelCode.startsWith('ebay_'));
  const msg = (await query(`SELECT store_code,
      COUNT(*) FILTER (WHERE NOT is_read AND NOT ${EBAY_SQL})::int AS unread,
      COUNT(*) FILTER (WHERE ${NEEDS_REPLY_SQL} AND received_at > now() - interval '30 days')::int AS to_answer,
      COUNT(*) FILTER (WHERE NOT is_read AND ${EBAY_SQL})::int AS from_ebay
    FROM (${LATEST_SQL}) m GROUP BY store_code`)).rows;
  // Same rule as the Dispatch page: paid, to be posted, not shipped/refunded/
  // returned, from the last 10 days (older ones were handled on eBay).
  const disp = (await query(`SELECT s.channel, COUNT(*)::int AS n FROM sales s WHERE s.channel LIKE 'ebay_%' AND s.is_estimate = false
      AND s.dispatched_at IS NULL AND s.collected_at IS NULL
      AND COALESCE(s.fulfillment_method, CASE WHEN s.payment_method = 'cash' THEN 'collect' ELSE 'ship' END) = 'ship'
      AND s.status NOT IN ('refunded','cancelled','dispatched','preorder')
      AND NOT (COALESCE(s.refunded_amount, 0) > 0 AND COALESCE(s.refunded_amount, 0) >= s.total - 0.005)
      AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.sale_id = s.id)
      AND s.occurred_at >= now() - interval '10 days' GROUP BY s.channel`).catch(() => ({ rows: [] }))).rows;
  let ret = [];
  try {
    ret = (await query(`SELECT s.channel, COUNT(*)::int AS n FROM returns r JOIN sales s ON s.id = r.sale_id
      WHERE s.channel LIKE 'ebay_%' AND r.status IN ('open','received') GROUP BY s.channel`)).rows;
  } catch (_) {}
  const last = (await query(`SELECT MAX(created_at) AS t FROM ebay_messages`)).rows[0]?.t || null;
  return {
    lastMessageSync: last, lastCheck: _lastSyncAt, schedule: await scheduleSettings(), checkEveryMins: await messageIntervalMins(),
    accounts: stores.map(s => ({
      code: s.code, name: s.name, channelCode: s.channelCode, connected: !!s.token, disabled: !!s.disabled, primary: !!s.primary,
      unread: msg.find(m => m.store_code === s.code)?.unread || 0,
      fromEbay: msg.find(m => m.store_code === s.code)?.from_ebay || 0,
      toAnswer: msg.find(m => m.store_code === s.code)?.to_answer || 0,
      toDispatch: disp.find(d => d.channel === s.channelCode)?.n || 0,
      openReturns: ret.find(d => d.channel === s.channelCode)?.n || 0,
    })),
  };
}

// ── Background check schedule ────────────────────────────────────────────
async function scheduleSettings() {
  const d = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data?.ebayMessages || {};
  const off = [30, 60, 120].includes(Number(d.offHoursMins)) ? Number(d.offHoursMins) : 30;
  return { workStart: 9, workEnd: 15, workMins: 5, offHoursMins: off };
}
async function saveScheduleSettings({ offHoursMins }) {
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  const v = [30, 60, 120].includes(Number(offHoursMins)) ? Number(offHoursMins) : 30;
  await query(`UPDATE app_settings SET data = $1::jsonb WHERE id = 1`, [JSON.stringify({ ...cur, ebayMessages: { ...(cur.ebayMessages || {}), offHoursMins: v } })]);
  return scheduleSettings();
}
function ukHour(d = new Date()) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(d), 10);
}
async function messageIntervalMins() {
  const s = await scheduleSettings();
  const h = ukHour();
  return h >= s.workStart && h < s.workEnd ? s.workMins : s.offHoursMins;
}

module.exports = { checkOrderOnEbay, EBAY_SQL, NEEDS_REPLY_SQL, LATEST_SQL, conversationRows, mark, orderForMessage, cleanBody, parseConversation, uploadPhotos, scheduleSettings, saveScheduleSettings, messageIntervalMins, ensureSchema, syncAll, syncStore, reply, markRead, eligibleItems, sendOffers, overview, messageText, stripHtml };
