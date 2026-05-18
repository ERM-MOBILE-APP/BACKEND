const mongoose = require('mongoose');

const allowanceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['travel', 'petrol'], required: true },
  purpose: { type: String, default: 'Client Meeting' },
  fromLocation: { type: String, required: true },
  toLocation: { type: String, required: true },
  date: { type: String, required: true },
  transport: { type: String, default: 'Car' },
  amount: { type: Number, required: true },
  notes: { type: String, default: '' },
  receiptUrl: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

module.exports = mongoose.model('Allowance', allowanceSchema);