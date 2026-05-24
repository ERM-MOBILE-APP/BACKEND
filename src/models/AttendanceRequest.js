const mongoose = require('mongoose');

const stampEmployeeId = require('../utils/stampEmployeeId');
// Correction / regularisation requests filed by employees from the
// attendance history list.
const attendanceRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // EMP-ID-SIDECAR — duplicate of the user's human employee id (TES047)
    // stored on every row so HR can read who a record belongs to without
    // joining back to the employees collection.
    employeeId: { type: String, default: '', index: true, trim: true, uppercase: true },
    date: { type: String, required: true }, // YYYY-MM-DD that the request is for
    requestType: {
      type: String,
      enum: ['regularize', 'late-justification', 'missing-checkout', 'other'],
      default: 'regularize',
    },
    reason: { type: String, default: '' },
    expectedCheckIn: { type: String, default: '' }, // "HH:mm"
    expectedCheckOut: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    reviewedBy: { type: String, default: '' },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

attendanceRequestSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('AttendanceRequest', attendanceRequestSchema);
