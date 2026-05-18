require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  console.log('Connected');

  const db = mongoose.connection.db;
  await db.collection('users').deleteMany({});

  const hashedPassword = await bcrypt.hash('password123', 10);

  await db.collection('users').insertOne({
    userId: 'EMP001',
    name: 'Hari Krishna',
    password: hashedPassword,
    role: 'employee',
    designation: 'Software Engineer',
    email: 'hari@tescodigitals.com',
    phone: '+91 98765 43210',
    dob: '15 Jan 1998',
    gender: 'Male',
    status: 'Active',
    workType: 'Remote',
    leaveBalance: 12,
    permissionBalance: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  console.log('User created with full profile data');

  const user = await db.collection('users').findOne({ userId: 'EMP001' });
  console.log('Saved user:', user);

  mongoose.disconnect();
}).catch(console.error);
