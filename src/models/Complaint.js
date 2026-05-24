const mongoose = require('mongoose');

const stampEmployeeId = require('../utils/stampEmployeeId');
const complaintSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // EMP-ID-SIDECAR — duplicate of the user's human employee id (TES047)
    // stored on every row so HR can read who a record belongs to without
    // joining back to the employees collection.
    employeeId: { type: String, default: '', index: true, trim: true, uppercase: true },
    subject: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'low',
    },
    status: {
      type: String,
      enum: ['open', 'in-progress', 'resolved', 'closed'],
      default: 'open',
    },
    hrResponse: { type: String, default: '' },
    respondedAt: { type: Date },
  },
  { timestamps: true }
);

complaintSchema.index({ user: 1, createdAt: -1 });

complaintSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('Complaint', complaintSchema);
