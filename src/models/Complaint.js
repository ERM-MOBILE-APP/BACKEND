const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
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

module.exports = mongoose.model('Complaint', complaintSchema);
