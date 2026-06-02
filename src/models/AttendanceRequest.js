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
      // 'expired' is set automatically when a pending request has been
      // sitting for 2+ days without HR action — keeps the queue from
      // growing forever and matches the policy HR asked for.
      type: String,
      enum: ['pending', 'approved', 'rejected', 'expired'],
      default: 'pending',
    },
    // Manager-tier decision (Jun 2026). Mirrors the same pattern Leave +
    // Allowance use:
    //   • '' (empty)   -> Awaiting Manager. Visible to BOTH the manager
    //                    (ERM Web) and HR (HRMS).
    //   • 'Approved'   -> Manager approved. HR now has the final call
    //                    (status stays 'pending'). HR sees an actionable
    //                    row in HRMS Attendance Requests.
    //   • 'Rejected'   -> Manager rejected. Request short-circuits -- HR
    //                    doesn't need to act; status flips to 'rejected'
    //                    at the same time.
    managerStatus:    { type: String, enum: ['', 'Approved', 'Rejected'], default: '' },
    managerStatusBy:  { type: String, default: '' },
    managerStatusAt:  { type: Date,   default: null },
    managerComment:   { type: String, default: '' },
    reviewedBy: { type: String, default: '' },
    reviewedAt: { type: Date },
    hrComment:  { type: String, default: '' },
  },
  { timestamps: true }
);

attendanceRequestSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('AttendanceRequest', attendanceRequestSchema);
