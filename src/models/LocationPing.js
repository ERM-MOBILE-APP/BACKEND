/**
 * LocationPing — one row per "where is the user now" sample. Mobile app
 * POSTS one of these every 2 minutes while the employee is checked in.
 *
 * Stored separately from Attendance because there can be 200+ pings per
 * employee per workday; co-locating them on Attendance would bloat that
 * row and make `Attendance.find()` queries slow.
 *
 * Queries that the HRMS / admin UI will need:
 *   • Where is this employee right now?         → use User.lastLocation
 *   • Where was this employee at noon today?    → LocationPing.findOne({user, recordedAt:{$lt,$gte}})
 *   • Heatmap of all visits this month?         → LocationPing.find({user, recordedAt:range})
 */

const mongoose = require('mongoose');

const stampEmployeeId = require('../utils/stampEmployeeId');
const locationPingSchema = new mongoose.Schema(
  {
    user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // EMP-ID-SIDECAR — duplicate of the user's human employee id (TES047)
    // stored on every row so HR can read who a record belongs to without
    // joining back to the employees collection.
    employeeId: { type: String, default: '', index: true, trim: true, uppercase: true },
    date:       { type: String, required: true },   // YYYY-MM-DD — for date-range queries
    recordedAt: { type: Date,   required: true, index: true },
    // #404 — Cosmetic IST sidecar so Robo 3T (and any DB viewer) shows
    // wall-clock local time next to the authoritative UTC recordedAt.
    // Format: "YYYY-MM-DD HH:mm:ss" in Asia/Kolkata (IST, UTC+05:30).
    // Set by the controller at insert time; never queried against.
    // All existing range queries continue to use recordedAt (UTC Date).
    recordedAtLocal: { type: String, default: '' },
    lat:        { type: Number, required: true },
    lng:        { type: Number, required: true },
    accuracy:   { type: Number, default: null },    // metres (best-effort, may be null)
    speed:      { type: Number, default: null },    // m/s (best-effort)
    presence:   { type: String, enum: ['active', 'idle', 'offline'], default: 'active' },
    // #375 — Marks samples where the mobile anti-jitter filter reported
    // no confirmed movement (parked, at office, in traffic). Kept so HR
    // has a continuous audit trail of 2-min pings; polyline/distance
    // queries filter these out via { isAnchor: { $ne: true } }.
    isAnchor:   { type: Boolean, default: false, index: true },
    // #379 — 2-minute bucket = floor(recordedAt_ms / 120000). Combined
    // with the unique compound index below, this makes it PHYSICALLY
    // impossible for two rows to land in the same 2-min window for the
    // same user — MongoDB rejects duplicates atomically at insert time.
    // Replaces the previous read-then-write dedup that raced under
    // concurrent bursts (3 rows within 69 ms observed for TES080 after
    // a 20-min bg-task gap fired multiple recovery pings at once).
    bucket:     { type: Number, required: true, index: true },
    // #434 — Provenance marker. Set to 'sqlite' / 'local_storage' when a ping
    // is uploaded from the mobile device's local SQLite store during the
    // Check-Out sync (as opposed to a realtime /location-ping). Lets HR / ops
    // tell offline-collected pings apart from live ones in MongoDB.
    source:     { type: String, default: '' },
  },
  { timestamps: true }
);

// Compound index for "this user on this date, ordered by time" queries.
locationPingSchema.index({ user: 1, date: 1, recordedAt: -1 });

// #379/#403 — ATOMIC DEDUP INDEX (partial + unique). One row per
// employee per 2-min slot. The `partialFilterExpression` gates the
// uniqueness constraint on rows that have a real bucket number —
// legacy rows with `bucket: null` (from before bucket became required)
// are excluded from the index and can't collide with new inserts.
// Without this filter, if TWO orphaned null-bucket rows existed for
// the same user+date, every new /location-ping raised E11000 500 →
// the mobile client rolled back its burst guard → retry → E11000 500
// again in an infinite loop, silently killing the 2-min cadence.
locationPingSchema.index(
  { user: 1, date: 1, bucket: 1 },
  {
    unique: true,
    partialFilterExpression: { bucket: { $type: 'number' } },
  }
);

locationPingSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('LocationPing', locationPingSchema);
