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
    lat:        { type: Number, required: true },
    lng:        { type: Number, required: true },
    accuracy:   { type: Number, default: null },    // metres (best-effort, may be null)
    speed:      { type: Number, default: null },    // m/s (best-effort)
    presence:   { type: String, enum: ['active', 'idle', 'offline'], default: 'active' },
  },
  { timestamps: true }
);

// Compound index for "this user on this date, ordered by time" queries.
locationPingSchema.index({ user: 1, date: 1, recordedAt: -1 });

locationPingSchema.plugin(stampEmployeeId);

module.exports = mongoose.model('LocationPing', locationPingSchema);
