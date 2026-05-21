require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  console.log('Connected');

  const db = mongoose.connection.db;
  await db.collection('users').deleteMany({});

  const hashedPassword = await bcrypt.hash('password123', 10);

  await db.collection('users').insertOne({
    userId: 'TES005',
    name: 'Vijay',
    password: hashedPassword,
    role: 'employee',
    designation: 'UI UX Designer',
    email: 'Bhvhjh@Gmail.Com',
    phone: '+91 9988776655',
    dob: '20-09-2005',
    gender: 'Male',
    bloodGroup: 'A+',
    photoUrl: '',
    address: '',
    status: 'Active',
    workType: 'Remote',
    leaveBalance: 12,
    permissionBalance: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  console.log('User created with full profile data');

  const user = await db.collection('users').findOne({ userId: 'TES005' });
  console.log('Saved user:', user);

  mongoose.disconnect();
}).catch(console.error);
