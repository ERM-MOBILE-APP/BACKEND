// SystemConfig — singleton document holding instance-wide settings.
// Currently used for one thing: a manually-locked office anchor that
// supersedes the OFFICE_LAT / OFFICE_LNG env vars. When HR pins the
// anchor to a specific employee's verified GPS location, this collection
// holds it permanently — it survives backend restarts, dyno cold-starts,
// and code redeploys.
//
// Convention: at most ONE document. Read with findOne({}), write with upsert.
// The handler does NOT auto-recalculate. It only changes when HR explicitly
// calls POST /api/attendance/admin/lock-office.

const mongoose = require('mongoose');

const SystemConfigSchema = new mongoose.Schema(
  {
    officeAnchor: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      name: { type: String, default: 'Tesco Structures HQ' },
      radiusM: { type: Number, default: 60 },
      lockedAt: { type: Date, default: null },
      source: {
        employeeId:   { type: String, default: null },
        employeeName: { type: String, default: null },
        method:       { type: String, default: null },
      },
    },
  },
  { timestamps: true, collection: 'systemconfigs' }
);

module.exports = mongoose.model('SystemConfig', SystemConfigSchema);
