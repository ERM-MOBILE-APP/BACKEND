const mongoose = require('mongoose');

const stampEmployeeId = require('../utils/stampEmployeeId');
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // EMP-ID-SIDECAR — duplicate of the user's human employee id (TES047)
    // stored on every row so HR can read who a record belongs to without
    // joining back to the employees collection.
    employeeId: { type: String, default: '', index: true, trim: true, uppercase: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    type: {
      type: String,
      enum: ['leave', 'attendance', 'allowance', 'payslip', 'announcement', 'general'],
      default: 'general',
    },
    isRead: { type: Boolean, default: false },
    link: { type: String, default: '' }, // optional in-app deep link
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, createdAt: -1 });

notificationSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('Notification', notificationSchema);
