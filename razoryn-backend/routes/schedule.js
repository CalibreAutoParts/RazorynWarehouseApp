// routes/schedule.js — feature 6: schedule/timetable
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/schedule?date=YYYY-MM-DD&from=&to=
router.get('/', requirePermission('schedule'), async (req, res) => {
  const { date, from, to } = req.query;
  const where = [], params = [];
  if (date)  { params.push(date); where.push(`scheduled_for = $${params.length}`); }
  if (from)  { params.push(from); where.push(`scheduled_for >= $${params.length}`); }
  if (to)    { params.push(to); where.push(`scheduled_for <= $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await query(`
    SELECT t.*, u.name AS assignee_name
    FROM schedule_tasks t
    LEFT JOIN users u ON u.id = t.assigned_to
    ${w}
    ORDER BY scheduled_for, due_time NULLS LAST
  `, params);
  res.json({ tasks: rows });
});

// POST /api/schedule  (admin)
router.post('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.scheduledFor) return res.status(400).json({ error: 'title_and_date_required' });
  const { rows } = await query(
    `INSERT INTO schedule_tasks (title, description, task_type, scheduled_for, due_time,
                                 assigned_to, recurrence)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.title, b.description || null, b.taskType || 'custom', b.scheduledFor,
     b.dueTime || null, b.assignedTo || null, b.recurrence || 'none']
  );
  await audit(req, 'create_task', 'task', rows[0].id);
  res.status(201).json({ task: rows[0] });
});

// PATCH /api/schedule/:id
router.patch('/:id', requirePermission('schedule'), async (req, res) => {
  const b = req.body || {};
  const updates = {
    title: b.title, description: b.description, task_type: b.taskType,
    scheduled_for: b.scheduledFor, due_time: b.dueTime,
    assigned_to: b.assignedTo, status: b.status, recurrence: b.recurrence,
  };
  const sets = [], params = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (b.status === 'done') {
    sets.push(`completed_at = now()`);
    params.push(req.user.id);
    sets.push(`completed_by = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no_updatable_fields' });
  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE schedule_tasks SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'update_task', 'task', rows[0].id);
  res.json({ task: rows[0] });
});

// DELETE /api/schedule/:id (admin)
router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await query(`DELETE FROM schedule_tasks WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
