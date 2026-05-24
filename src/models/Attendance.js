const mongoose = require('mongoose');

const stampEmployeeId = require('../utils/stampEmployeeId');
const attendanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // EMP-ID-SIDECAR — duplicate of the user's human employee id (TES047)
    // stored on every row so HR can read who a record belongs to without
    // joining back to the employees collection.
    employeeId: { type: String, default: '', index: true, trim: true, uppercase: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    checkIn: { type: Date },
    checkOut: { type: Date },
    location: { type: String, enum: ['remote', 'office', ''], default: '' },
    workedHours: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['present', 'leave', 'permission', 'absent', 'late', 'halfday'],
      default: 'present',
    },
    shift: { type: String, default: 'General Shift' },

    // ── Location captured at check-in time ────────────────────────
    checkInLat:  { type: Number, default: null },
    checkInLng:  { type: Number, default: null },
    checkOutLat: { type: Number, default: null },
    checkOutLng: { type: Number, default: null },
    // True when the system auto-checked-out because GPS turned off.
    autoCheckedOut: { type: Boolean, default: false },

    // ── Daily route summary (filled at check-out from LocationPings) ──
    // totalDistanceKm — sum of haversine across consecutive pings between
    // checkIn and checkOut. This is the canonical "how far did the
    // employee travel today" number; the petrol allowance section on the
    // HRMS pulls from here so even employees who didn't submit an
    // allowance request have their km accounted for.
    // distanceSource:
    //   'gps'    — derived from LocationPings (≥ 2 pings on the day)
    //   'pins'   — only checkIn/checkOut coords available, straight-line
    //   'none'   — no usable coords on the day
    totalDistanceKm: { type: Number, default: 0 },
    distanceSource:  { type: String, enum: ['gps', 'pins', 'none'], default: 'none' },
  },
  { timestamps: true }
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });

attendanceSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('Attendance', attendanceSchema);
