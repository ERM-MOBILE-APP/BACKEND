const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, default: 'employee' },
  designation: { type: String, default: 'Employee' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  dob: { type: String, default: '' },
  gender: { type: String, default: '' },
  status: { type: String, default: 'Active' },
  workType: { type: String, default: 'Remote' },
  leaveBalance: { type: Number, default: 12 },
  permissionBalance: { type: Number, default: 4 },
}, { timestamps: true });

userSchema.pre('save', async function () {
  if (this.isModified('password'))
    this.password = await bcrypt.hash(this.password, 10);
});

module.exports = mongoose.model('User', userSchema);