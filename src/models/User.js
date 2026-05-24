/**
 * User model — POINTS TO THE SAME `employees` COLLECTION AS HRMS.
 *
 * Why this file looks weird now
 * ─────────────────────────────
 * We unified the two MongoDB stores. The mobile ERM and HRMS web app
 * share ONE database. The HRMS web app writes to the `employees`
 * collection via its own Employee model; this mobile-side User model
 * reads/writes the same `employees` collection.
 *
 * Field naming is the trickiest part:
 *   • HRMS calls it  `firstName + lastName`, `employeeId`
 *   • Mobile calls it `name`, `userId`
 *
 * We solve this with virtuals so existing mobile code that reads
 * `user.name` or `user.userId` continues to work. Writes from the
 * mobile admin endpoints also continue to work — `name` is split into
 * firstName + lastName via a setter, and `userId` is aliased onto
 * `employeeId`.
 *
 * Schema is `strict: false` so any extra HRMS-added field (department
 * ObjectId, salary, education, etc.) round-trips unchanged.
 */

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    // ── HRMS canonical fields ─────────────────────────────────────
    employeeId: { type: String, unique: true, sparse: true, index: true },
    firstName:  { type: String, default: '' },
    lastName:   { type: String, default: '' },
    username:   { type: String, lowercase: true, sparse: true },
    // Note: NO `select: false` here on purpose — mobile login does
    // `User.findOne(...).then(u => bcrypt.compare(p, u.password))`. If we
    // hid the password the login would always fail. HRMS-side strips it
    // via its own Employee model's `select: false`.
    password:   { type: String, required: true },
    email:      { type: String, lowercase: true, trim: true, index: true },
    phone:      { type: String, default: '' },
    address:    { type: mongoose.Schema.Types.Mixed }, // HRMS object OR mobile flat string
    department: { type: mongoose.Schema.Types.Mixed }, // HRMS ObjectId OR string
    designation:{ type: mongoose.Schema.Types.Mixed }, // HRMS ObjectId OR string
    employmentType: { type: String, default: '' },
    joiningDate:{ type: Date },
    salary:     { type: Number, default: 0 },
    assignedTo: { type: String, default: '' },
    education:  { type: mongoose.Schema.Types.Mixed },
    status:     { type: String, default: 'Active' },
    isActive:   { type: Boolean, default: true },

    // ── Mobile-only fields (kept so mobile features keep working) ──
    role:              { type: String, default: 'employee' },
    dob:               { type: String, default: '' },
    gender:            { type: String, default: '' },
    bloodGroup:        { type: String, default: '' },
    photoUrl:          { type: String, default: '' },
    workType:          { type: String, default: 'Remote' },
    leaveBalance:      { type: Number, default: 12 },
    permissionBalance: { type: Number, default: 4 },

    // ── Presence + last location (live tracking) ────────────────
    // presence is updated by the mobile app on a short interval:
    //   active  — net ON and GPS ON
    //   idle    — net ON and GPS OFF
    //   offline — phone unreachable / sleeping
    presence:     { type: String, enum: ['active', 'idle', 'offline'], default: 'offline' },
    lastLocation: {
      lat:       { type: Number, default: null },
      lng:       { type: Number, default: null },
      accuracy:  { type: Number, default: null },
      updatedAt: { type: Date,   default: null },
    },
    lastSeenAt:   { type: Date, default: null },   // last time the mobile pinged
  },
  {
    collection: 'employees',   // ← points at the SAME collection HRMS uses
    timestamps: true,
    strict: false,             // accept any other field HRMS may add
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── name virtual: read = "First Last", write = split into firstName+lastName ──
userSchema.virtual('name')
  .get(function () {
    if (this.firstName || this.lastName) {
      return [this.firstName, this.lastName].filter(Boolean).join(' ').trim();
    }
    // Fallback for older docs that only had `name`
    return this._doc && this._doc.name ? this._doc.name : '';
  })
  .set(function (full) {
    const parts = String(full || '').trim().split(/\s+/);
    this.firstName = parts[0] || '';
    this.lastName  = parts.slice(1).join(' ') || '';
  });

// ─── userId virtual: maps to HRMS employeeId ──────────────────────
userSchema.virtual('userId')
  .get(function () { return this.employeeId; })
  .set(function (id) { this.employeeId = id; });

// ─── Hash password on save (mobile-side writes only) ──────────────
// HRMS Employee model has its own pre-save that hashes when HRMS writes.
// Each process loads its own model in its own memory, so the hooks
// don't cross — no double-hashing risk.
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

module.exports = mongoose.model('User', userSchema);
