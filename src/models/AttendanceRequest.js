const mongoose = require('mongoose');

// Correction / regularisation requests filed by employees from the
// attendance history list.
const attendanceRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
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

module.exports = mongoose.model('AttendanceRequest', attendanceRequestSchema);
