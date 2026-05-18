const mongoose = require('mongoose');

const leaveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // 'leave' = full leave request, 'permission' = short-time permission
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
    startDate: { type: String }, // stored as DD/MM/YYYY (front-end format)
    endDate: { type: String },
    isHalfDay: { type: Boolean, default: false },

    // ----- Permission fields -----
    permissionType: {
      type: String,
      enum: ['Personal', 'Medical', 'Official', 'Other', 'Casual Leave'],
    },
    date: { type: String },
    startTime: { type: String },
    endTime: { type: String },

    // Common
    reason: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Leave', leaveSchema);
