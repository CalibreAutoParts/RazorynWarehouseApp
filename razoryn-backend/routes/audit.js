// routes/audit.js — activity log for admins: a summary of what each staff member
// has done, plus a filterable recent-activity feed. Read-only; admin-only.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// Friendly labels for the technical action codes written by audit().
const ACTION_LABELS = {
  create_sale: 'Recorded a sale', update_sale: 'Edited a sale', delete_sale: 'Deleted a sale',
  sale_mark_paid: 'Marked a sale paid', email_invoice: 'Emailed an invoice',
  convert_estimate: 'Converted an estimate', return_from_sale: 'Logged a return',
  create_return: 'Logged a return', ebay_dispatch_sync: 'Synced eBay dispatches',
  set_quantity: 'Updated stock', adjust_stock: 'Adjusted stock', stock_check: 'Did a stock check',
  create_product: 'Added a product', update_product: 'Edited a product', delete_product: 'Deleted a product',
  create_ebay_listing: 'Created an eBay listing', price_link_apply: 'Updated prices',
  seo_bulk_apply: 'Applied SEO changes', create_mirror_link: 'Linked a listing',
  incoming_create: 'Added incoming stock', incoming_bulk_add: 'Added incoming stock (bulk)',
  incoming_receive: 'Received incoming stock', incoming_receive_container: 'Received a container',
  incoming_delete: 'Removed incoming stock',
  mark_dispatched: 'Dispatched an order', bulk_mark_dispatched: 'Dispatched orders',
  mark_collected: 'Marked an order collected',
  update_user: 'Changed a staff member', create_user: 'Added a staff member',
  update_pricing_config: 'Changed settings', update_email_templates: 'Edited email templates',
  login_pin: 'Signed in', login: 'Signed in',
};
function labelFor(action) {
  return ACTION_LABELS[action] || String(action || 'action').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// GET /api/audit/summary?days=30 — per-staff activity rollup.
router.get('/summary', async (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  const interval = `${days} days`;
  const totals = (await query(`
    SELECT a.user_id, u.name, u.role, COUNT(*)::int AS total, MAX(a.created_at) AS last_at
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.created_at > now() - $1::interval
    GROUP BY a.user_id, u.name, u.role
    ORDER BY total DESC`, [interval])).rows;
  const byAction = (await query(`
    SELECT a.user_id, a.action, COUNT(*)::int AS n
    FROM audit_log a
    WHERE a.created_at > now() - $1::interval
    GROUP BY a.user_id, a.action`, [interval])).rows;

  const actionsByUser = {};
  for (const r of byAction) {
    (actionsByUser[r.user_id] = actionsByUser[r.user_id] || []).push({ action: r.action, label: labelFor(r.action), n: r.n });
  }
  const staff = totals.map(t => ({
    userId: t.user_id,
    name: t.name || 'Unknown / system',
    role: t.role || null,
    total: t.total,
    lastAt: t.last_at,
    breakdown: (actionsByUser[t.user_id] || []).sort((a, b) => b.n - a.n),
  }));
  res.json({ days, staff });
});

// GET /api/audit?userId=&days=30&action=&limit=200 — recent activity feed.
router.get('/', async (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200));
  const where = [`a.created_at > now() - $1::interval`];
  const params = [`${days} days`];
  if (req.query.userId) { params.push(parseInt(req.query.userId)); where.push(`a.user_id = $${params.length}`); }
  if (req.query.action) { params.push(req.query.action); where.push(`a.action = $${params.length}`); }
  const rows = (await query(`
    SELECT a.id, a.action, a.target_type, a.target_id, a.metadata, a.created_at, u.name, u.role
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.created_at DESC LIMIT ${limit}`, params)).rows;
  res.json({ entries: rows.map(r => ({
    id: r.id, action: r.action, label: labelFor(r.action),
    targetType: r.target_type, targetId: r.target_id, metadata: r.metadata,
    at: r.created_at, who: r.name || 'Unknown / system', role: r.role || null,
  })) });
});

module.exports = router;
