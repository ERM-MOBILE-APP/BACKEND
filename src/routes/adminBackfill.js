/**
 * One-off backfill endpoints — gated by x-admin-secret.
 *
 * The schema migration in models/* added an `employeeId` sidecar to
 * every secondary collection (Attendance, Leave, Allowance, Complaint,
 * LocationPing, Notification, Payslip, AttendanceRequest). New rows get
 * the field auto-populated by the stampEmployeeId Mongoose plugin.
 *
 * Old rows that pre-date the change have `employeeId = ''`. This route
 * walks them and stamps the field by joining back to the `employees`
 * collection on `user`. Safe to re-run — only touches rows where the
 * field is missing or empty.
 *
 * Hit it once after deploying the schema change:
 *
 *   curl -X POST https://backend-emqy.onrender.com/api/admin/backfill-emp-id \
 *        -H "x-admin-secret: $ADMIN_SECRET"
 */
const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');

const COLLECTIONS = [
  'attendances',
  'attendancerequests',
  'leaves',
  'allowances',
  'complaints',
  'locationpings',
  'notifications',
  'payslips',
];

function checkAdmin(req, res) {
  const expected = (process.env.ADMIN_SECRET || '').trim();
  const got      = (req.headers['x-admin-secret'] || '').trim();
  if (!expected) { res.status(503).json({ message: 'ADMIN_SECRET not configured.' }); return false; }
  if (got !== expected) { res.status(401).json({ message: 'Missing/invalid x-admin-secret.' }); return false; }
  return true;
}

router.post('/backfill-emp-id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const db   = mongoose.connection.db;
    const empCol = db.collection('employees');
    // Build a lookup from User _id → employeeId in one query.
    const employees = await empCol
      .find({}, { projection: { _id: 1, employeeId: 1 } })
      .toArray();
    const empById = new Map();
    for (const e of employees) {
      if (e.employeeId) empById.set(String(e._id), String(e.employeeId).toUpperCase());
    }

    const summary = {};
    for (const name of COLLECTIONS) {
      const col = db.collection(name);
      // Touch only rows missing or empty employeeId.
      const rows = await col
        .find({
          user: { $exists: true, $ne: null },
          $or: [{ employeeId: { $exists: false } }, { employeeId: '' }, { employeeId: null }],
        }, { projection: { _id: 1, user: 1 } })
        .toArray();
      let stamped = 0;
      for (const r of rows) {
        const empId = empById.get(String(r.user));
        if (!empId) continue;
        await col.updateOne({ _id: r._id }, { $set: { employeeId: empId } });
        stamped += 1;
      }
      summary[name] = { scanned: rows.length, stamped };
    }
    res.json({ success: true, employeesScanned: employees.length, byCollection: summary });
  } catch (err) {
    console.error('[backfill-emp-id] error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
