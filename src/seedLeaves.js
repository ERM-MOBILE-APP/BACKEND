require('dotenv').config();
const mongoose = require('mongoose');
const Leave = require('./models/Leave');
const User = require('./models/User');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected');

    const user = await User.findOne({});
    if (!user) {
      console.log('No user found — run seed.js first');
      process.exit(1);
    }

    await Leave.deleteMany({ user: user._id });

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');

    const samples = [
      // ----- LEAVES -----
      {
        user: user._id,
        requestType: 'leave',
        leaveType: 'Casual Leave',
        startDate: `${yyyy}-${mm}-12`,
        endDate: `${yyyy}-${mm}-14`,
        daysCount: 3,
        isHalfDay: false,
        reason: 'Personal emergency at home',
        status: 'approved',
        hrComment: 'Recover Well. Health First.',
        reviewedBy: 'HR Lead',
        reviewedAt: new Date(),
      },
      {
        user: user._id,
        requestType: 'leave',
        leaveType: 'Casual Leave',
        startDate: `${yyyy}-${mm}-18`,
        endDate: `${yyyy}-${mm}-20`,
        daysCount: 3,
        isHalfDay: false,
        reason: 'Personal emergency at home',
        status: 'pending',
        hrComment: 'Awaiting team-lead approval.',
      },
      {
        user: user._id,
        requestType: 'leave',
        leaveType: 'Casual Leave',
        startDate: `${yyyy}-${mm}-05`,
        endDate: `${yyyy}-${mm}-07`,
        daysCount: 3,
        isHalfDay: false,
        reason: 'Personal emergency at home',
        status: 'rejected',
        hrComment: 'Overlap with sprint deadline.',
        reviewedBy: 'HR Lead',
        reviewedAt: new Date(),
      },
      // ----- PERMISSIONS -----
      {
        user: user._id,
        requestType: 'permission',
        permissionType: 'Medical',
        date: `${yyyy}-${mm}-12`,
        startTime: '09:00',
        endTime: '11:00',
        durationHours: 2,
        reason: 'Medical checkup',
        status: 'approved',
        hrComment: 'Recover Well. Health First.',
        reviewedBy: 'HR Lead',
        reviewedAt: new Date(),
      },
      {
        user: user._id,
        requestType: 'permission',
        permissionType: 'Medical',
        date: `${yyyy}-${mm}-15`,
        startTime: '09:00',
        endTime: '11:00',
        durationHours: 2,
        reason: 'Follow-up consultation',
        status: 'pending',
        hrComment: 'Awaiting manager approval.',
      },
      {
        user: user._id,
        requestType: 'permission',
        permissionType: 'Medical',
        date: `${yyyy}-${mm}-08`,
        startTime: '14:00',
        endTime: '16:00',
        durationHours: 2,
        reason: 'Dentist appointment',
        status: 'rejected',
        hrComment: 'Conflicts with all-hands meeting.',
        reviewedBy: 'HR Lead',
        reviewedAt: new Date(),
      },
    ];

    await Leave.insertMany(samples);
    console.log(`Seeded ${samples.length} leaves/permissions for ${user.userId || user.name}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('Seed error:', e);
    process.exit(1);
  }
})();
