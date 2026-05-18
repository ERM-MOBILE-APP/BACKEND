require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  console.log('Connected');

  const hash = await bcrypt.hash('password123', 10);
  console.log('Generated hash:', hash);

  await mongoose.connection.db.collection('users').deleteMany({});
  
  const result = await mongoose.connection.db.collection('users').insertOne({
    userId: 'EMP001',
    name: 'Hari',
    password: hash,
    role: 'employee',
    designation: 'UI/UX Designer',
    email: 'hari@tesco.com',
    phone: '+91 98765 43210',
    dob: '14 May 1995',
    gender: 'Male',
    status: 'Active',
    workType: 'Remote',
    leaveBalance: 12,
    permissionBalance: 4,
    createdAt: new Date(),
  });

  console.log('✅ User inserted:', result.insertedId);

  const user = await mongoose.connection.db.collection('users').findOne({ userId: 'EMP001' });
  console.log('✅ Verified in DB:', user);

  mongoose.disconnect();
}).catch(console.error);