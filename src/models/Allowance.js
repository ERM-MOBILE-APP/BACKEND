const mongoose = require('mongoose');

const stampEmployeeId = require('../utils/stampEmployeeId');
const allowanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // EMP-ID-SIDECAR — duplicate of the user's human employee id (TES047)
    // stored on every row so HR can read who a record belongs to without
    // joining back to the employees collection.
    employeeId: { type: String, default: '', index: true, trim: true, uppercase: true },
    type: { type: String, enum: ['travel', 'petrol'], required: true },
    purpose: { type: String, default: 'Client Meeting' },
    fromLocation: { type: String, required: true },
    toLocation: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    transport: { type: String, default: 'Car' },
    distance: { type: Number, default: 0 }, // km — used for petrol claims + petrol section monthly total
    // 'gps' when the value was computed from LocationPings on the request
    // date; 'manual' when it was typed by the employee (no pings that
    // day, or pre-GPS-era record). HR can use this to weight trust.
    distanceSource: { type: String, enum: ['gps', 'manual'], default: 'manual' },
    // GPS coords matching the fromLocation / toLocation text on the
    // request. Stamped at submit time so the allowance row carries its
    // own audit trail — even if LocationPings get archived later, HR
    // can still see exactly where the employee started and ended.
    fromLat: { type: Number, default: null },
    fromLng: { type: Number, default: null },
    toLat:   { type: Number, default: null },
    toLng:   { type: Number, default: null },
    amount: { type: Number, required: true },
    notes: { type: String, default: '' },
    receiptUrl: { type: String, default: '' },
    // Manager-tier status — set by the assigned manager via ERM Web's
    // /api/manager/leaves/:id or /api/manager/allowances/:id (the same
    // shared DB doc is read by HRMS). Empty string means "Awaiting
    // Manager" in the HRMS approval pages; 'Approved' enables the HR
    // action buttons; 'Rejected' short-circuits HR review entirely.
    managerStatus: {
      type: String,
      enum: ['', 'Approved', 'Rejected'],
      default: '',
    },
    managerStatusBy:  { type: String, default: '' },   // manager's display name
    managerStatusAt:  { type: Date,   default: null }, // when they acted
        status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    // HR review breakdown — the employee requests `amount`, but HR may
    // approve only part of it after verifying the actual distance.
    //   approvedAmount  → the ₹ that will be reimbursed
    //   rejectedAmount  → amount − approvedAmount  (what HR struck off)
    //   amountComment   → free-text note ("approved at 60% of claim because
    //                      GPS shows shorter distance" etc.). Surfaced to
    //                      the employee in the in-app notification.
    approvedAmount: { type: Number, default: 0 },
    rejectedAmount: { type: Number, default: 0 },
    amountComment:  { type: String, default: '' },
    hrComment: { type: String, default: '' },
    reviewedBy: { type: String, default: '' },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

allowanceSchema.index({ user: 1, date: -1 });

allowanceSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('Allowance', allowanceSchema);
