const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// In-memory OTP store: { email: { otp, expiresAt } }
// Replace with Redis or DB in production.
const otpStore = new Map();

exports.login = async (req, res) => {
  const { userId, password } = req.body;
  try {
    // userId field may contain either userId or email
    const user = await User.findOne({
      $or: [{ userId }, { email: userId }],
    });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { name: user.name, userId: user.userId, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Send OTP to user's registered email.
 * Mock implementation — generates a 6-digit OTP and stores it in memory.
 * In production: send via email service (SendGrid, SES, etc.).
 */
exports.sendOtp = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  try {
    // Optionally check user exists. Comment out to allow OTP for any email.
    // const user = await User.findOne({ email });
    // if (!user) return res.status(404).json({ message: 'No account found for this email' });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min
    otpStore.set(email.toLowerCase(), { otp, expiresAt });

    console.log(`[OTP] ${email} -> ${otp} (mock — log only, no email sent)`);

    return res.json({
      success: true,
      message: `OTP sent to ${email}. Please check your inbox.`,
      // never expose otp in real APIs — kept here only for dev testing:
      ...(process.env.NODE_ENV !== 'production' && { devOtp: otp }),
    });
  } catch (err) {
    console.error('[sendOtp]', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Verify OTP entered by user.
 */
exports.verifyOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp)
    return res.status(400).json({ message: 'Email and OTP are required' });

  const record = otpStore.get(email.toLowerCase());
  if (!record) return res.status(400).json({ message: 'No OTP requested for this email' });
  if (Date.now() > record.expiresAt) {
    otpStore.delete(email.toLowerCase());
    return res.status(400).json({ message: 'OTP expired. Please request a new one.' });
  }
  if (record.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });

  otpStore.delete(email.toLowerCase());
  const resetToken = jwt.sign(
    { email, type: 'reset' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  return res.json({ success: true, message: 'OTP verified', resetToken });
};