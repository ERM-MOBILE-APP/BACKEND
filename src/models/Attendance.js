const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  checkIn: { type: Date },
  checkOut: { type: Date },
  location: { type: String, enum: ['remote', 'office', ''], default: '' },
  workedHours: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['present', 'leave', 'permission', 'absent'],
    default: 'present',
  },
}, { timestamps: true });

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);