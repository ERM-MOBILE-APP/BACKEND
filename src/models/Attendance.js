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
    // #404 — Cosmetic IST sidecars so HR opening Robo 3T sees local
    // wall-clock time next to the authoritative UTC Date fields.
    // Format: "YYYY-MM-DD HH:mm:ss" in Asia/Kolkata. Set by the
    // controller on every write; never queried against. Every
    // existing query keeps using the UTC Date fields.
    checkInLocal:  { type: String, default: '' },
    checkOutLocal: { type: String, default: '' },
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


    // #388 HR manual override.
    // Set to true by /admin/mark-status whenever HR flips a row's
    // status via the Mark Present button. Downstream code paths that
    // re-derive status from check-in time MUST honour this flag and
    // skip re-derivation — otherwise the row flips back to Absent
    // within seconds of HR clicking Present.
    hrOverride:       { type: Boolean, default: false, index: true },
    hrOverrideStatus: { type: String,  default: '' },
    hrOverrideNote:   { type: String,  default: '' },
    hrOverrideAt:     { type: Date,    default: null },
  },
  { timestamps: true }
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });

// #457 — SELF-HEALING STATUS NORMALISER (cross-system compatibility).
//
// PRODUCTION BUG THIS FIXES: employees could not CHECK OUT. The server
// returned 500 with:
//   "Attendance validation failed: status: `On Time` is not a valid enum
//    value for path `status`."
//
// Cause: HRMS and ERM share this collection but use different vocabularies —
//   ERM  : 'present' | 'late' | 'absent' | 'permission' | 'halfday' | 'leave'
//   HRMS : 'On Time' | 'Late' | 'Absent' | 'Half Day'   (capitalised)
// HRMS's mark-status writes its own wording into the row. Afterwards ANY ERM
// save on that document — check-out, check-in, the auto-close cron — runs
// Mongoose validation over the WHOLE document, hits the foreign 'On Time'
// value sitting in `status`, and throws. So one HR edit permanently blocked
// that employee from checking out.
//
// Normalising in a pre('validate') hook heals the value on every save path at
// once (rather than patching each controller), and repairs legacy rows the
// first time they're touched.
const STATUS_ALIASES = {
  'on time':    'present',
  'ontime':     'present',
  'on-time':    'present',
  'present':    'present',
  'late':       'late',
  'absent':     'absent',
  'leave':      'leave',
  'on leave':   'leave',
  'permission': 'permission',
  'half day':   'halfday',
  'half-day':   'halfday',
  'halfday':    'halfday',
};
function normaliseStatusValue(v) {
  const key = String(v == null ? '' : v).trim().toLowerCase();
  return STATUS_ALIASES[key] || v;
}

// NOTE ON THE SIGNATURE: this hook takes NO arguments on purpose.
// It was first written as `function (next) { … next(); }`, which made every
// checkout fail with "next is not a function" — in this Mongoose version the
// hook wasn't being invoked with a callback, so calling next() threw and the
// save was rejected. A zero-argument hook is treated as promise/sync style:
// Mongoose continues as soon as it returns, so there is no callback to get
// wrong. Keep it argument-free.
attendanceSchema.pre('validate', function () {
  try {
    if (this.status) this.status = normaliseStatusValue(this.status);
    // hrOverrideStatus is a free-form String (no enum) but is read back as an
    // authoritative status by every ERM read path, so heal it too.
    if (this.hrOverrideStatus) this.hrOverrideStatus = normaliseStatusValue(this.hrOverrideStatus);
  } catch { /* never block a save on the normaliser itself */ }
});

attendanceSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('Attendance', attendanceSchema);
