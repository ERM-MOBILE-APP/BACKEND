require('dotenv').config();
const mongoose = require('mongoose');
const Allowance = require('./models/Allowance');
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

    await Allowance.deleteMany({ user: user._id });

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');

    const samples = [
      // ----- TRAVEL -----
      {
        user: user._id,
        type: 'travel',
        purpose: 'Client Meeting',
        fromLocation: 'Chennai',
        toLocation: 'Madurai',
        date: `${yyyy}-${mm}-04`,
        transport: 'Car',
        distance: 460,
        amount: 1200,
        notes: 'Office will remain closed for the upcoming client visit.',
        status: 'approved',
        hrComment: 'Approved.',
        reviewedBy: 'HR Lead',
        reviewedAt: new Date(),
      },
      {
        user: user._id,
        type: 'travel',
        purpose: 'Client Meeting',
        fromLocation: 'Chennai',
        toLocation: 'Madurai',
        date: `${yyyy}-${mm}-08`,
        transport: 'Car',
        distance: 460,
        amount: 1200,
        notes: 'Office will remain closed for the upcoming client visit.',
        status: 'pending',
      },
      {
        user: user._id,
        type: 'travel',
        purpose: 'Client Meeting',
        fromLocation: 'Chennai',
        toLocation: 'Madurai',
        date: `${yyyy}-${mm}-11`,
        transport: 'Car',
        distance: 460,
        amount: 1200,
        notes: 'Office will remain closed for the upcoming client visit.',
        status: 'rejected',
        hrComment: 'Receipts not attached.',
        reviewedBy: 'HR Lead',
        reviewedAt: new Date(),
      },
      // ----- PETROL -----
      {
        user: user._id,
        type: 'petrol',
        purpose: 'Daily Commute',
        fromLocation: 'Home',
        toLocation: 'Office',
        date: `${yyyy}-${mm}-02`,
        transport: 'Bike',
        distance: 15,
        amount: 1222,
        notes: 'Daily commute petrol claim.',
        status: 'approved',
        hrComment: 'Approved.',
      },
      {
        user: user._id,
        type: 'petrol',
        purpose: 'Daily Commute',
        fromLocation: 'Home',
        toLocation: 'Office',
        date: `${yyyy}-${mm}-06`,
        transport: 'Bike',
        distance: 15,
        amount: 1222,
        notes: 'Daily commute petrol claim.',
        status: 'pending',
      },
      {
        user: user._id,
        type: 'petrol',
        purpose: 'Daily Commute',
        fromLocation: 'Home',
        toLocation: 'Office',
        date: `${yyyy}-${mm}-09`,
        transport: 'Bike',
        distance: 15,
        amount: 1222,
        notes: 'Daily commute petrol claim.',
        status: 'rejected',
        hrComment: 'Already claimed once for this day.',
      },
      {
        user: user._id,
        type: 'petrol',
        purpose: 'Daily Commute',
        fromLocation: 'Home',
        toLocation: 'Office',
        date: `${yyyy}-${mm}-13`,
        transport: 'Bike',
        distance: 15,
        amount: 1222,
        notes: 'Daily commute petrol claim.',
        status: 'approved',
        hrComment: 'Approved.',
      },
    ];

    await Allowance.insertMany(samples);
    console.log(`Seeded ${samples.length} allowances for ${user.userId || user.name}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('Seed error:', e);
    process.exit(1);
  }
})();
