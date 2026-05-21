require('dotenv').config();
const mongoose = require('mongoose');
const Announcement = require('./models/Announcement');

const seedData = [
  {
    title: 'Office Holiday Notice',
    body:
      'Office will remain closed on Friday, 22 May 2026 for the upcoming public holiday. Regular operations resume on Monday.',
    category: 'holiday',
    postedBy: 'HR',
    audience: 'all',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
  },
  {
    title: 'Office Holiday Notice',
    body:
      'Office will remain closed for the upcoming public holiday. Please plan your work accordingly.',
    category: 'holiday',
    postedBy: 'HR',
    audience: 'all',
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1d ago
  },
  {
    title: 'New Attendance Policy',
    body:
      'Effective from June 1st, all employees are required to mark attendance via the ERM mobile app before 9:30 AM.',
    category: 'policy',
    postedBy: 'HR',
    audience: 'all',
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3d ago
  },
  {
    title: 'Monthly Town Hall',
    body:
      'Join us for the monthly town hall on Friday at 4 PM in the main conference room. Refreshments will be served.',
    category: 'event',
    postedBy: 'Admin',
    audience: 'all',
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5d ago
  },
];

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to Mongo');

    await Announcement.deleteMany({});
    const docs = await Announcement.insertMany(seedData);

    // overwrite createdAt because insertMany ignores it by default when timestamps:true
    for (let i = 0; i < docs.length; i++) {
      await Announcement.updateOne(
        { _id: docs[i]._id },
        { $set: { createdAt: seedData[i].createdAt } }
      );
    }

    console.log(`Seeded ${docs.length} announcements`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('Seed error:', e);
    process.exit(1);
  }
})();
