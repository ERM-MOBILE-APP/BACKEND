require('dotenv').config();
const mongoose = require('mongoose');
const Notification = require('./models/Notification');
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

    await Notification.deleteMany({ user: user._id });

    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    const samples = [
      {
        user: user._id,
        title: 'Leave Approved',
        body: 'Your annual leave request for Oct 12-15 has been approved by the manager.',
        type: 'leave',
        isRead: false,
        link: '/(tabs)/leave',
        createdAt: new Date(now - 2 * HOUR),
      },
      {
        user: user._id,
        title: 'Leave Approved',
        body: 'Your annual leave request for Oct 12-15 has been approved by the manager.',
        type: 'leave',
        isRead: false,
        link: '/(tabs)/leave',
        createdAt: new Date(now - 4 * HOUR),
      },
      {
        user: user._id,
        title: 'Leave Approved',
        body: 'Your annual leave request for Oct 12-15 has been approved by the manager.',
        type: 'leave',
        isRead: true,
        link: '/(tabs)/leave',
        createdAt: new Date(now - 1 * DAY),
      },
      {
        user: user._id,
        title: 'Allowance Approved',
        body: 'Your travel allowance claim of ₹1,200 for Chennai-Madurai has been approved.',
        type: 'allowance',
        isRead: true,
        link: '/(tabs)/allowance',
        createdAt: new Date(now - 2 * DAY),
      },
      {
        user: user._id,
        title: 'New Announcement',
        body: 'Office Holiday Notice: Office will remain closed for the upcoming public holiday.',
        type: 'announcement',
        isRead: true,
        link: '/(tabs)/',
        createdAt: new Date(now - 3 * DAY),
      },
    ];

    const docs = await Notification.insertMany(samples);
    // overwrite createdAt because timestamps:true would overwrite ours
    for (let i = 0; i < docs.length; i++) {
      await Notification.updateOne(
        { _id: docs[i]._id },
        { $set: { createdAt: samples[i].createdAt } }
      );
    }

    console.log(`Seeded ${docs.length} notifications for ${user.userId || user.name}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('Seed error:', e);
    process.exit(1);
  }
})();
