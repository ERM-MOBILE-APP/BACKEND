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

    // ── #336 Multi-session support (accidental check-out safety net) ──
    // Employees would sometimes hit "Check Out" by mistake early in the
    // day, then panic because tapping Check In again reset their timer
    // back to 00:00 and looked like they'd lost the morning. HR ended
    // up manually editing rows to give people their hours back — clearly
    // unsustainable.
    //
    // With this schema addition, a workday is now a sequence of
    // check-in / check-out "sessions". The top-level `checkIn` /
    // `checkOut` still exist for backward compatibility (they hold the
    // FIRST check-in of the day and the LATEST check-out respectively),
    // but the source of truth for total time worked is
    // `accumulatedSeconds` — the sum of every completed session's
    // duration. When an employee taps Check In again on the same day,
    // the timer resumes from `accumulatedSeconds` instead of restarting
    // from zero. Break time between checkout and re-check-in is NOT
    // counted (only session durations are summed).
    //
    // firstCheckIn — snapshot of the day's very first check-in time.
    //                Preserved even after multiple re-checkins so
    //                reports/downloads can still show "arrival time".
    // accumulatedSeconds — rolling total of completed session durations
    //                      in whole seconds. Rolled up at each checkout.
    // sessions[]   — chronological history of every completed session
    //                so audit reports can list "In 09:00 → Out 12:00,
    //                In 12:05 → Out 18:00" without recomputing.
    firstCheckIn:       { type: Date, default: null },
    accumulatedSeconds: { type: Number, default: 0 },
    sessions: {
      type: [
        new mongoose.Schema(
          {
            checkIn:     { type: Date, required: true },
            checkOut:    { type: Date, required: true },
            checkInLat:  { type: Number, default: null },
            checkInLng:  { type: Number, default: null },
            checkOutLat: { type: Number, default: null },
            checkOutLng: { type: Number, default: null },
            durationSeconds: { type: Number, default: 0 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

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

    // ── HR LOP markers ───────────────────────────────────────────────
    // True when the employee hit Check-Out before the scheduled end of
    // day AND no approved permission covers that day. The leavePolicy
    // module tallies these and converts each occurrence into 0.5 LOP.
    earlyCheckoutLop: { type: Boolean, default: false },
    // True when the nightly sweeper closed an open check-in at IST midnight
    // (separate from `autoCheckedOut` which is GPS-driven close).
    autoClosed:       { type: Boolean, default: false },
    autoClosedAt:     { type: Date,    default: null },
  },
  { timestamps: true }
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });

attendanceSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('Attendance', attendanceSchema);
