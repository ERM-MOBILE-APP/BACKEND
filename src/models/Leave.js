const mongoose = require('mongoose');

const stampEmployeeId = require('../utils/stampEmployeeId');
const leaveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // EMP-ID-SIDECAR — duplicate of the user's human employee id (TES047)
    // stored on every row so HR can read who a record belongs to without
    // joining back to the employees collection.
    employeeId: { type: String, default: '', index: true, trim: true, uppercase: true },

    requestType: {
      type: String,
      enum: ['leave', 'permission'],
      required: true,
    },

    // ----- Apply Leave fields -----
    leaveType: {
      type: String,
      enum: ['Casual Leave', 'Sick Leave', 'Earned Leave', 'Unpaid Leave'],
    },
    startDate: { type: String },
    endDate: { type: String },
    isHalfDay: { type: Boolean, default: false },
    daysCount: { type: Number, default: 0 },

    // ----- Permission fields -----
    permissionType: {
      type: String,
      enum: ['Personal', 'Medical', 'Official', 'Other', 'Casual Leave'],
    },
    date: { type: String },
    startTime: { type: String },
    endTime: { type: String },
    durationHours: { type: Number, default: 0 },

    // Common
    reason: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    hrComment: { type: String, default: '' },
    reviewedBy: { type: String, default: '' },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

leaveSchema.index({ user: 1, createdAt: -1 });

leaveSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('Leave', leaveSchema);
