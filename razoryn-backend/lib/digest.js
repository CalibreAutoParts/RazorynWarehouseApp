// lib/digest.js — email notifications + scheduled reports per staff member.
//
// Each user (Staff & Access) can opt into:
//   • emailNotifications — an hourly batch email of new app notifications
//     (new orders, returns, low stock, …) since the last email.
//   • reportFreq — 'daily' | 'weekly' | 'monthly' | 'quarterly' business report
//     emailed at ~07:00 UK time on the due day (weekly = Monday, monthly = 1st,
//     quarterly = 1 Jan/Apr/Jul/Oct).
// Prefs + last-sent stamps live in users.notify_prefs (JSONB). Driven by an
// hourly cron in server.js. Everything is best-effort — a mail failure never
// breaks anything else, and without RESEND_API_KEY it's a clean no-op.
const { query } = require('../db');

let _ready = false;
async function ensureColumns() {
  if (_ready) return;
  try {
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_prefs JSONB`);
    _ready = true;
  } catch (e) { console.warn('[digest] migration warning:', e.message); }
}

// UK-local time parts (report scheduling follows warehouse local time).
function ukNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hourCycle: 'h23',
    hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  return { hour: parseInt(get('hour'), 10), day: parseInt(get('day'), 10), month: parseInt(get('month'), 10), weekday: get('weekday') };
}

function reportDue(freq, uk) {
  if (uk.hour !== 7) return false;                       // reports go out at ~07:00 UK
  if (freq === 'daily') return true;
  if (freq === 'weekly') return uk.weekday === 'Mon';
  if (freq === 'monthly') return uk.day === 1;
  if (freq === 'quarterly') return uk.day === 1 && [1, 4, 7, 10].includes(uk.month);
  return false;
}

const gbp = (n) => '£' + (Number(n) || 0).toFixed(2);

// Business report for the period — sales, returns, dispatch, unpaid, low stock.
async function buildReport(freq) {
  const days = freq === 'daily' ? 1 : freq === 'weekly' ? 7 : freq === 'monthly' ? 30 : 91;
  const iv = `${days} days`;
  const sales = (await query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(GREATEST(total - COALESCE(refunded_amount, 0), 0)), 0) AS net
       FROM sales WHERE is_estimate = false AND status NOT IN ('refunded','cancelled')
        AND occurred_at > now() - $1::interval`, [iv])).rows[0];
  const returns = (await query(
    `SELECT COUNT(*)::int AS n FROM returns WHERE created_at > now() - $1::interval`, [iv])).rows[0];
  const dispatched = (await query(
    `SELECT COUNT(*)::int AS n FROM sales WHERE dispatched_at > now() - $1::interval OR collected_at > now() - $1::interval`, [iv])).rows[0];
  const unpaid = (await query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(GREATEST(total - COALESCE(amount_paid, 0), 0)), 0) AS due
       FROM sales WHERE is_estimate = false AND is_paid = false AND status NOT IN ('refunded','cancelled','preorder')`)).rows[0];
  const low = (await query(
    `SELECT COUNT(*)::int AS n FROM products
      WHERE active = true AND COALESCE(hidden, false) = false
        AND qty_on_hand <= COALESCE(low_stock_threshold, 3)`)).rows[0];
  const label = freq === 'daily' ? 'yesterday/today' : `last ${days} days`;
  const row = (k, v) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${k}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:700">${v}</td></tr>`;
  const html = `
    <h2 style="font-family:Arial,sans-serif">Warehouse ${freq} report</h2>
    <table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse;min-width:340px">
      ${row(`Sales (${label})`, `${sales.n} orders · ${gbp(sales.net)} net`)}
      ${row('Dispatched / collected', dispatched.n)}
      ${row('Returns opened', returns.n)}
      ${row('Unpaid invoices (all time)', `${unpaid.n} · ${gbp(unpaid.due)} outstanding`)}
      ${row('Low-stock items right now', low.n)}
    </table>
    <p style="font-family:Arial,sans-serif;font-size:12px;color:#777">Automated report from Warehouse Hub. Change frequency in Staff &amp; Access.</p>`;
  return { html, subject: `Warehouse ${freq} report — ${sales.n} orders, ${gbp(sales.net)} net` };
}

// One hourly tick: batch-notification emails + due reports.
async function runDigestTick() {
  const email = require('../services/email');
  if (!email.isConfigured()) return { skipped: 'email_not_configured' };
  await ensureColumns();
  const users = (await query(
    `SELECT id, name, email, notify_prefs FROM users
      WHERE active = true AND email IS NOT NULL AND email <> '' AND notify_prefs IS NOT NULL`)).rows;
  const uk = ukNow();
  let sentNotif = 0, sentReports = 0;
  for (const u of users) {
    const prefs = u.notify_prefs || {};
    let changed = false;
    // 1) Hourly notification batch.
    if (prefs.emailNotifications) {
      const since = prefs.lastNotifyAt ? new Date(prefs.lastNotifyAt) : new Date(Date.now() - 3600e3);
      const rows = (await query(
        `SELECT title, body, created_at FROM notifications
          WHERE created_at > $1 ORDER BY created_at DESC LIMIT 30`, [since])).rows;
      if (rows.length) {
        const list = rows.map(n =>
          `<li style="margin-bottom:6px"><strong>${n.title || ''}</strong>${n.body ? `<br><span style="color:#555">${n.body}</span>` : ''}</li>`).join('');
        try {
          await email.sendEmail({
            to: u.email,
            subject: `Warehouse: ${rows.length} new notification${rows.length === 1 ? '' : 's'}`,
            html: `<div style="font-family:Arial,sans-serif;font-size:14px"><p>Hi ${u.name || ''}, since the last email:</p><ul>${list}</ul><p style="font-size:12px;color:#777">Turn this off in Staff &amp; Access.</p></div>`,
          });
          sentNotif++;
        } catch (e) { console.warn('[digest] notify email failed:', u.email, e.message); }
      }
      prefs.lastNotifyAt = new Date().toISOString(); changed = true;
    }
    // 2) Scheduled report.
    const freq = prefs.reportFreq;
    if (freq && freq !== 'none' && reportDue(freq, uk)) {
      const last = prefs.lastReportAt ? new Date(prefs.lastReportAt).getTime() : 0;
      if (Date.now() - last > 20 * 3600e3) {     // once per due day
        try {
          const rep = await buildReport(freq);
          await email.sendEmail({ to: u.email, subject: rep.subject, html: rep.html });
          prefs.lastReportAt = new Date().toISOString(); changed = true;
          sentReports++;
        } catch (e) { console.warn('[digest] report email failed:', u.email, e.message); }
      }
    }
    if (changed) {
      try { await query(`UPDATE users SET notify_prefs = $2::jsonb WHERE id = $1`, [u.id, JSON.stringify(prefs)]); } catch (_) {}
    }
  }
  return { users: users.length, sentNotif, sentReports };
}

module.exports = { ensureColumns, runDigestTick, buildReport };
