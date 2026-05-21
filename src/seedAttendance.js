require('dotenv').config();
const mongoose = require('mongoose');
const Attendance = require('./models/Attendance');

const userId = process.env.SEED_USER_ID; // pass via env or it falls back to first user
const User = require('./models/User');

const STATUSES = ['present', 'present', 'present', 'present', 'late', 'permission', 'absent', 'halfday'];

function pad(n) {
  return String(n).padStart(2, '0');
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected');

    const user = userId
      ? await User.findById(userId)
      : await User.findOne({});
    if (!user) {
      console.log('No user found — run seed.js first.');
      process.exit(1);
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed
    const lastDay = new Date(year, month + 1, 0).getDate();

    await Attendance.deleteMany({
      user: user._id,
      date: { $regex: `^${year}-${pad(month + 1)}-` },
    });

    const docs = [];
    for (let d = 1; d <= Math.min(lastDay, now.getDate()); d++) {
      const day = new Date(year, month, d).getDay();
      if (day === 0 || day === 6) continue; // skip weekend

      const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
      const status = STATUSES[(d - 1) % STATUSES.length];

      let checkIn = null;
      let checkOut = null;
      let workedHours = 0;

      if (['present', 'late', 'halfday'].includes(status)) {
        const inHour = status === 'late' ? 9 : 8;
        const inMin = status === 'late' ? 45 : 55;
        const outHour = status === 'halfday' ? 13 : 18;
        checkIn = new Date(year, month, d, inHour, inMin);
        checkOut = new Date(year, month, d, outHour, 5);
        workedHours = Math.round(((checkOut - checkIn) / 3600000) * 100) / 100;
      }

      docs.push({
        user: user._id,
        date: dateStr,
        status,
        checkIn,
        checkOut,
        workedHours,
        location: 'office',
        shift: 'General Shift',
      });
    }

    await Attendance.insertMany(docs);
    console.log(`Seeded ${docs.length} attendance records for ${user.userId || user.name}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('Seed error:', e);
    process.exit(1);
  }
})();
