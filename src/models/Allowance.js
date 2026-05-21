const mongoose = require('mongoose');

const allowanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['travel', 'petrol'], required: true },
    purpose: { type: String, default: 'Client Meeting' },
    fromLocation: { type: String, required: true },
    toLocation: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    transport: { type: String, default: 'Car' },
    distance: { type: Number, default: 0 }, // km — used mainly for petrol claims
    amount: { type: Number, required: true },
    notes: { type: String, default: '' },
    receiptUrl: { type: String, default: '' },
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

allowanceSchema.index({ user: 1, date: -1 });

module.exports = mongoose.model('Allowance', allowanceSchema);
