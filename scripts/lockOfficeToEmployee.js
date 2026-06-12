// One-shot office anchor lock.
//
// Usage:  node scripts/lockOfficeToEmployee.js <EMPLOYEE_ID>
// Example: node scripts/lockOfficeToEmployee.js TES047
//
// Connects to the same MongoDB the backend uses (via MONGO_URI from .env),
// reads that employee's User.lastLocation, and writes those exact
// coordinates to SystemConfig.officeAnchor. From the moment this runs,
// every adminLiveLocations response will use these coordinates as the
// office centre — no further auto-recalculation, ever.
//
// Safe to re-run with a different employeeId if you ever need to move
// the anchor. To wipe the anchor entirely, run:
//   db.systemconfigs.deleteMany({})

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const SystemConfig = require('../src/models/SystemConfig');

async function main() {
  const empId = (process.argv[2] || '').trim().toUpperCase();
  if (!empId) {
    console.error('Usage: node scripts/lockOfficeToEmployee.js <EMPLOYEE_ID>');
    process.exit(2);
  }

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI missing from .env');
    process.exit(2);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('connected to MongoDB');

  const user = await User.findOne({ employeeId: empId })
    .select('firstName lastName name employeeId lastLocation')
    .lean();

  if (!user) {
    console.error('employee not found:', empId);
    process.exit(3);
  }

  const loc = user.lastLocation || {};
  if (typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
    console.error('employee', empId, 'has no GPS yet — ask them to open the ERM mobile app while at the office, then retry.');
    process.exit(3);
  }

  const fullName = user.name || ((user.firstName || '') + ' ' + (user.lastName || '')).trim() || empId;
  const radiusM = Number(process.env.OFFICE_RADIUS_M || 60);

  await SystemConfig.findOneAndUpdate(
    {},
    {
      $set: {
        officeAnchor: {
          lat: loc.lat,
          lng: loc.lng,
          name: 'Tesco Structures HQ',
          radiusM,
          lockedAt: new Date(),
          source: { employeeId: user.employeeId, employeeName: fullName, method: 'script' },
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log('────────────────────────────────────────');
  console.log('OFFICE ANCHOR LOCKED');
  console.log('  Employee :', fullName, '(' + user.employeeId + ')');
  console.log('  Latitude :', loc.lat);
  console.log('  Longitude:', loc.lng);
  console.log('  Radius   :', radiusM, 'm');
  console.log('────────────────────────────────────────');
  console.log('This anchor will NEVER auto-change. To move it later,');
  console.log('re-run this script with a different employee.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
