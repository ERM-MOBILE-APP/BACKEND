const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    type: {
      type: String,
      enum: ['leave', 'attendance', 'allowance', 'payslip', 'announcement', 'general'],
      default: 'general',
    },
    isRead: { type: Boolean, default: false },
    link: { type: String, default: '' }, // optional in-app deep link
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
