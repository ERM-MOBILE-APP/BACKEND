const mongoose = require('mongoose');

const leaveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

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

module.exports = mongoose.model('Leave', leaveSchema);
