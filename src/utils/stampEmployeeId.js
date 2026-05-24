/**
 * stampEmployeeId — Mongoose plugin that auto-fills the `employeeId`
 * sidecar field on any schema that already has a `user` ObjectId ref
 * pointing at the `employees` collection.
 *
 * Usage (on a schema that has { user, employeeId } fields):
 *   const stampEmployeeId = require('../utils/stampEmployeeId');
 *   mySchema.plugin(stampEmployeeId);
 *
 * What it does
 * ────────────
 * Before every save, if `employeeId` is empty BUT `user` is set, it
 * looks up the user's `employeeId` (the human TES047 code) from the
 * employees collection and copies it onto the row. After this every
 * Attendance / Leave / Allowance / Complaint / LocationPing / Payslip /
 * Notification / AttendanceRequest document carries the readable emp id
 * alongside the ObjectId, so HR can read raw collection dumps without
 * joining back to employees.
 *
 * Cost: one indexed findById on save. Cached implicitly by Mongoose
 * connection pooling, so the overhead is negligible.
 */
const mongoose = require('mongoose');

module.exports = function stampEmployeeId(schema) {
  // Skip if the schema doesn't actually declare an employeeId field —
  // makes the plugin safe to attach globally without breaking anything.
  if (!schema.path('employeeId') || !schema.path('user')) return;

  schema.pre('save', async function () {
    if (this.employeeId && String(this.employeeId).trim()) return;
    if (!this.user) return;
    try {
      const doc = await mongoose.connection
        .collection('employees')
        .findOne(
          { _id: new mongoose.Types.ObjectId(String(this.user)) },
          { projection: { employeeId: 1 } },
        );
      if (doc && doc.employeeId) {
        this.employeeId = String(doc.employeeId).toUpperCase();
      }
    } catch { /* non-fatal — leave employeeId empty if lookup fails */ }
  });

  // insertMany bypasses pre('save') by default — also catch it.
  schema.pre('insertMany', async function (next, docs) {
    if (!Array.isArray(docs) || docs.length === 0) return next();
    const needsStamp = docs.filter((d) => d.user && !(d.employeeId && String(d.employeeId).trim()));
    if (needsStamp.length === 0) return next();
    try {
      const userIds = [...new Set(needsStamp.map((d) => String(d.user)))]
        .map((id) => new mongoose.Types.ObjectId(id));
      const employees = await mongoose.connection
        .collection('employees')
        .find({ _id: { $in: userIds } }, { projection: { employeeId: 1 } })
        .toArray();
      const lookup = Object.fromEntries(
        employees.map((e) => [String(e._id), String(e.employeeId || '').toUpperCase()]),
      );
      for (const d of needsStamp) {
        const id = lookup[String(d.user)];
        if (id) d.employeeId = id;
      }
    } catch { /* non-fatal */ }
    next();
  });
};
