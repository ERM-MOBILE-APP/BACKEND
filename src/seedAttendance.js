/**
 * Seed attendance for the current month (May 2026 by default).
 *
 * Rule used:
 *   - All weekdays (Mon–Fri) up to and including yesterday are marked 'present'
 *   - Weekends (Sat, Sun) are skipped
 *   - Today and future dates are NOT seeded (the user check-ins live)
 *   - The user said they took no leave / no permission, so everything is 'present'
 *
 * Re-run safely: it upserts by (user, date).
 *
 * Usage:  node src/seedAttendance.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Attendance = require('./models/Attendance');
const User = require('./models/User');

const TARGET_USER_ID = 'EMP001';

// Office hours per spec: 10 AM – 7 PM
const CHECK_IN_HOUR = 10;
const CHECK_OUT_HOUR = 19;

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to Mongo');

  const user = await User.findOne({ userId: TARGET_USER_ID });
  if (!user) {
    console.error(`User ${TARGET_USER_ID} not found. Run "node src/seed.js" first.`);
    process.exit(1);
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  const todayDay = now.getDate();

  const pad = (n) => String(n).padStart(2, '0');

  let inserted = 0;
  for (let day = 1; day < todayDay; day++) {
    const d = new Date(year, month, day);
    const dow = d.getDay(); // 0 = Sun, 6 = Sat
    if (dow === 0 || dow === 6) continue;

    const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`;
    const checkIn = new Date(year, month, day, CHECK_IN_HOUR, 2, 0);
    const checkOut = new Date(year, month, day, CHECK_OUT_HOUR, 5, 0);
    const workedHours = +((checkOut - checkIn) / 3600000).toFixed(2);

    await Attendance.findOneAndUpdate(
      { user: user._id, date: dateStr },
      {
        $set: {
          checkIn,
          checkOut,
          workedHours,
          location: 'office',
          status: 'present',
        },
      },
      { upsert: true, new: true }
    );
    inserted++;
  }

  console.log(`Seeded ${inserted} attendance records for ${year}-${pad(month + 1)}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
