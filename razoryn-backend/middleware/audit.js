// middleware/audit.js — record admin actions to audit_log
const { query } = require('../db');

async function audit(req, action, targetType = null, targetId = null, metadata = null) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, action, target_type, target_id, metadata, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        req.user ? req.user.id : null,
        action,
        targetType,
        targetId,
        metadata ? JSON.stringify(metadata) : null,
        req.ip || null,
      ]
    );
  } catch (e) {
    // Audit failures should never break the request
    console.warn('[audit] failed:', e.message);
  }
}

module.exports = { audit };
