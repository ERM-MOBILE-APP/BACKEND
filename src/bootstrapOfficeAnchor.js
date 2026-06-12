// Bootstrap office anchor — runs once on backend startup.
//
// If BOOTSTRAP_OFFICE_EMPLOYEE_ID env var is set AND SystemConfig has no
// officeAnchor yet, this reads that employee's User.lastLocation and
// locks it as the official office anchor. After that, it does NOTHING
// on subsequent restarts (the anchor stays whatever was locked).
//
// To re-lock to a different employee later, either:
//   • DELETE the SystemConfig document, set the env var, restart, OR
//   • POST /api/attendance/admin/lock-office with the new employeeId.

const User = require('./models/User');
const SystemConfig = require('./models/SystemConfig');

async function bootstrapOfficeAnchor() {
  try {
    const empId = (process.env.BOOTSTRAP_OFFICE_EMPLOYEE_ID || '').trim().toUpperCase();
    if (!empId) {
      console.log('[bootstrapOfficeAnchor] BOOTSTRAP_OFFICE_EMPLOYEE_ID not set — skipping.');
      return;
    }
    if (!SystemConfig) {
      console.log('[bootstrapOfficeAnchor] SystemConfig model not loaded — skipping.');
      return;
    }
    const existing = await SystemConfig.findOne({}).lean();
    if (existing && existing.officeAnchor && typeof existing.officeAnchor.lat === 'number') {
      console.log('[bootstrapOfficeAnchor] anchor already locked at',
        existing.officeAnchor.lat, existing.officeAnchor.lng,
        '— leaving it alone.');
      return;
    }
    const user = await User.findOne({ employeeId: empId })
      .select('firstName lastName name employeeId lastLocation')
      .lean();
    if (!user) {
      console.warn('[bootstrapOfficeAnchor] employee', empId, 'not found — cannot bootstrap.');
      return;
    }
    const loc = user.lastLocation || {};
    if (typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      console.warn('[bootstrapOfficeAnchor] employee', empId,
        'has no GPS yet — ask them to open the ERM app, then restart this backend.');
      return;
    }
    const fullName = user.name || ((user.firstName || '') + ' ' + (user.lastName || '')).trim() || empId;
    await SystemConfig.findOneAndUpdate(
      {},
      {
        $set: {
          officeAnchor: {
            lat: loc.lat,
            lng: loc.lng,
            name: 'Tesco Structures HQ',
            radiusM: Number(process.env.OFFICE_RADIUS_M || 60),
            lockedAt: new Date(),
            source: {
              employeeId: user.employeeId,
              employeeName: fullName,
              method: 'bootstrap',
            },
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.log('[bootstrapOfficeAnchor] LOCKED anchor to', empId, '@', loc.lat, loc.lng,
      '— this will never auto-change again.');
  } catch (err) {
    console.error('[bootstrapOfficeAnchor] failed:', err && err.message);
  }
}

module.exports = { bootstrapOfficeAnchor };
