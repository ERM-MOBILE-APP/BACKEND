const mongoose = require('mongoose');

const stampEmployeeId = require('../utils/stampEmployeeId');
const earningsSchema = new mongoose.Schema({
  basicSalary:       { type: Number, default: 0 },
  hraAllowance:      { type: Number, default: 0 },
  performanceBonus:  { type: Number, default: 0 },
  otherEarnings:     { type: Number, default: 0 },
}, { _id: false });

const deductionsSchema = new mongoose.Schema({
  incomeTax:        { type: Number, default: 0 },
  providentFund:    { type: Number, default: 0 },
  healthInsurance:  { type: Number, default: 0 },
  lopDeduction:     { type: Number, default: 0 },
  otherDeductions:  { type: Number, default: 0 },
}, { _id: false });

const payslipSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // EMP-ID-SIDECAR — duplicate of the user's human employee id (TES047)
    // stored on every row so HR can read who a record belongs to without
    // joining back to the employees collection.
    employeeId: { type: String, default: '', index: true, trim: true, uppercase: true },
  month:       { type: Number, required: true },   // 1-12
  year:        { type: Number, required: true },
  monthLabel:  { type: String },                   // e.g. "May 2026"
  earnings:    { type: earningsSchema, default: () => ({}) },
  deductions:  { type: deductionsSchema, default: () => ({}) },
  totalGross:  { type: Number, default: 0 },
  totalDeductions: { type: Number, default: 0 },
  netPay:      { type: Number, default: 0 },
  status:      { type: String, enum: ['processed', 'pending'], default: 'processed' },
  paidVia:     { type: String, default: 'HDFC Bank' },
}, { timestamps: true });

// Unique payslip per employee per month/year
payslipSchema.index({ user: 1, month: 1, year: 1 }, { unique: true });

// Attach the EMP-ID auto-stamp plugin to the TOP-LEVEL payslipSchema
// (not the earnings sub-schema — that one has no `user` field).
payslipSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('Payslip', payslipSchema);
